/**
 * Initial state + seeding.
 *
 * Seeding creates the fictional estate, registers the first mapping revision,
 * publishes a baseline version and records the two downstream consumers.
 * Baseline publication uses the real commit path so the seed is subject to the
 * same integrity checks as every later version.
 */

import { buildDataset } from '../domain/blueprint.js';
import { buildLateAdditions, buildLateDeletions, buildSourceRows } from '../domain/fixtures.js';
import { newId, nowIso } from '../domain/model.js';
import { ensureMapping } from './mappingRegistry.js';
import { compileVersion } from './compiler.js';
import { createVersion } from './migrations.js';
import { PACKAGE_MODES } from '../domain/model.js';

export const SCHEMA_VERSION = 1;

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: nowIso(),
    datasets: [],
    sources: {},
    mappings: [],
    migrations: [],
    versions: [],
    publication: {},
    consumers: [],
    leases: [],
    events: [],
    journal: [],
  };
}

export function seedState({ withPendingChanges = true } = {}) {
  const state = emptyState();
  const dataset = buildDataset();
  state.datasets.push(dataset);

  const snapshot = buildSourceRows();
  state.sources[dataset.id] = {
    snapshot,
    additions: withPendingChanges ? buildLateAdditions() : {},
    deletions: withPendingChanges ? buildLateDeletions() : {},
    loadedAt: nowIso(),
  };

  state.consumers.push(
    {
      id: 'consumer-revenue',
      name: 'Revenue analytics',
      role: 'consumer',
      subscriptions: ['fact_orders', 'dim_customer', 'dim_product', 'dim_region'],
      createdAt: nowIso(),
    },
    {
      id: 'consumer-promo',
      name: 'Promotion attribution',
      role: 'consumer',
      subscriptions: ['bridge_order_promo', 'dim_promotion', 'fact_orders'],
      createdAt: nowIso(),
    },
  );

  const mapping = ensureMapping(state, dataset.id);
  const compiled = compileVersion({
    dataset,
    mapping,
    snapshot,
    epoch: 0,
  });
  const version = createVersion(state, {
    datasetId: dataset.id,
    compiled,
    source: 'baseline',
    summary: 'Baseline publication (mapping revision 1)',
  });
  state.publication[dataset.id] = {
    epoch: 0,
    activeVersionId: version.id,
    activeMappingRevision: mapping.revision,
  };
  state.events.push({
    at: nowIso(),
    type: 'BASELINE_PUBLISHED',
    versionId: version.id,
  });
  return state;
}
