/**
 * Package compiler.
 *
 * A *version* is a complete, immutable snapshot of every table in the estate at
 * one publication epoch. Compiling one is the only way data reaches consumers.
 *
 * Rules enforced here:
 *
 *   - All tables are compiled in one pass from one source snapshot, so a version
 *     can never mix old and new keys across tables in a group.
 *   - Per key group, the key space is decided once:
 *       * `dual` when the group's ruling allows retaining the old key: the
 *         plain `<field>` keeps the old value and `<field>__masked` adds the new
 *       * `replacement` when it does not: `<field>` becomes the new key only
 *     This can differ between groups inside one version. A version is still
 *     all-or-nothing across tables *within* each group.
 *   - Integrity is verified independently in each key space the version emits,
 *     for every relationship. A version that is not join-complete is never
 *     returned; compilation throws.
 *   - Deletions are applied to every table. PURGE cascades through dependent
 *     rows; TOMBSTONE keeps the row flagged and masked.
 *   - Restricted groups never leak the old value: not in the key column, not in
 *     a shadow column, not in a tombstone audit field.
 */

import {
  DELETION_POLICIES,
  DomainError,
  PACKAGE_MODES,
  assert,
  canonicalJson,
  deriveKey,
  keyFingerprint,
  nowIso,
  rulingFor,
} from '../domain/model.js';
import { findRelationships } from '../domain/relationships.js';

export const MASKED_SUFFIX = '__masked';

function specsFor(dataset, tableId) {
  return new Map(dataset.keys.filter((k) => k.tableId === tableId).map((k) => [k.field, k]));
}

/**
 * Compute the emit plan for the version: for each group, which key space is
 * present and whether the group is dual or replacement.
 */
export function keyPlan(dataset) {
  const groups = new Map();
  for (const spec of dataset.keys) {
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group).push(spec);
  }
  const plan = {};
  for (const [group, specs] of groups.entries()) {
    const ruling = rulingFor(dataset, group);
    plan[group] = {
      group,
      retainOldKey: ruling.retainOldKey,
      // A group may only be dual when every one of its columns can keep the old
      // value; otherwise the whole group must move to the new key in one step.
      mode: ruling.retainOldKey ? PACKAGE_MODES.DUAL : PACKAGE_MODES.REPLACEMENT,
      retention: ruling.retention,
      bindings: specs
        .map((s) => ({ tableId: s.tableId, field: s.field }))
        .sort((a, b) => a.tableId.localeCompare(b.tableId)),
    };
  }
  return plan;
}

/**
 * Assemble the effective source: snapshot rows plus late additions, minus late
 * deletions. Additions are keyed by record id; a re-added id supersedes the
 * snapshot row.
 */
export function effectiveSource(snapshot, additions = {}, deletions = {}) {
  const tables = {};
  for (const [tableId, rows] of Object.entries(snapshot)) {
    tables[tableId] = new Map(rows.map((r) => [String(r.id), { ...r }]));
  }
  for (const [tableId, rows] of Object.entries(additions || {})) {
    tables[tableId] ||= new Map();
    for (const row of rows) tables[tableId].set(String(row.id), { ...row });
  }
  const deleted = new Map();
  for (const [tableId, ids] of Object.entries(deletions || {})) {
    deleted.set(tableId, new Set(ids.map(String)));
  }
  return { tables, deleted };
}

/**
 * Cascading purge.
 *
 * Deleting a parent row deletes every child row that points at it. Additionally,
 * records live in exactly one table (record ids are unique per table), so a
 * purged row takes its own dependents with it.
 *
 * The traversal is bounded by the number of tables, so cyclic references (a
 * declared fact -> fact edge) terminate.
 */
function cascadePurge(dataset, tables, deleted) {
  const cascadeLog = [];
  const { relations } = findRelationships(dataset);

  const index = (tableId, field) => {
    const map = new Map();
    for (const row of tables[tableId]?.values() ?? []) {
      const v = row[field];
      if (v === undefined || v === null) continue;
      if (!map.has(String(v))) map.set(String(v), []);
      map.get(String(v)).push(String(row.id));
    }
    return map;
  };

  let changed = true;
  let guard = 0;
  while (changed && guard < dataset.tables.length + 2) {
    changed = false;
    guard += 1;
    for (const relation of relations) {
      const parentDeleted = deleted.get(relation.parent.tableId);
      if (!parentDeleted || parentDeleted.size === 0) continue;
      const parentKeyByValue = index(relation.parent.tableId, relation.parent.field);
      const childRowsByValue = index(relation.child.tableId, relation.child.field);
      for (const parentId of [...parentDeleted]) {
        const parentRow = tables[relation.parent.tableId]?.get(parentId);
        if (!parentRow) continue;
        const value = String(parentRow[relation.parent.field]);
        // Every child row sharing this value is now orphaned.
        for (const childId of childRowsByValue.get(value) || []) {
          if (deleted.get(relation.child.tableId)?.has(childId)) continue;
          if (!deleted.has(relation.child.tableId)) deleted.set(relation.child.tableId, new Set());
          deleted.get(relation.child.tableId).add(childId);
          cascadeLog.push({
            tableId: relation.child.tableId,
            recordId: childId,
            because: { tableId: relation.parent.tableId, recordId: parentId, joinValue: value },
            relationId: relation.id,
          });
          changed = true;
        }
        void parentKeyByValue;
      }
    }
  }
  return cascadeLog;
}

/**
 * Compile one complete version.
 */
export function compileVersion({
  dataset,
  mapping,
  snapshot,
  additions = {},
  deletions = {},
  mode = PACKAGE_MODES.DUAL,
  migrationId = null,
  epoch = 0,
}) {
  assert(
    mode === PACKAGE_MODES.DUAL || mode === PACKAGE_MODES.REPLACEMENT,
    'INVALID_MODE',
    `Unknown package mode ${mode}`,
  );
  const plan = keyPlan(dataset);

  const { tables, deleted } = effectiveSource(snapshot, additions, deletions);

  const isPurge = dataset.rulings.deletionPolicy === DELETION_POLICIES.PURGE;
  const cascadeLog = isPurge ? cascadePurge(dataset, tables, deleted) : [];

  const emitted = {};
  const deletionEvidence = [];

  for (const table of dataset.tables) {
    const specs = specsFor(dataset, table.id);
    const sourceRows = tables[table.id] || new Map();
    const outRows = [];
    for (const row of sourceRows.values()) {
      const isDeleted = deleted.get(table.id)?.has(String(row.id)) ?? false;
      if (isDeleted && isPurge) {
        // Purged rows never appear in a package. Record only salted fingerprints
        // so that deletion is auditable without retaining the identifier.
        const keyFingerprints = {};
        for (const [field, spec] of specs.entries()) {
          if (row[field] !== undefined) {
            keyFingerprints[spec.group] = keyFingerprint(mapping.keySeed, `${spec.group}\u0000${row[field]}`);
          }
        }
        deletionEvidence.push({
          tableId: table.id,
          recordIdFingerprint: keyFingerprint(mapping.keySeed, `${table.id}\u0000${row.id}`),
          decision: DELETION_POLICIES.PURGE,
          keyFingerprints,
          cascaded: cascadeLog.some((c) => c.tableId === table.id && c.recordId === String(row.id)),
          at: nowIso(),
        });
        continue;
      }

      const out = { _record_id: String(row.id) };
      if (isDeleted) out._deleted = true;

      for (const field of table.fields) {
        if (specs.has(field.name)) continue; // key columns handled below
        out[field.name] = row[field.name] ?? null;
      }

      for (const [field, spec] of specs.entries()) {
        const oldValue = row[field];
        const groupPlan = plan[spec.group];
        if (oldValue === undefined || oldValue === null) {
          out[`${field}${MASKED_SUFFIX}`] = null;
          out[field] = null;
          continue;
        }
        const newValue = deriveKey(mapping, spec.group, oldValue);
        out[`${field}${MASKED_SUFFIX}`] = newValue;
        // Dual + retained: the plain column keeps the old value and the masked
        // column carries the new one. Anything else: the plain column becomes
        // the new key, so no consumer-facing column can hold the old value.
        out[field] = groupPlan.retainOldKey && mode === PACKAGE_MODES.DUAL ? oldValue : newValue;
      }

      if (isDeleted) {
        deletionEvidence.push({
          tableId: table.id,
          recordId: String(row.id),
          decision: DELETION_POLICIES.TOMBSTONE,
          fingerprint: keyFingerprint(mapping.keySeed, `${table.id}\u0000${row.id}`),
          at: nowIso(),
        });
      }
      outRows.push(out);
    }
    emitted[table.id] = outRows;
  }

  const evidence = verifyVersion({ dataset, tables: emitted, plan, mode });
  if (!evidence.ok) {
    throw new DomainError('JOIN_INTEGRITY_FAILED', 'Compiled version is not join-complete', {
      violations: evidence.violations.slice(0, 50),
      totalViolations: evidence.violations.length,
    });
  }

  // Belt and braces: no restricted group may have emitted an old-value column.
  const payloadText = canonicalJson(emitted);
  for (const p of Object.values(plan)) {
    if (p.retainOldKey) continue;
    for (const binding of p.bindings) {
      const legacyColumn = `"${binding.field}__old"`;
      assert(
        !payloadText.includes(legacyColumn),
        'RESTRICTED_KEY_LEAK',
        `Restricted group ${p.group} emitted a legacy column on ${binding.tableId}.${binding.field}`,
      );
    }
  }
  // Stronger statement, testable: for every restricted group, no emitted cell
  // in the primary key column of any binding equals an old source value.
  for (const p of Object.values(plan)) {
    if (p.retainOldKey) continue;
    for (const binding of p.bindings) {
      const oldValues = new Set(
        [...(tables[binding.tableId]?.values() ?? [])]
          .map((r) => r[binding.field])
          .filter((v) => v !== undefined && v !== null)
          .map(String),
      );
      for (const row of emitted[binding.tableId] || []) {
        assert(
          !oldValues.has(String(row[binding.field])),
          'RESTRICTED_KEY_LEAK',
          `Restricted group ${p.group} emitted an unmasked old key on ${binding.tableId}.${binding.field}`,
        );
      }
    }
  }

  return {
    compiledAt: nowIso(),
    mappingRevision: mapping.revision,
    mappingId: mapping.id,
    mode,
    epoch,
    migrationId,
    plan,
    tables: emitted,
    deletionEvidence,
    cascade: cascadeLog,
    evidence,
    stats: Object.fromEntries(
      Object.entries(emitted).map(([tableId, rows]) => [
        tableId,
        { rows: rows.length, tombstones: rows.filter((r) => r._deleted).length },
      ]),
    ),
  };
}

/**
 * Verify join completeness for every declared relationship.
 *
 * In each key space the version emits:
 *   - the parent column must be unique (else the join is ambiguous)
 *   - every non-deleted child value must resolve on the parent side
 *
 * Positive evidence is recorded too: matched pairs, distinct values, and the
 * count of child rows checked. The evidence is what the UI and the downloadable
 * bundle present as proof of cross-table consistency.
 *
 * Tombstone rows are excluded from the child check: they are retained but
 * semantically absent.
 */
export function verifyVersion({ dataset, relations: declaredRelations, tables, plan, mode }) {
  const relations = declaredRelations ?? findRelationships(dataset).relations;
  const violations = [];
  const matches = [];

  const columnFor = (field, group, space) => {
    const p = plan[group];
    if (space === 'new') return `${field}${MASKED_SUFFIX}`;
    return mode === PACKAGE_MODES.DUAL && p.retainOldKey ? field : null;
  };

  for (const relation of relations) {
    const groupPlan = plan[relation.group];
    if (!groupPlan) continue;
    const spaces = ['new'];
    if (mode === PACKAGE_MODES.DUAL && groupPlan.retainOldKey) spaces.push('old');

    for (const space of spaces) {
      const childCol = columnFor(relation.child.field, relation.group, space);
      const parentCol = columnFor(relation.parent.field, relation.group, space);
      if (!childCol || !parentCol) continue;

      const childRows = tables[relation.child.tableId] || [];
      const parentRows = tables[relation.parent.tableId] || [];
      const parentIndex = new Map();
      const duplicates = new Set();
      for (const row of parentRows) {
        const key = row[parentCol];
        if (key === undefined || key === null) continue;
        if (parentIndex.has(key)) duplicates.add(key);
        parentIndex.set(key, String(row._record_id));
      }
      if (duplicates.size > 0) {
        violations.push({
          kind: 'DUPLICATE_PARENT_KEY',
          relationId: relation.id,
          space,
          column: `${relation.parent.tableId}.${parentCol}`,
          count: duplicates.size,
          examples: [...duplicates].slice(0, 10),
        });
      }

      let checked = 0;
      let matched = 0;
      let orphans = 0;
      const examples = [];
      for (const row of childRows) {
        if (row._deleted) continue;
        const key = row[childCol];
        if (key === undefined || key === null) continue;
        checked += 1;
        if (parentIndex.has(key)) {
          matched += 1;
        } else {
          orphans += 1;
          if (examples.length < 10) examples.push({ recordId: String(row._record_id), value: key });
        }
      }
      if (orphans > 0) {
        violations.push({
          kind: 'ORPHAN_CHILD_KEY',
          relationId: relation.id,
          space,
          child: `${relation.child.tableId}.${childCol}`,
          parent: `${relation.parent.tableId}.${parentCol}`,
          count: orphans,
          examples,
        });
      }

      matches.push({
        relationId: relation.id,
        group: relation.group,
        space,
        childTable: relation.child.tableId,
        childColumn: childCol,
        parentTable: relation.parent.tableId,
        parentColumn: parentCol,
        childRowsChecked: checked,
        matched,
        orphans,
        distinctParentValues: parentIndex.size,
        duplicates: duplicates.size,
        ok: orphans === 0 && duplicates.size === 0,
      });
    }
  }

  return {
    ok: violations.length === 0,
    checkedRelations: relations.length,
    spaces: mode === PACKAGE_MODES.DUAL ? ['old', 'new'] : ['new'],
    relationChecks: matches.length,
    matches,
    violations,
    verifiedAt: nowIso(),
  };
}
