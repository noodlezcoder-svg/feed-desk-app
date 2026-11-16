import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config';

// Uses Application Default Credentials: the runtime service account on Cloud Run,
// or the key file named by GOOGLE_APPLICATION_CREDENTIALS anywhere else.
const app =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
    projectId: config.firebaseWeb.projectId || undefined,
  });

export const auth = getAuth(app);
export const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });
