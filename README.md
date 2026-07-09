# DCO Studio

A **verbatim, byte-for-byte port** of MUSE's DCO (Dynamic Creative Optimization)
module — the AI ad-creative generation engine (routes/dco.ts + its services)
and its React frontend (DCOView.tsx), copied directly from production with
zero rewriting of the actual generation logic.

> Earlier versions of this repo tried to genericize/adapt the code to a
> provider-agnostic adapter layer. That port introduced real bugs (logo
> compositing broke, generation produced garbage) because a 5,000+ line
> pipeline was mechanically rewritten instead of copied. This version throws
> that away and copies the original source files as-is — see
> [`docs/NOTES.md`](docs/NOTES.md) for exactly what's verbatim vs. what
> (minimally) had to change to make it a standalone repo.

## What's here

```
packages/server/
  src/
    routes/dco.ts              ← verbatim copy of backend/src/routes/dco.ts
    services/dcoQa.ts          ← verbatim
    services/dcoCharacters.ts  ← verbatim
    services/dcoStories.ts     ← verbatim
    services/dcoOverlay.ts     ← verbatim
    services/fontSetup.ts      ← verbatim
    services/supabase.ts       ← verbatim
    index.ts                   ← NEW: minimal bootstrap (see docs/NOTES.md)
  fonts/                       ← the embedded display fonts (Anton, Barlow…)
  supabase-dco.sql             ← verbatim DB schema
packages/client/
  src/
    DCOView.tsx                ← verbatim copy of views/DCOView.tsx
    DemoApp.tsx                ← NEW: mounts <DCOView /> (it takes no props)
```

Every file marked "verbatim" is byte-for-byte identical to the source —
verified with SHA256 at copy time. Nothing about prompts, QA logic, overlay
rendering, or the frontend UI was changed.

## Quick start

```bash
npm install
cp .env.example .env   # fill in your keys — see .env.example, names match the original exactly
npm run dev:server      # http://localhost:3001
npm run dev:client       # http://localhost:5173
```

Run `packages/server/supabase-dco.sql` once in your Supabase SQL editor, and
create the two storage buckets it needs (`dco-characters`, `dco-stories`,
both public-read) — the SQL file doesn't create buckets, same as the original.

## Before you integrate this into your platform, read this

Because this is a **verbatim** copy, it carries over things that only made
sense inside MUSE and will need your attention:

1. **Hardcoded brand profile.** `routes/dco.ts` still contains
   `BRAND_PROFILES.tarrito_rojo` (a real client's brand identity + ~45 scene
   prompts) and product-category interaction rules for TVs/fridges/motorcycles
   specific to that client. If your integration doesn't select that profile,
   it's inert — but it's still in the file. There is also a `generic` /
   learned-profile path (`POST /analyze-brand` → `dco_brand_profiles` table)
   that works for any brand — **use that path**, not the hardcoded one.
2. **`DCOView.tsx` is MUSE's actual UI**, in Spanish, with MUSE's red
   (`#E30613`) hardcoded in dozens of inline styles, MUSE's production URL as
   the fallback `BACKEND_URL`, and `localStorage.getItem('muse_user')` for the
   logged-in user's email. None of that is parameterized. Point
   `VITE_API_URL` at your backend and either accept MUSE's look-and-feel or
   fork the component to restyle it.
3. **Env var names match the original exactly** — see `.env.example`.
4. See [`docs/NOTES.md`](docs/NOTES.md) for the full list of what's verbatim,
   what changed and why, and known behaviors (e.g. `X-Muse-Key` auth is a
   no-op unless `API_SECRET` is set — the frontend never sends that header).

## About your logo/garbage-output issue

If pieces aren't respecting an uploaded logo or the output looks broken, that
almost certainly traces back to the genericized code from the previous
version of this repo, not this verbatim one. If it still happens on this
version, it's a real bug (or a config/env issue) worth debugging directly
against the original pipeline logic — see `services/dcoOverlay.ts`
(`compositeBrandLayer`, called unconditionally at the end of `/generate` in
`routes/dco.ts`) for exactly how the logo is composited, and check the server
logs for `[dcoOverlay]` warnings.
