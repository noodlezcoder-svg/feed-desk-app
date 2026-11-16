import type { Request, Response } from 'express';
import { config } from '../config';
import { auth } from '../firebase';
import { isAllowed, SESSION_COOKIE } from '../middleware/requireAuth';

const SESSION_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

export function showLogin(_req: Request, res: Response) {
  res.render('login', { firebase: config.firebaseWeb, configured: Boolean(config.firebaseWeb.apiKey) });
}

/** The browser signs in with Firebase, then trades its ID token for an httpOnly session cookie here. */
export async function createSession(req: Request, res: Response) {
  const idToken: unknown = req.body?.idToken;
  if (typeof idToken !== 'string' || !idToken) return res.status(400).json({ error: 'Missing sign-in token.' });

  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken, true);
  } catch {
    return res.status(401).json({ error: 'Sign-in failed. Try again.' });
  }
  // Only mint a session from a fresh sign-in (Firebase's recommendation).
  if (Date.now() / 1000 - decoded.auth_time > 5 * 60) return res.status(401).json({ error: 'Please sign in again.' });
  if (!isAllowed(decoded)) return res.status(403).json({ error: 'This account is not allowed to use Feed Desk.' });

  const cookie = await auth.createSessionCookie(idToken, { expiresIn: SESSION_MS });
  res.cookie(SESSION_COOKIE, cookie, {
    maxAge: SESSION_MS,
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict', // also blocks cross-site form posts (CSRF)
    path: '/',
  });
  res.json({ ok: true });
}

export async function logout(req: Request, res: Response) {
  const cookie: unknown = req.cookies?.[SESSION_COOKIE];
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  if (typeof cookie === 'string' && cookie) {
    try {
      const decoded = await auth.verifySessionCookie(cookie);
      await auth.revokeRefreshTokens(decoded.sub);
    } catch {
      /* already invalid */
    }
  }
  res.redirect('/login');
}
