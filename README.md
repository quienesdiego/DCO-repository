# DCO Studio

AI-powered ad-creative generation engine: from a single reference creative and
a copy brief, produce on-brand static ad pieces (across all your standard ad
formats), animated GIFs, video scripts, and narrative multi-slide carousels —
with automatic QA and a deterministic, pixel-perfect text/logo layer.

This is a **generic, provider-agnostic** extraction of a production DCO
(Dynamic Creative Optimization) module: no hardcoded brand, client, product
category, or vendor lock-in. You bring your own AI provider keys, your own
database, and mount the frontend component inside your own app.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pipeline
actually works (the "one painter, one compositor" split, the QA design, why
brand identity is data and not code) before changing anything — the design
choices there aren't arbitrary.

Read [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for how to plug in your own
APIs/database/auth/frontend.

## What it does

- **Learn a brand** from a batch of its approved reference creatives (colors,
  typography, badge shapes, tone) — no manual design-system entry.
- **Generate static creatives** across a full set of standard ad formats
  (feed, story, banners…), with automatic multi-round QA (anatomy defects,
  character consistency, brand-fidelity vs. creative-freshness balance) and a
  code-rendered text/logo layer that's identical in quality on piece #1 and
  piece #200.
- **Generate copy** for new audiences from an existing spreadsheet brief, or
  from scratch, with an automatically enforced length contract per format.
- **Adapt an approved piece** to new formats/sizes (outpainting) while
  preserving its text and logo.
- **Build narrative carousels** (3–6 slides) with a consistent character
  across slides.
- **Produce a 3-clip video script** (with ready-to-paste prompts for
  text-to-video models) from a finished static piece.
- **Retouch** a generated piece with a plain-language correction instead of
  regenerating from scratch.

## Stack

- **Server**: Node.js + TypeScript, [Hono](https://hono.dev), streaming SSE
  for long-running generation jobs. See `packages/server`.
- **Client**: a single React + TypeScript component
  (`packages/client/src/DCOStudio.tsx`) you mount inside your existing app.
- **Default AI providers**: Anthropic Claude (copy/reasoning) + Google Gemini
  (image generation + multimodal QA) + optional OpenAI (`gpt-image-1`) as a
  second image engine — all swappable, see below.
- **Default persistence**: Supabase (Postgres + Storage) — swappable.

## Quick start

```bash
npm install
cp .env.example .env   # fill in your API keys — see below
npm run dev:server      # http://localhost:3001
npm run dev:client      # http://localhost:5173 — a minimal demo host app
```

Required for the default providers (see `.env.example` for the full list):

| Variable | What it's for |
|---|---|
| `ANTHROPIC_API_KEY` | copywriting / brief parsing / storyboards |
| `GEMINI_API_KEY` | image generation + QA + brand-identity extraction |
| `OPENAI_API_KEY` | optional second image engine |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | brand profiles, characters, stories, feedback, file storage |

Run `packages/server/src/db/schema.sql` once in your Supabase project's SQL
editor (creates tables + the two storage buckets it needs).

## Bring your own APIs

None of this is required. Every AI/storage dependency sits behind a small
interface in `packages/server/src/adapters/types.ts`:

- `ImageProvider` — paints/edits the base photograph
- `TextProvider` — copywriting, brief parsing, storyboards, QA verdicts, brand-identity extraction
- `StorageProvider` — binary file storage
- `DcoRepository` — brand profiles, characters, stories, feedback persistence

Implement whichever ones you want to replace, wire them in
`packages/server/src/index.ts`, and everything else — the prompt engineering,
the QA logic, the deterministic overlay renderer — keeps working unchanged.
Full guide: [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

## Repo layout

```
packages/
  server/
    src/
      adapters/           # provider interfaces + default implementations
        types.ts
        providers/         # gemini.ts, anthropic.ts, openaiImage.ts, supabase.ts
      services/            # overlay.ts, qa.ts, characters.ts, stories.ts, fontSetup.ts
      routes/dco.ts         # HTTP/SSE API — createDcoRoutes(providers)
      db/schema.sql         # default Supabase/Postgres schema
      index.ts              # server entrypoint — wires default providers from env
    fonts/                  # embedded display fonts used by the overlay renderer
  client/
    src/
      DCOStudio.tsx          # the component you mount in your app
      DemoApp.tsx            # minimal usage example
docs/
  ARCHITECTURE.md           # how the pipeline works and why
  INTEGRATION.md            # how to swap providers / mount the client
```

## License

Private. Not licensed for external use or redistribution.
