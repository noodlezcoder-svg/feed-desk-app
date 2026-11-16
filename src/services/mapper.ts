import { UserError } from '../errors';
import { FeedSchema, hashSource, type Feed, type Product, type SourceSnapshot } from '../models/Product';
import type { Settings } from '../models/Settings';
import type { ProductInput } from './gmc.service';
import type { WhopProduct, WhopVariant } from './whop.service';

/** Shorten to at most `max` characters, cutting at a word boundary when possible. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max);
  return s.slice(0, cut > 0 ? cut : max).trimEnd();
}

function attr(attrs: Record<string, string>, ...names: string[]): string {
  for (const [k, v] of Object.entries(attrs)) if (names.includes(k.toLowerCase()) && v) return String(v);
  return '';
}

/** Whop product + variant → the snapshot stored in Firestore. */
export function toSnapshot(p: WhopProduct | undefined, v: WhopVariant): SourceSnapshot {
  const base = {
    productId: v.product?.id ?? p?.id ?? '',
    variantId: v.id,
    productTitle: p?.title ?? v.product?.title ?? v.id,
    variantTitle: v.title ?? '',
    description: p?.description ?? null,
    headline: p?.headline ?? null,
    route: p?.route ?? null,
    sku: v.sku ?? null,
    price: String(v.initial_price_due?.amount ?? v.initial_price ?? ''),
    currency: (v.currency ?? '').toUpperCase(),
    inStock: Boolean(v.unlimited_stock || (v.stock ?? 0) > 0),
    visible: v.visibility === 'visible' && p?.visibility !== 'hidden' && p?.visibility !== 'archived',
    imageUrl: v.image?.url ?? p?.gallery_images?.[0]?.url ?? null,
    attributes: Object.fromEntries(Object.entries(v.attributes ?? {}).map(([k, val]) => [k, String(val)])),
  };
  return { ...base, hash: hashSource(base), fetchedAt: new Date().toISOString() };
}

/** The variant's page on your own store domain (Google only accepts links on your claimed website). */
export function productLink(s: SourceSnapshot, settings: Settings): string {
  if (!settings.storeBaseUrl || !s.route) return '';
  return `${settings.storeBaseUrl.replace(/\/$/, '')}/products/${encodeURIComponent(s.route)}?variant=${encodeURIComponent(s.variantId)}`;
}

/** A starting listing built from Whop data alone, before Claude or you touch it. */
export function defaultFeed(s: SourceSnapshot, settings: Settings): Feed {
  const options = Object.values(s.attributes).filter(Boolean);
  return {
    title: clip([s.productTitle, ...options].join(', '), 150),
    description: clip(s.description || s.headline || s.productTitle, 5000),
    link: productLink(s, settings),
    imageLink: s.imageUrl ?? '',
    brand: settings.brand,
    condition: 'NEW',
    googleProductCategory: '',
    productType: '',
    productHighlights: [],
    color: attr(s.attributes, 'color', 'colour'),
    size: attr(s.attributes, 'size'),
    material: attr(s.attributes, 'material'),
  };
}

/** "49.99" + "GBP" → Merchant API price (amount in micros). */
export function toPrice(amount: string, currency: string) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) throw new UserError(`Whop price "${amount}" is not a plain number.`);
  if (!/^[A-Z]{3}$/.test(currency)) throw new UserError(`Whop currency "${currency}" is not a 3-letter code.`);
  const micros = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
  return { amountMicros: micros.toString(), currencyCode: currency };
}

/** Approved product → Merchant API ProductInput. Price and stock come from Whop, never from the edited copy. */
export function toProductInput(p: Product, settings: Settings): ProductInput {
  if (!p.source.visible) throw new UserError('This variant is hidden on Whop, so its page is not live. Make it visible first.');
  const parsed = FeedSchema.safeParse(p.feed);
  if (!parsed.success) {
    throw new UserError(`The listing is incomplete: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const f = parsed.data;
  const attrs: Record<string, unknown> = {
    title: f.title,
    description: f.description,
    link: f.link,
    imageLink: f.imageLink,
    brand: f.brand,
    condition: f.condition,
    price: toPrice(p.source.price, p.source.currency),
    availability: p.source.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
    identifierExists: false,
    itemGroupId: p.source.productId || undefined,
  };
  if (f.googleProductCategory) attrs.googleProductCategory = f.googleProductCategory;
  if (f.productType) attrs.productTypes = [f.productType];
  if (f.productHighlights.length) attrs.productHighlights = f.productHighlights;
  if (f.color) attrs.color = f.color;
  if (f.size) attrs.size = f.size;
  if (f.material) attrs.material = f.material;
  return {
    offerId: p.id,
    contentLanguage: settings.contentLanguage,
    feedLabel: settings.feedLabel,
    productAttributes: attrs,
  };
}
