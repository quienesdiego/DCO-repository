/**
 * DCO Studio server — thin bootstrap around the VERBATIM port of MUSE's DCO
 * backend (routes/dco.ts + services/dco*.ts + services/supabase.ts, services/fontSetup.ts).
 * Nothing in routes/ or services/ was rewritten — see the repo README for why.
 *
 * What IS different from the original backend/src/server.ts (deliberately,
 * documented here so nothing is a silent surprise):
 *  - Only /api/dco is mounted. The original server.ts also mounted unrelated
 *    MUSE features (search, analysis, aviatur, Corferias, alert-mentions,
 *    agent) that have nothing to do with DCO and depend on their own tables.
 *  - CORS is a configurable allowlist (CORS_ORIGIN env var), not the
 *    hardcoded muse.vercel.app / muse-frontend-hhin.onrender.com domains —
 *    those are MUSE's own deployment URLs and would reject every request
 *    from YOUR platform's origin if kept as-is.
 *  - The X-Muse-Key guard logic is IDENTICAL (same header name, same
 *    behavior: only enforced if API_SECRET is set) — kept as-is because
 *    the DCOView.tsx frontend doesn't send this header either, so if you
 *    set API_SECRET you also need your own reverse proxy / edge layer to
 *    inject X-Muse-Key, exactly like production does.
 *  - The unauthorized-call email alert (logAndAlert → Resend) was dropped —
 *    it's a side feature unrelated to DCO's generation pipeline and needs
 *    infrastructure (Resend account, alertService.ts) this repo doesn't ship.
 */
import './services/fontSetup.js';
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { logger } from 'hono/logger';
import { dcoRoutes } from './routes/dco.js';

const app = new Hono();

app.use('*', compress());
app.use('*', logger());
app.use('*', cors({
    origin: process.env.CORS_ORIGIN?.split(',') || '*',
    credentials: true,
}));

// ─── X-Muse-Key guard — identical logic to the source server.ts ───────────────
// No-op unless API_SECRET is set. /api/dco/template is public in the original
// (PUBLIC_PATHS), kept public here too.
const PUBLIC_PATHS = ['/api/dco/template'];
app.use('/api/*', async (c, next) => {
    if (PUBLIC_PATHS.some(p => c.req.path.startsWith(p))) return next();
    const requiredSecret = process.env.API_SECRET;
    if (requiredSecret && c.req.header('X-Muse-Key') !== requiredSecret) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
});

app.get('/api/status', c => c.json({ status: 'DCO STUDIO ONLINE', timestamp: new Date().toISOString() }));

app.route('/api/dco', dcoRoutes);

const port = Number(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port }, info => {
    console.log(`[dco-studio] server listening on http://localhost:${info.port}`);
});
