# Feed Desk app

A minimal web app for one job: take products from **Whop**, let **Claude** draft Google Shopping listings, review and approve them, then push them to **Google Merchant Center** (Merchant API v1).

```
Whop API ──Import──► Firestore ──Draft with Claude──► you edit + approve ──Push──► Merchant API
                        ▲                                                           │
                        └──────────── Refresh status (review state + issues) ◄──────┘
```

- Claude only drafts. Nothing reaches Google until you press **Save & approve** and then **Push**.
- Price and stock always come from Whop at push time, so they match your product page.
- One Merchant Center item per Whop **variant** (`offerId` = variant id), grouped by product (`itemGroupId`).

## Stack

| Part | Choice |
|---|---|
| Server | Node 22+, TypeScript, Express 5, EJS views |
| Login | Firebase Authentication (Google sign-in) + an email allowlist |
| Data | Cloud Firestore (one JSON document per variant, plus `meta/settings`) |
| AI | Anthropic SDK, `claude-opus-5-5`, structured outputs (Zod) |
| Google | Merchant API v1 over REST, signed in with Application Default Credentials |

Firebase Auth and Firestore both work on Firebase's free Spark plan, with no billing account.

## Structure (MVC + a service layer)

```
src/
├─ app.ts                     routes, middleware, error handler
├─ config.ts                  environment variables
├─ firebase.ts                Firebase Admin (Auth + Firestore)
├─ errors.ts                  UserError (shown to the user as-is)
├─ middleware/requireAuth.ts  session cookie + allowlist check
├─ models/                    M: data shapes + Firestore reads/writes
│  ├─ Product.ts
│  └─ Settings.ts
├─ services/                  the only code that talks to outside APIs
│  ├─ whop.service.ts         list products + variants
│  ├─ claude.service.ts       draft listing copy
│  ├─ gmc.service.ts          insert / delete / status / connection check
│  └─ mapper.ts               Whop → snapshot → Merchant API ProductInput
└─ controllers/               C: one per screen
   ├─ auth.controller.ts
   ├─ products.controller.ts
   └─ settings.controller.ts
views/                        V: EJS templates
public/style.css
test/                         mapper + view rendering tests
```

Controllers call models and services. Only services call Whop, Claude or Google.

### Product status

`imported → drafted → approved → pushed → live | disapproved`. A pushed product whose Whop data changes on the next import becomes `stale` and needs a new approval.

### Routes

| Route | What it does |
|---|---|
| `GET /login`, `POST /session`, `POST /logout` | Sign in and out |
| `GET /` | Product list with status filters |
| `POST /products/import` | Read all Whop products and variants, upsert them (unchanged ones are skipped) |
| `GET /products/:id`, `POST /products/:id` | Review and edit; **Save draft** or **Save & approve** |
| `POST /products/:id/draft` | Claude drafts the listing |
| `POST /products/:id/push` | Send an approved product to Merchant Center |
| `POST /products/:id/status` | Read Google's review state and issues |
| `POST /products/:id/remove` | Delete the product from Merchant Center |
| `GET /settings`, `POST /settings`, `POST /settings/check` | Settings and a read-only connection check |

## Setup

### 1. Firebase (login + database)

1. In the [Firebase console](https://console.firebase.google.com), add Firebase to the **same Google Cloud project** you use for the Merchant API.
2. **Authentication → Sign-in method**: enable **Google**. Under **Settings → Authorized domains**, add your deployed domain (`localhost` is already there).
3. **Firestore Database → Create database**. Only the server touches the data, so the rules can block all browser access:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} { allow read, write: if false; }
     }
   }
   ```
4. **Project settings → General → Your apps**: add a Web app and copy `apiKey`, `authDomain` and `projectId` into your env.

### 2. Service account (server sign-in to Google)

The server uses one service account for Firestore, Firebase Auth and the Merchant API.

- On Cloud Run, the service's own service account is used, with no key file.
- Anywhere else, create a key for the service account (Firebase **Project settings → Service accounts**), keep the file **outside this folder**, and set `GOOGLE_APPLICATION_CREDENTIALS` to its path.
- If you reuse an existing Merchant API service account, give it the **Cloud Datastore User** and **Firebase Authentication Admin** roles.

In Merchant Center:
- Add the service account's email as a user.
- Make sure the Cloud project has the Merchant API turned on and is registered with the Merchant Center account.
- Have a primary product data source whose input is **API**, and note its ID.

After you fill in Settings, **Settings → Check Merchant Center** shows which of these steps are done.

### 3. API keys

- `WHOP_API_KEY`: a Whop API key that can read your business's products and variants.
- `ANTHROPIC_API_KEY`: from the Claude Console.

### 4. Run locally

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env`, then:

```bash
npm run dev
```

Open http://localhost:8080, sign in, fill in **Settings** (Whop business ID, store URL on your own domain, Merchant Center ID, data source ID, language, feed label, brand), run **Check Merchant Center**, then **Import from Whop**.

## Deploy

**Cloud Run** (needs billing on the Cloud project). Store the two API keys in Secret Manager first, then:

```bash
gcloud run deploy feed-desk --source . --region <region> --service-account <service-account-email> --set-env-vars NODE_ENV=production,ALLOWED_EMAILS=<you>,FIREBASE_API_KEY=<key>,FIREBASE_AUTH_DOMAIN=<domain>,FIREBASE_PROJECT_ID=<project> --set-secrets WHOP_API_KEY=whop-api-key:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest
```

**Any other Docker or Node host** (Render, Fly.io, a VPS): build the `Dockerfile` and set the same variables. Mount the service account key as a secret file and point `GOOGLE_APPLICATION_CREDENTIALS` at it.

Either way, add the deployed domain to Firebase **Authorized domains**.

## Scripts

| Command | |
|---|---|
| `npm run dev` | Run with reload (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm test` | Mapper and view rendering tests |
| `npm run typecheck` | Type-check only |

## Notes

- **Free tier:** Firestore's free quota is 50k reads and 20k writes a day. Import only writes variants that changed, and the list page uses count queries, so a single store stays well inside it.
- **Claude:** the request uses the server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). If the model declines for policy reasons, the API retries on its default fallback model. Set `CLAUDE_MODEL` to use a different model.
- **Security:**
  - Sessions are httpOnly, `SameSite=Strict` cookies (5 days). Sign out revokes them.
  - Only verified emails on `ALLOWED_EMAILS` can sign in.
  - Secrets live only in environment variables.
- **Next steps:** bulk draft/push, and Whop webhooks to mark products stale without a manual import.
