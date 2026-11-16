import { createHash } from 'node:crypto';
import * as z from 'zod';
import { db } from '../firebase';

/**
 * One Firestore document per Whop variant (= one Merchant Center item).
 * Document id = Whop variant id = GMC offerId.
 *
 * imported → drafted → approved → pushed → live | disapproved
 * Any pushed product whose Whop data changes becomes "stale" and needs a new approval.
 */
export const STATUSES = ['imported', 'drafted', 'approved', 'pushed', 'live', 'disapproved', 'stale'] as const;
export type ProductStatus = (typeof STATUSES)[number];

/** A copy of what Whop says about the variant. Price and stock always come from here. */
export interface SourceSnapshot {
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  description: string | null;
  headline: string | null;
  route: string | null;
  sku: string | null;
  price: string;
  currency: string;
  inStock: boolean;
  visible: boolean;
  imageUrl: string | null;
  attributes: Record<string, string>;
  hash: string;
  fetchedAt: string;
}

/** The listing copy you (and Claude) edit. Optional fields use "" for "not set". */
export const FeedSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(150, 'Title must be 150 characters or fewer'),
  description: z.string().trim().min(1, 'Description is required').max(5000, 'Description must be 5000 characters or fewer'),
  link: z.url({ protocol: /^https$/, error: 'Link must be a full https:// URL on your own domain' }),
  imageLink: z.url({ protocol: /^https$/, error: 'Image link must be a full https:// URL' }),
  brand: z.string().trim().min(1, 'Brand is required').max(70),
  condition: z.enum(['NEW', 'USED', 'REFURBISHED']),
  googleProductCategory: z.string().trim().max(750),
  productType: z.string().trim().max(750),
  productHighlights: z.array(z.string().trim().min(1).max(150)).max(10, 'At most 10 highlights'),
  color: z.string().trim().max(100),
  size: z.string().trim().max(100),
  material: z.string().trim().max(200),
});
export type Feed = z.infer<typeof FeedSchema>;

export interface GmcIssue {
  code: string;
  severity: string;
  description: string;
  attribute?: string;
}

export interface GmcState {
  state: 'not_pushed' | 'processing' | 'pending' | 'approved' | 'disapproved' | 'uploaded';
  pushedAt?: string;
  checkedAt?: string;
  issues: GmcIssue[];
  lastError?: string;
}

export interface Product {
  id: string;
  status: ProductStatus;
  source: SourceSnapshot;
  feed: Feed | null;
  claude: { model: string; draftedAt: string; policyRisk: string } | null;
  gmc: GmcState;
  createdAt: string;
  updatedAt: string;
}

const col = () => db.collection('products');
const now = () => new Date().toISOString();
const PUSHED: ProductStatus[] = ['pushed', 'live', 'disapproved'];

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function hashSource(s: Omit<SourceSnapshot, 'hash' | 'fetchedAt'>): string {
  return createHash('sha256').update(stableStringify(s)).digest('hex').slice(0, 16);
}

export async function get(id: string): Promise<Product | null> {
  const doc = await col().doc(id).get();
  return doc.exists ? (doc.data() as Product) : null;
}

/** Up to 200 products, newest first. Filtering in one field only, so no composite index is needed. */
export async function list(status?: ProductStatus): Promise<Product[]> {
  const q = status ? col().where('status', '==', status).limit(200) : col().orderBy('updatedAt', 'desc').limit(200);
  const snap = await q.get();
  return snap.docs.map((d) => d.data() as Product).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Count queries cost one read per 1000 matches, so this stays cheap on the free tier. */
export async function countByStatus(): Promise<Record<ProductStatus | 'all', number>> {
  const [all, ...each] = await Promise.all([
    col().count().get(),
    ...STATUSES.map((s) => col().where('status', '==', s).count().get()),
  ]);
  const out = { all: all.data().count } as Record<ProductStatus | 'all', number>;
  STATUSES.forEach((s, i) => (out[s] = each[i].data().count));
  return out;
}

/** Insert new variants, refresh changed ones, skip unchanged ones (no write = no cost). */
export async function upsertSnapshots(snaps: SourceSnapshot[]) {
  let created = 0;
  let changed = 0;
  let unchanged = 0;
  for (let i = 0; i < snaps.length; i += 300) {
    const chunk = snaps.slice(i, i + 300);
    const refs = chunk.map((s) => col().doc(s.variantId));
    const docs = await db.getAll(...refs);
    const batch = db.batch();
    let writes = 0;
    docs.forEach((doc, j) => {
      const s = chunk[j];
      const t = now();
      if (!doc.exists) {
        const p: Product = {
          id: s.variantId,
          status: 'imported',
          source: s,
          feed: null,
          claude: null,
          gmc: { state: 'not_pushed', issues: [] },
          createdAt: t,
          updatedAt: t,
        };
        batch.set(refs[j], p);
        created++;
        writes++;
        return;
      }
      const p = doc.data() as Product;
      if (p.source.hash === s.hash) {
        unchanged++;
        return;
      }
      batch.update(refs[j], { source: s, status: PUSHED.includes(p.status) ? 'stale' : p.status, updatedAt: t });
      changed++;
      writes++;
    });
    if (writes) await batch.commit();
  }
  return { created, changed, unchanged };
}

export async function saveFeed(id: string, feed: Feed, status: ProductStatus) {
  await col().doc(id).update({ feed, status, updatedAt: now() });
}

export async function saveDraft(id: string, feed: Feed, claude: NonNullable<Product['claude']>) {
  await col().doc(id).update({ feed, claude, status: 'drafted', updatedAt: now() });
}

export async function setGmc(id: string, gmc: GmcState, status?: ProductStatus) {
  await col()
    .doc(id)
    .update({ gmc, ...(status ? { status } : {}), updatedAt: now() });
}
