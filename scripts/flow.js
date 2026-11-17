import { seedState } from '../src/services/seed.js';
import {
  previewMigration,
  startMigration,
  acknowledgeMigration,
  withdrawAck,
  commitMigration,
  revokeMigration,
  issueLease,
  publishFromWorker,
} from '../src/services/migrations.js';
import { PACKAGE_MODES } from '../src/domain/model.js';

const state = seedState();
const dataset = state.datasets[0];
const dsId = dataset.id;

const preview = previewMigration(state, dsId, { mode: PACKAGE_MODES.DUAL });
console.log('preview affected', preview.affectedConsumers.map((c) => c.name));
console.log('preview restricted', preview.restrictedGroups);
console.log('preview integrity', preview.integrity.ok, preview.integrity.checkedRelations, preview.integrity.spaces);
console.log('pending additions', preview.pendingAdditions);
console.log('pending deletions', preview.pendingDeletions);

const mig = startMigration(state, dsId, { mode: PACKAGE_MODES.DUAL });
console.log('started', mig.phase, 'required', mig.requiredConsumerIds, 'rev', mig.mappingRevision);
acknowledgeMigration(state, mig.id, { consumerId: 'consumer-revenue', note: 'ok' });
try {
  commitMigration(state, mig.id);
} catch (e) {
  console.log('commit blocked:', e.code, e.message);
}
acknowledgeMigration(state, mig.id, { consumerId: 'consumer-promo', note: 'ok late' });
const { version } = commitMigration(state, mig.id);
console.log('committed', mig.phase, 'v', version.versionNo, 'epoch', version.epoch, 'mode', version.mode);
console.log('lease active?', state.leases.length);
const lease = issueLease(state, dsId, { workerId: 'old-worker' });
console.log('lease', lease.epoch, lease.mappingRevision, lease.status);

// now revoke (post-commit) -> publishes rollback
const { rollbackVersion } = revokeMigration(state, mig.id, { reason: 'testing rollback' });
console.log('rolled back; rollback version', rollbackVersion?.versionNo, 'epoch', rollbackVersion?.epoch);
console.log('old worker lease now:', state.leases.find((l) => l.id === lease.id)?.status);
try {
  publishFromWorker(state, dsId, { leaseId: 'nope' });
} catch (e) {
  console.log('bad lease:', e.code);
}
console.log('versions:');
for (const v of state.versions) console.log(' ', v.versionNo, v.status, v.mode, 'maprev', v.mappingRevision, 'int', v.evidence.ok);
