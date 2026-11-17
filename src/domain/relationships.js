/**
 * Relationship discovery.
 *
 * A relationship always has a *child* side (may repeat a key) and a *parent*
 * side (key must be unique). Direction comes from table role by default:
 *
 *   - a group with exactly one dimension table: every fact in the group is a
 *     child of that dimension
 *   - a group with facts but no dimension: the relation is ambiguous, so it
 *     must be declared explicitly in `dataset.references`
 *   - a declared reference always wins over auto-derivation and is the only way
 *     to express fact -> fact or dimension -> dimension edges
 *
 * This matters because a naive pairwise combination would call
 * `bridge_order_promo.order_id -> fact_orders.order_id` a relation whose
 * "parent" side repeats, and would then report false integrity failures on an
 * otherwise correct version.
 *
 * Every table in a group must still move together: the group is the unit of
 * re-keying completeness.
 */

import { TABLE_ROLES, groupBindings } from './model.js';

function refId(ref) {
  return `${ref.group}:${ref.child.tableId}.${ref.child.field}->${ref.parent.tableId}.${ref.parent.field}`;
}

export function findRelationships(dataset) {
  const groups = new Map();
  for (const spec of dataset.keys) {
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group).push(spec);
  }

  const relations = [];
  const notes = [];
  const seen = new Set();

  const add = (rel) => {
    const id = refId(rel);
    if (seen.has(id)) return;
    seen.add(id);
    relations.push({ id, ...rel });
  };

  // Explicit references are authoritative.
  for (const ref of dataset.references || []) {
    add({ ...ref, source: 'declared' });
  }

  for (const [group, specs] of groups.entries()) {
    const byTable = new Map();
    for (const spec of specs) {
      const table = dataset.tables.find((t) => t.id === spec.tableId);
      if (!table) continue;
      if (!byTable.has(table.id)) byTable.set(table.id, { table, field: spec.field });
    }
    const members = [...byTable.values()];
    const parents = members.filter((m) => m.table.role === TABLE_ROLES.DIMENSION);
    const children = members.filter((m) => m.table.role === TABLE_ROLES.FACT);

    if (parents.length === 1) {
      for (const child of children) {
        add({
          group,
          child: { tableId: child.table.id, field: child.field },
          parent: { tableId: parents[0].table.id, field: parents[0].field },
          source: 'role',
        });
      }
      // Two dimensions in one group with no declaration: not auto-emitted.
      if (members.length - parents.length - children.length > 0) {
        notes.push({ group, note: 'multiple dimension members; no automatic parent chosen' });
      }
    } else if (parents.length === 0) {
      // A fact-to-fact group is ambiguous, but once at least one edge for the
      // group is declared the direction is known and no note is needed.
      const groupHasDeclared = relations.some((r) => r.group === group);
      if (!groupHasDeclared) {
        for (const child of children) {
          for (const other of children) {
            if (child.table.id === other.table.id) continue;
            notes.push({
              group,
              tableId: child.table.id,
              note: 'fact-to-fact group has no declared direction; add an explicit reference to verify it',
            });
          }
        }
      }
    } else {
      notes.push({ group, note: 'multiple dimension members; declare explicit references' });
    }
  }

  relations.sort((a, b) => a.id.localeCompare(b.id));
  return { relations, notes, groups: summarizeGroups(dataset) };
}

function summarizeGroups(dataset) {
  return [...new Set(dataset.keys.map((k) => k.group))]
    .sort()
    .map((group) => {
      const bindings = groupBindings(dataset, group).map((k) => ({ tableId: k.tableId, field: k.field }));
      return {
        group,
        tableIds: [...new Set(bindings.map((b) => b.tableId))].sort(),
        bindings: bindings.sort((a, b) => a.tableId.localeCompare(b.tableId)),
      };
    });
}

export { groupBindings };
