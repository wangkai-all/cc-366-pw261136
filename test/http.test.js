import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBundle } from '../src/services/exportBundle.js';

let proc;
let base;
let dir;
const PORT = 4317;

function req(path, opts = {}) {
  return fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  }).then(async (r) => {
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  });
}

const post = (path, body = {}) => req(path, { method: 'POST', body: JSON.stringify(body) });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kr-http-'));
  proc = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), KEY_ROTATION_DB: join(dir, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  base = `http://127.0.0.1:${PORT}`;
});

after(async () => {
  proc?.kill('SIGTERM');
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('overview exposes the estate and consumers', async () => {
  const { status, body } = await req('/api/overview');
  assert.equal(status, 200);
  const ds = body.datasets[0];
  assert.equal(ds.tables.length, 6);
  assert.equal(ds.consumers.length, 2);
  assert.ok(ds.relationships.length >= 5, 'auto-discovered relationships');
  assert.equal(ds.publication.epoch, 0);
  assert.equal(ds.versions[0].versionNo, 1);
});

test('preview reports integrity and impact without publishing', async () => {
  const { status, body: ds } = await req('/api/overview');
  assert.equal(status, 200);
  const { status: s2, body } = await req(`/api/datasets/${ds.datasets[0].id}/preview?mode=dual`);
  assert.equal(s2, 200);
  assert.equal(body.integrity.ok, true);
  assert.equal(body.affectedConsumers.length, 2);
  assert.ok(body.restrictedGroups.includes('national_id'));
  assert.ok(body.stats.fact_orders.rows > 0);
});

test('full migration: start, chase one late ack, withdraw, re-ack, commit, verify, export', async () => {
  const { body: ov } = await req('/api/overview');
  const ds = ov.datasets[0];
  const dsId = ds.id;

  const start = await post(`/api/datasets/${dsId}/migrations`, { mode: 'dual' });
  assert.equal(start.status, 200);
  const mig = start.body;
  assert.equal(mig.phase, 'AWAITING_ACKS');
  assert.deepEqual(mig.pendingConsumerIds.sort(), ['consumer-promo', 'consumer-revenue']);

  // commit blocked
  const blocked = await post(`/api/migrations/${mig.id}/commit`);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'ACKS_PENDING');

  // one ack, withdraw it, ack again
  await post(`/api/migrations/${mig.id}/ack`, {
    consumerId: 'consumer-revenue',
    revision: mig.mappingRevision,
    plan: mig.planHash,
  });
  const w = await post(`/api/migrations/${mig.id}/withdraw`, { consumerId: 'consumer-revenue' });
  assert.equal(w.status, 200);
  await post(`/api/migrations/${mig.id}/ack`, {
    consumerId: 'consumer-revenue',
    revision: mig.mappingRevision,
    plan: mig.planHash,
  });

  // stale ack rejected over HTTP
  const stale = await post(`/api/migrations/${mig.id}/ack`, {
    consumerId: 'consumer-promo',
    revision: mig.mappingRevision - 1,
    plan: mig.planHash,
  });
  assert.equal(stale.status, 400);
  assert.equal(stale.body.error.code, 'STALE_ACK');

  // remaining consumer acknowledges late (deadline not yet passed -> on time)
  const ack = await post(`/api/migrations/${mig.id}/ack`, {
    consumerId: 'consumer-promo',
    revision: mig.mappingRevision,
    plan: mig.planHash,
    note: 'checked against staged plan',
  });
  assert.equal(ack.status, 200);

  const commit = await post(`/api/migrations/${mig.id}/commit`);
  assert.equal(commit.status, 200);
  const version = commit.body.version;
  assert.equal(version.integrityOk, true);
  assert.equal(version.epoch, 1);

  // export bundle, verify offline
  const exp = await req(`/api/versions/${version.id}/export`);
  assert.equal(exp.status, 200);
  const checked = await verifyBundle(exp.body);
  assert.equal(checked.ok, true, 'downloaded bundle self-verifies');
  assert.equal(Object.keys(checked.checksumResults).length, 6);

  // A tampered table fails checksum *and* the replayed join check. Re-sealing
  // the checksum must not launder the payload: the integrity block inside the
  // bundle is never trusted on its own.
  const { createHash } = await import('node:crypto');
  const { canonicalJson } = await import('../src/domain/model.js');
  const forged = structuredClone(exp.body);
  forged.tables.fact_orders[0].customer_id__masked = 'mk_000000000000000000000000';
  forged.checksums.fact_orders = createHash('sha256')
    .update(canonicalJson(forged.tables.fact_orders))
    .digest('hex')
    .slice(0, 20);
  forged.integrity = { ...forged.integrity, ok: true };
  const tampered = await verifyBundle(forged);
  assert.equal(tampered.checksumsOk, true, 'forged checksum matches the forged table');
  assert.equal(tampered.ok, false, 'replayed join check still catches the tamper');
  assert.ok(tampered.integrity.violations.some((v) => v.kind === 'ORPHAN_CHILD_KEY'));

  // re-verify integrity endpoint
  const re = await req(`/api/versions/${version.id}/integrity`);
  assert.equal(re.status, 200);
  assert.equal(re.body.recheck.ok, true);
  assert.equal(re.body.stable, true);

  // row browse
  const rows = await req(`/api/versions/${version.id}/table/dim_customer?limit=5`);
  assert.equal(rows.status, 200);
  assert.equal(rows.body.rows.length, 5);
  assert.ok(rows.body.columns.includes('customer_id__masked'));

  // and old keys are absent from the fact national id column
  const fact = await req(`/api/versions/${version.id}/table/fact_orders?limit=60`);
  for (const r of fact.body.rows) {
    assert.match(r.customer_national_id, /^mk_/);
  }
});

test('stale worker publish is refused after commit', async () => {
  const { body: ov } = await req('/api/overview');
  const dsId = ov.datasets[0].id;
  const oldLease = await post(`/api/datasets/${dsId}/leases`, { workerId: 'legacy-worker' });
  assert.equal(oldLease.status, 200);
  // A second migration advances the mapping/epoch.
  const start = await post(`/api/datasets/${dsId}/migrations`, { mode: 'replacement' });
  for (const c of start.body.requiredConsumerIds) {
    await post(`/api/migrations/${start.body.id}/ack`, {
      consumerId: c,
      revision: start.body.mappingRevision,
      plan: start.body.planHash,
    });
  }
  const commit = await post(`/api/migrations/${start.body.id}/commit`);
  assert.equal(commit.status, 200);

  const stale = await post(`/api/datasets/${dsId}/worker-publish`, { leaseId: oldLease.body.id });
  assert.equal(stale.status, 400);
  assert.equal(stale.body.error.code, 'LEASE_EXPIRED');

  // a fresh lease works
  const fresh = await post(`/api/datasets/${dsId}/leases`, { workerId: 'worker-new' });
  const pub = await post(`/api/datasets/${dsId}/worker-publish`, { leaseId: fresh.body.id, workerId: 'worker-new' });
  assert.equal(pub.status, 200);
});

test('revocation after commit publishes a rollback version', async () => {
  const { body: ov } = await req('/api/overview');
  const dsId = ov.datasets[0].id;
  const latest = ov.datasets[0].latestMigration;
  // The most recent migration is committed; roll it back.
  const rev = await post(`/api/migrations/${latest.id}/revoke`, { reason: 'operator rollback' });
  assert.equal(rev.status, 200);
  assert.ok(rev.body.rollbackVersion);
  assert.equal(rev.body.rollbackVersion.integrityOk, true);
  assert.equal(rev.body.migration.phase, 'ROLLED_BACK');

  const after = await req('/api/overview');
  assert.equal(after.body.datasets[0].publication.activeVersionId, rev.body.rollbackVersion.id);
  assert.ok(after.body.datasets[0].versions.some((v) => v.status === 'ROLLED_BACK'));
});

test('source changes can be recorded and the next commit re-keys them', async () => {
  const { body: ov0 } = await req('/api/overview');
  const dsId = ov0.datasets[0].id;
  const before = ov0.datasets[0].pendingChanges;
  const add = await post(`/api/datasets/${dsId}/changes`, { kind: 'addition', tableId: 'fact_orders' });
  assert.equal(add.status, 200);
  assert.equal(add.body.rows.length, 1);
  const del = await post(`/api/datasets/${dsId}/changes`, { kind: 'deletion', tableId: 'dim_region' });
  assert.equal(del.status, 200);
  assert.equal(del.body.ids.length, 1);

  const { body: ov1 } = await req('/api/overview');
  const pc = ov1.datasets[0].pendingChanges;
  const adds = (t) => pc.additions.find((a) => a.tableId === t)?.rows || 0;
  const dels = (t) => pc.deletions.find((d) => d.tableId === t)?.ids || 0;
  assert.equal(adds('fact_orders'), ((before.additions.find((a) => a.tableId === 'fact_orders')?.rows) || 0) + 1);
  assert.equal(dels('dim_region'), 1);

  // preview shows the new addition inside the same package
  const prev = await req(`/api/datasets/${dsId}/preview?mode=dual`);
  assert.equal(prev.body.integrity.ok, true);
  assert.ok(prev.body.pendingAdditions.some((a) => a.tableId === 'fact_orders'));

  // bad table rejected
  const bad = await post(`/api/datasets/${dsId}/changes`, { kind: 'addition', tableId: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'UNKNOWN_TABLE');
});

test('table rows download as CSV with masked columns', async () => {
  const { body: ov } = await req('/api/overview');
  const vid = ov.datasets[0].publication.activeVersionId;
  const res = await fetch(`${base}/api/versions/${vid}/table/dim_customer.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  const [header, ...rows] = csv.trim().split('\n');
  assert.ok(header.includes('customer_id__masked'));
  assert.ok(rows.length > 0);
  // the national-id group is replacement-only: its column holds the masked key
  const cols = header.split(',');
  const idx = cols.indexOf('national_id');
  for (const row of rows) {
    const cells = row.split(',');
    assert.match(cells[idx], /^mk_/);
  }
});

test('unknown routes and bad input are rejected with structured errors', async () => {
  assert.equal((await req('/api/nope')).status, 404);
  const bad = await post('/api/migrations/missing/ack', { consumerId: 'consumer-revenue' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'UNKNOWN_MIGRATION');
  const notRequired = await post('/api/migrations/nope/commit', {});
  assert.equal(notRequired.body.error.code, 'UNKNOWN_MIGRATION');
});

test('state survives a restart (durable store)', async () => {
  const beforeOv = (await req('/api/overview')).body;
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 600));
  proc = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), KEY_ROTATION_DB: join(dir, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('restart failed')), 8000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const afterOv = (await req('/api/overview')).body;
  const b = beforeOv.datasets[0];
  const a = afterOv.datasets[0];
  assert.equal(a.publication.activeVersionId, b.publication.activeVersionId);
  assert.equal(a.publication.epoch, b.publication.epoch);
  assert.ok(a.versions.length >= b.versions.length);
});
