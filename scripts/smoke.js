/**
 * Terminal walkthrough of the whole coordination story.
 *
 *   npm run smoke
 *
 * Uses an in-memory seeded state (no server, no disk writes) and prints each
 * step plus the evidence the UI would show.
 */
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
import { PACKAGE_MODES } from '../src/domain/model.js';

const line = (s = '') => console.log(s);
const h = (s) => line(`\n\x1b[1m${s}\x1b[0m`);

const state = seedState();
const ds = state.datasets[0];
const dsId = ds.id;

h('1. Estate');
for (const g of previewMigration(state, dsId, { mode: PACKAGE_MODES.DUAL }).groups) {
  line(`  ${g.group.padEnd(12)} ${g.bindings.map((b) => `${b.tableId}.${b.field}`).join(' ↔ ')}  [${g.mode}]`);
}

h('2. Preview impact');
const preview = previewMigration(state, dsId, { mode: PACKAGE_MODES.DUAL });
line(`  affected consumers : ${preview.affectedConsumers.map((c) => c.name).join(', ')}`);
line(`  restricted groups  : ${preview.restrictedGroups.join(', ')} (new key only, no dual carry)`);
line(`  pending additions  : ${preview.pendingAdditions.map((a) => `${a.tableId}+${a.rows}`).join(', ') || 'none'}`);
line(`  pending deletions  : ${preview.pendingDeletions.map((d) => `${d.tableId} ${d.requested} (${d.decision})`).join(', ') || 'none'}`);
line(`  trial integrity    : ${preview.integrity.ok ? 'join-complete' : 'FAILED'} — ${preview.integrity.relationChecks} checks across ${preview.integrity.spaces.join('+')}`);
if (preview.sample) {
  line(`  worked example     : ${preview.sample.child.tableId}.${preview.sample.child.field} ${preview.sample.child.oldValue} -> ${preview.sample.child.newValue}`);
  line(`                       resolves to ${preview.sample.parent?.tableId} row ${preview.sample.parent?.recordId}`);
}

h('3. Start migration');
const m = startMigration(state, dsId, { mode: PACKAGE_MODES.DUAL, ackDeadlineMinutes: 30 });
line(`  phase ${m.phase}; staged mapping revision ${m.mappingRevision}; required acks: ${m.requiredConsumerIds.join(', ')}`);

h('4. Acks: one late, one withdrawn and re-sent');
acknowledgeMigration(state, m.id, { consumerId: 'consumer-revenue', note: 'checked plan hash' });
line('  consumer-revenue acked');
withdrawAck(state, m.id, { consumerId: 'consumer-revenue', note: 'staging exercise' });
line('  consumer-revenue withdrew — commit is blocked again');
try {
  commitMigration(state, m.id);
} catch (err) {
  line(`  commit refused: ${err.code} — ${err.message}`);
}
acknowledgeMigration(state, m.id, { consumerId: 'consumer-revenue' });
m.ackDeadline = new Date(Date.now() - 60_000).toISOString();
const late = acknowledgeMigration(state, m.id, { consumerId: 'consumer-promo' });
line(`  consumer-promo acked ${late.late ? 'LATE (flagged)' : 'on time'}`);

h('5. Commit');
const { version: v1 } = commitMigration(state, m.id);
line(`  committed: version v${v1.versionNo}, mode ${v1.mode}, epoch ${v1.epoch}, mapping rev ${v1.mappingRevision}`);
line(`  integrity: ${v1.evidence.relationChecks} checks, ${v1.evidence.violations.length} violations`);
for (const mm of v1.evidence.matches) {
  line(`    ${mm.ok ? 'ok' : 'FAIL'} [${mm.space}] ${mm.childTable}.${mm.childColumn} -> ${mm.parentTable}.${mm.parentColumn}  matched ${mm.matched}/${mm.childRowsChecked}`);
}
line(`  tombstones recorded: ${v1.deletionEvidence.length}; cascaded: ${v1.cascade.length}`);

h('6. Stale publisher is refused');
const oldLease = issueLease(state, dsId, { workerId: 'worker-legacy' });
line(`  lease issued at epoch ${oldLease.epoch}, rev ${oldLease.mappingRevision}`);
const m2 = startMigration(state, dsId, { mode: PACKAGE_MODES.REPLACEMENT });
for (const c of m2.requiredConsumerIds) {
  acknowledgeMigration(state, m2.id, { consumerId: c, revision: m2.mappingRevision, plan: m2.planHash });
}
const { version: v2 } = commitMigration(state, m2.id);
line(`  replacement package v${v2.versionNo} committed at epoch ${v2.epoch}`);
line(`  legacy lease status: ${oldLease.status}`);
try {
  publishFromWorker(state, dsId, { leaseId: oldLease.id });
} catch (err) {
  line(`  legacy publish refused: ${err.code} — ${err.message}`);
}

h('7. Roll back after commit');
const { rollbackVersion } = revokeMigration(state, m2.id, { reason: 'consumer regression' });
line(`  rollback version v${rollbackVersion.versionNo} published at epoch ${rollbackVersion.epoch}, mode ${rollbackVersion.mode}`);
line(`  rollback integrity: ${rollbackVersion.evidence.ok ? 'join-complete' : 'FAILED'}`);
line(`  national_id still masked-only: ${rollbackVersion.tables.dim_customer.every((r) => /^mk_/.test(r.national_id))}`);

h('8. Summary');
for (const v of state.versions) {
  line(`  v${v.versionNo}  ${v.status.padEnd(12)} ${v.mode.padEnd(12)} rev ${v.mappingRevision}  epoch ${v.epoch}  integrity ${v.evidence.ok ? 'ok' : 'FAILED'}`);
}
line(`\n  current publication: epoch ${state.publication[dsId].epoch}, version ${state.versions.find((x) => x.id === state.publication[dsId].activeVersionId)?.versionNo}`);
