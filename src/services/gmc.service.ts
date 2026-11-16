import { GoogleAuth } from 'google-auth-library';
import type { GmcIssue, GmcState } from '../models/Product';
import type { Settings } from '../models/Settings';

// Google Merchant API v1 (the Content API for Shopping was shut down on 2026-08-18).
// Signs in with Application Default Credentials: the Cloud Run service account, or the
// key file in GOOGLE_APPLICATION_CREDENTIALS. That service account must be a user in Merchant Center.
const API = 'https://merchantapi.googleapis.com';
const googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/content'] });

export interface ProductInput {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  productAttributes: Record<string, unknown>;
}

interface MerchantProduct {
  offerId?: string;
  productStatus?: {
    destinationStatuses?: { approvedCountries?: string[]; pendingCountries?: string[]; disapprovedCountries?: string[] }[];
    itemLevelIssues?: { code?: string; severity?: string; description?: string; attribute?: string }[];
  };
}

export class GmcError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const token = await googleAuth.getAccessToken();
  if (!token) throw new Error('Could not get a Google access token. Check the server credentials.');
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* not JSON */
    }
    throw new GmcError(`Merchant API ${res.status}: ${msg}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const account = (s: Settings) => `accounts/${s.merchantAccountId}`;
const dataSourceName = (s: Settings) => `${account(s)}/dataSources/${s.dataSourceId}`;
/** Merchant Center names a product "<language>~<feedLabel>~<offerId>". */
const productKey = (s: Settings, offerId: string) => encodeURIComponent(`${s.contentLanguage}~${s.feedLabel}~${offerId}`);

/** Insert or replace one product in the API data source. */
export async function insertProduct(s: Settings, input: ProductInput) {
  const ds = encodeURIComponent(dataSourceName(s));
  return call<{ name?: string; product?: string }>('POST', `/products/v1/${account(s)}/productInputs:insert?dataSource=${ds}`, input);
}

/** Remove one product. Returns false if Merchant Center did not have it. */
export async function deleteProduct(s: Settings, offerId: string): Promise<boolean> {
  const ds = encodeURIComponent(dataSourceName(s));
  try {
    await call('DELETE', `/products/v1/${account(s)}/productInputs/${productKey(s, offerId)}?dataSource=${ds}`);
    return true;
  } catch (e) {
    if (e instanceof GmcError && e.status === 404) return false;
    throw e;
  }
}

const STATUS_FIELDS = 'offerId,productStatus(destinationStatuses,itemLevelIssues(code,severity,description,attribute))';

function stateOf(p: MerchantProduct): GmcState['state'] {
  const ds = p.productStatus?.destinationStatuses ?? [];
  if (ds.some((d) => d.disapprovedCountries?.length)) return 'disapproved';
  if (ds.some((d) => d.pendingCountries?.length)) return 'pending';
  if (ds.some((d) => d.approvedCountries?.length)) return 'approved';
  return 'uploaded';
}

/** Google's review state and item issues. A 404 right after a push means Google is still processing it. */
export async function getStatus(s: Settings, offerId: string): Promise<{ state: GmcState['state']; issues: GmcIssue[] }> {
  try {
    const p = await call<MerchantProduct>(
      'GET',
      `/products/v1/${account(s)}/products/${productKey(s, offerId)}?fields=${encodeURIComponent(STATUS_FIELDS)}`,
    );
    const issues = (p.productStatus?.itemLevelIssues ?? []).map((i) => ({
      code: i.code ?? '',
      severity: i.severity ?? '',
      description: i.description ?? '',
      attribute: i.attribute,
    }));
    return { state: stateOf(p), issues };
  } catch (e) {
    if (e instanceof GmcError && e.status === 404) return { state: 'processing', issues: [] };
    throw e;
  }
}

export interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

/** Read-only checks for the Settings page: sign-in, account, Cloud project registration, data source. */
export async function checkConnection(s: Settings): Promise<Check[]> {
  const checks: Check[] = [];
  const run = async (label: string, fn: () => Promise<string>) => {
    try {
      checks.push({ label, ok: true, detail: await fn() });
    } catch (e) {
      checks.push({ label, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };
  await run('Google sign-in', async () => {
    const creds = await googleAuth.getCredentials();
    return creds.client_email ? `Signed in as ${creds.client_email}. Add this address as a user in Merchant Center.` : 'Signed in.';
  });
  if (!s.merchantAccountId) {
    checks.push({ label: 'Merchant Center account', ok: false, detail: 'Merchant Center ID is not set.' });
    return checks;
  }
  await run('Merchant Center account', async () => {
    const a = await call<{ accountName?: string }>('GET', `/accounts/v1/${account(s)}`);
    return `Found "${a.accountName ?? s.merchantAccountId}".`;
  });
  await run('Cloud project registered', async () => {
    const r = await call<{ gcpIds?: string[] }>('GET', `/accounts/v1/${account(s)}/developerRegistration`);
    if (!r.gcpIds?.length) throw new Error('Not registered yet. Register your Cloud project with this Merchant Center account.');
    return 'Registered.';
  });
  if (!s.dataSourceId) {
    checks.push({ label: 'Data source', ok: false, detail: 'Data source ID is not set.' });
    return checks;
  }
  await run('Data source', async () => {
    const d = await call<{ displayName?: string; input?: string; primaryProductDataSource?: { feedLabel?: string; contentLanguage?: string } }>(
      'GET',
      `/datasources/v1/${dataSourceName(s)}`,
    );
    if (d.input !== 'API') throw new Error(`"${d.displayName}" is not an API data source (input: ${d.input}).`);
    const p = d.primaryProductDataSource;
    if (p?.feedLabel && p.feedLabel !== s.feedLabel) throw new Error(`"${d.displayName}" uses feed label ${p.feedLabel}, not ${s.feedLabel}.`);
    if (p?.contentLanguage && p.contentLanguage !== s.contentLanguage)
      throw new Error(`"${d.displayName}" uses language ${p.contentLanguage}, not ${s.contentLanguage}.`);
    return `"${d.displayName}" is an API data source.`;
  });
  return checks;
}
