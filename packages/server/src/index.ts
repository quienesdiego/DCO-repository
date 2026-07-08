// Order matters: fontSetup must be the very first import (it sets FONTCONFIG_PATH
// before sharp's native binding loads — see services/fontSetup.ts for why).
import './services/fontSetup.js';
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createDcoRoutes } from './routes/dco.js';
import { createGeminiImageProvider, createGeminiTextProvider } from './adapters/providers/gemini.js';
import { createOpenAIImageProvider } from './adapters/providers/openaiImage.js';
import { createAnthropicTextProvider } from './adapters/providers/anthropic.js';
import { createSupabaseClient, createSupabaseRepository, createSupabaseStorage } from './adapters/providers/supabase.js';
import type { DcoProviders } from './adapters/types.js';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

/**
 * Builds the default provider bundle from environment variables. This is the
 * ONE place that wires concrete vendors — swap any of these for your own
 * ImageProvider/TextProvider/StorageProvider/DcoRepository implementation
 * without touching routes/ or services/. See README.md "Bring your own APIs".
 */
function buildProviders(): DcoProviders {
    const supabase = createSupabaseClient({
        url: requireEnv('SUPABASE_URL'),
        serviceKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    });

    const geminiApiKey = requireEnv('GEMINI_API_KEY');
    const image = createGeminiImageProvider({ apiKey: geminiApiKey });
    const imageAlt = process.env.OPENAI_API_KEY
        ? createOpenAIImageProvider({ apiKey: process.env.OPENAI_API_KEY })
        : undefined;

    return {
        image,
        imageAlt,
        text: createAnthropicTextProvider({ apiKey: requireEnv('ANTHROPIC_API_KEY') }),
        vision: createGeminiTextProvider({ apiKey: geminiApiKey }),
        storage: createSupabaseStorage(supabase),
        repository: createSupabaseRepository(supabase),
    };
}

const app = new Hono();

app.use('*', cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*' }));

// Generic API-key gate. Set DCO_API_SECRET to require an `X-Api-Key` header on
// every request except the public paths below (e.g. the downloadable template).
const PUBLIC_PATHS = new Set(['/api/dco/template']);
app.use('*', async (c, next) => {
    const secret = process.env.DCO_API_SECRET;
    if (!secret || PUBLIC_PATHS.has(c.req.path)) return next();
    if (c.req.header('X-Api-Key') !== secret) return c.json({ error: 'Unauthorized' }, 401);
    return next();
});

app.get('/health', c => c.json({ ok: true }));
app.route('/api/dco', createDcoRoutes(buildProviders()));

const port = Number(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port }, info => {
    console.log(`[dco-studio] server listening on http://localhost:${info.port}`);
});
