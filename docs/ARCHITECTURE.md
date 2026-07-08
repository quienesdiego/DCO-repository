# Architecture

DCO Studio generates on-brand ad creatives (static images, GIFs, video prompts,
narrative carousels) from a reference creative, optional product photos/logos,
and a copy brief. The design choices below are what make output consistent at
scale — read this before changing the pipeline.

## The core idea: one painter, one compositor

The image-generation model (`providers.image`) **only ever paints the
photograph** — scene, subject, product, lighting, brand-appropriate graphic
energy. It is explicitly instructed to render **zero text and zero logos**,
and its prompt never contains the real copy, only layout/style hints.

All text and logos are drawn afterwards, deterministically, in code
(`services/overlay.ts`, sharp + hand-built SVG + embedded display fonts).

Why: a diffusion/image model renders text correctly some of the time — it's a
coin flip. Splitting "paint the photo" from "place the exact text, in the
exact place, in the exact brand typeface" is the only way to get the same
quality on creative #1 and creative #200 of a batch.

If you're tempted to let the image model "just also draw the headline" —
don't. This split is why the QA anti-text gate exists (see below) and why
overlay zones (`BrandTextZone`) are percentage-based rectangles resolved
against the *final* composited frame, not something the model has to get
right on its own.

## Two-stage QA, one model pass, no arbitration

`services/qa.ts` runs two independent checks per candidate image:

1. **Deterministic (zero tokens)** — pure code, no AI call:
   - `checkImageHasNoText` — local OCR (tesseract.js) gate: did the "painter"
     disobey and write text anyway? Binary, verifiable, no judgment call.
   - `checkBrandColorPresence` — does the brand's signature color appear
     prominently, measured with CIEDE2000 perceptual color distance?
2. **A single AI pass** (`runQualityCheck`, via `providers.vision`) for
   whatever genuinely requires visual judgment: anatomy defects, character
   consistency, and a brand-fidelity vs. creative-freshness balance score.

Design rules worth preserving if you extend this:
- **Never run two models to arbitrate the same verdict.** One model, temperature
  0, strict JSON. If you need higher confidence, tighten the prompt or add a
  deterministic check — don't add a second opinion.
- **Fail-open on network/provider errors** for the AI pass (a timeout should
  never block delivery) but **fail-closed on hard rules** — a leaked layout
  label (e.g. the literal word "headline" rendered in the image) or a
  character mismatch always forces a retry, even if the model's own
  `passed` field says true.
- **Cap the score, don't just report it.** A holistic 100/100 is not possible
  if brand-fidelity or creative-freshness scores below it — see the score
  capping logic in `runQualityCheck`. This existed because models will
  happily give a generic, off-brand image a high overall score.

## Brand identity is data, not code

`dco_brand_profiles` (see `db/schema.sql`) stores a *learned* identity per
brand: typography descriptors, colors, badge shape, tone — extracted from a
batch of the brand's approved reference creatives via `POST /analyze-brand`
(a single `providers.vision` call with a large forensic-extraction prompt).

There is no hardcoded brand profile, category-specific product-interaction
logic, or client name anywhere in this codebase. When you integrate DCO
Studio, your brands live in your database, keyed by whatever profile ID your
host app already uses.

## Manual zones

`BrandTextZone` / `GraphicOverlayZone` are percentage-based rectangles (`{x,
y, w, h}` in 0–100) that tell the overlay compositor where to place each piece
of copy/logo on the *final* frame. They can be:
- Proposed automatically from `POST /analyze-brand`'s visual analysis, or
- Left at sensible per-format defaults.

Note: this port intentionally does not add drag-to-draw zone editing in the UI
— the upstream product this was extracted from documents the intent but never
shipped it either. See the `// TODO` in `packages/client/src/DCOStudio.tsx`.

## Pipeline (POST /api/dco/generate, the main endpoint)

```
1. Resolve brand identity      → saved profile, or on-the-fly extraction
                                  (providers.vision) if none exists yet
2. Sample real badge color     → pixel-level read of a marked zone on the
                                  reference image (sampleZoneDominantColor),
                                  never guessed by a vision model
3. Build a scene variant       → deterministic, code-only variation (time of
                                  day, composition) so a batch doesn't repeat
4. Build the image prompt      → brand rules + format + copy laid out as
                                  EMPTY placeholders (never real text) + a
                                  final "ZERO text, ZERO logos" instruction
5. Generate the photo          → providers.image / providers.imageAlt,
                                  retries on 429/503
6. QA, up to 3 rounds          → anti-text gate → single vision-model pass →
                                  keep the best-scoring attempt even if no
                                  attempt fully passes
7. Composite the brand layer   → services/overlay.ts — ALWAYS applied, even
                                  if QA never fully passed
8. Build the video prompt      → vision analysis of the FINAL composited
                                  image, then a text-provider pass to write a
                                  3-clip (10s each) video script
9. Stream results over SSE     → start → qa_retry* → qa_score* → result | error → done
```

## Provider adapters

Everything above depends only on the interfaces in
`packages/server/src/adapters/types.ts`:

| Interface | Job | Default implementation |
|---|---|---|
| `ImageProvider` | paint/edit the base photograph | Gemini (`adapters/providers/gemini.ts`), optionally OpenAI as `imageAlt` |
| `TextProvider` (as `text`) | copywriting, brief parsing, storyboards | Anthropic Claude |
| `TextProvider` (as `vision`) | QA verdicts, brand-identity extraction (multimodal + strict JSON) | Gemini |
| `StorageProvider` | binary storage (character photos, story slides) | Supabase Storage |
| `DcoRepository` | brand profiles, characters, stories, feedback | Supabase/Postgres |

See `docs/INTEGRATION.md` for how to replace any of these with your own stack.
