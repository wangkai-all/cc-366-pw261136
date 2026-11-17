# Key Rotation Control

A small, dependency-free data-processing application for a fictional retail
estate. It coordinates the **masked join-key rotation** of a set of fact and
dimension tables: a conversion service publishes versions, a mapping-registration
service stages the new key material, and two downstream consumers must be brought
across without ever seeing a version that is only half re-keyed.

```
npm start          # http://localhost:4173
npm test           # 33 unit + HTTP integration tests
npm run smoke      # terminal-only end-to-end walkthrough
```

The state file defaults to `data/state.json`. Override with
`KEY_ROTATION_DB=/path/to/state.json` and the port with `PORT`.

## The problem this solves

Six tables join on six shared key groups:

| Key group | Tables | Ruling |
|---|---|---|
| `customer_id` | `dim_customer`, `fact_orders` | may retain old key |
| `product_id` | `dim_product`, `fact_orders` | may retain old key |
| `region_id` | `dim_region`, `fact_orders` | may retain old key |
| `promo_id` | `dim_promotion`, `bridge_order_promo` | may retain old key |
| `order_id` | `fact_orders`, `bridge_order_promo` | may retain old key |
| `national_id` | `dim_customer.national_id`, `fact_orders.customer_national_id` | **must not retain old key** |

The last row is the hard case. Its ruling (`retainOldKey: false`) means no
consumer-facing package may contain the old value — not in a dual-key transition
package, not in a rollback. Because re-keying must stay join-complete, the whole
group moves in one step: the fact column `customer_national_id` and the dimension
column `national_id` both become the new masked key in the same version.

### Two invariants, enforced in code

1. **Join completeness.** A version is compiled from one source snapshot in one
   pass and then independently re-verified for every declared relationship, in
   every key space the version emits (`old` and/or `new`). The compiler refuses
   to return a version with an orphan child key or a duplicated parent key —
   see `src/services/compiler.js` → `verifyVersion`.
2. **No old-key leak for restricted groups.** For a `replacement` group the
   plain column holds the new key and `__masked` mirrors it; the compiler asserts
   that no emitted cell equals an old source value (see `compileVersion`).

## Choosing a transition shape

- **Dual-key transition** (`mode=dual`) keeps `<field>` (old) and adds
  `<field>__masked` (new). Use it when every group's ruling permits retention.
- **Whole-version replacement** (`mode=replacement`) publishes new keys only.

The emission plan is resolved *per group*, so a single version can carry dual
keys for five groups and a replacement column for `national_id`. The web UI
shows this as the “Emission plan”; rollbacks use the base version's mode.

## Lifecycle

```
preview ──▶ start ──▶ AWAITING_ACKS ──▶ commit ──▶ COMMITTED
                          │   ▲                         │
                 ack / late ack │ withdraw              │ revoke
                          ▼   │                         ▼
                        (blocked)                  ROLLED_BACK
```

- **Preview** trial-compiles the current source and reports affected
  relationships, affected consumers, restricted groups, and pending late
  additions/deletions. Nothing is written.
- **Start** stages a new mapping revision. The previous revision stays `ACTIVE`
  until commit, so running consumers are never stranded. Commit is blocked until
  every consumer that touches an affected table acknowledges the exact
  `(mappingRevision, planHash)` pair.
- **Acknowledgements** may arrive late (past the deadline) and are flagged. A
  consumer can **withdraw** its ack before commit, which re-blocks commit.
- **Commit** recompiles the source at that moment (so late additions are
  re-keyed into the same version), re-verifies, atomically activates the new
  mapping, advances the publication epoch, and installs a complete version.
  Publication is fenced on `(epoch, mappingRevision)`.
- **Revoke** before commit retires the staged mapping and publishes nothing.
  Revoke after commit publishes a fresh, complete **rollback version** built with
  the previous mapping revision and the base version's mode.

## Publishing from a worker (stale-process protection)

A worker registers a **lease** pinned to the current `(epoch, mappingRevision)`.
It may publish either a server-compiled version or a payload it built itself,
but in both cases the app re-checks the fence:

- an expired/used lease → `LEASE_EXPIRED`
- a payload naming a superseded mapping revision → `STALE_MAPPING`
- a payload whose plan hash differs → `STALE_PLAN`
- a payload that is not join-complete → `JOIN_INTEGRITY_FAILED`

So an old process that still holds pre-migration state cannot republish stale
keys. Every successful commit/rollback expires all outstanding leases.

## Deletions and additions

The source estate has a pending change feed (late additions and deletions) that
is applied when a version is compiled:

- **Tombstone** (default): the row stays, flagged `_deleted`, keys masked per
  rulings. Joins ignore tombstones. Deletion evidence records a salted
  fingerprint.
- **Purge**: the row is removed and every dependent row cascades through the
  declared relationships, leaving only salted fingerprints. The cascade keeps
  the package join-complete by construction.

Late additions are re-keyed in the same version as everything else, so a row
that arrives between plan and commit never breaks the join.

## Evidence and downloadable results

Every version is checksummed per table and carries the integrity evidence the
compiler produced (per relationship, per key space: child rows checked, matched,
orphans, distinct parent values, duplicates).

- `GET /api/versions/:id/export` → self-verifying JSON evidence bundle
  (tables + plan + relationships + evidence + deletions + checksums).
- `GET /api/versions/:id/table/:tableId.csv` → per-table CSV download.
- `node scripts/verify-bundle.js bundle.json` → offline verification of a
  downloaded bundle: recomputes each table checksum and **replays the join rules
  against the bundle's own rows**. The integrity block stored inside the file is
  shown for comparison but never trusted — a tampered table fails even if its
  checksum is re-sealed.
- `GET /api/versions/:id/integrity` → re-runs verification against the stored
  rows and reports whether it still passes.

## Layout

```
src/domain/        model, rulings, relationships, fixtures, blueprint
src/services/      compiler, mapping registry, migrations, seed, export
src/storage/       durable append-only JSON store (atomic rename)
src/server.js      HTTP API + static server
public/            dependency-free UI
test/              node:test unit + HTTP integration suites
scripts/           smoke walkthrough, offline bundle verifier
```

All data is fictional. Masked keys are deterministic HMACs of the source value
and the registered seed, so re-running a build reproduces the same keys and the
mapping can be verified independently.
