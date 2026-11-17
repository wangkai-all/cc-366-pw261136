/* Key Rotation Control — UI.
   Small, dependency-free client. All state comes from the server; every
   mutating action is a POST and re-fetches the overview. */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const state = {
  overview: null,
  datasetId: null,
  preview: null,
  busy: false,
  fencing: null,
  versionDetail: null,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.code = body?.error?.code || 'HTTP_ERROR';
    err.details = body?.error?.details;
    throw err;
  }
  return body;
}

function flash(message, kind = 'ok') {
  const ok = $('#global-ok');
  const error = $('#global-error');
  if (kind === 'error') {
    error.textContent = message;
    error.classList.remove('hidden');
    ok.classList.add('hidden');
  } else {
    ok.textContent = message;
    ok.classList.remove('hidden');
    error.classList.add('hidden');
  }
  clearTimeout(flash._t);
  flash._t = setTimeout(() => {
    ok.classList.add('hidden');
    error.classList.add('hidden');
  }, 7000);
}

async function guard(fn) {
  if (state.busy) return;
  state.busy = true;
  try {
    await fn();
  } catch (err) {
    flash(`${err.code}: ${err.message}${err.details ? ` — ${JSON.stringify(err.details)}` : ''}`, 'error');
  } finally {
    state.busy = false;
    await refresh({ quiet: true });
  }
}

async function refresh({ quiet = false } = {}) {
  const overview = await api('/api/overview');
  state.overview = overview;
  const ds = overview.datasets[0];
  state.datasetId = ds?.id || null;
  if (!quiet) flash('Refreshed');
  render();
}

function currentDataset() {
  return state.overview?.datasets?.[0] || null;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ---------- rendering ---------- */

function render() {
  const ds = currentDataset();
  if (!ds) return;
  $('#dataset-line').textContent = ds.name;
  $('#epoch-pill').textContent = `epoch ${ds.publication.epoch}`;
  $('#mapping-pill').textContent = `mapping rev ${ds.publication.activeMappingRevision ?? '—'}`;
  $('#version-pill').textContent = ds.publication.activeVersionNo
    ? `version v${ds.publication.activeVersionNo}`
    : 'no version';

  renderEstate(ds);
  renderPlan(ds);
  renderPreviewForMode();
  renderMigration(ds);
  renderConsumers(ds);
  renderEvidence(ds);
  renderFencing(ds);
  renderVersions(ds);
}

function modeTag(mode) {
  return el('span', { class: `tag ${mode}` }, mode === 'dual' ? 'dual key' : 'replacement');
}

function renderEstate(ds) {
  const root = $('#estate');
  root.replaceChildren();
  const groups = groupByKey(ds);
  for (const group of groups) {
    const restricted = ds.rulings.byGroup?.[group.group]?.retainOldKey === false;
    const card = el(
      'div',
      { class: `group-card${restricted ? ' restricted' : ''}` },
      el(
        'h3',
        {},
        el('span', { class: 'mono' }, group.group),
        el('span', { class: `tag ${restricted ? 'replacement' : 'dual'}` }, restricted ? 'no old key' : 'dual'),
      ),
      el(
        'ul',
        {},
        group.tables.map((t) =>
          el(
            'li',
            {},
            el('span', { class: `dot ${t.role === 'fact' ? 'fact' : 'dim'}` }),
            el('span', { class: `tag ${t.role === 'fact' ? 'fact' : 'dim'}` }, t.role),
            el('span', {}, t.tableId),
            el('span', { class: 'mono muted' }, t.field),
          ),
        ),
      ),
    );
    root.append(card);
  }
}

function groupByKey(ds) {
  const byGroup = new Map();
  for (const spec of ds.keys) {
    if (!byGroup.has(spec.group)) byGroup.set(spec.group, []);
    const table = ds.tables.find((t) => t.id === spec.tableId);
    byGroup.get(spec.group).push({ tableId: spec.tableId, field: spec.field, role: table?.role || 'dimension' });
  }
  return [...byGroup.entries()]
    .map(([group, tables]) => ({ group, tables: tables.sort((a, b) => a.tableId.localeCompare(b.tableId)) }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

function renderPlan(ds) {
  const root = $('#plan');
  root.replaceChildren();
  const groups = ds.keys.reduce((acc, spec) => {
    if (!acc[spec.group]) acc[spec.group] = [];
    acc[spec.group].push(spec);
    return acc;
  }, {});

  // The plan table reflects the previewed mode if one exists, otherwise the
  // migration's mode, otherwise the current selector.
  const effectiveMode = state.preview?.mode || ds.openMigration?.mode || $('#preview-mode').value;

  const table = el('table', {},
    el('thead', {}, el('tr', {}, ['Key group', 'Tables', 'Mode', 'Key spaces'].map((h) => el('th', {}, h)))),
    el('tbody', {}, Object.entries(groups).map(([group, specs]) => {
      const restricted = ds.rulings.byGroup?.[group]?.retainOldKey === false;
      const mode = restricted ? 'replacement' : effectiveMode;
      const spaces = mode === 'dual' ? 'old + new' : 'new only';
      return el('tr', {},
        el('td', {}, el('span', { class: 'mono' }, group)),
        el('td', {}, specs.map((s) => el('span', { class: 'chip' }, `${s.tableId}.${s.field}`))),
        el('td', {}, modeTag(mode)),
        el('td', {}, spaces),
      );
    })),
  );
  root.append(el('div', { class: 'table-wrap' }, table));
  root.append(el('p', { class: 'muted' },
    'Restricted groups never emit the old value in any package, including rollbacks.'));
  if (effectiveMode === 'replacement') {
    root.append(el('p', { class: 'muted' },
      'Whole-version replacement: every table is republished with new keys only, in one atomic version.'));
  }
  renderPendingChanges(ds);
}

function renderPendingChanges(ds) {
  const root = $('#pending-changes');
  const select = $('#change-table');
  const current = select.value;
  select.replaceChildren(...ds.tables.map((t) => el('option', { value: t.id }, `${t.id} (${t.role})`)));
  if (current && [...select.options].some((o) => o.value === current)) select.value = current;

  const pc = ds.pendingChanges || { additions: [], deletions: [], deletionPolicy: 'tombstone' };
  root.replaceChildren();
  const additions = pc.additions.filter((a) => a.rows > 0);
  const deletions = pc.deletions.filter((d) => d.ids > 0);
  if (!additions.length && !deletions.length) {
    root.append(el('p', { class: 'muted' }, 'No pending source changes. The next commit publishes the current source as it stands.'));
    return;
  }
  root.append(el('p', { class: 'subtle' },
    `Pending at next commit (deletion policy: ${pc.deletionPolicy}):`));
  if (additions.length) {
    root.append(el('div', { class: 'row' },
      el('span', { class: 'tag dual' }, 'additions'),
      el('span', { class: 'muted' }, additions.map((a) => `${a.tableId} +${a.rows}`).join(', '))));
  }
  if (deletions.length) {
    root.append(el('div', { class: 'row' },
      el('span', { class: 'tag replacement' }, 'deletions'),
      el('span', { class: 'muted' },
        deletions.map((d) => `${d.tableId} ${d.ids}`).join(', ')
        + (pc.deletionPolicy === 'purge' ? ' — rows are purged and children cascade' : ' — rows stay as tombstones'))));
  }
}

function renderPreviewForMode() {
  const sel = $('#preview-mode');
  if (state.preview && sel.value !== state.preview.mode) sel.value = state.preview.mode;
}

function renderMigration(ds) {
  const root = $('#migration');
  root.replaceChildren();
  const m = ds.openMigration || ds.latestMigration;
  const startBtn = $('#start-btn');
  const revokeBtn = $('#revoke-btn');
  const commitBtn = $('#commit-btn');
  startBtn.disabled = Boolean(ds.openMigration);
  revokeBtn.disabled = !m || !['AWAITING_ACKS', 'COMMITTED'].includes(m.phase);
  commitBtn.disabled = !m || m.phase !== 'AWAITING_ACKS' || m.pendingConsumerIds.length > 0;

  if (!m) {
    root.append(el('p', { class: 'muted' }, 'No migration has been started for this estate.'));
    return;
  }

  const steps = [
    { key: 'DRAFT', label: 'Draft' },
    { key: 'AWAITING_ACKS', label: 'Acks' },
    { key: 'COMMITTED', label: 'Commit' },
  ];
  const order = ['DRAFT', 'AWAITING_ACKS', 'COMMITTED'];
  const at = order.indexOf(m.phase === 'ROLLED_BACK' ? 'AWAITING_ACKS' : m.phase);
  const track = el('div', { class: 'phase-track' },
    steps.map((s, i) => el('span', {
      class: `phase-step ${m.phase === 'COMMITTED' && i <= 2 ? 'done' : i < at ? 'done' : i === at ? 'current' : ''}`,
    })),
  );

  root.append(
    el('div', { class: 'row spread' },
      el('strong', {}, `Phase: ${m.phase}`),
      modeTag(m.mode),
    ),
    track,
    el('div', { class: 'phase-labels' }, steps.map((s) => el('span', {}, s.label))),
    el('div', { class: 'row' },
      el('span', { class: 'pill' }, `rev ${m.mappingRevision}`),
      el('span', { class: 'pill' }, `plan ${m.planHash}`),
      m.phase === 'AWAITING_ACKS' ? el('span', { class: 'pill' }, `deadline ${fmtTime(m.ackDeadline)}`) : null,
      el('span', { class: 'pill' }, `created ${fmtTime(m.createdAt)}`),
    ),
  );

  if (m.pendingConsumerIds.length && m.phase === 'AWAITING_ACKS') {
    root.append(el('div', { class: 'note' },
      `Waiting on: ${m.pendingConsumerIds.join(', ')}. Commit is blocked until every required consumer acknowledges this exact plan.`));
  }
  if (m.phase === 'ROLLED_BACK') {
    root.append(el('div', { class: 'note' },
      `Rolled back${m.revocation?.afterCommit ? ' after commit (a complete rollback version was published)' : ' before commit (staging revision retired; nothing was published)'}. ${m.revocation?.reason || ''}`));
  }
  if (m.commit) {
    const c = m.commit.integrity;
    root.append(el('div', { class: 'stats' },
      stat(c?.relationChecks ?? '—', 'relationship checks'),
      stat(c?.spaces?.join(' + ') || '—', 'key spaces verified'),
      stat(m.commit.stats ? Object.values(m.commit.stats).reduce((a, s) => a + s.rows, 0) : '—', 'rows published'),
      stat(m.commit.epoch, 'epoch'),
    ));
  }

  root.append(el('h3', {}, 'History'));
  root.append(el('ul', { class: 'mig-history' },
    m.history.slice().reverse().map((h) =>
      el('li', {},
        el('span', { class: 't' }, fmtTime(h.at)),
        el('span', { class: 'mono' }, h.event),
        el('span', {}, h.detail),
      )),
  ));

  const preview = ds.openMigration?.preview || m.preview;
  if (preview?.pendingAdditions?.length || preview?.pendingDeletions?.length) {
    root.append(el('h3', {}, 'Pending source changes at commit'));
    if (preview.pendingAdditions?.length) {
      root.append(el('p', { class: 'subtle' },
        `Late additions: ${preview.pendingAdditions.map((a) => `${a.tableId} +${a.rows}`).join(', ')}`));
    }
    if (preview.pendingDeletions?.length) {
      root.append(el('p', { class: 'subtle' },
        `Deletions: ${preview.pendingDeletions.map((d) => `${d.tableId} ${d.requested} (${d.decision}, ${d.evidence} evidenced${d.cascaded ? `, ${d.cascaded} cascaded` : ''})`).join(', ')}`));
    }
  }
}

function stat(value, key) {
  return el('div', { class: 'stat' }, el('div', { class: 'v' }, String(value)), el('div', { class: 'k' }, key));
}

function renderConsumers(ds) {
  const root = $('#consumers');
  root.replaceChildren();
  const m = ds.openMigration;
  for (const c of ds.consumers) {
    const ack = m?.acks?.[c.id] || null;
    const required = m?.requiredConsumerIds?.includes(c.id);
    const pending = required && !ack;
    const card = el('div', { class: `consumer${pending ? ' unacked' : ''}` },
      el('div', { class: 'row spread' },
        el('strong', {}, c.name),
        !m ? el('span', { class: 'tag' }, 'idle')
          : !required ? el('span', { class: 'tag' }, 'unaffected')
            : ack ? el('span', { class: `tag ${ack.late ? 'pending' : 'ok'}` }, ack.late ? 'acked late' : 'acked')
              : el('span', { class: 'tag pending' }, 'waiting'),
      ),
      el('div', { class: 'subs' }, c.subscriptions.map((s) => el('span', { class: 'chip' }, s))),
      ack ? el('p', { class: 'muted' }, `at ${fmtTime(ack.at)}${ack.note ? ` — “${ack.note}”` : ''}`) : null,
      pending
        ? el('div', { class: 'row' },
            el('button', { class: 'btn sm primary', type: 'button', onclick: () => ackConsumer(c.id) }, 'Acknowledge now'),
            el('button', { class: 'btn sm', type: 'button', onclick: () => ackConsumerLate(c.id) }, 'Record earlier confirmation…'),
          )
        : m?.phase === 'AWAITING_ACKS' && ack
          ? el('div', { class: 'row' },
              el('button', { class: 'btn sm danger', type: 'button', onclick: () => withdrawConsumer(c.id) }, 'Withdraw ack'),
            )
          : null,
    );
    root.append(card);
  }
  if (!ds.consumers.length) root.append(el('p', { class: 'muted' }, 'No consumers registered.'));
}

function renderEvidence(ds) {
  const root = $('#evidence');
  const activeId = ds.publication.activeVersionId;
  if (!activeId) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No active version.'));
    return;
  }
  if (state.versionDetail?.id !== activeId) {
    root.replaceChildren(el('p', { class: 'muted' }, 'Loading evidence…'));
    api(`/api/versions/${activeId}`)
      .then((detail) => {
        state.versionDetail = detail;
        renderEvidence(currentDataset());
      })
      .catch(() => {});
    return;
  }
  const v = state.versionDetail;
  const integ = v.evidence;
  root.replaceChildren();
  root.append(
    el('div', { class: 'row spread' },
      el('div', {},
        el('strong', {}, `Version v${v.versionNo}`),
        el('span', { class: 'version-meta' }, ` · ${v.mode} · epoch ${v.epoch} · mapping rev ${v.mappingRevision}`),
      ),
      el('span', { class: `badge ${integ?.ok ? '' : 'bad'}` }, integ?.ok ? 'join-complete' : 'failed'),
    ),
    el('div', { class: 'stats' },
      stat(integ?.checkedRelations ?? 0, 'relationships'),
      stat(integ?.relationChecks ?? 0, 'checks (relation × key space)'),
      stat(integ?.spaces?.join(' + ') || '—', 'key spaces'),
      stat(integ?.violations?.length ?? 0, 'violations'),
    ),
    el('p', { class: 'subtle' },
      'Each row below is one relationship checked in one key space. “Matched” counts child rows whose key resolved on the parent side.'),
  );

  const matches = integ?.matches || [];
  if (!matches.length) {
    root.append(el('p', { class: 'muted' }, 'No relationship checks recorded.'));
  } else {
    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table', {},
      el('thead', {}, el('tr', {}, ['Relationship', 'Key space', 'Child rows', 'Matched', 'Orphans', 'Parent keys', 'Result'].map((h) => el('th', {}, h)))),
      el('tbody', {}, matches.map((mm) =>
        el('tr', {},
          el('td', {}, el('span', { class: 'rel' }, `${mm.childTable}.${mm.childColumn} → ${mm.parentTable}.${mm.parentColumn}`)),
          el('td', {}, el('span', { class: `tag ${mm.space === 'new' ? 'dual' : ''}` }, mm.space === 'new' ? 'new (masked)' : 'old')),
          el('td', { class: 'num' }, mm.childRowsChecked),
          el('td', { class: 'num' }, mm.matched),
          el('td', { class: 'num' }, mm.orphans),
          el('td', { class: 'num' }, mm.distinctParentValues),
          el('td', {}, el('span', { class: `badge ${mm.ok ? '' : 'bad'}` }, mm.ok ? 'ok' : 'fail')),
        )),
      ),
    );
    wrap.append(table);
    root.append(wrap);
  }

  if (integ?.violations?.length) {
    root.append(el('h3', {}, 'Violations'));
    root.append(el('div', { class: 'checks' }, integ.violations.map((vv) =>
      el('div', { class: 'check' },
        el('span', { class: 'badge bad' }, vv.kind),
        el('span', { class: 'rel' }, `${vv.relationId} · ${vv.space} · ${vv.count} rows`),
        el('span', { class: 'muted' }, JSON.stringify(vv.examples?.slice(0, 3) || [])),
      ))));
  }

  const deletions = v.deletionEvidence || [];
  if (deletions.length) {
    root.append(el('h3', {}, 'Deletion evidence'));
    root.append(el('p', { class: 'subtle' },
      `Policy: ${ds.rulings.deletionPolicy}. A tombstoned row stays in the package so surviving children still resolve, and is excluded from referential checks as a child; a purged row is removed, its dependents cascade, and only salted fingerprints remain.`));
    root.append(el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {}, ['Table', 'Record', 'Decision', 'Fingerprint'].map((h) => el('th', {}, h)))),
        el('tbody', {}, deletions.map((d) =>
          el('tr', {},
            el('td', {}, d.tableId),
            el('td', { class: 'mono' }, d.recordId || d.recordIdFingerprint),
            el('td', {}, el('span', { class: 'tag' }, d.decision)),
            el('td', { class: 'mono' }, String(d.fingerprint || '').slice(0, 16)),
          ))),
      )));
  }

  root.append(el('div', { class: 'row' },
    el('button', { class: 'btn sm', type: 'button', onclick: () => showRows(v.id) }, 'Browse tables'),
    el('a', { class: 'btn sm', href: `/api/versions/${v.id}/export`, download: '' }, 'Download evidence bundle'),
    el('button', { class: 'btn sm', type: 'button', onclick: () => recheck(v.id) }, 'Re-verify now'),
  ));
}

function renderFencing(ds) {
  const root = $('#fencing');
  root.replaceChildren();
  root.append(el('p', { class: 'subtle' },
    `Current publication fence: epoch ${ds.publication.epoch}, mapping revision ${ds.publication.activeMappingRevision ?? '—'}.`));

  const lease = state.fencing;
  if (lease) {
    root.append(el('div', { class: 'row' },
      el('span', { class: 'pill' }, `lease ${lease.id}`),
      el('span', { class: 'pill' }, `epoch ${lease.epoch}`),
      el('span', { class: 'pill' }, `rev ${lease.mappingRevision}`),
      el('span', { class: `tag ${lease.status === 'ACTIVE' ? 'ok' : 'bad'}` }, lease.status),
    ));
    root.append(el('div', { class: 'row' },
      el('button', { class: 'btn sm', type: 'button', onclick: () => workerPublish(lease) }, 'Publish from this worker'),
      el('button', { class: 'btn sm', type: 'button', onclick: () => { state.fencing = null; renderFencing(currentDataset()); } }, 'Clear'),
    ));
  }

  const leases = ds.leases || [];
  if (leases.length) {
    const wrap = el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {}, ['Worker', 'Epoch', 'Rev', 'Status', 'Issued', 'Reason'].map((h) => el('th', {}, h)))),
        el('tbody', {}, leases.map((l) =>
          el('tr', {},
            el('td', { class: 'mono' }, l.workerId),
            el('td', { class: 'num' }, l.epoch),
            el('td', { class: 'num' }, l.mappingRevision),
            el('td', {}, el('span', { class: `tag ${l.status === 'ACTIVE' ? 'ok' : l.status === 'EXPIRED' ? 'bad' : ''}` }, l.status)),
            el('td', {}, fmtTime(l.issuedAt)),
            el('td', { class: 'muted' }, l.reason || '—'),
          ))),
      ));
    root.append(wrap);
  } else {
    root.append(el('p', { class: 'muted' }, 'No worker leases issued yet.'));
  }
}

function renderVersions(ds) {
  const root = $('#versions');
  root.replaceChildren();
  if (!ds.versions.length) {
    root.append(el('p', { class: 'muted' }, 'No versions.'));
    return;
  }
  for (const v of ds.versions) {
    root.append(el('div', { class: `version-row${v.status === 'ACTIVE' ? ' active' : ''}` },
      el('span', { class: 'version-no' }, `v${v.versionNo}`),
      el('div', {},
        el('div', { class: 'row' },
          el('span', { class: `tag ${v.status === 'ACTIVE' ? 'ok' : ''}` }, v.status),
          modeTag(v.mode),
          el('span', { class: `badge ${v.integrityOk ? '' : 'bad'}` }, v.integrityOk ? 'verified' : 'failed'),
        ),
        el('div', { class: 'version-meta' },
          `${v.source} · rev ${v.mappingRevision} · epoch ${v.epoch} · ${fmtTime(v.createdAt)}${v.supersededBy ? ` · superseded by ${v.supersededBy}` : ''}${v.rollbackOfVersionId ? ` · rollback of ${v.rollbackOfVersionId}` : ''}`),
      ),
      el('div', { class: 'row' },
        el('a', { class: 'btn sm', href: `/api/versions/${v.id}/export`, download: '' }, 'Download'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => showRows(v.id) }, 'Rows'),
      ),
    ));
  }
}

/* ---------- actions ---------- */

async function runPreview() {
  const mode = $('#preview-mode').value;
  await guard(async () => {
    const preview = await api(`/api/datasets/${state.datasetId}/preview?mode=${encodeURIComponent(mode)}`);
    state.preview = preview;
    renderPreviewPanel(preview);
    renderPlan(currentDataset());
    flash(`Preview complete: ${preview.integrity.checkedRelations} relationships, ${preview.affectedConsumers.length} consumers affected.`);
  });
}

function renderPreviewPanel(preview) {
  const root = $('#preview');
  root.replaceChildren();
  root.append(
    el('div', { class: 'row' },
      el('span', { class: `badge ${preview.integrity.ok ? '' : 'bad'}` }, preview.integrity.ok ? 'trial compile join-complete' : 'trial compile FAILED'),
      el('span', { class: 'pill' }, `plan ${preview.planHash}`),
      el('span', { class: 'pill' }, preview.mode),
    ),
    el('div', { class: 'stats' },
      stat(preview.affectedTables.length, 'tables move together'),
      stat(preview.affectedConsumers.length, 'consumers affected'),
      stat(preview.integrity.relationChecks, 'join checks passed'),
      stat(Object.values(preview.stats).reduce((a, s) => a + s.rows, 0), 'rows in package'),
    ),
  );

  if (preview.restrictedGroups.length) {
    root.append(el('div', { class: 'note' },
      `Restricted key groups: ${preview.restrictedGroups.join(', ')}. These emit the new key only — no dual-key transition is possible for them in any package.`));
  }

  if (preview.pendingAdditions.length) {
    root.append(el('h3', {}, 'Late additions included'));
    root.append(el('p', { class: 'subtle' },
      preview.pendingAdditions.map((a) => `${a.tableId}: +${a.rows} row(s)`).join(' · ') +
      ' — re-keyed in this same version so joins stay complete.'));
  }
  if (preview.pendingDeletions.length) {
    root.append(el('h3', {}, 'Deletions applied'));
    root.append(el('p', { class: 'subtle' },
      preview.pendingDeletions.map((d) =>
        `${d.tableId}: ${d.requested} requested, ${d.decision}, ${d.evidence} evidenced${d.cascaded ? `, ${d.cascaded} cascaded` : ''}`).join(' · ')));
  }

  if (preview.sample) {
    root.append(el('h3', {}, 'Worked join example (new key space)'));
    const s = preview.sample;
    root.append(el('div', { class: 'group-card' },
      el('p', { class: 'subtle' }, `${s.relationId} · group ${s.group}`),
      el('div', { class: 'table-wrap', style: 'margin-top:.4rem' },
        el('table', {},
          el('thead', {}, el('tr', {}, ['Side', 'Record', 'Old key', 'New key', 'Resolves'].map((h) => el('th', {}, h))),
          ),
          el('tbody', {},
            el('tr', {},
              el('td', {}, s.child.tableId),
              el('td', { class: 'mono' }, s.child.recordId),
              el('td', { class: 'mono key-old' }, s.child.oldValue),
              el('td', { class: 'mono key-masked' }, s.child.newValue),
              el('td', {}, el('span', { class: `badge ${s.resolved ? '' : 'bad'}` }, s.resolved ? 'matched' : 'orphan')),
            ),
            s.parent
              ? el('tr', {},
                  el('td', {}, s.parent.tableId),
                  el('td', { class: 'mono' }, s.parent.recordId),
                  el('td', { class: 'mono key-old' }, s.parent.oldValue),
                  el('td', { class: 'mono key-masked' }, s.parent.newValue),
                  el('td', {}, el('span', { class: 'badge' }, 'parent')),
                )
              : null,
          ),
        ),
      ),
    ));
  }

  root.append(el('h3', {}, 'Affected consumers'));
  if (!preview.affectedConsumers.length) {
    root.append(el('p', { class: 'muted' }, 'None — no consumer subscribes to a table in this plan.'));
  } else {
    root.append(el('div', { class: 'checks' }, preview.affectedConsumers.map((c) =>
      el('div', { class: 'check' },
        el('span', { class: 'tag pending' }, 'must ack'),
        el('span', {}, `${c.name} — overlaps ${c.overlappingTables.join(', ')}`),
        el('span', { class: 'muted' }, c.subscriptions.join(', ')),
      ))));
  }

  if (preview.notes?.length) {
    root.append(el('h3', {}, 'Relationship notes'));
    for (const note of preview.notes) {
      root.append(el('p', { class: 'muted' }, `${note.group}: ${note.note}`));
    }
  }
}

async function startMigration() {
  const mode = $('#preview-mode').value;
  await guard(async () => {
    const m = await api(`/api/datasets/${state.datasetId}/migrations`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
    flash(`Migration started in ${m.phase}; ${m.pendingConsumerIds.length} consumer(s) must acknowledge.`);
  });
}

async function ackConsumer(consumerId) {
  const m = currentDataset()?.openMigration;
  if (!m) return;
  await guard(async () => {
    const ack = await api(`/api/migrations/${m.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({
        consumerId,
        note: 'Confirmed exact plan hash in the console.',
        revision: m.mappingRevision,
        plan: m.planHash,
      }),
    });
    flash(`${consumerId} acknowledged revision ${m.mappingRevision}${ack.late ? ' (late)' : ''}.`);
  });
}

/**
 * A consumer confirmed out of band at some earlier time (e.g. a phone call or
 * ticket). Record that time so the audit trail is truthful: lateness is computed
 * against the confirmation time, not the moment the operator types it in.
 */
async function ackConsumerLate(consumerId) {
  const m = currentDataset()?.openMigration;
  if (!m) return;
  const input = window.prompt(
    `When did ${consumerId} confirm (ISO timestamp)?\nLeave blank to confirm now.`,
    new Date().toISOString(),
  );
  if (input === null) return;
  const iso = input.trim() || new Date().toISOString();
  await guard(async () => {
    const ack = await api(`/api/migrations/${m.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({
        consumerId,
        note: 'Confirmation received out of band; timestamp entered by operator.',
        revision: m.mappingRevision,
        plan: m.planHash,
        confirmationReceivedAt: iso,
      }),
    });
    flash(`${consumerId} confirmation recorded for ${new Date(ack.at).toLocaleString()}${ack.late ? ' — late against the deadline' : ''}.`);
  });
}

async function withdrawConsumer(consumerId) {
  const m = currentDataset()?.openMigration;
  if (!m) return;
  await guard(async () => {
    await api(`/api/migrations/${m.id}/withdraw`, {
      method: 'POST',
      body: JSON.stringify({ consumerId, note: 'Withdrawn from the console before commit.' }),
    });
    flash(`${consumerId} withdrew its acknowledgement. Commit is blocked again.`);
  });
}

async function commitMigration() {
  const m = currentDataset()?.openMigration;
  if (!m) return;
  await guard(async () => {
    const out = await api(`/api/migrations/${m.id}/commit`, { method: 'POST', body: JSON.stringify({}) });
    const c = out.version;
    flash(`Committed. Published v${c.versionNo} at epoch ${c.epoch}; ${c.integrity.relationChecks} join checks passed.`);
  });
}

async function revokeMigration() {
  const m = currentDataset()?.openMigration || currentDataset()?.latestMigration;
  if (!m) return;
  await guard(async () => {
    const out = await api(`/api/migrations/${m.id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Operator revoked from the console.' }),
    });
    flash(out.rollbackVersion
      ? `Rolled back after commit; published complete rollback version v${out.rollbackVersion.versionNo}.`
      : 'Revoked before commit; staged mapping revision retired and nothing was published.');
    state.fencing = null;
  });
}

async function issueLease() {
  await guard(async () => {
    const lease = await api(`/api/datasets/${state.datasetId}/leases`, {
      method: 'POST',
      body: JSON.stringify({ workerId: $('#worker-id').value || 'worker', note: 'issued from console' }),
    });
    state.fencing = lease;
    flash(`Lease ${lease.id} issued against epoch ${lease.epoch}, rev ${lease.mappingRevision}.`);
  });
}

async function workerPublish(lease) {
  await guard(async () => {
    const v = await api(`/api/datasets/${state.datasetId}/worker-publish`, {
      method: 'POST',
      body: JSON.stringify({ leaseId: lease.id, workerId: lease.workerId }),
    });
    state.fencing = null;
    flash(`Worker published v${v.versionNo}.`);
  });
}

async function recheck(versionId) {
  await guard(async () => {
    const out = await api(`/api/versions/${versionId}/integrity`);
    flash(out.recheck.ok
      ? `Re-verified from stored rows: ${out.recheck.relationChecks} checks, 0 violations.`
      : `Re-verification FAILED: ${out.recheck.violations.length} violation(s).`, out.recheck.ok ? 'ok' : 'error');
  });
}

/* ---------- row browser dialog ---------- */

async function showRows(versionId) {
  const dialog = $('#rows-dialog');
  const body = $('#rows-body');
  body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  dialog.showModal();
  const version = await api(`/api/versions/${versionId}`);
  const tableIds = Object.keys(version.tables);
  const select = el('select', {
    onchange: async () => loadTable(versionId, select.value),
  }, tableIds.map((t) => el('option', { value: t }, t)));
  body.replaceChildren(
    el('div', { class: 'row' },
      el('label', { class: 'field' }, el('span', {}, 'Table'), select),
      el('span', { class: 'pill' }, `v${version.versionNo}`),
      el('span', { class: 'pill' }, version.mode),
      el('span', { class: 'muted' }, `checksums: ${Object.keys(version.checksums).length} tables`),
      el('a', {
        class: 'btn sm',
        href: `/api/versions/${versionId}/table/${encodeURIComponent(select.value)}.csv`,
        download: '',
        id: 'csv-link',
      }, 'Download table CSV'),
    ),
    el('div', { id: 'rows-table', class: 'stack' }),
  );
  select.addEventListener('change', () => {
    const link = $('#csv-link');
    if (link) link.href = `/api/versions/${versionId}/table/${encodeURIComponent(select.value)}.csv`;
  });
  await loadTable(versionId, tableIds[0]);
}

async function loadTable(versionId, tableId) {
  const holder = $('#rows-table');
  holder.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  const data = await api(`/api/versions/${versionId}/table/${tableId}?limit=40`);
  const rows = data.rows;
  const cols = data.columns;
  const table = el('table', {},
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', {}, c)))),
    el('tbody', {}, rows.map((r) =>
      el('tr', { class: r._deleted ? 'deleted' : '' },
        cols.map((c) => {
          const v = r[c];
          const cls = c.endsWith('__masked') ? 'mono key-masked' : c === '_record_id' ? 'mono' : '';
          return el('td', { class: cls }, v === null || v === undefined ? '—' : String(v));
        })),
    )),
  );
  holder.replaceChildren(
    el('p', { class: 'subtle' }, `${data.total} rows; showing ${rows.length}. Masked columns are highlighted.`),
    el('div', { class: 'table-wrap' }, table),
  );
}

async function simulateAddition() {
  const tableId = $('#change-table').value;
  const ds = currentDataset();
  await guard(async () => {
    const out = await api(`/api/datasets/${ds.id}/changes`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'addition', tableId }),
    });
    state.preview = null;
    flash(`Recorded late addition ${out.rows.join(', ')} in ${out.tableId}. The next commit re-keys it with the rest of the version.`);
  });
}

async function simulateDeletion() {
  const tableId = $('#change-table').value;
  const ds = currentDataset();
  await guard(async () => {
    const out = await api(`/api/datasets/${ds.id}/changes`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'deletion', tableId }),
    });
    state.preview = null;
    flash(`Requested deletion of ${out.ids.join(', ')} from ${out.tableId}; the next commit applies the ${ds.pendingChanges.deletionPolicy} policy.`);
  });
}

async function resetDemo() {
  if (!window.confirm('Re-seed the fictional estate? All migrations, versions and leases in this instance are discarded.')) return;
  await guard(async () => {
    await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ withPendingChanges: true }) });
    state.preview = null;
    state.versionDetail = null;
    state.fencing = null;
    flash('Fictional estate re-seeded. Baseline published at epoch 0.');
  });
}

/* ---------- wiring ---------- */

$('#refresh-btn').addEventListener('click', () => refresh());
$('#reset-btn').addEventListener('click', () => resetDemo());
$('#preview-btn').addEventListener('click', () => runPreview());
$('#start-btn').addEventListener('click', () => startMigration());
$('#commit-btn').addEventListener('click', () => commitMigration());
$('#revoke-btn').addEventListener('click', () => revokeMigration());
$('#lease-btn').addEventListener('click', () => issueLease());
$('#add-change-btn').addEventListener('click', () => simulateAddition());
$('#del-change-btn').addEventListener('click', () => simulateDeletion());
$('#preview-mode').addEventListener('change', () => { state.preview = null; $('#preview').replaceChildren(); });
$('#rows-close').addEventListener('click', () => $('#rows-dialog').close());

refresh({ quiet: true });

// Keep the console fresh when a migration is mid-flight so a late ack from
// another operator shows up without a manual refresh.
setInterval(async () => {
  const m = currentDataset()?.openMigration;
  if (!m || state.busy) return;
  try {
    await refresh({ quiet: true });
  } catch {
    /* transient; next tick retries */
  }
}, 15000);
