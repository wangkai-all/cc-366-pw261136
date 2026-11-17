/**
 * Mapping registry.
 *
 * A mapping is a registered, versioned set of masking seeds. Every build is
 * stamped with the mapping revision that produced it. Publishing is fenced on
 * (dataset epoch, mapping revision): a process still holding an older revision
 * cannot publish a mapping that has been superseded. That is what stops an old
 * worker from republishing stale keys after a cut-over.
 */

import { randomBytes } from 'node:crypto';
import { DomainError, nowIso, newId } from '../domain/model.js';

export function ensureMapping(state, datasetId) {
  const existing = state.mappings.find((m) => m.datasetId === datasetId && m.status === 'ACTIVE');
  if (existing) return existing;
  const mapping = {
    id: newId('mp'),
    datasetId,
    revision: (state.mappings.filter((m) => m.datasetId === datasetId).at(-1)?.revision || 0) + 1,
    keySeed: randomBytes(32).toString('hex'),
    groupSeeds: {},
    status: 'ACTIVE',
    createdAt: nowIso(),
  };
  state.mappings.push(mapping);
  return mapping;
}

export function activeMapping(state, datasetId) {
  return state.mappings.find((m) => m.datasetId === datasetId && m.status === 'ACTIVE') || null;
}

export function mappingByRevision(state, datasetId, revision) {
  return state.mappings.find((m) => m.datasetId === datasetId && m.revision === revision) || null;
}

/**
 * Create the next mapping revision for a migration. The new revision is not
 * ACTIVE until the migration commits, so concurrent old processes keep using
 * the previous revision until the cut-over is atomic.
 */
export function stageMappingRevision(state, datasetId) {
  const current = activeMapping(state, datasetId);
  if (!current) ensureMapping(state, datasetId);
  const revisions = state.mappings.filter((m) => m.datasetId === datasetId);
  const nextRevision = Math.max(...revisions.map((m) => m.revision)) + 1;
  const mapping = {
    id: newId('mp'),
    datasetId,
    revision: nextRevision,
    keySeed: randomBytes(32).toString('hex'),
    groupSeeds: {},
    status: 'STAGED',
    createdAt: nowIso(),
    basedOn: activeMapping(state, datasetId)?.revision ?? null,
  };
  state.mappings.push(mapping);
  return mapping;
}

export function activateMapping(state, datasetId, mappingId) {
  for (const m of state.mappings) {
    if (m.datasetId !== datasetId) continue;
    if (m.id === mappingId) m.status = 'ACTIVE';
    else if (m.status === 'ACTIVE') m.status = 'SUPERSEDED';
  }
}

export function retireMapping(state, datasetId, mappingId, reason = 'superseded') {
  const m = state.mappings.find((x) => x.id === mappingId && x.datasetId === datasetId);
  if (m) {
    m.status = 'RETIRED';
    m.retiredAt = nowIso();
    m.retireReason = reason;
  }
  return m;
}

/**
 * Publication fencing. A publisher presents the dataset epoch it last observed
 * and the mapping revision it built with. Publication is accepted only if both
 * still match the registry. This makes stale-worker publication a hard error,
 * not a race.
 */
export function assertPublisherCurrent(state, datasetId, { expectedEpoch, mappingRevision }) {
  const dataset = state.datasets.find((d) => d.id === datasetId);
  if (!dataset) throw new DomainError('UNKNOWN_DATASET', `Unknown dataset ${datasetId}`);
  if (typeof expectedEpoch !== 'number' || expectedEpoch !== state.publication[datasetId].epoch) {
    throw new DomainError(
      'STALE_PUBLISHER',
      'Publisher epoch is stale; another process already advanced this dataset',
      { expected: state.publication[datasetId].epoch, presented: expectedEpoch },
    );
  }
  const mapping = mappingByRevision(state, datasetId, mappingRevision);
  if (!mapping || mapping.status === 'SUPERSEDED' || mapping.status === 'RETIRED') {
    throw new DomainError(
      'STALE_MAPPING',
      'Publisher is using a superseded mapping revision',
      { presented: mappingRevision, active: activeMapping(state, datasetId)?.revision ?? null },
    );
  }
  return mapping;
}

export function datasetEpoch(state, datasetId) {
  return state.publication[datasetId]?.epoch ?? 0;
}
