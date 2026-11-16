import type { Request, Response } from 'express';
import { UserError } from '../errors';
import * as Product from '../models/Product';
import * as Settings from '../models/Settings';
import * as claude from '../services/claude.service';
import * as gmc from '../services/gmc.service';
import { defaultFeed, toProductInput, toSnapshot } from '../services/mapper';
import * as whop from '../services/whop.service';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const msgOf = (req: Request) => str(req.query.msg) || null;
const productUrl = (id: string) => `/products/${encodeURIComponent(id)}`;
const back = (res: Response, path: string, msg: string) => res.redirect(`${path}?msg=${encodeURIComponent(msg)}`);

async function load(id: string) {
  const p = await Product.get(id);
  if (!p) throw new UserError('That product is not in Feed Desk. Import from Whop first.', 404);
  return p;
}

/** Form fields → Feed object (validated by the caller). */
function feedFromForm(body: Record<string, unknown>) {
  return {
    title: str(body.title),
    description: str(body.description),
    link: str(body.link).trim(),
    imageLink: str(body.imageLink).trim(),
    brand: str(body.brand),
    condition: str(body.condition) || 'NEW',
    googleProductCategory: str(body.googleProductCategory),
    productType: str(body.productType),
    productHighlights: str(body.productHighlights)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
    color: str(body.color),
    size: str(body.size),
    material: str(body.material),
  };
}

// GET /
export async function index(req: Request, res: Response) {
  const status = Product.STATUSES.find((s) => s === req.query.status);
  const [products, counts] = await Promise.all([Product.list(status), Product.countByStatus()]);
  res.render('products/index', { products, counts, statuses: Product.STATUSES, status: status ?? null, msg: msgOf(req) });
}

// POST /products/import
export async function importFromWhop(_req: Request, res: Response) {
  const settings = await Settings.get();
  Settings.requireFields(settings, ['whopAccountId']);
  const { products, variants } = await whop.fetchCatalog(settings.whopAccountId);
  const byId = new Map(products.map((p) => [p.id, p]));
  const snaps = variants.map((v) => toSnapshot(byId.get(v.product?.id ?? ''), v));
  const r = await Product.upsertSnapshots(snaps);
  back(res, '/', `Whop import: ${r.created} new, ${r.changed} changed, ${r.unchanged} unchanged.`);
}

// GET /products/:id
export async function show(req: Request, res: Response) {
  const product = await load(String(req.params.id));
  const settings = await Settings.get();
  res.render('products/edit', {
    product,
    feed: product.feed ?? defaultFeed(product.source, settings),
    msg: msgOf(req),
    errors: [],
  });
}

// POST /products/:id  (Save draft / Save & approve)
export async function update(req: Request, res: Response) {
  const id = String(req.params.id);
  const product = await load(id);
  const raw = feedFromForm(req.body ?? {});
  const parsed = Product.FeedSchema.safeParse(raw);
  if (!parsed.success) {
    return res.status(400).render('products/edit', {
      product,
      feed: raw,
      msg: null,
      errors: parsed.error.issues.map((i) => i.message),
    });
  }
  const approve = req.body?.action === 'approve';
  await Product.saveFeed(id, parsed.data, approve ? 'approved' : 'drafted');
  back(res, productUrl(id), approve ? 'Saved and approved. You can push it to Merchant Center now.' : 'Draft saved.');
}

// POST /products/:id/draft
export async function draft(req: Request, res: Response) {
  const id = String(req.params.id);
  const product = await load(id);
  const settings = await Settings.get();
  const base = product.feed ?? defaultFeed(product.source, settings);
  const d = await claude.draftListing(product.source, settings);
  const feed: Product.Feed = {
    ...base,
    title: d.title || base.title,
    description: d.description || base.description,
    googleProductCategory: d.googleProductCategory,
    productType: d.productType,
    productHighlights: d.productHighlights,
    color: d.color || base.color,
    size: d.size || base.size,
    material: d.material || base.material,
  };
  await Product.saveDraft(id, feed, { model: d.model, draftedAt: new Date().toISOString(), policyRisk: d.policyRisk.trim() });
  back(res, productUrl(id), 'Claude drafted the listing. Check it, then Save & approve.');
}

// POST /products/:id/push
export async function push(req: Request, res: Response) {
  const id = String(req.params.id);
  const product = await load(id);
  if (product.status !== 'approved') throw new UserError('Approve the listing before pushing it to Merchant Center.');
  const settings = await Settings.get();
  Settings.requireFields(settings, ['merchantAccountId', 'dataSourceId', 'contentLanguage', 'feedLabel']);
  const input = toProductInput(product, settings);
  try {
    await gmc.insertProduct(settings, input);
  } catch (e) {
    await Product.setGmc(id, { ...product.gmc, lastError: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  const t = new Date().toISOString();
  await Product.setGmc(id, { state: 'processing', pushedAt: t, checkedAt: t, issues: [] }, 'pushed');
  back(res, productUrl(id), 'Sent to Merchant Center. Google takes a few minutes to process it; then use Refresh status.');
}

// POST /products/:id/status
export async function refreshStatus(req: Request, res: Response) {
  const id = String(req.params.id);
  const product = await load(id);
  if (!product.gmc.pushedAt) throw new UserError('This product has not been pushed yet.');
  const settings = await Settings.get();
  Settings.requireFields(settings, ['merchantAccountId', 'contentLanguage', 'feedLabel']);
  const st = await gmc.getStatus(settings, id);
  const onGoogle = product.status === 'pushed' || product.status === 'live' || product.status === 'disapproved';
  const status: Product.ProductStatus | undefined = !onGoogle
    ? undefined
    : st.state === 'approved'
      ? 'live'
      : st.state === 'disapproved'
        ? 'disapproved'
        : 'pushed';
  await Product.setGmc(id, { ...product.gmc, state: st.state, issues: st.issues, checkedAt: new Date().toISOString(), lastError: undefined }, status);
  back(res, productUrl(id), `Google status: ${st.state}${st.issues.length ? `, ${st.issues.length} issue(s)` : ''}.`);
}

// POST /products/:id/remove
export async function removeFromGmc(req: Request, res: Response) {
  const id = String(req.params.id);
  const product = await load(id);
  const settings = await Settings.get();
  Settings.requireFields(settings, ['merchantAccountId', 'dataSourceId', 'contentLanguage', 'feedLabel']);
  const existed = await gmc.deleteProduct(settings, id);
  await Product.setGmc(id, { state: 'not_pushed', issues: [] }, product.feed ? 'drafted' : 'imported');
  back(res, productUrl(id), existed ? 'Removed from Merchant Center.' : 'Merchant Center did not have this product.');
}
