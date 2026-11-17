/**
 * Fixture generator for the fictional source estate.
 *
 * Deterministic for a given seed. Include the hard cases explicitly:
 *   - rows that arrive after the plan snapshot (late additions)
 *   - rows deleted at source before commit (deletions)
 *   - a high-sensitivity key group that may not retain old values
 *   - a dimension table with no natural business key beyond the masked one
 */

import { createHash } from 'node:crypto';

function seeded(seedString) {
  let h = createHash('sha256').update(seedString).digest();
  let i = 0;
  return () => {
    if (i + 4 > h.length) {
      h = createHash('sha256').update(h).digest();
      i = 0;
    }
    const n = h.readUInt32BE(i);
    i += 4;
    return n / 0x100000000;
  };
}

const FIRST = ['Ada', 'Bilal', 'Chen', 'Dara', 'Esi', 'Farid', 'Gita', 'Hugo', 'Imani', 'Joon', 'Kira', 'Luis'];
const LAST = ['Okafor', 'Nakamura', 'Silva', 'Haddad', 'Novak', 'Mbeki', 'Rossi', 'Kowalski'];
const REGIONS = ['EMEA', 'AMER', 'APAC', 'LATAM'];
const PRODUCTS = ['Aurora Lamp', 'Basalt Mug', 'Cedar Desk', 'Dune Chair', 'Ember Kettle', 'Fjord Shelf'];
const PROMOS = ['SPRING10', 'SUMMER15', 'AUTUMN20', 'WINTER25'];

/** Build the fictional source data. */
export function buildSourceRows({ seed = 'fictional-estate-v1' } = {}) {
  const rnd = seeded(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const digits = (n) => String(Math.floor(rnd() * 10 ** n)).padStart(n, '0');

  const customers = [];
  for (let i = 1; i <= 24; i += 1) {
    const id = `CUS-${String(i).padStart(4, '0')}`;
    customers.push({
      id,
      customer_id: id,
      full_name: `${pick(FIRST)} ${pick(LAST)}`,
      email: `customer${i}@example.invalid`,
      loyalty_tier: pick(['bronze', 'silver', 'gold']),
      national_id: `NID-${digits(8)}`,
    });
  }

  const products = [];
  for (let i = 1; i <= 12; i += 1) {
    const id = `PRD-${String(i).padStart(3, '0')}`;
    products.push({
      id,
      product_id: id,
      product_name: `${pick(PRODUCTS)} ${i}`,
      category: pick(['home', 'kitchen', 'office']),
      list_price: (10 + Math.floor(rnd() * 400)) / 10,
    });
  }

  const regions = REGIONS.map((name, i) => ({
    id: `REG-${i + 1}`,
    region_id: `REG-${i + 1}`,
    region_name: name,
    timezone: pick(['UTC', 'UTC+1', 'UTC-5', 'UTC+8']),
  }));

  const promotions = PROMOS.map((code, i) => ({
    id: `PRO-${i + 1}`,
    promo_id: `PRO-${i + 1}`,
    promo_code: code,
    discount_pct: pick([10, 15, 20, 25]),
    active: i < 3,
  }));

  const orders = [];
  for (let i = 1; i <= 60; i += 1) {
    const id = `ORD-${String(i).padStart(5, '0')}`;
    const customer = pick(customers);
    const product = pick(products);
    const region = pick(regions);
    orders.push({
      id,
      order_id: id,
      customer_id: customer.customer_id,
      product_id: product.product_id,
      region_id: region.region_id,
      order_date: `2025-${String(1 + Math.floor(rnd() * 9)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 27)).padStart(2, '0')}`,
      quantity: 1 + Math.floor(rnd() * 5),
      amount: (5 + Math.floor(rnd() * 900)) / 10,
      // High-sensitivity contact captured on the fact row. Must join to
      // dim_customer.national_id, so both use the national_id group.
      customer_national_id: customer.national_id,
    });
  }

  const bridge = [];
  for (let i = 1; i <= 40; i += 1) {
    const order = pick(orders);
    const promo = pick(promotions);
    bridge.push({
      id: `BOP-${String(i).padStart(4, '0')}`,
      order_id: order.order_id,
      promo_id: promo.promo_id,
      applied_at: '2025-06-01',
      discount_applied: promo.discount_pct,
    });
  }

  return {
    fact_orders: orders,
    bridge_order_promo: bridge,
    dim_customer: customers,
    dim_product: products,
    dim_region: regions,
    dim_promotion: promotions,
  };
}

/**
 * Rows that arrive *after* the migration plan snapshot. They exist only in the
 * live source. A correct cut-over must include them (nothing is dropped because
 * it appeared late), and the additions must be re-keyed in the same version as
 * the rest so joins stay complete.
 */
export function buildLateAdditions({ seed = 'fictional-estate-v1-late' } = {}) {
  const rnd = seeded(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const newCustomerId = 'CUS-0101';
  const newProductId = 'PRD-101';
  return {
    dim_customer: [
      {
        id: newCustomerId,
        customer_id: newCustomerId,
        full_name: `${pick(FIRST)} ${pick(LAST)}`,
        email: 'newcustomer@example.invalid',
        loyalty_tier: 'bronze',
        national_id: 'NID-90909090',
      },
    ],
    dim_product: [
      {
        id: newProductId,
        product_id: newProductId,
        product_name: 'Glacier Vase 101',
        category: 'home',
        list_price: 24.5,
      },
    ],
    fact_orders: [
      {
        id: 'ORD-90001',
        order_id: 'ORD-90001',
        customer_id: newCustomerId,
        product_id: newProductId,
        region_id: 'REG-1',
        order_date: '2025-11-02',
        quantity: 2,
        amount: 49.0,
        customer_national_id: 'NID-90909090',
      },
    ],
    bridge_order_promo: [],
  };
}

/**
 * Records deleted at source between snapshot and commit.
 * Under the default TOMBSTONE policy the row is retained and marked deleted.
 * Under PURGE the row is removed and every dependent row cascades, leaving only
 * a fingerprint/hash for audit.
 */
export function buildLateDeletions() {
  return {
    dim_product: ['PRD-012'],
    fact_orders: ['ORD-00007', 'ORD-00019'],
    bridge_order_promo: ['BOP-0003'],
  };
}
