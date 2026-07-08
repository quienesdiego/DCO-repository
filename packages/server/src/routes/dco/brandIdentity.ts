// ─── Brand identity extraction ("Learn brand") ────────────────────────────────
// Forensic, per-element visual analysis of a brand's reference images (colors,
// per-text-level typography, badges, icon row, layout grid, photography style).
// This is the ONE brand-learning path the generic system keeps — it produces a
// `dco_brand_profiles` row (via providers.repository.brandProfiles) instead of
// a hardcoded per-client identity block. Fully agnostic of any specific brand;
// ported unchanged from the source system aside from routing the model call
// through the `vision` TextProvider instead of a raw Gemini fetch.
import type { TextProvider, ImagePart } from '../../adapters/types.js';
import { extractJSON } from './jsonUtils.js';

export const KV_FORMAT_LABELS: Record<string, string> = {
    square:   'SQUARE POST (~1:1, e.g. 1080×1080)',
    vertical: 'STORY / VERTICAL (~9:16, e.g. 1080×1920)',
    portrait: 'FEED PORTRAIT (~4:5, e.g. 1080×1350)',
    banner:   'DISPLAY BANNER (wide/narrow, e.g. 970×250 or 300×600)',
    general:  'UNSPECIFIED FORMAT',
};

export interface LabeledReferenceImage extends ImagePart {
    formatLabel: string;
}

/**
 * Runs the forensic brand-identity extraction over 1+ reference images. Returns
 * the raw analysis JSON (colors, typography per text level, badges, icon row,
 * layout grid, `identityPrompt` — a long free-text creative-direction block —
 * `qaRules`, `productCategory`, etc.) as produced by the vision model.
 *
 * TextProvider.complete() takes a single flat `images` array (no per-image
 * interleaved text label like the raw Gemini `contents[].parts` array the
 * source system used) — so the per-image format labels are folded into the
 * prompt text as an explicit "image order" note instead.
 */
export async function analyzeBrandIdentity(
    vision: TextProvider,
    images: LabeledReferenceImage[],
    multiFormatNote: string,
): Promise<any> {
    const kvCount = images.length;
    const orderNote = images.map((img, i) => `Image ${i + 1} — format: ${img.formatLabel}`).join('\n');

    const analysisPrompt = `You are a forensic brand analyst and senior creative director. Your analysis feeds DIRECTLY into an AI image generator — every field must be so precise that the generator can recreate this brand's visual system without ever seeing the originals. Be a scientist, not a poet. Measure everything. Assume nothing.

I am providing ${kvCount} reference image(s) from a brand's advertising, each preceded by its format label below. Study ALL of them before writing a single word.

IMAGE ORDER (matches the order the images are attached in):
${orderNote}
${multiFormatNote}

═══════════════════════════════════════════
EXTRACTION PROTOCOL — cover every item below
═══════════════════════════════════════════

1. COLOR SYSTEM
   — Primary, secondary, accent: exact hex
   — Are backgrounds solid, gradient, or full-bleed photo?
   — If gradient: angle in degrees, all color stops with hex and %
   — Any color overlay on photos? (hex, opacity %, blend mode)
   — Dark overlay / vignette on photo? (direction, opacity)

2. TYPOGRAPHY — per text level, be forensic:
   — Font STYLE: upright | italic | oblique
   — Font WIDTH: ultra-condensed | condensed | normal | expanded
   — Font WEIGHT: Thin | Regular | SemiBold | Bold | ExtraBold | Black | Ultra-Black
   — Letter CASE: ALL_CAPS | Title_Case | lowercase | mixed
   — Letter SPACING: tight | normal | wide | extra-wide
   — STROKE: color hex, approximate width in px (for a 1080px canvas), inside/outside
   — OUTLINE: separate from stroke — is the letter outlined in another color?
   — SHADOW: direction (degrees), distance (px), blur (px), color hex, opacity %
   — GLOW: color hex, radius, opacity
   — FILL: solid color | gradient fill (list stops) | mixed colors within same word
   — SIZE relative to frame: estimate as % of frame height
   — Do this for: HEADLINE, SUBHEAD, BODY, CTA, BADGE/CHIP, LOGO TEXT, TAGLINE separately

3. LAYOUT GRID (as % of frame height)
   — Zone 0–25%: what lives here, exact positions
   — Zone 25–50%: what lives here
   — Zone 50–75%: what lives here
   — Zone 75–100%: what lives here
   — Is the grid symmetric or asymmetric?
   — Safe margins from all 4 edges (in %)

4. BRAND BAND (if exists)
   — Color or gradient (exact)
   — Position: top | bottom | left | right | none
   — Height as % of frame
   — Contents from left to right: logo? tagline? website? icons? CTA?
   — Border or edge treatment?

5. LOGO & SECONDARY MARKS
   — Is the main brand name rendered as a LOGOTYPE (custom lettering) or standard font?
   — If logotype: describe the lettering style exactly (italic script, geometric, hand-drawn, etc.)
   — Color and color treatment (full color | white | monochrome | gradient)
   — Position: which corner, distance from edges in %
   — Size: % of frame width
   — Any containing shape (box, pill, halo)?
   — Secondary logos, partner logos, legal marks: same extraction

6. BADGES, PILLS, CHIPS, BANNERS
   — For EACH badge/pill/chip visible:
     • Shape (pill | rectangle | circle | diagonal-banner | ribbon)
     • Background color hex
     • Text color hex, font weight, case
     • Text content (what does it say?)
     • Position in frame (zone + corner)
     • Any icon inside or next to it?
   — If none: write "none"

7. ICON ROW / FEATURE SPECS ROW
   — Is there a row of icons with feature/spec labels? (common in tech, auto, pharma brands)
   — If yes: position (top/bottom/inside band), number of icons, icon color, text color, text size
   — Icon style: outline | filled | circular-bg | square-bg
   — Background of icon row: transparent | solid color hex
   — Describe icon types visible

8. PHOTO / SCENE COMPOSITION
   — Background treatment: full-bleed photo | solid color | gradient | hybrid
   — Photo overlay: dark gradient (direction, opacity) | color tint (hex, %) | none
   — Speed lines / motion blur / light trails: yes/no, color, direction
   — Subject: solo person | group | product only | person+product | environment only
   — Subject size: % of frame height
   — Product position: center | left | right | dominant foreground | background prop
   — Camera angle: eye-level | low-angle | overhead | 3/4 view
   — Lighting: direction, color temperature, hard/soft, dramatic/natural
   — Color grade: warm cinematic | cool desaturated | vivid high-contrast | dark moody | clean flat

9. DECORATIVE ELEMENTS
   — Geometric patterns: type (lines/dots/grid/hexagons), color, opacity, location
   — Swooshes, curves, dividers, frames: color, position, size
   — Particle effects, sparks, light flares: color, density, location
   — Any texture overlays: type, opacity

10. COPY STRUCTURE (read what the reference actually says)
    — List EVERY text element visible from top to bottom
    — For each: exact text content | font treatment summary | position in frame

Return ONLY valid JSON — no markdown fences, no text outside the JSON:
{
  "brandName": "exact brand name as it appears in the logo",
  "primaryColor": "#hex",
  "secondaryColor": "#hex or null",
  "accentColor": "#hex",
  "gradientSystem": "describe ALL gradients: element, angle, color stops with hex and %. Write 'none' if no gradients.",
  "overlaySystem": "photo color overlay: hex, opacity %, blend mode. Dark gradient: direction, start opacity, end opacity. Write 'none' if absent.",
  "bandColor": "#hex or gradient description",
  "bandPosition": "top | bottom | left | right | none",
  "bandHeightPercent": 0,
  "backgroundTreatment": "full-bleed-photo | solid-color | gradient | photo-with-overlay | hybrid",
  "photoOverlay": "Describe the overlay on the photo: dark vignette (opacity, direction), color tint (hex, %), speed lines (color, direction), light flares — or write 'none'",
  "speedLines": "none | describe: color, direction, opacity, density — present in high-energy brands",
  "typography": {
    "headline": {
      "fontStyle": "upright | italic | oblique",
      "fontWidth": "ultra-condensed | condensed | normal | expanded",
      "fontWeight": "Black | ExtraBold | Bold | SemiBold | Regular",
      "case": "ALL_CAPS | Title_Case | lowercase | mixed",
      "letterSpacing": "tight | normal | wide | extra-wide",
      "fillColor": "#hex — main text fill color",
      "fillType": "solid | gradient | mixed-colors-per-word",
      "fillGradient": "if gradient fill: angle, color stops with hex and % — else null",
      "strokeColor": "#hex or null",
      "strokeWidthPx": 0,
      "outlineColor": "#hex or null — secondary outline if different from stroke",
      "shadowDirection": "angle in degrees or null",
      "shadowDistancePx": 0,
      "shadowBlurPx": 0,
      "shadowColor": "#hex or null",
      "glowColor": "#hex or null",
      "glowRadiusPx": 0,
      "sizePercentOfFrameHeight": 0,
      "maxWidthPercent": 0,
      "notes": "any additional visual detail about this text treatment"
    },
    "subhead": {
      "fontStyle": "upright | italic | oblique",
      "fontWidth": "ultra-condensed | condensed | normal | expanded",
      "fontWeight": "Black | ExtraBold | Bold | SemiBold | Regular",
      "case": "ALL_CAPS | Title_Case | lowercase | mixed",
      "fillColor": "#hex",
      "fillType": "solid | gradient | mixed-colors-per-word",
      "strokeColor": "#hex or null",
      "strokeWidthPx": 0,
      "shadowColor": "#hex or null",
      "sizePercentOfFrameHeight": 0,
      "notes": ""
    },
    "body": {
      "fontStyle": "upright | italic | oblique",
      "fontWidth": "normal | condensed | expanded",
      "fontWeight": "Regular | SemiBold | Bold",
      "case": "mixed | ALL_CAPS",
      "fillColor": "#hex",
      "strokeColor": "#hex or null",
      "sizePercentOfFrameHeight": 0
    },
    "cta": {
      "fontStyle": "upright | italic",
      "fontWeight": "Bold | ExtraBold | Black",
      "case": "ALL_CAPS | Title_Case",
      "fillColor": "#hex",
      "bgColor": "#hex or null — button background",
      "buttonShape": "pill | rectangle | none",
      "strokeColor": "#hex or null",
      "sizePercentOfFrameHeight": 0
    },
    "logo": {
      "type": "logotype | wordmark | symbol+wordmark",
      "style": "Describe lettering style: italic script, geometric sans, hand-lettered, condensed bold, custom display — be specific",
      "fillColor": "#hex or 'gradient' or 'multicolor'",
      "fillDetail": "If gradient or multicolor: describe exactly",
      "strokeColor": "#hex or null",
      "strokeWidthPx": 0,
      "shadowOrGlow": "describe or null"
    },
    "tagline": {
      "text": "exact tagline text if visible",
      "fontWeight": "Regular | Bold | SemiBold",
      "fillColor": "#hex",
      "sizePercentOfFrameHeight": 0,
      "position": "inside band | below logo | top of frame | none"
    }
  },
  "badges": [
    {
      "text": "exact text content of badge",
      "shape": "pill | rectangle | circle | diagonal-banner | ribbon",
      "bgColor": "#hex",
      "textColor": "#hex",
      "textWeight": "Bold | ExtraBold | Black",
      "textCase": "ALL_CAPS | Title_Case",
      "hasIcon": false,
      "position": "zone + corner description",
      "verticalPercent": 0
    }
  ],
  "iconRow": {
    "present": false,
    "position": "bottom-inside-band | bottom-above-band | top | none",
    "verticalPercent": 0,
    "iconCount": 0,
    "iconStyle": "outline | filled | circular-bg | square-bg",
    "iconColor": "#hex",
    "textColor": "#hex",
    "textSize": "small | medium",
    "bgColor": "#hex or transparent",
    "description": "Describe what the icons represent and how they're laid out"
  },
  "decorativeElements": "Describe any speed lines, particle effects, light flares, swooshes, geometric patterns, textures — color, position, opacity. Write 'none' if clean.",
  "textZones": {
    "headline": {
      "zone": "inside-band | photo-overlay-top | photo-overlay-center | photo-overlay-bottom | solid-bg-area",
      "verticalPercent": 0,
      "horizontalAlignment": "center | left | right",
      "maxWidthPercent": 0
    },
    "subhead": {
      "zone": "inside-band | photo-overlay-top | photo-overlay-center | photo-overlay-bottom | none",
      "verticalPercent": 0,
      "horizontalAlignment": "center | left | right"
    },
    "body": {
      "zone": "inside-band | photo-overlay | solid-bg-area | none",
      "verticalPercent": 0,
      "horizontalAlignment": "center | left | right"
    },
    "cta": {
      "zone": "inside-band | standalone-button | pill-float | none",
      "verticalPercent": 0,
      "horizontalAlignment": "center | right | left"
    },
    "chip": {
      "zone": "inside-band | top-corner | photo-overlay | none",
      "verticalPercent": 0,
      "horizontalAlignment": "center | left | right"
    }
  },
  "logoPosition": "top-left | top-right | bottom-left | bottom-right | inside-band-left | inside-band-right | inside-band-center | center",
  "logoSizePercent": 0,
  "layoutDescription": "Describe EVERY zone of the frame by % of height: what lives there, exact element positions, stacking order, spacing rules, safe margins from each edge.",
  "copyStructure": "List every text element top to bottom with its exact content, font treatment summary, and zone. This is the visual reading order of the ad.",
  "photographyStyle": "Subject type and demographics, camera angle and focal length feel, lighting recipe (direction, temperature, quality), color grade, background environment, depth of field, energy level, any special photographic effects.",
  "productPosition": "center | right | left | dominant-foreground | background-prop | not-shown",
  "productSilhouette": "Any outline/silhouette/glow effect around the product: color, opacity, style — or 'none'",
  "certificationSeals": "Describe any official seals, safety marks, quality certifications: shape, color, text, exact position — or 'none'",
  "identityPrompt": "Write exactly 600 words of ultra-precise creative direction FOR AN AI IMAGE GENERATOR that has NEVER seen this brand before. Use these exact labeled sections with this exact structure:\\n\\nBRAND ESSENCE: In 2 sentences, what is the visual personality of this brand? What emotion does it project?\\n\\nCOLOR SYSTEM: List every color with its hex code and exactly which element uses it. Include gradient angles and stops. Include photo overlay colors and opacities.\\n\\nTYPOGRAPHY — THE MOST CRITICAL SECTION: For each text level (HEADLINE, SUBHEAD, BODY, CTA, LOGO, TAGLINE) write: font style (italic/upright), font width (ultra-condensed/normal), font weight, letter case, fill color and treatment (solid/gradient/multi-color), stroke color and width, shadow direction/distance/color, glow color if any, approximate size as % of frame height. If the brand uses italic ultra-condensed heavy fonts — say exactly that. If the headline has a red stroke on white fill — say exactly that.\\n\\nLAYOUT ARCHITECTURE: Describe the frame in zones (top 0-25%, 25-50%, 50-75%, bottom 75-100%). State exactly what element lives in each zone, its position, size, and stacking order. Include safe margins.\\n\\nBRAND BAND: If present — color or gradient (exact stops), position, height %, all elements inside from left to right, any border treatment.\\n\\nBADGES AND PILLS: For each badge/pill — shape, background color, text color, font weight, case, position, content type.\\n\\nICON ROW: If present — position, number of icons, style, colors, what they represent. If absent — write NONE.\\n\\nPHOTO AND SCENE DIRECTION: Subject demographics, camera angle, lighting recipe (direction, kelvin temperature, hard/soft), color grade, required environment types that match the brand, energy level, depth of field. Any motion blur, speed lines, or atmospheric effects.\\n\\nDECORATIVE SYSTEM: Speed lines, particles, swooshes, geometric patterns — colors, opacity, position. Write NONE if the brand is clean.\\n\\nFIXED NON-NEGOTIABLE ELEMENTS: List every element that MUST appear in every execution — logo position and size, specific marks, seals, taglines, icon rows — anything that would make the ad look wrong if missing.\\n\\nNEVER GENERATE: List the top 8 specific things an AI image generator gets wrong for this brand style — wrong font treatment, wrong colors, wrong layout, generic-looking elements to avoid.",
  "productCategory": "Free-text product/industry category as it applies to this brand (e.g. beverage, apparel, electronics, automotive, financial, telecom, pharma) — describe it, don't pick from a fixed list.",
  "productSubcategory": "Specific subcategory in free text.",
  "productBenefits": ["Array of 3-6 specific product features, technologies, or claims visible in the reference images. Use the real names as they appear in the copy or packaging."],
  "brandDNA": ["5 absolute visual rules that appear in EVERY reference image — the non-negotiable fingerprints of this brand. Write each as a complete actionable sentence for an image generator."],
  "negativePrompt": "List 10-12 things that must NEVER appear in images for this brand: wrong colors, wrong font treatments, wrong layouts, generic AI mistakes. Format as comma-separated items.",
  "qaRules": ["Write 12 specific verifiable visual rules an AI QA system can check by looking at a generated image. Format: RULE_ID: what must be true. Cover logo position, color accuracy, typography treatment, band presence, badge rendering, text legibility, prohibited elements."]
}`;

    const text = await vision.complete({
        prompt: analysisPrompt,
        images: images.map(img => ({ base64: img.base64, mimeType: img.mimeType })),
        temperature: 0.1,
        jsonMode: true,
        maxTokens: 65536,
    });

    try {
        return JSON.parse(text);
    } catch {
        const jsonMatch = extractJSON(text);
        if (jsonMatch) return JSON.parse(jsonMatch);
        throw new Error('No se pudo extraer JSON del análisis: ' + text.slice(0, 300));
    }
}

/**
 * Converts what analyzeBrandIdentity already extracted (each text element's
 * position/alignment, logo position/size, each badge's position) into a first
 * draft of overlay zones (% of frame) so the user can drag-adjust instead of
 * drawing from a blank sheet. Heuristic (the identity schema is descriptive,
 * not exact coordinates) but a real starting point based on THEIR reference
 * image, not a generic template shared by every brand.
 */
export function deriveProposedZones(identity: any): Record<string, { x: number; y: number; w: number; h: number }> {
    const zones: Record<string, { x: number; y: number; w: number; h: number }> = {};
    if (!identity || typeof identity !== 'object') return zones;

    const DEFAULT_H: Record<string, number> = { headline: 15, subhead: 8, chip: 6, cta: 7 };
    const tz = identity.textZones || {};
    for (const key of ['headline', 'subhead', 'chip', 'cta']) {
        const t = tz[key];
        if (!t || !t.zone || t.zone === 'none') continue;
        const h = DEFAULT_H[key];
        const w = typeof t.maxWidthPercent === 'number' && t.maxWidthPercent > 0 ? t.maxWidthPercent : (key === 'headline' ? 56 : key === 'subhead' ? 50 : 24);
        const align = String(t.horizontalAlignment || 'left').toLowerCase();
        const x = align === 'right' ? Math.max(2, 96 - w) : align === 'center' ? Math.max(2, (100 - w) / 2) : 6;
        const yCenter = typeof t.verticalPercent === 'number' ? t.verticalPercent : (key === 'headline' ? 20 : key === 'subhead' ? 35 : key === 'cta' ? 88 : 15);
        const y = Math.max(1, Math.min(98 - h, yCenter - h / 2));
        zones[key] = { x, y, w, h };
    }

    const logoPosMap: Record<string, { x: number; y: number }> = {
        'top-left': { x: 4, y: 4 }, 'top-right': { x: 76, y: 4 },
        'bottom-left': { x: 4, y: 84 }, 'bottom-right': { x: 76, y: 84 },
        'center': { x: 32, y: 40 },
        'inside-band-left': { x: 4, y: 84 }, 'inside-band-right': { x: 76, y: 84 }, 'inside-band-center': { x: 32, y: 84 },
    };
    const logoAnchor = logoPosMap[String(identity.logoPosition || '').toLowerCase().trim()];
    if (logoAnchor) {
        const sizePct = Number(identity.logoSizePercent);
        const w = Number.isFinite(sizePct) && sizePct > 0 ? Math.min(70, Math.max(10, sizePct)) : 20;
        zones.logo = { x: logoAnchor.x, y: logoAnchor.y, w, h: w * 0.42 };
    }

    const badges = Array.isArray(identity.badges) ? identity.badges.slice(0, 6) : [];
    badges.forEach((b: any, i: number) => {
        const y = typeof b?.verticalPercent === 'number' ? b.verticalPercent : 50 + i * 8;
        zones[`benefit_${i + 1}`] = { x: 6, y: Math.max(1, Math.min(92, y - 3)), w: 36, h: 6.5 };
    });

    return zones;
}

/** Derives a default logo overlay zone from a learned identity's logoPosition/logoSizePercent, or null if absent. */
export function deriveDefaultLogoZone(identity: any): { x: number; y: number; w: number; h: number } | null {
    if (!identity || typeof identity !== 'object') return null;
    const posMap: Record<string, { x: number; y: number }> = {
        'top-left': { x: 4, y: 4 }, 'top-right': { x: 76, y: 4 },
        'bottom-left': { x: 4, y: 84 }, 'bottom-right': { x: 76, y: 84 },
        'center': { x: 32, y: 40 },
        'inside-band-left': { x: 4, y: 84 }, 'inside-band-right': { x: 76, y: 84 }, 'inside-band-center': { x: 32, y: 84 },
    };
    const anchor = posMap[String(identity.logoPosition || '').toLowerCase().trim()];
    if (!anchor) return null;
    const sizePct = Number(identity.logoSizePercent);
    const w = Number.isFinite(sizePct) && sizePct > 0 ? Math.min(70, Math.max(10, sizePct)) : 20;
    return { x: anchor.x, y: anchor.y, w, h: w * 0.42 };
}
