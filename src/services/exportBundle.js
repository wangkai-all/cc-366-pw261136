/**
 * Downloadable evidence bundle for a version.
 *
 * A consumer (or auditor) receives one self-describing JSON file containing:
 *   - the version's data for every table, as published
 *   - the key plan that governed emission
 *   - the integrity evidence captured at compile time
 *   - deletion/cascade evidence
 *   - checksums so the payload can be verified offline
 *
 * `verifyBundle` re-checks the checksums and the join evidence without any
 * access to server state, so the file is independently verifiable.
 */

import { canonicalJson } from '../domain/model.js';
import { findRelationships } from '../domain/relationships.js';
import { keyPlan, verifyVersion } from './compiler.js';

export function exportBundle(version, state) {
  const dataset = state.datasets.find((d) => d.id === version.datasetId);
  const { relations } = findRelationships(dataset);
  return {
    bundleFormat: 'key-rotation-evidence/v1',
    generatedAt: new Date().toISOString(),
    dataset: { id: dataset.id, name: dataset.name },
    version: {
      id: version.id,
      versionNo: version.versionNo,
      mode: version.mode,
      epoch: version.epoch,
      status: version.status,
      mappingRevision: version.mappingRevision,
      createdAt: version.createdAt,
      summary: version.summary,
      rollbackOfVersionId: version.rollbackOfVersionId ?? null,
    },
    plan: version.plan,
    // The relationship set travels with the file so the join rules can be
    // replayed offline without the server's dataset.
    relations,
    tables: version.tables,
    stats: version.stats,
    checksums: version.checksums,
    integrity: version.evidence,
    deletions: {
      policy: dataset.rulings.deletionPolicy,
      evidence: version.deletionEvidence,
      cascade: version.cascade,
    },
    rulings: dataset.rulings,
    verify: {
      how: 'Recompute sha256 of canonical JSON per table and compare to checksums; then replay the relationship rules in integrity.spaces.',
      canonicalJsonNote: 'Object keys sorted recursively; arrays keep order.',
    },
  };
}

/**
 * Offline verification of a downloaded bundle. Accepts the parsed JSON and
 * returns { ok, checksumResults, integrity, recordedIntegrity }.
 *
 * The join evidence is *recomputed* from the bundle's own tables rather than
 * trusted: the embedded `integrity` block is itself part of the payload, so a
 * tampered bundle could carry a clean-looking result. The recorded copy is
 * returned separately so a caller can show whether the two agree.
 */
export async function verifyBundle(bundle) {
  const { createHash } = await import('node:crypto');
  const checksumResults = {};
  let checksumsOk = true;
  for (const [tableId, expected] of Object.entries(bundle.checksums || {})) {
    const actual = createHash('sha256')
      .update(canonicalJson(bundle.tables[tableId] || []))
      .digest('hex')
      .slice(0, 20);
    const ok = actual === expected;
    if (!ok) checksumsOk = false;
    checksumResults[tableId] = { expected, actual, ok };
  }

  const relations = bundle.relations ?? [];
  const replay = verifyVersion({
    dataset: null,
    relations,
    tables: bundle.tables || {},
    plan: bundle.plan || {},
    mode: bundle.version?.mode,
  });
  return {
    ok: checksumsOk && replay.ok,
    checksumsOk,
    checksumResults,
    integrity: replay,
    recordedIntegrity: bundle.integrity,
  };
}

export { keyPlan, verifyVersion };
