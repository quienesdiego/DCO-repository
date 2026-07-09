# Notes on this port

## Verbatim (byte-for-byte identical to `MUSE_dco_source`, SHA256-verified)

- `packages/server/src/routes/dco.ts` ← `backend/src/routes/dco.ts`
- `packages/server/src/services/dcoQa.ts` ← `backend/src/services/dcoQa.ts`
- `packages/server/src/services/dcoCharacters.ts` ← `backend/src/services/dcoCharacters.ts`
- `packages/server/src/services/dcoStories.ts` ← `backend/src/services/dcoStories.ts`
- `packages/server/src/services/dcoOverlay.ts` ← `backend/src/services/dcoOverlay.ts`
- `packages/server/src/services/fontSetup.ts` ← `backend/src/services/fontSetup.ts`
- `packages/server/src/services/supabase.ts` ← `backend/src/services/supabase.ts`
- `packages/server/supabase-dco.sql` ← `backend/supabase-dco.sql`
- `packages/server/fonts/*.ttf` ← `backend/fonts/*.ttf`
- `packages/client/src/DCOView.tsx` ← `views/DCOView.tsx`

`services/supabase.ts` is copied in full, including MUSE-specific
auth/session/token-usage/activity-logging functions (`registerUser`,
`getUserPermissions`, `logTokenUsage`, `CLIENT_ACCESS_MAP`, etc.) that have
nothing to do with DCO. They're harmless dead code here (nothing in
`routes/dco.ts` calls them) — left in rather than trimmed, in the interest of
"verbatim, not re-edited." Delete them if you don't want them.

## What's NEW (didn't exist in the source, had to be written to make this a standalone repo)

- `packages/server/src/index.ts` — the source's `backend/src/server.ts`
  mounts 7 unrelated route modules (search, analysis, aviatur, Corferias,
  health, agent, alert-mentions) that depend on services not included here.
  This bootstrap mounts **only** `/api/dco`, keeping the same middleware
  *behavior* (fontSetup-must-load-first, gzip compression, the `X-Muse-Key` /
  `API_SECRET` guard) but with CORS made configurable instead of hardcoded to
  MUSE's own Vercel/Render domains (keeping those literally would reject
  every request from your platform's origin).
- `packages/client/src/DemoApp.tsx` — a one-line mount point
  (`<DCOView />`), since `DCOView.tsx` takes no props and reads its config
  from `import.meta.env.VITE_API_URL` / `localStorage` directly, exactly like
  in the source app.
- `package.json` / `tsconfig.json` files, `.env.example`, this doc, the
  top-level README — packaging only, no logic.

## What was deliberately NOT ported

`backend/src/server.ts` also wires `logAndAlert()` (an email alert via Resend
on unauthorized API calls) and mounts routes for entirely different MUSE
features (search, competitor analysis, Corferias pacing dashboard, social
alert ingestion). None of that is part of DCO; porting it would require
copying unrelated services and env vars for no benefit to the creative-
generation pipeline. If you need it, copy the relevant route/service files
from `MUSE_dco_source` the same way this repo's `routes/dco.ts` was copied.

## Known behaviors carried over as-is (not bugs in this port — this is how production behaves)

- **Auth is opt-in.** The `X-Muse-Key` header is only checked if `API_SECRET`
  is set in the environment. `DCOView.tsx` never sends that header — in
  MUSE's own deployment, this is presumably handled by not setting
  `API_SECRET`, or by a layer in front of the backend that this repo doesn't
  include.
- **`BRAND_PROFILES.tarrito_rojo`** and the TV/fridge/motorcycle product-
  category interaction rules inside `buildPrompt` are real client data,
  copied verbatim. They only activate if a request selects that specific
  profile — the `generic` + learned-profile path
  (`POST /analyze-brand` → `dco_brand_profiles`) is what you want for your
  own brands.
- **Image providers**: Gemini (`gemini-3.1-flash-image-preview`, via raw
  `fetch` to the REST API — not the `@google/genai` SDK) is the primary
  generator; `gpt-image-2` (also raw `fetch`) is the alternate, selected per
  request via the `imageProvider` field. Both need their respective API keys
  set even if you only plan to use one, since some code paths (e.g.
  `/recreate-formats` banner handling) can fall back between them.

## Debugging "logo not respected" / garbage output

The logo is **never** sent to the image-generation model to draw — it's
composited afterward, pixel-perfect, by `compositeBrandLayer` in
`dcoOverlay.ts`, called unconditionally near the end of the `/generate`
handler in `routes/dco.ts` regardless of whether QA passed. If your logo
isn't showing up:

1. Confirm you're actually calling this repo's `/api/dco/generate` (not a
   leftover deployment of the old genericized version).
2. Check server logs for `[dcoOverlay]` warnings — a failed graphic-zone
   composite logs a warning and skips that logo but still returns the image,
   so a missing logo can fail silently unless you're watching logs.
3. Confirm the logo file you're uploading actually lands in the
   `logoImage` / `extraLogoImage[]` / `conglomerateLogoImage` form fields
   `routes/dco.ts` expects (see the endpoint table that was in the earlier
   analysis, or just read the top of the `/generate` handler in `dco.ts`).
4. If you're marking a manual logo zone, verify its `{x,y,w,h}` percentages
   in `manualZones` actually land inside the frame for the format you're
   generating — a zone with `x+w > 100` or similar will composite off-canvas.
