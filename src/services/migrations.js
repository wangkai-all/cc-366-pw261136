/**
 * Migration orchestration.
 *
 * A migration is the only sanctioned path from one mapping revision to the next.
 * Its lifecycle is:
 *
 *   start -> AWAITING_ACKS -> commit -> COMMITTED
 *                    |  ^
 *                    |  +-- consumer withdraws a late ack
 *                    v
 *                ROLLED_BACK  (operator revokes, or rollback after commit)
 *
 * Rules:
 *   - Start stages a new mapping revision; the *previous* revision stays ACTIVE
 *     until commit, so running consumers are never stranded mid-way.
 *   - Every consumer whose subscriptions touch a table in the new version must
 *     acknowledge the *exact* staged plan (revision + plan hash). Late acks are
 *     accepted and flagged; a withdrawal puts the migration back to pending.
 *   - Commit recompiles the source at that moment, re-verifies join integrity in
 *     every emitted key space, then atomically activates the mapping, advances
 *     the publication epoch and installs the complete version.
 *   - Publication is fenced by (epoch, mapping revision). A worker holding an
 *     expired lease — an "old process" — cannot republish stale keys.
 *   - Revocation before commit retires the staged mapping. Revocation after
 *     commit publishes a fresh rollback version built with the previous mapping
 *     revision, so consumers always have a complete, consistent package.
 */

import { createHash } from 'node:crypto';
import {
  DomainError,
  MIGRATION_PHASES,
  PACKAGE_MODES,
  assert,
  canonicalJson,
  newId,
  nowIso,
} from '../domain/model.js';
import { findRelationships } from '../domain/relationships.js';
import {
  activateMapping,
  activeMapping,
  assertPublisherCurrent,
  datasetEpoch,
  ensureMapping,
  mappingByRevision,
  retireMapping,
  stageMappingRevision,
} from './mappingRegistry.js';
import { compileVersion, keyPlan, verifyVersion } from './compiler.js';

const ACK_DEFAULT_MINUTES = 30;

function sha256Short(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

export function planHash(dataset) {
  return sha256Short(canonicalJson(keyPlan(dataset)));
}

function ephemeralPreviewMapping(dataset) {
  // Stable per dataset so refreshing a preview does not shuffle sample keys.
  const seed = createHash('sha256').update(`preview:${dataset.id}`).digest('hex');
  return { id: 'preview', revision: null, keySeed: seed, groupSeeds: {} };
}

function datasetOf(state, datasetId) {
  const dataset = state.datasets.find((d) => d.id === datasetId);
  if (!dataset) throw new DomainError('UNKNOWN_DATASET', `Unknown dataset ${datasetId}`);
  return dataset;
}

function migrationOf(state, migrationId) {
  const migration = state.migrations.find((m) => m.id === migrationId);
  if (!migration) throw new DomainError('UNKNOWN_MIGRATION', `Unknown migration ${migrationId}`);
  return migration;
}

function sourceOf(state, datasetId) {
  const src = state.sources[datasetId];
  if (!src) throw new DomainError('NO_SOURCE', `No source estate loaded for ${datasetId}`);
  return src;
}

function consumerOf(state, consumerId) {
  const consumer = state.consumers.find((c) => c.id === consumerId);
  if (!consumer) throw new DomainError('UNKNOWN_CONSUMER', `Unknown consumer ${consumerId}`);
  return consumer;
}

function affectedConsumers(dataset, consumers, affectedTableIds) {
  const tables = new Set(affectedTableIds);
  return consumers
    .filter((c) => c.role === 'consumer' && c.subscriptions.some((t) => tables.has(t)))
    .map((c) => ({
      id: c.id,
      name: c.name,
      subscriptions: c.subscriptions.slice().sort(),
      overlappingTables: c.subscriptions.filter((t) => tables.has(t)).sort(),
    }));
}

/**
 * Compute the impact of a planned migration without changing any state.
 * Returns everything the web UI needs to show who is affected and what the
 * package would contain, including a trial compile + verification.
 */
export function previewMigration(state, datasetId, { mode = PACKAGE_MODES.DUAL } = {}) {
  const dataset = datasetOf(state, datasetId);
  const source = sourceOf(state, datasetId);
  const plan = keyPlan(dataset);
  const { relations, notes } = findRelationships(dataset);
  const affectedTables = [...new Set(Object.values(plan).flatMap((p) => p.bindings.map((b) => b.tableId)))].sort();

  // Trial compile with an ephemeral seed: proves the plan is join-complete for
  // the current source without registering a revision.
  const compiled = compileVersion({
    dataset,
    mapping: ephemeralPreviewMapping(dataset),
    snapshot: source.snapshot,
    additions: source.additions,
    deletions: source.deletions,
    mode,
    epoch: datasetEpoch(state, datasetId),
  });

  const deletionSummary = Object.entries(source.deletions || {}).map(([tableId, ids]) => ({
    tableId,
    requested: ids.length,
    cascaded: compiled.cascade.filter((c) => c.tableId === tableId).length,
    decision: dataset.rulings.deletionPolicy,
    evidence: compiled.deletionEvidence.filter((e) => e.tableId === tableId).length,
  }));
  const additionsSummary = Object.entries(source.additions || {}).map(([tableId, rows]) => ({
    tableId,
    rows: rows.length,
  }));

  // A worked example of the cross-table join proof: one fact row and the
  // dimension row it resolves to in the new key space.
  const sample = buildJoinSample(dataset, compiled);

  return {
    datasetId,
    mode,
    planHash: planHash(dataset),
    groups: Object.values(plan).map((p) => ({
      ...p,
      retainsOldKey: p.retainOldKey,
      emittedKeySpaces: mode === PACKAGE_MODES.DUAL && p.retainOldKey ? ['old', 'new'] : ['new'],
      restricted: !p.retainOldKey,
    })),
    restrictedGroups: Object.values(plan).filter((p) => !p.retainOldKey).map((p) => p.group),
    affectedTables,
    relationships: relations,
    notes,
    affectedConsumers: affectedConsumers(dataset, state.consumers, affectedTables),
    pendingAdditions: additionsSummary,
    pendingDeletions: deletionSummary,
    deletionPolicy: dataset.rulings.deletionPolicy,
    integrity: compiled.evidence,
    stats: compiled.stats,
    sample,
  };
}

/**
 * Show, concretely, that a fact key resolves to exactly one dimension key in
 * the new space. Purely illustrative: the authoritative proof is `integrity`.
 */
function buildJoinSample(dataset, compiled) {
  const { relations } = findRelationships(dataset);
  const pick = relations.find((r) => r.group === 'customer_id') || relations[0];
  if (!pick) return null;
  const childRows = compiled.tables[pick.child.tableId] || [];
  const parentRows = compiled.tables[pick.parent.tableId] || [];
  const child = childRows.find((r) => !r._deleted && r[`${pick.child.field}__masked`]);
  if (!child) return null;
  const childKey = child[`${pick.child.field}__masked`];
  const parent = parentRows.find((r) => r[`${pick.parent.field}__masked`] === childKey);
  return {
    relationId: pick.id,
    group: pick.group,
    child: {
      tableId: pick.child.tableId,
      recordId: String(child._record_id),
      field: pick.child.field,
      oldValue: child[pick.child.field],
      newValue: childKey,
    },
    parent: parent
      ? {
          tableId: pick.parent.tableId,
          recordId: String(parent._record_id),
          field: pick.parent.field,
          oldValue: parent[pick.parent.field],
          newValue: parent[`${pick.parent.field}__masked`],
        }
      : null,
    resolved: Boolean(parent),
  };
}

export function startMigration(state, datasetId, { mode = PACKAGE_MODES.DUAL, consumerIds = null, ackDeadlineMinutes = ACK_DEFAULT_MINUTES, actor = 'operator' } = {}) {
  const dataset = datasetOf(state, datasetId);
  sourceOf(state, datasetId);
  assert(
    !state.migrations.some(
      (m) => m.datasetId === datasetId && m.phase === MIGRATION_PHASES.AWAITING_ACKS,
    ),
    'MIGRATION_IN_FLIGHT',
    'Another migration for this dataset is still awaiting acknowledgement; revoke or commit it first',
  );

  const preview = previewMigration(state, datasetId, { mode });
  const required = preview.affectedConsumers.map((c) => c.id);
  const requested = consumerIds && consumerIds.length ? consumerIds : required;
  for (const id of requested) consumerOf(state, id);
  const requiredSet = new Set(required);
  assert(
    [...requiredSet].every((id) => requested.includes(id)) || requested.length === 0,
    'ACK_SET_INCOMPLETE',
    'The required consumer set cannot be reduced; every subscribed consumer must acknowledge',
    { required },
  );

  ensureMapping(state, datasetId);
  const staged = stageMappingRevision(state, datasetId);
  const epochAtStart = datasetEpoch(state, datasetId);
  const minutes = Math.max(1, Math.min(24 * 60, Number(ackDeadlineMinutes) || ACK_DEFAULT_MINUTES));

  const migration = {
    id: newId('mig'),
    datasetId,
    actor,
    mode,
    phase: MIGRATION_PHASES.AWAITING_ACKS,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    mappingId: staged.id,
    mappingRevision: staged.revision,
    baseMappingRevision: activeMapping(state, datasetId)?.revision ?? null,
    baseVersionId: state.publication[datasetId]?.activeVersionId ?? null,
    baseEpoch: epochAtStart,
    planHash: preview.planHash,
    ackDeadline: new Date(Date.now() + minutes * 60_000).toISOString(),
    requiredConsumerIds: required,
    acks: {},
    preview: {
      affectedTables: preview.affectedTables,
      affectedConsumers: preview.affectedConsumers,
      restrictedGroups: preview.restrictedGroups,
      relationships: preview.relationships.map((r) => r.id),
      integrity: preview.integrity,
      stats: preview.stats,
      pendingAdditions: preview.pendingAdditions,
      pendingDeletions: preview.pendingDeletions,
    },
    history: [
      {
        at: nowIso(),
        event: 'PLANNED',
        detail: `Staged mapping revision ${staged.revision} for ${mode} package`,
      },
    ],
  };
  state.migrations.push(migration);
  state.events.push({
    at: migration.createdAt,
    type: 'MIGRATION_STARTED',
    migrationId: migration.id,
    detail: `${dataset.name}: ${mode} package, revision ${staged.revision}`,
  });
  return migration;
}

/**
 * Consumer acknowledgement. Accepted late (flagged) as long as the migration is
 * still AWAITING_ACKS and the ack names the exact staged revision + plan.
 */
export function acknowledgeMigration(
  state,
  migrationId,
  { consumerId, note = '', revision = null, plan = null, actor = null, confirmationReceivedAt = null },
) {
  const migration = migrationOf(state, migrationId);
  consumerOf(state, consumerId);
  assert(
    migration.phase === MIGRATION_PHASES.AWAITING_ACKS,
    'MIGRATION_NOT_OPEN',
    `Migration is ${migration.phase}; acknowledgements are closed`,
  );
  assert(
    migration.requiredConsumerIds.includes(consumerId),
    'NOT_REQUIRED',
    `${consumerId} is not a required consumer for this migration`,
  );
  if (revision !== null && Number(revision) !== migration.mappingRevision) {
    throw new DomainError('STALE_ACK', 'Acknowledgement names an older mapping revision', {
      expected: migration.mappingRevision,
      presented: revision,
    });
  }
  if (plan !== null && String(plan) !== migration.planHash) {
    throw new DomainError('STALE_ACK', 'Acknowledgement names a different key plan', {
      expected: migration.planHash,
      presented: plan,
    });
  }
  const receivedAt = nowIso();
  // A confirmation can be recorded from a consumer that confirmed out of band
  // earlier. `confirmationReceivedAt` lets the operator enter the time the
  // consumer actually confirmed; lateness is judged on that time, not on when
  // the operator typed it, so the record stays truthful.
  const effectiveAt = confirmationReceivedAt ? new Date(confirmationReceivedAt) : new Date(receivedAt);
  assert(!Number.isNaN(effectiveAt.valueOf()), 'BAD_TIMESTAMP', 'confirmationReceivedAt is not a valid timestamp');
  const late = effectiveAt > new Date(migration.ackDeadline);
  migration.acks[consumerId] = {
    at: effectiveAt.toISOString(),
    recordedAt: receivedAt,
    note: String(note),
    revision: migration.mappingRevision,
    planHash: migration.planHash,
    late,
    actor: actor || consumerId,
  };
  migration.updatedAt = receivedAt;
  migration.history.push({
    at: receivedAt,
    event: late ? 'ACK_LATE' : 'ACK',
    detail: `${consumerId} acknowledged revision ${migration.mappingRevision}${late ? ' after the deadline' : ''}`,
  });
  state.events.push({ at: receivedAt, type: late ? 'ACK_LATE' : 'ACK', migrationId, consumerId });
  return migration.acks[consumerId];
}

/** A consumer withdraws its ack before commit — mid-flight revocation. */
export function withdrawAck(state, migrationId, { consumerId, note = '' }) {
  const migration = migrationOf(state, migrationId);
  assert(
    migration.phase === MIGRATION_PHASES.AWAITING_ACKS,
    'MIGRATION_FINALIZED',
    `Migration is ${migration.phase}; ack withdrawal is only possible before commit`,
  );
  assert(migration.acks[consumerId], 'NO_ACK', `${consumerId} has not acknowledged`);
  delete migration.acks[consumerId];
  const at = nowIso();
  migration.updatedAt = at;
  migration.history.push({
    at,
    event: 'ACK_WITHDRAWN',
    detail: `${consumerId} withdrew acknowledgement${note ? `: ${note}` : ''}`,
  });
  state.events.push({ at, type: 'ACK_WITHDRAWN', migrationId, consumerId });
  return migration;
}

function pendingConsumers(migration) {
  return migration.requiredConsumerIds.filter((id) => !migration.acks[id]);
}

export function commitMigration(state, migrationId, { actor = 'operator' } = {}) {
  const migration = migrationOf(state, migrationId);
  assert(
    migration.phase === MIGRATION_PHASES.AWAITING_ACKS,
    'MIGRATION_NOT_OPEN',
    `Migration is ${migration.phase}; cannot commit`,
  );
  const pending = pendingConsumers(migration);
  assert(
    pending.length === 0,
    'ACKS_PENDING',
    `Cannot commit until every required consumer acknowledges: ${pending.join(', ')}`,
    { pending },
  );
  for (const [consumerId, ack] of Object.entries(migration.acks)) {
    assert(
      ack.revision === migration.mappingRevision && ack.planHash === migration.planHash,
      'STALE_ACK',
      `Acknowledgement from ${consumerId} does not match the staged plan`,
    );
  }

  const dataset = datasetOf(state, migration.datasetId);
  const source = sourceOf(state, migration.datasetId);
  const staged = mappingByRevision(state, migration.datasetId, migration.mappingRevision);
  assert(staged && staged.status === 'STAGED', 'MAPPING_NOT_STAGED', 'Staged mapping revision is missing');

  const epoch = datasetEpoch(state, migration.datasetId) + 1;
  const compiled = compileVersion({
    dataset,
    mapping: staged,
    snapshot: source.snapshot,
    additions: source.additions,
    deletions: source.deletions,
    mode: migration.mode,
    migrationId: migration.id,
    epoch,
  });

  activateMapping(state, migration.datasetId, staged.id);
  const version = createVersion(state, {
    datasetId: migration.datasetId,
    compiled,
    source: 'migration',
    migrationId: migration.id,
    summary: `Key rotation ${migration.mode} package`,
  });
  state.publication[migration.datasetId] = {
    epoch,
    activeVersionId: version.id,
    activeMappingRevision: staged.revision,
  };

  // Any lease issued against the previous epoch/revision is now stale by
  // construction: assertPublisherCurrent will refuse it.
  expireLeases(state, migration.datasetId, { epoch, revision: staged.revision });

  const at = nowIso();
  migration.phase = MIGRATION_PHASES.COMMITTED;
  migration.updatedAt = at;
  migration.commit = {
    at,
    actor,
    epoch,
    versionId: version.id,
    mappingRevision: staged.revision,
    integrity: compiled.evidence,
    stats: compiled.stats,
  };
  migration.history.push({
    at,
    event: 'COMMITTED',
    detail: `Activated mapping revision ${staged.revision}; published version ${version.versionNo} at epoch ${epoch}`,
  });
  state.events.push({
    at,
    type: 'MIGRATION_COMMITTED',
    migrationId: migration.id,
    versionId: version.id,
    epoch,
  });
  return { migration, version };
}

/**
 * Operator revocation. Before commit: retire the staged mapping, nothing is
 * published. After commit: rebuild a complete rollback version with the mapping
 * revision that was active before the migration.
 */
export function revokeMigration(state, migrationId, { reason = '', actor = 'operator' } = {}) {
  const migration = migrationOf(state, migrationId);
  assert(
    [MIGRATION_PHASES.AWAITING_ACKS, MIGRATION_PHASES.COMMITTED].includes(migration.phase),
    'MIGRATION_FINALIZED',
    `Migration is ${migration.phase}; nothing to revoke`,
  );
  const dataset = datasetOf(state, migration.datasetId);
  const at = nowIso();

  if (migration.phase === MIGRATION_PHASES.AWAITING_ACKS) {
    const staged = mappingByRevision(state, migration.datasetId, migration.mappingRevision);
    if (staged) retireMapping(state, migration.datasetId, staged.id, 'migration revoked before commit');
    migration.phase = MIGRATION_PHASES.ROLLED_BACK;
    migration.updatedAt = at;
    migration.revocation = { at, actor, reason: String(reason), afterCommit: false };
    migration.history.push({
      at,
      event: 'REVOKED',
      detail: `Revoked before commit; staging revision retired. ${reason}`.trim(),
    });
    state.events.push({ at, type: 'MIGRATION_REVOKED', migrationId, phase: 'pre-commit' });
    return { migration, rollbackVersion: null };
  }

  // Post-commit rollback: publish a complete version with the previous mapping.
  const baseRevision = migration.baseMappingRevision;
  const baseMapping = mappingByRevision(state, migration.datasetId, baseRevision);
  assert(baseMapping, 'MAPPING_MISSING', `Cannot roll back: mapping revision ${baseRevision} is unavailable`);
  const source = sourceOf(state, migration.datasetId);
  const epoch = datasetEpoch(state, migration.datasetId) + 1;
  // A rollback restores the pre-migration key space by compiling with the base
  // mapping revision in the base version's mode, so the restored package has
  // exactly the semantics consumers had before the migration — never a
  // half-restored mixture.
  const baseVersion = migration.baseVersionId
    ? state.versions.find((v) => v.id === migration.baseVersionId)
    : null;
  const rollbackMode = baseVersion?.mode || PACKAGE_MODES.DUAL;
  const compiled = compileVersion({
    dataset,
    mapping: baseMapping,
    snapshot: source.snapshot,
    additions: source.additions,
    deletions: source.deletions,
    mode: rollbackMode,
    migrationId: migration.id,
    epoch,
  });

  // Refresh the base mapping's seeds into a new revision so historical keys
  // cannot be confused with the abandoned ones while keeping values stable.
  // (Same seeds, new revision label; publication fences the abandoned revision.)
  activateMapping(state, migration.datasetId, baseMapping.id);
  const version = createVersion(state, {
    datasetId: migration.datasetId,
    compiled,
    source: 'rollback',
    migrationId: migration.id,
    summary: `Rollback of ${migration.mode} package`,
    rollbackOfVersionId: migration.commit?.versionId ?? null,
  });
  state.publication[migration.datasetId] = {
    epoch,
    activeVersionId: version.id,
    activeMappingRevision: baseMapping.revision,
  };
  expireLeases(state, migration.datasetId, { epoch, revision: baseMapping.revision });

  const committedVersion = state.versions.find((v) => v.id === migration.commit?.versionId);
  if (committedVersion) {
    committedVersion.status = 'ROLLED_BACK';
    committedVersion.supersededBy = version.id;
    committedVersion.supersededAt = at;
  }
  const abandoned = mappingByRevision(state, migration.datasetId, migration.mappingRevision);
  if (abandoned) retireMapping(state, migration.datasetId, abandoned.id, 'migration rolled back');

  migration.phase = MIGRATION_PHASES.ROLLED_BACK;
  migration.updatedAt = at;
  migration.revocation = { at, actor, reason: String(reason), afterCommit: true };
  migration.history.push({
    at,
    event: 'ROLLED_BACK',
    detail: `Rollback version ${version.versionNo} published at epoch ${epoch} using revision ${baseMapping.revision}. ${reason}`.trim(),
  });
  state.events.push({ at, type: 'MIGRATION_ROLLED_BACK', migrationId, versionId: version.id });
  return { migration, rollbackVersion: version };
}

/**
 * Create a version record. Verifies join integrity again at the storage
 * boundary — nothing unverified can become a version.
 */
export function createVersion(state, { datasetId, compiled, source, migrationId = null, summary = '', rollbackOfVersionId = null }) {
  if (!compiled.evidence?.ok) {
    throw new DomainError('JOIN_INTEGRITY_FAILED', 'Refusing to store a version that failed integrity');
  }
  const previous = state.publication[datasetId]?.activeVersionId
    ? state.versions.find((v) => v.id === state.publication[datasetId].activeVersionId)
    : null;
  if (previous) {
    previous.status = 'SUPERSEDED';
    previous.supersededBy = null; // filled below once the id exists
    previous.supersededAt = nowIso();
  }
  const versionNo = (state.versions.filter((v) => v.datasetId === datasetId).at(-1)?.versionNo || 0) + 1;
  const version = {
    id: newId('ver'),
    datasetId,
    versionNo,
    source,
    summary,
    migrationId,
    rollbackOfVersionId,
    status: 'ACTIVE',
    mappingId: compiled.mappingId,
    mappingRevision: compiled.mappingRevision,
    epoch: compiled.epoch,
    mode: compiled.mode,
    createdAt: nowIso(),
    plan: compiled.plan,
    tables: compiled.tables,
    evidence: compiled.evidence,
    deletionEvidence: compiled.deletionEvidence,
    cascade: compiled.cascade,
    stats: compiled.stats,
    checksums: tableChecksums(compiled.tables),
  };
  if (previous) {
    const idx = state.versions.findIndex((v) => v.id === previous.id);
    state.versions[idx].supersededBy = version.id;
  }
  state.versions.push(version);
  if (!state.publication[datasetId]) state.publication[datasetId] = { epoch: 0, activeVersionId: null, activeMappingRevision: null };
  return version;
}

function tableChecksums(tables) {
  const out = {};
  for (const [tableId, rows] of Object.entries(tables)) {
    out[tableId] = sha256Short(canonicalJson(rows));
  }
  return out;
}

/**
 * Worker leases. A process registers the epoch/revision it is working against.
 * After a commit or rollback those values advance, so the lease goes stale.
 */
export function issueLease(state, datasetId, { workerId, note = '' }) {
  datasetOf(state, datasetId);
  const epoch = datasetEpoch(state, datasetId);
  const mapping = activeMapping(state, datasetId) || ensureMapping(state, datasetId);
  const lease = {
    id: newId('lease'),
    datasetId,
    workerId: String(workerId || 'unnamed-worker'),
    epoch,
    mappingRevision: mapping.revision,
    status: 'ACTIVE',
    issuedAt: nowIso(),
    note: String(note),
  };
  state.leases.push(lease);
  state.events.push({ at: lease.issuedAt, type: 'LEASE_ISSUED', leaseId: lease.id, workerId: lease.workerId });
  return lease;
}

function expireLeases(state, datasetId, { epoch, revision }) {
  for (const lease of state.leases) {
    if (lease.datasetId !== datasetId) continue;
    if (lease.status !== 'ACTIVE') continue;
    if (lease.epoch === epoch && lease.mappingRevision === revision) continue;
    lease.status = 'EXPIRED';
    lease.expiredAt = nowIso();
    lease.reason = 'publication epoch or mapping revision advanced';
  }
}

/**
 * Worker publication. The worker presents a lease. Optionally it also presents
 * a payload it built itself (`tables`, `mappingRevision`, `planHash`, `mode`).
 *
 * Every payload is treated as untrusted:
 *   - the lease is re-checked against the registry (stale lease = hard error)
 *   - a presented mapping revision must still be the active one
 *   - a presented plan hash must match the current plan
 *   - the rows are re-verified for join completeness before anything is stored
 *
 * So an old process that still holds an expired lease cannot republish stale
 * keys, and a worker that submits rows built on a superseded mapping is
 * rejected rather than having its payload installed.
 */
export function publishFromWorker(state, datasetId, { leaseId, workerId = null, payload = null } = {}) {
  const lease = state.leases.find((l) => l.id === leaseId && l.datasetId === datasetId);
  if (!lease) throw new DomainError('UNKNOWN_LEASE', `Unknown lease ${leaseId}`);
  if (workerId && lease.workerId !== workerId) {
    throw new DomainError('LEASE_MISMATCH', 'Lease belongs to a different worker');
  }
  if (lease.status !== 'ACTIVE') {
    throw new DomainError('LEASE_EXPIRED', 'Lease is no longer active; the process must re-register', {
      leaseStatus: lease.status,
      reason: lease.reason,
    });
  }
  assertPublisherCurrent(state, datasetId, { expectedEpoch: lease.epoch, mappingRevision: lease.mappingRevision });

  const dataset = datasetOf(state, datasetId);

  if (payload) {
    const presentedRevision = payload.mappingRevision ?? lease.mappingRevision;
    if (Number(presentedRevision) !== lease.mappingRevision) {
      throw new DomainError('STALE_MAPPING', 'Worker payload was built on a different mapping revision', {
        leaseRevision: lease.mappingRevision,
        payloadRevision: presentedRevision,
        active: activeMapping(state, datasetId)?.revision ?? null,
      });
    }
    assertPublisherCurrent(state, datasetId, { expectedEpoch: lease.epoch, mappingRevision: Number(presentedRevision) });
    if (payload.planHash && payload.planHash !== planHash(dataset)) {
      throw new DomainError('STALE_PLAN', 'Worker payload does not match the current key plan', {
        expected: planHash(dataset),
        presented: payload.planHash,
      });
    }
    const mode = payload.mode === PACKAGE_MODES.DUAL ? PACKAGE_MODES.DUAL : PACKAGE_MODES.REPLACEMENT;
    const evidence = verifyVersion({ dataset, tables: payload.tables, plan: keyPlan(dataset), mode });
    if (!evidence.ok) {
      throw new DomainError('JOIN_INTEGRITY_FAILED', 'Worker payload is not join-complete; refusing to publish', {
        violations: evidence.violations.slice(0, 50),
      });
    }
    const epoch = lease.epoch + 1;
    const activeMappingRow = mappingByRevision(state, datasetId, lease.mappingRevision);
    const version = createVersion(state, {
      datasetId,
      compiled: {
        mappingId: activeMappingRow?.id ?? null,
        mappingRevision: lease.mappingRevision,
        mode,
        epoch,
        plan: keyPlan(dataset),
        tables: payload.tables,
        evidence,
        deletionEvidence: payload.deletionEvidence || [],
        cascade: payload.cascade || [],
        stats: Object.fromEntries(
          Object.entries(payload.tables).map(([tableId, rows]) => [
            tableId,
            { rows: rows.length, tombstones: rows.filter((r) => r._deleted).length },
          ]),
        ),
      },
      source: 'worker',
      summary: `Worker ${lease.workerId} published a self-built payload on revision ${lease.mappingRevision}`,
    });
    finalizeWorkerPublication(state, datasetId, lease, version, epoch);
    return version;
  }

  const source = sourceOf(state, datasetId);
  const mapping = mappingByRevision(state, datasetId, lease.mappingRevision);
  const epoch = lease.epoch + 1;
  const compiled = compileVersion({
    dataset,
    mapping,
    snapshot: source.snapshot,
    additions: source.additions,
    deletions: source.deletions,
    mode: PACKAGE_MODES.REPLACEMENT,
    epoch,
  });
  const version = createVersion(state, {
    datasetId,
    compiled,
    source: 'worker',
    summary: `Worker ${lease.workerId} publication on revision ${lease.mappingRevision}`,
  });
  finalizeWorkerPublication(state, datasetId, lease, version, epoch);
  return version;
}

function finalizeWorkerPublication(state, datasetId, lease, version, epoch) {
  state.publication[datasetId] = {
    epoch,
    activeVersionId: version.id,
    activeMappingRevision: lease.mappingRevision,
  };
  expireLeases(state, datasetId, { epoch, revision: lease.mappingRevision });
  lease.status = 'USED';
  lease.usedAt = nowIso();
  state.events.push({
    at: lease.usedAt,
    type: 'WORKER_PUBLISHED',
    leaseId: lease.id,
    workerId: lease.workerId,
    versionId: version.id,
    epoch,
  });
}
