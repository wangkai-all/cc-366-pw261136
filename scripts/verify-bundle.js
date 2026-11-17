#!/usr/bin/env node
/**
 * Offline verifier for a downloaded evidence bundle.
 *
 *   node scripts/verify-bundle.js path/to/bundle.json
 *
 * Exits 0 only when both hold:
 *   1. each table's sha256 (canonical JSON) matches the recorded checksum
 *   2. replaying the join rules over the bundle's own tables finds no orphan
 *      child key and no duplicated parent key, in every key space the bundle
 *      claims to emit
 *
 * Does not contact the server and does not need the source estate. The
 * integrity block stored inside the bundle is shown for comparison but is
 * never trusted on its own — it is part of the same payload a tamperer edits.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/domain/model.js';
import { verifyVersion } from '../src/services/compiler.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/verify-bundle.js <bundle.json>');
  process.exit(2);
}

const bundle = JSON.parse(await readFile(path, 'utf8'));
if (bundle.bundleFormat !== 'key-rotation-evidence/v1') {
  console.error(`unexpected bundleFormat: ${bundle.bundleFormat}`);
  process.exit(2);
}

let ok = true;
const lines = [];
for (const [tableId, expected] of Object.entries(bundle.checksums || {})) {
  const actual = createHash('sha256')
    .update(canonicalJson(bundle.tables[tableId] || []))
    .digest('hex')
    .slice(0, 20);
  const match = actual === expected;
  if (!match) ok = false;
  lines.push(`${match ? 'ok  ' : 'FAIL'} ${tableId.padEnd(22)} ${bundle.tables[tableId]?.length ?? 0} rows  ${actual}`);
}

// Recompute the join checks from the payload; do not trust the stored block.
const replayed = verifyVersion({
  dataset: null,
  relations: bundle.relations ?? [],
  tables: bundle.tables || {},
  plan: bundle.plan || {},
  mode: bundle.version?.mode,
});
if (!replayed.ok) ok = false;

const recorded = bundle.integrity || {};
const agrees = recorded.ok === replayed.ok
  && (recorded.relationChecks ?? -1) === replayed.relationChecks;
if (!agrees) ok = false;

console.log(`Bundle:   ${bundle.dataset?.name} v${bundle.version?.versionNo} (${bundle.version?.mode})`);
console.log(`Epoch:    ${bundle.version?.epoch}  mapping rev ${bundle.version?.mappingRevision}`);
console.log(`Tables:   ${Object.keys(bundle.tables || {}).length}`);
console.log('');
for (const line of lines) console.log(`  ${line}`);
console.log('');
console.log(`Integrity (replayed): ${replayed.ok ? 'ok' : 'FAILED'} — ${replayed.checkedRelations} relationships, `
  + `${replayed.relationChecks} checks, ${replayed.violations.length} violations, `
  + `spaces ${replayed.spaces.join('+')}`);
console.log(`Integrity (recorded): ${recorded.ok ? 'ok' : 'FAILED'} — ${agrees ? 'agrees with replay' : 'DISAGREES with replay'}`);
for (const check of replayed.matches) {
  if (!check.ok) console.log(`  FAIL ${check.relationId} [${check.space}] orphans=${check.orphans} duplicates=${check.duplicates}`);
}
for (const violation of replayed.violations) {
  console.log(`  FAIL ${violation.kind} ${violation.relationId} [${violation.space}] count=${violation.count}`);
}
console.log('');
console.log(ok ? 'VERIFIED' : 'VERIFICATION FAILED');
process.exit(ok ? 0 : 1);
