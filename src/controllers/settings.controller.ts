import type { Request, Response } from 'express';
import * as Settings from '../models/Settings';
import * as gmc from '../services/gmc.service';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// GET /settings
export async function show(req: Request, res: Response) {
  res.render('settings', {
    settings: await Settings.get(),
    errors: [],
    checks: null,
    msg: str(req.query.msg) || null,
  });
}

// POST /settings
export async function save(req: Request, res: Response) {
  const b = req.body ?? {};
  const raw = {
    whopAccountId: str(b.whopAccountId),
    storeBaseUrl: str(b.storeBaseUrl).replace(/\/$/, ''),
    merchantAccountId: str(b.merchantAccountId),
    dataSourceId: str(b.dataSourceId),
    contentLanguage: str(b.contentLanguage).toLowerCase(),
    feedLabel: str(b.feedLabel).toUpperCase(),
    brand: str(b.brand),
  };
  const parsed = Settings.SettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return res.status(400).render('settings', {
      settings: raw,
      errors: parsed.error.issues.map((i) => i.message),
      checks: null,
      msg: null,
    });
  }
  await Settings.save(parsed.data);
  res.redirect(`/settings?msg=${encodeURIComponent('Settings saved.')}`);
}

// POST /settings/check
export async function check(_req: Request, res: Response) {
  const settings = await Settings.get();
  res.render('settings', { settings, errors: [], checks: await gmc.checkConnection(settings), msg: null });
}
