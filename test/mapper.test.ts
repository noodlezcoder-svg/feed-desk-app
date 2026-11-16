import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeedSchema, type Product } from '../src/models/Product';
import { DEFAULTS, type Settings } from '../src/models/Settings';
import { clip, defaultFeed, toPrice, toProductInput, toSnapshot } from '../src/services/mapper';

const settings: Settings = { ...DEFAULTS, storeBaseUrl: 'https://shop.example.com', brand: 'Example Lights', merchantAccountId: '123', dataSourceId: '456' };

const whopProduct = { id: 'prod_1', title: 'Arc Floor Lamp', route: 'arc-floor-lamp', visibility: 'visible', description: 'A tall arc lamp.' };
const whopVariant = {
  id: 'plan_1',
  product: { id: 'prod_1' },
  title: 'Black',
  initial_price: 89.5,
  currency: 'gbp',
  visibility: 'visible',
  stock: 3,
  image: { url: 'https://img.example.com/arc.jpg' },
  attributes: { Colour: 'Black' },
};

test('toPrice converts to micros', () => {
  assert.deepEqual(toPrice('49', 'GBP'), { amountMicros: '49000000', currencyCode: 'GBP' });
  assert.deepEqual(toPrice('89.5', 'GBP'), { amountMicros: '89500000', currencyCode: 'GBP' });
  assert.deepEqual(toPrice('0.99', 'USD'), { amountMicros: '990000', currencyCode: 'USD' });
  assert.throws(() => toPrice('abc', 'GBP'));
  assert.throws(() => toPrice('10', 'gb'));
});

test('clip cuts at a word boundary', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('one two three', 8), 'one two');
});

test('snapshot hash ignores fetch time and changes with price', () => {
  const a = toSnapshot(whopProduct, whopVariant);
  const b = toSnapshot(whopProduct, whopVariant);
  const c = toSnapshot(whopProduct, { ...whopVariant, initial_price: 99 });
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.equal(a.currency, 'GBP');
  assert.equal(a.inStock, true);
  assert.equal(a.visible, true);
});

test('defaultFeed + toProductInput build a valid Merchant API body', () => {
  const source = toSnapshot(whopProduct, whopVariant);
  const feed = defaultFeed(source, settings);
  assert.equal(feed.link, 'https://shop.example.com/products/arc-floor-lamp?variant=plan_1');
  assert.equal(feed.color, 'Black');
  assert.ok(FeedSchema.safeParse(feed).success);

  const product: Product = {
    id: 'plan_1', status: 'approved', source, feed, claude: null,
    gmc: { state: 'not_pushed', issues: [] }, createdAt: '', updatedAt: '',
  };
  const input = toProductInput(product, settings);
  assert.equal(input.offerId, 'plan_1');
  assert.equal(input.feedLabel, 'GB');
  assert.deepEqual(input.productAttributes.price, { amountMicros: '89500000', currencyCode: 'GBP' });
  assert.equal(input.productAttributes.availability, 'IN_STOCK');
  assert.equal(input.productAttributes.itemGroupId, 'prod_1');
});

test('hidden variants and incomplete listings are refused', () => {
  const hidden = toSnapshot(whopProduct, { ...whopVariant, visibility: 'hidden' });
  const base = { id: 'plan_1', status: 'approved' as const, claude: null, gmc: { state: 'not_pushed' as const, issues: [] }, createdAt: '', updatedAt: '' };
  assert.throws(() => toProductInput({ ...base, source: hidden, feed: defaultFeed(hidden, settings) }, settings), /hidden on Whop/);
  const source = toSnapshot(whopProduct, whopVariant);
  assert.throws(() => toProductInput({ ...base, source, feed: { ...defaultFeed(source, settings), link: 'http://x' } }, settings), /incomplete/);
});
