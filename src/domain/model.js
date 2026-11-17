/**
 * Domain model and shared helpers.
 *
 * The application coordinates a *re-keying* of masked join keys across a set of
 * fact and dimension tables. Two invariants drive everything:
 *
 *   1. Every published *version* is internally join-complete. No consumer may
 *      ever be offered a build where one table has moved to the new key and
 *      another still carries only the old one.
 *   2. A key that a field is not allowed to keep (a ruling with
 *      retainOldKey=false) must never leak into any package offered to
 *      consumers — not in a dual-key transition package, not in a rollback,
 *      and not in a tombstone row.
 *
 * All persistence is append-only JSON on disk (see storage/store.js). Historical
 * versions are immutable; later work supersedes them.
 */

import { randomUUID, createHmac } from 'node:crypto';

export const TABLE_ROLES = Object.freeze({
  FACT: 'fact',
  DIMENSION: 'dimension',
});

export const MIGRATION_PHASES = Object.freeze({
  DRAFT: 'DRAFT',
  AWAITING_ACKS: 'AWAITING_ACKS',
  COMMITTED: 'COMMITTED',
  ROLLED_BACK: 'ROLLED_BACK',
});

export const PACKAGE_MODES = Object.freeze({
  DUAL: 'dual', // rows carry old and new keys while consumers migrate
  REPLACEMENT: 'replacement', // whole-version replacement, new keys only
});

export const DELETION_POLICIES = Object.freeze({
  TOMBSTONE: 'tombstone', // row retained, marked deleted, keys kept per rulings
  PURGE: 'purge', // row removed, dependent rows cascaded, only a hash remains
});

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/** Deterministic salted hash used for audit references to keys we must forget. */
export function keyFingerprint(salt, key) {
  return createHmac('sha256', salt).update(String(key)).digest('hex').slice(0, 16);
}

export function assert(condition, code, message, details) {
  if (!condition) throw new DomainError(code, message, details);
}

/**
 * A field ruling scope is a *key group*: a group name that may bind differently
 * named columns on different tables (e.g. dim_customer.national_id and
 * fact_orders.customer_national_id share the group "national_id"). Rulings are
 * keyed by group so both sides of a join always obey the same retention rule —
 * this is what makes "no partial re-key" enforceable.
 */
export const DEFAULT_RULING = Object.freeze({
  retainOldKey: true,
  retention: 'SIX_MONTHS',
});

export function normalizeRuling(raw = {}) {
  const retentions = new Set(['SIX_MONTHS', 'TWELVE_MONTHS', 'INDEFINITE', 'SHORT_LIVED']);
  return {
    retainOldKey: raw.retainOldKey === undefined ? true : Boolean(raw.retainOldKey),
    retention: retentions.has(raw.retention) ? raw.retention : DEFAULT_RULING.retention,
  };
}

export function normalizeTable(raw) {
  const role = raw.role === TABLE_ROLES.FACT ? TABLE_ROLES.FACT : TABLE_ROLES.DIMENSION;
  const keys = Array.isArray(raw.joinKeys) ? raw.joinKeys.map(String) : [];
  const fields = Array.isArray(raw.fields)
    ? raw.fields.map((f) => ({
        name: String(f.name),
        sensitivity: String(f.sensitivity || 'standard'),
        isJoinKey: keys.includes(String(f.name)),
      }))
    : keys.map((k) => ({ name: k, sensitivity: 'standard', isJoinKey: true }));
  return {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    role,
    joinKeys: keys,
    fields,
  };
}

/**
 * A masking key spec: one declared key column on one table. `group` binds
 * differently named columns into a single join group; when omitted it defaults
 * to the field name.
 */
export function normalizeKeySpec(raw) {
  return {
    tableId: String(raw.tableId),
    field: String(raw.field),
    group: String(raw.group || raw.field),
    format: String(raw.format || 'opaque24'),
  };
}

export function newDataset({ name, description = '', tables, keys, rulings = {}, deletionPolicy }) {
  return {
    id: newId('ds'),
    name,
    description,
    createdAt: nowIso(),
    tables: tables.map(normalizeTable),
    keys: keys.map(normalizeKeySpec),
    rulings: {
      default: normalizeRuling(rulings.default || {}),
      byGroup: Object.fromEntries(
        Object.entries(rulings.byGroup || {}).map(([k, v]) => [String(k), normalizeRuling(v)]),
      ),
      deletionPolicy: Object.values(DELETION_POLICIES).includes(deletionPolicy)
        ? deletionPolicy
        : DELETION_POLICIES.TOMBSTONE,
    },
  };
}

/** Ruling for a key group, falling back to the dataset default. */
export function rulingFor(dataset, group) {
  return dataset.rulings.byGroup[group] || dataset.rulings.default;
}

/** Every (tableId, field) bound to a group. */
export function groupBindings(dataset, group) {
  return dataset.keys.filter((k) => k.group === group);
}

/**
 * Masking key derivation.
 *
 * Critical invariant: the new key for a *value* of a *group* must be identical
 * on every table that joins on that group. Derivation is therefore scoped by
 * group only — never by table id — so dim_customer.national_id and
 * fact_orders.customer_national_id produce the same masked value for the same
 * source value, and joins survive the cut-over.
 *
 * Seeds come from the mapping registration, so derivations are reproducible and
 * verifiable independently of the build that used them.
 */
export function deriveKey(mapping, group, oldKey) {
  const seed = mapping.groupSeeds[group] || mapping.keySeed;
  const digest = createHmac('sha256', seed).update(`${group}\u0000${oldKey}`).digest('hex');
  return `mk_${digest.slice(0, 24)}`;
}

/**
 * Validate that every join key has a masking key spec, and that specs point at
 * real tables/fields.
 */
export function validateDataset(dataset) {
  assert(dataset.tables.length > 0, 'INVALID_DATASET', 'Dataset must declare at least one table');
  const ids = new Set();
  for (const t of dataset.tables) {
    assert(!ids.has(t.id), 'INVALID_DATASET', `Duplicate table id ${t.id}`);
    ids.add(t.id);
    for (const k of t.joinKeys) {
      assert(
        dataset.keys.some((spec) => spec.tableId === t.id && spec.field === k),
        'INVALID_DATASET',
        `Join key ${k} on ${t.id} has no masking key spec`,
      );
    }
  }
  for (const spec of dataset.keys) {
    const table = dataset.tables.find((t) => t.id === spec.tableId);
    assert(table, 'INVALID_DATASET', `Key spec references unknown table ${spec.tableId}`);
    assert(
      table.fields.some((f) => f.name === spec.field),
      'INVALID_DATASET',
      `Key spec references unknown field ${spec.field}`,
    );
  }
  return dataset;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
