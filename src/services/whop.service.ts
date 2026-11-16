import { config } from '../config';
import { UserError } from '../errors';

// Whop REST API, v1. Docs: https://docs.whop.com/api-reference
const BASE = 'https://api.whop.com/api/v1';

export interface WhopProduct {
  id: string;
  title: string;
  route?: string | null;
  visibility?: string;
  headline?: string | null;
  description?: string | null;
  gallery_images?: { url?: string | null }[] | null;
  updated_at?: string;
}

/** A variant is what you sell (price, stock, options). Each one becomes one Merchant Center item. */
export interface WhopVariant {
  id: string;
  product?: { id: string; title?: string } | null;
  title?: string | null;
  sku?: string | null;
  initial_price?: number | string | null;
  initial_price_due?: { amount: number | string } | null;
  currency?: string | null;
  visibility?: string;
  unlimited_stock?: boolean;
  stock?: number | null;
  image?: { url?: string | null } | null;
  attributes?: Record<string, string> | null;
  updated_at?: string;
}

interface Page<T> {
  data: T[];
  page_info?: { has_next_page?: boolean; end_cursor?: string | null };
}

async function listAll<T>(kind: 'products' | 'variants', accountId: string, pageSize: number): Promise<T[]> {
  if (!config.whopApiKey) throw new UserError('WHOP_API_KEY is not set on the server.');
  const out: T[] = [];
  let after: string | null = null;
  for (let pageNo = 0; pageNo < 500; pageNo++) {
    const q = new URLSearchParams({ account_id: accountId, first: String(pageSize) });
    if (after) q.set('after', after);
    const res = await fetch(`${BASE}/${kind}?${q}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.whopApiKey}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Whop ${kind}: ${res.status} ${text.slice(0, 300)}`);
    const page = JSON.parse(text) as Page<T>;
    if (!Array.isArray(page.data)) throw new Error(`Whop ${kind}: unexpected response`);
    out.push(...page.data);
    const next = page.page_info?.has_next_page ? page.page_info.end_cursor : null;
    if (!next) break;
    after = next;
  }
  return out;
}

export async function fetchCatalog(accountId: string) {
  const [products, variants] = await Promise.all([
    listAll<WhopProduct>('products', accountId, 25),
    listAll<WhopVariant>('variants', accountId, 100),
  ]);
  return { products, variants };
}
