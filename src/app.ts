import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config';
import * as authCtl from './controllers/auth.controller';
import * as productsCtl from './controllers/products.controller';
import * as settingsCtl from './controllers/settings.controller';
import { UserError } from './errors';
import { requireAuth } from './middleware/requireAuth';

const root = path.join(__dirname, '..'); // works from src/ (tsx) and dist/ (node)
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));

app.use(express.static(path.join(root, 'public')));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

// Public routes
app.get('/healthz', (_req, res) => {
  res.type('text').send('ok');
});
app.get('/login', authCtl.showLogin);
app.post('/session', authCtl.createSession);
app.post('/logout', authCtl.logout);

// Everything below needs a signed-in, allowed user
app.use(requireAuth);

app.get('/', productsCtl.index);
app.post('/products/import', productsCtl.importFromWhop);
app.get('/products/:id', productsCtl.show);
app.post('/products/:id', productsCtl.update);
app.post('/products/:id/draft', productsCtl.draft);
app.post('/products/:id/push', productsCtl.push);
app.post('/products/:id/status', productsCtl.refreshStatus);
app.post('/products/:id/remove', productsCtl.removeFromGmc);

app.get('/settings', settingsCtl.show);
app.post('/settings', settingsCtl.save);
app.post('/settings/check', settingsCtl.check);

app.use((_req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

// Express 5 forwards rejected promises from async handlers here.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof UserError) return res.status(err.status).render('error', { message: err.message });
  console.error(err);
  res.status(500).render('error', { message: err instanceof Error ? err.message : 'Something went wrong.' });
});

app.listen(config.port, () => {
  console.log(`Feed Desk on http://localhost:${config.port}`);
  if (!config.allowedEmails.length) console.warn('ALLOWED_EMAILS is empty: nobody can sign in.');
});
