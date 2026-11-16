import * as z from 'zod';
import { UserError } from '../errors';
import { db } from '../firebase';

/** Non-secret settings, edited on the Settings page and stored in Firestore (meta/settings). */
export const SettingsSchema = z.object({
  whopAccountId: z.union([z.string().trim().regex(/^biz_[A-Za-z0-9]+$/, 'Whop business id starts with biz_'), z.literal('')]),
  storeBaseUrl: z.union([z.url({ protocol: /^https$/, error: 'Store URL must be a full https:// URL' }), z.literal('')]),
  merchantAccountId: z.string().trim().regex(/^\d*$/, 'Merchant Center ID is digits only'),
  dataSourceId: z.string().trim().regex(/^\d*$/, 'Data source ID is digits only'),
  contentLanguage: z.string().trim().regex(/^[a-z]{2}$/, 'Language is a 2-letter code such as en'),
  feedLabel: z.string().trim().regex(/^[A-Z0-9_-]{2,20}$/, 'Feed label is uppercase, such as GB or US'),
  brand: z.string().trim().max(70),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULTS: Settings = {
  whopAccountId: '',
  storeBaseUrl: '',
  merchantAccountId: '',
  dataSourceId: '',
  contentLanguage: 'en',
  feedLabel: 'GB',
  brand: '',
};

const LABELS: Record<keyof Settings, string> = {
  whopAccountId: 'Whop business ID',
  storeBaseUrl: 'Store URL',
  merchantAccountId: 'Merchant Center ID',
  dataSourceId: 'Data source ID',
  contentLanguage: 'Language',
  feedLabel: 'Feed label',
  brand: 'Brand',
};

const ref = () => db.collection('meta').doc('settings');

export async function get(): Promise<Settings> {
  const doc = await ref().get();
  return { ...DEFAULTS, ...(doc.data() as Partial<Settings> | undefined) };
}

export async function save(s: Settings) {
  await ref().set({ ...s, updatedAt: new Date().toISOString() });
}

export function requireFields(s: Settings, keys: (keyof Settings)[]) {
  const missing = keys.filter((k) => !s[k]);
  if (missing.length) {
    throw new UserError(`Fill in ${missing.map((k) => LABELS[k]).join(', ')} on the Settings page first.`);
  }
}
