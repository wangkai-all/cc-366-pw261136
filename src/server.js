import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Store } from './storage/store.js';
import { seedState, SCHEMA_VERSION } from './services/seed.js';
import {
  DomainError,
  MIGRATION_PHASES,
  PACKAGE_MODES,
  canonicalJson,
  nowIso,
} from './domain/model.js';
import { findRelationships } from './domain/relationships.js';
import {
  acknowledgeMigration,
  commitMigration,
  issueLease,
  previewMigration,
  publishFromWorker,
  revokeMigration,
  startMigration,
  withdrawAck,
} from './services/migrations.js';
import { exportBundle } from './services/exportBundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_PATH = process.env.KEY_ROTATION_DB || join(ROOT, 'data', 'state.json');
const PORT = Number(process.env.PORT || 4173);

const store = new Store(DATA_PATH, () => seedState());

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new DomainError('BODY_TOO_LARGE', 'Request body exceeds 2 MB');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('BAD_JSON', 'Request body is not valid JSON');
  }
}

function datasetOr404(state, datasetId) {
  const dataset = state.datasets.find((d) => d.id === datasetId);
  if (!dataset) throw new DomainError('UNKNOWN_DATASET', `Unknown dataset ${datasetId}`, {}, 404);
  return dataset;
}

function migrationOr404(state, migrationId) {
  const migration = state.migrations.find((m) => m.id === migrationId);
  if (!migration) throw new DomainError('UNKNOWN_MIGRATION', `Unknown migration ${migrationId}`);
  return migration;
}

/** Compact view of the whole system for the UI. */
function overview(state) {
  const datasets = state.datasets.map((dataset) => {
    const { relations, notes } = findRelationships(dataset);
    const publication = state.publication[dataset.id] || { epoch: 0, activeVersionId: null, activeMappingRevision: null };
    const active = state.versions.find((v) => v.id === publication.activeVersionId) || null;
    const open = state.migrations
      .filter((m) => m.datasetId === dataset.id && [MIGRATION_PHASES.AWAITING_ACKS].includes(m.phase))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
    const latestMigration = state.migrations
      .filter((m) => m.datasetId === dataset.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
    return {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      publication: {
        epoch: publication.epoch,
        activeVersionId: publication.activeVersionId,
        activeVersionNo: active?.versionNo ?? null,
        activeMappingRevision: publication.activeMappingRevision,
        mode: active?.mode ?? null,
      },
      tables: dataset.tables.map((t) => ({
        id: t.id,
        name: t.name,
        role: t.role,
        joinKeys: t.joinKeys,
      })),
      keys: dataset.keys,
      rulings: dataset.rulings,
      relationships: relations,
      notes,
      consumers: state.consumers.map((c) => ({
        ...c,
        acknowledged: Boolean(open?.acks?.[c.id]),
        pendingAck: Boolean(open && open.requiredConsumerIds.includes(c.id) && !open.acks?.[c.id]),
        ack: open?.acks?.[c.id] || null,
      })),
      openMigration: open ? summarizeMigration(open) : null,
      latestMigration: latestMigration ? summarizeMigration(latestMigration) : null,
      versions: state.versions
        .filter((v) => v.datasetId === dataset.id)
        .map((v) => ({
          id: v.id,
          versionNo: v.versionNo,
          status: v.status,
          mode: v.mode,
          epoch: v.epoch,
          source: v.source,
          createdAt: v.createdAt,
          mappingRevision: v.mappingRevision,
          summary: v.summary,
          integrityOk: v.evidence?.ok ?? false,
          supersededBy: v.supersededBy ?? null,
          rollbackOfVersionId: v.rollbackOfVersionId ?? null,
        }))
        .sort((a, b) => b.versionNo - a.versionNo),
      leases: state.leases
        .filter((l) => l.datasetId === dataset.id)
        .map((l) => ({
          id: l.id,
          workerId: l.workerId,
          epoch: l.epoch,
          mappingRevision: l.mappingRevision,
          status: l.status,
          issuedAt: l.issuedAt,
          expiredAt: l.expiredAt ?? null,
          reason: l.reason ?? null,
        }))
        .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)),
      pendingChanges: {
        additions: Object.entries(state.sources[dataset.id]?.additions || {}).map(([tableId, rows]) => ({
          tableId,
          rows: rows.length,
        })),
        deletions: Object.entries(state.sources[dataset.id]?.deletions || {}).map(([tableId, ids]) => ({
          tableId,
          ids: ids.length,
        })),
        deletionPolicy: dataset.rulings.deletionPolicy,
      },
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
    datasets,
    events: state.events.slice(-60).reverse(),
    journal: (state.journal || []).slice(-40).reverse(),
  };
}

function summarizeMigration(m) {
  const pending = m.requiredConsumerIds.filter((id) => !m.acks[id]);
  return {
    id: m.id,
    datasetId: m.datasetId,
    phase: m.phase,
    mode: m.mode,
    mappingRevision: m.mappingRevision,
    baseMappingRevision: m.baseMappingRevision,
    planHash: m.planHash,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    ackDeadline: m.ackDeadline,
    requiredConsumerIds: m.requiredConsumerIds,
    pendingConsumerIds: pending,
    acks: m.acks,
    commit: m.commit || null,
    revocation: m.revocation || null,
    history: m.history,
    preview: m.preview,
  };
}

const routes = [];
function countChanges(feed) {
  return Object.values(feed || {}).reduce((n, v) => n + v.length, 0);
}

/**
 * Build a plausible late-arriving source row for a table.
 *
 * Key columns need care:
 *   - a parent-side key (a dimension's own key, or fact_orders.order_id for the
 *     bridge) must be unique, so it gets a fresh value
 *   - a child-side key must reference an existing parent, so it is copied from
 *     a live row
 * Everything else is copied from a representative source row.
 */
function synthesizeLateRow(dataset, source, table) {
  const existing = source.snapshot[table.id] || [];
  const template = existing[Math.floor(Math.random() * existing.length)] || {};
  const token = Math.random().toString(36).slice(2, 8).toUpperCase();
  const recordId = `LATE-${token}`;
  const row = { ...template, id: recordId };
  const specs = dataset.keys.filter((k) => k.tableId === table.id);
  for (const spec of specs) {
    // Is this binding the parent side of every relation it participates in?
    // A dimension table is always a parent. Within a fact-only group (order_id)
    // the declared reference decides.
    const isParentRole = table.role === 'dimension';
    const declaredAsParent = (dataset.references || []).some(
      (r) => r.group === spec.group && r.parent.tableId === table.id && r.parent.field === spec.field,
    );
    const isDeclaredChild = (dataset.references || []).some(
      (r) => r.group === spec.group && r.child.tableId === table.id && r.child.field === spec.field,
    );
    if (isParentRole || (declaredAsParent && !isDeclaredChild)) {
      // Fresh unique key in the same shape as the source values.
      row[spec.field] = reissueKey(template[spec.field], token);
    } else if (!template[spec.field]) {
      // No source value to reference; leave null so the row is a keyless orphan
      // rather than an invalid join. (Fixtures are well-formed; this is a guard.)
      row[spec.field] = null;
    }
  }
  return row;
}

function reissueKey(previous, token) {
  if (typeof previous !== 'string' || previous.length === 0) return `KEY-${token}`;
  const lastDash = previous.lastIndexOf('-');
  if (lastDash === -1) return `${previous}-${token}`;
  return `${previous.slice(0, lastDash + 1)}${token}`;
}

function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, regex, keys, handler });
}

route('POST', '/api/admin/reset', async ({ body }) => {
  return store.transact((state) => {
    const fresh = seedState({ withPendingChanges: body.withPendingChanges !== false });
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, fresh);
    state.events.push({ at: nowIso(), type: 'RESET', detail: 'Fictional estate re-seeded' });
    return { ok: true, datasets: state.datasets.map((d) => d.id) };
  }, { label: 'reset estate' });
});

route('GET', '/api/health', async () => ({ ok: true, schemaVersion: SCHEMA_VERSION, now: nowIso() }));

route('GET', '/api/overview', async () => {
  await store.load();
  return overview(store.state);
});

route('GET', '/api/datasets/:id/preview', async ({ params, query }) => {
  await store.load();
  const mode = query.get('mode') || PACKAGE_MODES.DUAL;
  const preview = previewMigration(store.state, params.id, { mode });
  return preview;
});

route('POST', '/api/datasets/:id/migrations', async ({ params, body }) => {
  return store.transact((state) => {
    const migration = startMigration(state, params.id, {
      mode: body.mode,
      ackDeadlineMinutes: body.ackDeadlineMinutes,
      actor: body.actor,
    });
    return summarizeMigration(migration);
  }, { label: 'start migration' });
});

route('GET', '/api/migrations/:id', async ({ params }) => {
  await store.load();
  return summarizeMigration(migrationOr404(store.state, params.id));
});

route('POST', '/api/migrations/:id/ack', async ({ params, body }) => {
  return store.transact(
    (state) =>
      acknowledgeMigration(state, params.id, {
        consumerId: body.consumerId,
        note: body.note,
        revision: body.revision ?? null,
        plan: body.plan ?? null,
        confirmationReceivedAt: body.confirmationReceivedAt ?? null,
      }),
    { label: 'acknowledge' },
  );
});

route('POST', '/api/migrations/:id/withdraw', async ({ params, body }) => {
  return store.transact(
    (state) => withdrawAck(state, params.id, { consumerId: body.consumerId, note: body.note }),
    { label: 'withdraw ack' },
  );
});

route('POST', '/api/migrations/:id/commit', async ({ params, body }) => {
  return store.transact(
    (state) => {
      const { migration, version } = commitMigration(state, params.id, { actor: body.actor });
      return { migration: summarizeMigration(migration), version: versionSummary(version) };
    },
    { label: 'commit migration' },
  );
});

route('POST', '/api/migrations/:id/revoke', async ({ params, body }) => {
  return store.transact(
    (state) => {
      const { migration, rollbackVersion } = revokeMigration(state, params.id, { reason: body.reason, actor: body.actor });
      return {
        migration: summarizeMigration(migration),
        rollbackVersion: rollbackVersion ? versionSummary(rollbackVersion) : null,
      };
    },
    { label: 'revoke migration' },
  );
});

route('POST', '/api/datasets/:id/changes', async ({ params, body }) => {
  return store.transact(
    (state) => {
      const dataset = datasetOr404(state, params.id);
      const source = state.sources[params.id];
      if (!source) throw new DomainError('NO_SOURCE', `No source estate for ${params.id}`);
      const kind = body.kind === 'deletion' ? 'deletion' : 'addition';
      const table = dataset.tables.find((t) => t.id === String(body.tableId));
      if (!table) throw new DomainError('UNKNOWN_TABLE', `Unknown table ${body.tableId}`);

      if (kind === 'addition') {
        // Synthesize a late-arriving record from the *source* snapshot (never
        // from a published row, which is masked). Copying masked values into the
        // source would key the record to a parent that no longer matches.
        let rows = Array.isArray(body.rows) ? body.rows : [];
        if (!rows.length) {
          rows = [synthesizeLateRow(dataset, source, table)];
        }
        source.additions[table.id] = [...(source.additions[table.id] || []), ...rows];
        state.events.push({ at: nowIso(), type: 'SOURCE_ADDITION', tableId: table.id, rows: rows.length });
        return { kind, tableId: table.id, rows: rows.map((r) => String(r.id)), additions: countChanges(source.additions), deletions: countChanges(source.deletions) };
      }

      // Deletion: take the oldest live source record in the table unless the
      // caller named one explicitly.
      let ids = (Array.isArray(body.ids) ? body.ids : [body.id]).filter(Boolean).map(String);
      if (!ids.length) {
        const pendingIds = new Set(source.deletions[table.id] || []);
        const candidate = (source.snapshot[table.id] || []).find((r) => !pendingIds.has(String(r.id)));
        if (!candidate) throw new DomainError('EMPTY_TABLE', `No source rows to delete in ${table.id}`);
        ids = [String(candidate.id)];
      }
      source.deletions[table.id] = [...new Set([...(source.deletions[table.id] || []), ...ids])];
      state.events.push({ at: nowIso(), type: 'SOURCE_DELETION', tableId: table.id, ids });
      return { kind, tableId: table.id, ids, additions: countChanges(source.additions), deletions: countChanges(source.deletions) };
    },
    { label: 'record source change' },
  );
});

route('POST', '/api/datasets/:id/leases', async ({ params, body }) => {
  return store.transact(
    (state) => issueLease(state, params.id, { workerId: body.workerId, note: body.note }),
    { label: 'issue lease' },
  );
});

route('POST', '/api/datasets/:id/worker-publish', async ({ params, body }) => {
  return store.transact(
    (state) => {
      const version = publishFromWorker(state, params.id, {
        leaseId: body.leaseId,
        workerId: body.workerId,
        payload: body.payload || null,
      });
      return versionSummary(version);
    },
    { label: 'worker publish' },
  );
});

route('GET', '/api/datasets/:id/versions', async ({ params }) => {
  await store.load();
  datasetOr404(store.state, params.id);
  return store.state.versions
    .filter((v) => v.datasetId === params.id)
    .map(versionSummary)
    .sort((a, b) => b.versionNo - a.versionNo);
});

route('GET', '/api/versions/:id', async ({ params }) => {
  await store.load();
  const version = store.state.versions.find((v) => v.id === params.id);
  if (!version) throw new DomainError('UNKNOWN_VERSION', `Unknown version ${params.id}`);
  return version;
});

route('GET', '/api/versions/:id/table/:tableId.csv', async ({ params, res }) => {
  await store.load();
  const version = store.state.versions.find((v) => v.id === params.id);
  if (!version) throw new DomainError('UNKNOWN_VERSION', `Unknown version ${params.id}`);
  const rows = version.tables[params.tableId];
  if (!rows) throw new DomainError('UNKNOWN_TABLE', `Unknown table ${params.tableId}`);
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${params.tableId}-v${version.versionNo}.csv"`,
    'cache-control': 'no-store',
  });
  res.end(`${csv}\n`);
  return undefined;
});

route('GET', '/api/versions/:id/table/:tableId', async ({ params, query }) => {
  await store.load();
  const version = store.state.versions.find((v) => v.id === params.id);
  if (!version) throw new DomainError('UNKNOWN_VERSION', `Unknown version ${params.id}`);
  const rows = version.tables[params.tableId];
  if (!rows) throw new DomainError('UNKNOWN_TABLE', `Unknown table ${params.tableId}`);
  const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 25));
  const offset = Math.max(0, Number(query.get('offset')) || 0);
  return {
    versionId: version.id,
    tableId: params.tableId,
    total: rows.length,
    offset,
    limit,
    rows: rows.slice(offset, offset + limit),
    columns: [...new Set(rows.flatMap((r) => Object.keys(r)))],
  };
});

route('GET', '/api/versions/:id/export', async ({ params, res }) => {
  await store.load();
  const version = store.state.versions.find((v) => v.id === params.id);
  if (!version) throw new DomainError('UNKNOWN_VERSION', `Unknown version ${params.id}`);
  const bundle = exportBundle(version, store.state);
  const filename = `key-rotation-v${version.versionNo}-${version.id}.json`;
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(bundle, null, 2));
  return undefined; // handler wrote the response
});

route('GET', '/api/versions/:id/integrity', async ({ params }) => {
  await store.load();
  const version = store.state.versions.find((v) => v.id === params.id);
  if (!version) throw new DomainError('UNKNOWN_VERSION', `Unknown version ${params.id}`);
  const { verifyVersion, keyPlan } = await import('./services/compiler.js');
  const dataset = datasetOr404(store.state, version.datasetId);
  const recheck = verifyVersion({
    dataset,
    tables: version.tables,
    plan: keyPlan(dataset),
    mode: version.mode,
  });
  return {
    stored: version.evidence,
    recheck,
    checksums: version.checksums,
    stable: recheck.ok,
  };
});

function versionSummary(v) {
  return {
    id: v.id,
    datasetId: v.datasetId,
    versionNo: v.versionNo,
    status: v.status,
    mode: v.mode,
    epoch: v.epoch,
    source: v.source,
    summary: v.summary,
    createdAt: v.createdAt,
    mappingRevision: v.mappingRevision,
    integrityOk: v.evidence?.ok ?? false,
    integrity: v.evidence ?? null,
    stats: v.stats,
    checksums: v.checksums,
    supersededBy: v.supersededBy ?? null,
    supersededAt: v.supersededAt ?? null,
    rollbackOfVersionId: v.rollbackOfVersionId ?? null,
    deletionEvidence: v.deletionEvidence ?? [],
    cascade: v.cascade ?? [],
  };
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(pathname, res) {
  const safe = pathname === '/' ? '/index.html' : pathname;
  if (safe.includes('..')) return text(res, 400, 'bad path');
  try {
    const body = await readFile(join(ROOT, 'public', safe));
    const ext = safe.slice(safe.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': STATIC_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname === '/app.js' || url.pathname === '/styles.css')) {
      if (await serveStatic(url.pathname, res)) return;
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const result = await r.handler({ params, query: url.searchParams, body, req, res });
      if (res.writableEnded) return;
      json(res, 200, result ?? { ok: true });
      return;
    }
    if (req.method === 'GET' && (await serveStatic(url.pathname, res))) return;
    json(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${url.pathname}` } });
  } catch (err) {
    const status = err instanceof DomainError ? (err.details?.status || 400) : 500;
    if (!(err instanceof DomainError)) {
      console.error('[unhandled]', err);
    }
    json(res, status, {
      error: {
        code: err.code || 'INTERNAL',
        message: err.message,
        details: err.details || undefined,
      },
    });
  }
});

if (process.env.KEY_ROTATION_SILENT !== '1') {
  await store.load();
  server.listen(PORT, () => {
    console.log(`key-rotation-control listening on http://localhost:${PORT}`);
    console.log(`state file: ${DATA_PATH}`);
  });
}

export { server, store };
