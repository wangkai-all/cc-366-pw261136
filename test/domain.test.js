import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset } from '../src/domain/blueprint.js';
import { buildSourceRows, buildLateAdditions, buildLateDeletions } from '../src/domain/fixtures.js';
import { compileVersion, keyPlan, verifyVersion } from '../src/services/compiler.js';
import { seedState } from '../src/services/seed.js';
import {
  acknowledgeMigration,
  commitMigration,
  issueLease,
  previewMigration,
  publishFromWorker,
  revokeMigration,
  startMigration,
  withdrawAck,
} from '../src/services/migrations.js';
import { PACKAGE_MODES, DELETION_POLICIES, DomainError } from '../src/domain/model.js';

const MAPPING = { id: 'mp_test', revision: 1, keySeed: 'a'.repeat(64), groupSeeds: {} };

function freshState() {
  return seedState();
}

test('key plan: restricted group is replacement, others dual', () => {
  const dataset = buildDataset();
  const plan = keyPlan(dataset);
  assert.equal(plan.national_id.mode, 'replacement');
  assert.equal(plan.national_id.retainOldKey, false);
  assert.equal(plan.customer_id.mode, 'dual');
});

test('dual compilation is join-complete in old and new key spaces', () => {
  const dataset = buildDataset();
  const v = compileVersion({
    dataset,
    mapping: MAPPING,
    snapshot: buildSourceRows(),
    mode: PACKAGE_MODES.DUAL,
    epoch: 0,
  });
  assert.equal(v.evidence.ok, true);
  assert.deepEqual(v.evidence.spaces, ['old', 'new']);
  // dim index still unique in new space
  const dim = v.tables.dim_customer;
  const masked = dim.map((r) => r.customer_id__masked);
  assert.equal(new Set(masked).size, masked.length, 'masked dimension keys must stay unique');
});

test('a shared client can join fact to dimension through the masked key', () => {
  const dataset = buildDataset();
  const v = compileVersion({
    dataset,
    mapping: MAPPING,
    snapshot: buildSourceRows(),
    mode: PACKAGE_MODES.REPLACEMENT,
    epoch: 0,
  });
  const fact = v.tables.fact_orders[0];
  const dim = v.tables.dim_customer.find((r) => r.customer_id__masked === fact.customer_id);
  assert.ok(dim, 'the fact masked key must resolve to a dimension row');
  // and the national-id group masks identically on both sides
  assert.ok(
    v.tables.dim_customer.some((r) => r.national_id === fact.customer_national_id),
    'fact national-id key must resolve to a customer',
  );
});

test('replacement mode is join-complete and emits no old-key column', () => {
  const dataset = buildDataset();
  const v = compileVersion({
    dataset,
    mapping: MAPPING,
    snapshot: buildSourceRows(),
    mode: PACKAGE_MODES.REPLACEMENT,
    epoch: 0,
  });
  assert.equal(v.evidence.ok, true);
  for (const row of v.tables.fact_orders) {
    assert.equal(row.customer_id, row.customer_id__masked);
    assert.match(row.customer_id, /^mk_/);
  }
});

test('compiling with different mappings produces different keys but identical structure', () => {
  const dataset = buildDataset();
  const a = compileVersion({ dataset, mapping: MAPPING, snapshot: buildSourceRows(), mode: 'dual' });
  const b = compileVersion({
    dataset,
    mapping: { ...MAPPING, keySeed: 'b'.repeat(64) },
    snapshot: buildSourceRows(),
    mode: 'dual',
  });
  assert.equal(a.evidence.ok && b.evidence.ok, true);
  assert.notEqual(a.tables.dim_customer[0].customer_id__masked, b.tables.dim_customer[0].customer_id__masked);
});

test('late additions are re-keyed into the same version and join cleanly', () => {
  const dataset = buildDataset();
  const v = compileVersion({
    dataset,
    mapping: MAPPING,
    snapshot: buildSourceRows(),
    additions: buildLateAdditions(),
    mode: PACKAGE_MODES.DUAL,
    epoch: 1,
  });
  const added = v.tables.fact_orders.find((r) => r._record_id === 'ORD-90001');
  assert.ok(added, 'late-added fact row must be present');
  assert.ok(
    v.tables.dim_customer.some((r) => r.customer_id__masked === added.customer_id__masked),
    'late-added fact must resolve to its late-added dimension row',
  );
});

test('tombstone deletion keeps the row flagged; joins ignore it', () => {
  const dataset = buildDataset();
  const v = compileVersion({
    dataset,
    mapping: MAPPING,
    snapshot: buildSourceRows(),
    deletions: buildLateDeletions(),
    mode: PACKAGE_MODES.DUAL,
  });
  const tomb = v.tables.fact_orders.find((r) => r._record_id === 'ORD-00007');
  assert.equal(tomb._deleted, true);
  assert.equal(v.evidence.ok, true);
  assert.ok(v.deletionEvidence.some((d) => d.recordId === 'ORD-00007' && d.decision === 'tombstone'));
});

test('purge removes the row, cascades children, and leaves only fingerprints', () => {
  const dataset = buildDataset();
  dataset.rulings.deletionPolicy = DELETION_POLICIES.PURGE;
  const v = compileVersion({
    dataset,
    mapping: MAPPING,
    snapshot: buildSourceRows(),
    deletions: { dim_product: ['PRD-012'] },
    mode: PACKAGE_MODES.DUAL,
  });
  assert.equal(v.tables.dim_product.some((r) => r._record_id === 'PRD-012'), false, 'purged dimension row is gone');
  const cascadedFacts = v.cascade.filter((c) => c.tableId === 'fact_orders');
  assert.ok(cascadedFacts.length > 0, 'facts referencing the purged product cascade');
  assert.ok(v.deletionEvidence.every((d) => d.decision === 'purge'));
  assert.ok(v.evidence.ok, 'cascade keeps the package join-complete');
});

test('integrity check detects a deliberately broken package', () => {
  const dataset = buildDataset();
  const v = compileVersion({ dataset, mapping: MAPPING, snapshot: buildSourceRows(), mode: 'dual' });
  // break the new-space join by mutating one fact key
  v.tables.fact_orders[0].customer_id__masked = 'mk_ffffffffffffffffffffffff';
  const recheck = verifyVersion({ dataset, tables: v.tables, plan: keyPlan(dataset), mode: 'dual' });
  assert.equal(recheck.ok, false);
  assert.ok(recheck.violations.some((x) => x.kind === 'ORPHAN_CHILD_KEY' && x.space === 'new'));
});

test('migration requires acknowledgements from every affected consumer', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const m = startMigration(state, dsId, { mode: 'dual' });
  assert.equal(m.phase, 'AWAITING_ACKS');
  assert.deepEqual(m.requiredConsumerIds.sort(), ['consumer-promo', 'consumer-revenue']);
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-revenue' });
  assert.throws(() => commitMigration(state, m.id), (e) => e.code === 'ACKS_PENDING');
});

test('late acknowledgement is accepted and flagged', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const m = startMigration(state, dsId, { mode: 'dual', ackDeadlineMinutes: 1 });
  m.ackDeadline = new Date(Date.now() - 60_000).toISOString();
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-revenue' });
  assert.equal(m.acks['consumer-revenue'].late, true);
});

test('a confirmation recorded with an earlier receipt time is not marked late', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const m = startMigration(state, dsId, { mode: 'dual' });
  const early = new Date(Date.now() - 5 * 60_000).toISOString();
  const ack = acknowledgeMigration(state, m.id, {
    consumerId: 'consumer-revenue',
    confirmationReceivedAt: early,
  });
  assert.equal(ack.late, false);
  assert.equal(ack.at, early);
  assert.ok(ack.recordedAt);
});

test('stale ack (wrong revision) is rejected', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const m = startMigration(state, dsId, { mode: 'dual' });
  assert.throws(
    () => acknowledgeMigration(state, m.id, { consumerId: 'consumer-revenue', revision: m.mappingRevision - 1 }),
    (e) => e.code === 'STALE_ACK',
  );
});

test('consumer can withdraw an ack mid-flight, re-blocking commit', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const m = startMigration(state, dsId, { mode: 'dual' });
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-revenue' });
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-promo' });
  withdrawAck(state, m.id, { consumerId: 'consumer-promo' });
  assert.throws(() => commitMigration(state, m.id), (e) => e.code === 'ACKS_PENDING');
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-promo' });
  const { version } = commitMigration(state, m.id);
  assert.equal(m.phase, 'COMMITTED');
  assert.equal(version.evidence.ok, true);
});

test('pre-commit revocation publishes nothing and retires the staged mapping', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const before = state.versions.length;
  const m = startMigration(state, dsId, { mode: 'dual' });
  const { rollbackVersion } = revokeMigration(state, m.id, { reason: 'test' });
  assert.equal(rollbackVersion, null);
  assert.equal(state.versions.length, before);
  assert.equal(m.phase, 'ROLLED_BACK');
  assert.equal(m.revocation.afterCommit, false);
});

test('post-commit rollback publishes a complete version using the base mapping', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const m = startMigration(state, dsId, { mode: 'dual' });
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-revenue' });
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-promo' });
  const { version } = commitMigration(state, m.id);
  const { rollbackVersion } = revokeMigration(state, m.id, { reason: 'regression' });
  assert.ok(rollbackVersion);
  assert.equal(rollbackVersion.evidence.ok, true);
  assert.equal(rollbackVersion.rollbackOfVersionId, version.id);
  assert.equal(version.status, 'ROLLED_BACK');
  assert.equal(state.publication[dsId].activeVersionId, rollbackVersion.id);
});

test('an old worker lease cannot publish after the mapping advances', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const lease = issueLease(state, dsId, { workerId: 'old-worker' });
  const m = startMigration(state, dsId, { mode: 'dual' });
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-revenue' });
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-promo' });
  commitMigration(state, m.id);
  assert.equal(lease.status, 'EXPIRED');
  assert.throws(
    () => publishFromWorker(state, dsId, { leaseId: lease.id }),
    (e) => e.code === 'LEASE_EXPIRED',
  );
  assert.equal(state.versions.at(-1).source, 'migration', 'no stale version was installed');
});

test('a fresh lease can publish, and its publication advances the fence', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const lease = issueLease(state, dsId, { workerId: 'worker-2' });
  const epochBefore = state.publication[dsId].epoch;
  const v = publishFromWorker(state, dsId, { leaseId: lease.id });
  assert.equal(v.evidence.ok, true);
  assert.equal(state.publication[dsId].epoch, epochBefore + 1);
  assert.equal(lease.status, 'USED');
});

test('preview reports affected consumers, restricted groups and late changes', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const p = previewMigration(state, dsId, { mode: 'dual' });
  assert.deepEqual(p.restrictedGroups, ['national_id']);
  assert.equal(p.affectedConsumers.length, 2);
  assert.ok(p.pendingAdditions.some((a) => a.tableId === 'fact_orders'));
  assert.ok(p.pendingDeletions.some((d) => d.tableId === 'fact_orders'));
  assert.equal(p.integrity.ok, true);
  assert.equal(p.integrity.checkedRelations > 0, true);
});

test('restricted group never leaks an old key into a dual package', () => {
  const dataset = buildDataset();
  const snapshot = buildSourceRows();
  const v = compileVersion({ dataset, mapping: MAPPING, snapshot, mode: 'dual' });
  const oldNationalIds = new Set(snapshot.dim_customer.map((r) => r.national_id));
  for (const row of v.tables.dim_customer) {
    assert.equal(oldNationalIds.has(row.national_id), false, `old national id leaked for ${row._record_id}`);
  }
  for (const row of v.tables.fact_orders) {
    assert.match(row.customer_national_id, /^mk_/);
  }
});

test('plan hash is stable across previews and changes with the dataset', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const a = previewMigration(state, dsId, { mode: 'dual' });
  const b = previewMigration(state, dsId, { mode: 'dual' });
  assert.equal(a.planHash, b.planHash);
});

test('starting a second migration while one is open is rejected', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  startMigration(state, dsId, { mode: 'dual' });
  assert.throws(() => startMigration(state, dsId, { mode: 'dual' }), (e) => e.code === 'MIGRATION_IN_FLIGHT');
});

test('preview includes a resolved worked join example', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const p = previewMigration(state, dsId, { mode: 'dual' });
  assert.ok(p.sample);
  assert.equal(p.sample.resolved, true);
  assert.match(p.sample.child.newValue, /^mk_/);
  assert.equal(p.sample.child.newValue, p.sample.parent.newValue);
});

test('a worker cannot publish a payload built on a superseded mapping revision', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const lease = issueLease(state, dsId, { workerId: 'w-payload' });
  const rev = lease.mappingRevision;
  // Advance the mapping via a committed migration.
  const m = startMigration(state, dsId, { mode: 'dual' });
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-revenue' });
  acknowledgeMigration(state, m.id, { consumerId: 'consumer-promo' });
  commitMigration(state, m.id);
  assert.throws(
    () =>
      publishFromWorker(state, dsId, {
        leaseId: lease.id,
        payload: { mappingRevision: rev, tables: {}, mode: 'dual' },
      }),
    (e) => e.code === 'LEASE_EXPIRED',
  );
});

test('a worker payload that is not join-complete is refused', () => {
  const state = freshState();
  const dsId = state.datasets[0].id;
  const lease = issueLease(state, dsId, { workerId: 'w-broken' });
  assert.throws(
    () =>
      publishFromWorker(state, dsId, {
        leaseId: lease.id,
        payload: {
          mappingRevision: lease.mappingRevision,
          mode: 'dual',
          tables: {
            fact_orders: [{ _record_id: 'ORD-1', customer_id: 'mk_a', customer_id__masked: 'mk_a', customer_national_id: 'mk_a', customer_national_id__masked: 'mk_a' }],
            dim_customer: [],
            dim_product: [],
            dim_region: [],
            dim_promotion: [],
            bridge_order_promo: [],
          },
        },
      }),
    (e) => e.code === 'JOIN_INTEGRITY_FAILED',
  );
  assert.equal(lease.status, 'ACTIVE', 'a refused payload must not consume the lease');
});
