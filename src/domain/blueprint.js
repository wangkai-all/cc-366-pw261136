/**
 * The fictional estate used by the app.
 *
 * Two columns with different names can be bound to the same *key group* so that
 * they mask identically and can be joined after the swap. The national-id group
 * is deliberately high-sensitivity: its ruling forbids retaining the old value
 * in any consumer-facing package.
 */

import { newDataset, validateDataset } from './model.js';

export const DATASET_BLUEPRINT = {
  name: 'Retail order estate (fictional)',
  description:
    'Six fact/dimension tables joined on customer, product, region, promotion, order and national-id key groups.',
  tables: [
    {
      id: 'fact_orders',
      name: 'Orders (fact)',
      role: 'fact',
      joinKeys: ['order_id', 'customer_id', 'product_id', 'region_id', 'customer_national_id'],
      fields: [
        { name: 'order_id' },
        { name: 'customer_id' },
        { name: 'product_id' },
        { name: 'region_id' },
        { name: 'order_date' },
        { name: 'quantity' },
        { name: 'amount' },
        { name: 'customer_national_id', sensitivity: 'high' },
      ],
    },
    {
      id: 'bridge_order_promo',
      name: 'Order promotions (fact)',
      role: 'fact',
      joinKeys: ['order_id', 'promo_id'],
      fields: [
        { name: 'order_id' },
        { name: 'promo_id' },
        { name: 'applied_at' },
        { name: 'discount_applied' },
      ],
    },
    {
      id: 'dim_customer',
      name: 'Customer (dim)',
      role: 'dimension',
      joinKeys: ['customer_id', 'national_id'],
      fields: [
        { name: 'customer_id' },
        { name: 'full_name' },
        { name: 'email' },
        { name: 'loyalty_tier' },
        { name: 'national_id', sensitivity: 'high' },
      ],
    },
    {
      id: 'dim_product',
      name: 'Product (dim)',
      role: 'dimension',
      joinKeys: ['product_id'],
      fields: [
        { name: 'product_id' },
        { name: 'product_name' },
        { name: 'category' },
        { name: 'list_price' },
      ],
    },
    {
      id: 'dim_region',
      name: 'Region (dim)',
      role: 'dimension',
      joinKeys: ['region_id'],
      fields: [
        { name: 'region_id' },
        { name: 'region_name' },
        { name: 'timezone' },
      ],
    },
    {
      id: 'dim_promotion',
      name: 'Promotion (dim)',
      role: 'dimension',
      joinKeys: ['promo_id'],
      fields: [
        { name: 'promo_id' },
        { name: 'promo_code' },
        { name: 'discount_pct' },
        { name: 'active' },
      ],
    },
  ],
  keys: [
    { tableId: 'fact_orders', field: 'order_id', group: 'order_id' },
    { tableId: 'bridge_order_promo', field: 'order_id', group: 'order_id' },
    { tableId: 'fact_orders', field: 'customer_id', group: 'customer_id' },
    { tableId: 'dim_customer', field: 'customer_id', group: 'customer_id' },
    { tableId: 'fact_orders', field: 'product_id', group: 'product_id' },
    { tableId: 'dim_product', field: 'product_id', group: 'product_id' },
    { tableId: 'fact_orders', field: 'region_id', group: 'region_id' },
    { tableId: 'dim_region', field: 'region_id', group: 'region_id' },
    { tableId: 'bridge_order_promo', field: 'promo_id', group: 'promo_id' },
    { tableId: 'dim_promotion', field: 'promo_id', group: 'promo_id' },
    { tableId: 'fact_orders', field: 'customer_national_id', group: 'national_id' },
    { tableId: 'dim_customer', field: 'national_id', group: 'national_id' },
  ],
  rulings: {
    default: { retainOldKey: true, retention: 'SIX_MONTHS' },
    byGroup: {
      national_id: { retainOldKey: false, retention: 'SHORT_LIVED' },
    },
  },
  deletionPolicy: 'tombstone',
  // Extra reference edges that are not auto-derivable from table role.
  references: [
    {
      group: 'order_id',
      child: { tableId: 'bridge_order_promo', field: 'order_id' },
      parent: { tableId: 'fact_orders', field: 'order_id' },
    },
  ],
};

export function buildDataset() {
  const { references, ...rest } = DATASET_BLUEPRINT;
  const dataset = newDataset(rest);
  dataset.references = references || [];
  validateDataset(dataset);
  return dataset;
}
