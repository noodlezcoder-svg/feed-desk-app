import type { NextFunction, Request, Response } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { config } from '../config';
import { auth } from '../firebase';

export const SESSION_COOKIE = '__session';

/** Signed in with a verified email that is on the ALLOWED_EMAILS list. */
export function isAllowed(token: Pick<DecodedIdToken, 'email' | 'email_verified'>): boolean {
  const email = token.email?.toLowerCase();
  return Boolean(email && token.email_verified && config.allowedEmails.includes(email));
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const cookie: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof cookie !== 'string' || !cookie) return res.redirect('/login');
  try {
    // checkRevoked=true so "Sign out" really ends the session.
    const decoded = await auth.verifySessionCookie(cookie, true);
    if (!isAllowed(decoded)) {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      return res.status(403).render('error', { message: 'This account is not allowed to use Feed Desk.' });
    }
    res.locals.user = { uid: decoded.uid, email: decoded.email };
    next();
  } catch {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect('/login');
  }
}
