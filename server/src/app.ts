import express from 'express';
import { prisma } from './db/prisma.js';
import { changePassword, login, logout, me, requireAuth } from './auth/auth.js';
import { errorMiddleware, route } from './lib/errors.js';
import { leadsRouter } from './routes/leads.js';
import { usersRouter } from './routes/users.js';
import { medicinesRouter } from './routes/medicines.js';
import { ordersRouter } from './routes/orders.js';
import { renewalsRouter } from './routes/renewals.js';
import { followUpsRouter } from './routes/followUps.js';
import { notificationsRouter } from './routes/notifications.js';
import { miscRouter } from './routes/misc.js';
import { locationsRouter } from './routes/locations.js';

/**
 * The Express app, exported without listening.
 *
 * index.ts owns the port. Keeping them apart means the test suite can drive the real app
 * in-process with supertest — no port, no server lifecycle, no cleanup between tests.
 */
export const app = express();

/**
 * Cross-origin access for the frontend, which is served from its own domain.
 *
 * Authentication is a Bearer token in the Authorization header, not a cookie, so credentials
 * mode is not in play and a wildcard origin is safe: every route past login still demands a
 * valid token, and a browser on a hostile page has none. CORS_ORIGIN pins it to specific
 * origins when set — comma-separated, honoured by reflecting whichever one asked.
 *
 * The preflight is answered here rather than falling through to the 404 handler, which would
 * have refused OPTIONS and taken every PATCH and DELETE with it.
 */
const corsAllow = (process.env.CORS_ORIGIN ?? '*').split(',').map((o) => o.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allow = corsAllow.includes('*')
    ? '*'
    : origin && corsAllow.includes(origin)
      ? origin
      : corsAllow[0];
  res.header('Access-Control-Allow-Origin', allow);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: '5mb' })); // payment screenshots arrive as data URLs

app.get('/api/health', route(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true });
}));

app.post('/api/auth/login', route(login));
app.post('/api/auth/logout', requireAuth, route(logout));
app.get('/api/auth/me', requireAuth, route(me));
app.patch('/api/auth/password', requireAuth, route(changePassword));

app.use('/api/leads', requireAuth, leadsRouter);
app.use('/api/users', requireAuth, usersRouter);
app.use('/api/medicines', requireAuth, medicinesRouter);
app.use('/api/orders', requireAuth, ordersRouter);
app.use('/api/renewals', requireAuth, renewalsRouter);
app.use('/api/follow-ups', requireAuth, followUpsRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api/locations', requireAuth, locationsRouter);
app.use('/api', requireAuth, miscRouter);

// JSON for unknown routes, so a typo in the client is not answered with an HTML error page.
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Must be last — Express identifies the error handler by its four arguments.
app.use(errorMiddleware);
