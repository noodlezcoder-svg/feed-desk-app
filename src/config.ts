import { existsSync } from 'node:fs';

// Local development: read .env if it is there. In production the host sets real env vars.
if (existsSync('.env')) process.loadEnvFile('.env');

const env = (name: string, fallback = ''): string => (process.env[name] ?? fallback).trim();

export const config = {
  port: Number(env('PORT', '8080')),
  isProd: env('NODE_ENV') === 'production',

  // Only these Google accounts may sign in (comma-separated). Empty = nobody can.
  allowedEmails: env('ALLOWED_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  // Firebase web config. These values are public by design (they ship to the browser).
  firebaseWeb: {
    apiKey: env('FIREBASE_API_KEY'),
    authDomain: env('FIREBASE_AUTH_DOMAIN'),
    projectId: env('FIREBASE_PROJECT_ID'),
  },

  // Secrets: never commit these. Server-side only.
  whopApiKey: env('WHOP_API_KEY'),
  claudeModel: env('CLAUDE_MODEL', 'claude-opus-5-5'),
  // ANTHROPIC_API_KEY is read by the Anthropic SDK itself.
  // GOOGLE_APPLICATION_CREDENTIALS is read by Google's libraries (unset on Cloud Run).
};
