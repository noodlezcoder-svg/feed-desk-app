import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import ejs from 'ejs';
import { STATUSES, type Product } from '../src/models/Product';
import { DEFAULTS } from '../src/models/Settings';
import { defaultFeed, toSnapshot } from '../src/services/mapper';

const views = path.join(__dirname, '..', 'views');
const render = (name: string, data: Record<string, unknown>) => ejs.renderFile(path.join(views, `${name}.ejs`), data);

const source = toSnapshot(
  { id: 'prod_1', title: 'Arc <Lamp>', route: 'arc', visibility: 'visible' },
  { id: 'plan_1', product: { id: 'prod_1' }, title: 'Black', initial_price: 10, currency: 'gbp', visibility: 'visible', stock: 1, attributes: { size: 'L' } },
);
const product: Product = {
  id: 'plan_1', status: 'pushed', source, feed: defaultFeed(source, DEFAULTS),
  claude: { model: 'claude-opus-5-5', draftedAt: '2026-11-16T10:00:00Z', policyRisk: 'Check the wattage claim.' },
  gmc: { state: 'pending', pushedAt: '2026-11-16T10:05:00Z', issues: [{ code: 'x', severity: 'WARNING', description: 'Missing GTIN', attribute: 'gtin' }] },
  createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:05:00Z',
};
const user = { email: 'owner@example.com' };

test('every view renders and escapes Whop text', async () => {
  const counts = Object.fromEntries([['all', 1], ...STATUSES.map((s) => [s, 0])]);
  const index = await render('products/index', { user, products: [product], counts, statuses: STATUSES, status: null, msg: 'Hi' });
  assert.match(index, /Arc &lt;Lamp&gt;/);

  const edit = await render('products/edit', { user, product, feed: product.feed, msg: null, errors: ['Title is required'] });
  assert.match(edit, /Refresh status/);
  assert.match(edit, /Check the wattage claim/);

  const settings = await render('settings', { user, settings: DEFAULTS, errors: [], checks: [{ label: 'Google sign-in', ok: true, detail: 'ok' }], msg: null });
  assert.match(settings, /Connection check/);

  const login = await render('login', { firebase: { apiKey: 'k', authDomain: 'd', projectId: 'p' }, configured: true });
  assert.match(login, /signInWithPopup/);

  const error = await render('error', { message: 'Boom' });
  assert.match(error, /Boom/);
});
