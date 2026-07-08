// ─── Manual/default overlay-zone resolution for /generate ────────────────────
// Generic: editorial default layouts per format family (not tied to any brand),
// plus the logic that folds user-marked zones (drawn on the reference image in
// the frontend) into the deterministic brand layer's zone list, and into the
// "keep these areas clean" instruction sent to the image model.
import type { BrandTextZone, ZoneBox } from '../../services/overlay.js';
import type { CopyFields } from './copy.js';

export type ManualZones = Record<string, ZoneBox>;

const BENEFIT_ZONE_RE = /^benefit_(\d+)$/;

// Copy elements (real text rendered by the deterministic brand layer) vs.
// graphic elements (a reference image the caller already uploaded, to be
// positioned) need a different phrasing in the "keep this area clean" prompt.
const TEXT_ZONE_LABEL: Record<string, string> = {
    headline: 'HEADLINE', subhead: 'SUBHEAD', chip: 'CHIP/BADGE', body: 'BODY', cta: 'CTA',
    // brand_name (a wordmark when no logo file was uploaded) is composed as TEXT
    // by code too, exactly like headline/subhead — it must never be left to the
    // image model to draw freely (uncontrolled size is how a wordmark ends up
    // occupying half the frame).
    brand_name: 'BRAND NAME/WORDMARK',
};

export function textZoneLabel(key: string): string | null {
    if (TEXT_ZONE_LABEL[key]) return TEXT_ZONE_LABEL[key];
    const m = key.match(BENEFIT_ZONE_RE);
    return m ? `BENEFIT BULLET #${m[1]}` : null;
}

const GRAPHIC_ZONE_LABEL: Record<string, string> = {
    character: 'CHARACTER/PERSON (the reference character photo, if provided)',
};

/** Real copy string for a given zone key — used both for the "render exactly this" instruction and the overlay fallback. */
export function textForZoneKey(key: string, copy: CopyFields): string | undefined {
    if (key === 'headline') return copy.headline;
    if (key === 'subhead') return copy.subhead;
    if (key === 'chip') return copy.chip;
    if (key === 'cta') return copy.cta;
    const m = key.match(BENEFIT_ZONE_RE);
    if (m) return copy.beneficios?.[parseInt(m[1], 10) - 1];
    return undefined;
}

// Editorial default layout per format family — used whenever the user hasn't
// hand-marked a zone for a given element, so generation still produces a
// consistent, readable layout without requiring manual zone drawing every time.
const FAMILY_DEFAULT_ZONES: Record<string, Record<string, ZoneBox>> = {
    square:    { headline: { x: 6, y: 13, w: 56, h: 17 }, subhead: { x: 6, y: 31, w: 50, h: 9 },  chip: { x: 64, y: 15, w: 24, h: 6 },   cta: { x: 24, y: 88, w: 52, h: 7 } },
    story:     { headline: { x: 8, y: 15, w: 84, h: 13 }, subhead: { x: 8, y: 29, w: 74, h: 7 },  chip: { x: 8, y: 9, w: 26, h: 4.5 },   cta: { x: 20, y: 88, w: 60, h: 5.5 } },
    portrait:  { headline: { x: 6, y: 13, w: 60, h: 15 }, subhead: { x: 6, y: 29, w: 52, h: 8 },  chip: { x: 64, y: 15, w: 24, h: 5.5 }, cta: { x: 24, y: 88, w: 52, h: 6.5 } },
    landscape: { headline: { x: 5, y: 16, w: 48, h: 20 }, subhead: { x: 5, y: 38, w: 42, h: 10 }, chip: { x: 5, y: 8, w: 18, h: 7 },     cta: { x: 5, y: 84, w: 30, h: 9 } },
    micro:     { headline: { x: 4, y: 8, w: 60, h: 30 },  subhead: { x: 4, y: 42, w: 55, h: 16 }, chip: { x: 68, y: 8, w: 28, h: 14 },   cta: { x: 66, y: 60, w: 30, h: 24 } },
};

function benefitDefaultZones(family: string, count: number): ZoneBox[] {
    const base = family === 'story' ? { x: 8, y: 52, w: 56, h: 6, gap: 2 }
        : family === 'landscape' ? { x: 5, y: 52, w: 38, h: 8.5, gap: 2.5 }
        : { x: 6, y: 47, w: 46, h: 7.5, gap: 2.2 };
    return Array.from({ length: count }, (_, i) => ({ x: base.x, y: base.y + i * (base.h + base.gap), w: base.w, h: base.h }));
}

const DEFAULT_BRAND_NAME_ZONE: ZoneBox = { x: 4, y: 4, w: 40, h: 10 };
export const DEFAULT_LOGO_ZONE: ZoneBox = { x: 76, y: 4, w: 20, h: 9 };
export const DEFAULT_CONGLOMERATE_LOGO_ZONE: ZoneBox = { x: 4, y: 4, w: 20, h: 9 };

/** Resolves the deterministic brand-layer text zones (headline/subhead/chip/cta/benefits/brand_name) for one task. */
export function resolveBrandTextZones(
    copy: CopyFields,
    family: string,
    manualZones: ManualZones,
    brandNameText: string | undefined,
    hasLogoFile: boolean,
): BrandTextZone[] {
    const d = FAMILY_DEFAULT_ZONES[family] || FAMILY_DEFAULT_ZONES.square;
    const zones: BrandTextZone[] = [];
    if (copy.headline) zones.push({ kind: 'headline', text: copy.headline, ...(manualZones.headline || d.headline) });
    if (copy.subhead)  zones.push({ kind: 'subhead',  text: copy.subhead,  ...(manualZones.subhead  || d.subhead) });
    if (copy.chip)     zones.push({ kind: 'chip',     text: copy.chip,     ...(manualZones.chip     || d.chip) });
    if (copy.cta)      zones.push({ kind: 'cta',      text: copy.cta,      ...(manualZones.cta      || d.cta) });

    let bens: string[] = Array.isArray(copy.beneficios) ? copy.beneficios.filter(Boolean) : [];
    if (!bens.length && copy.body) bens = String(copy.body).split('·').map((s: string) => s.trim()).filter(Boolean).slice(0, 4);
    const defs = benefitDefaultZones(family, bens.length);
    bens.forEach((b, i) => zones.push({ kind: 'benefit', text: b, index: i, ...(manualZones[`benefit_${i + 1}`] || defs[i]) }));

    if (!hasLogoFile && brandNameText && brandNameText.trim()) {
        zones.push({ kind: 'brand_name', text: brandNameText.trim(), ...(manualZones.brand_name || DEFAULT_BRAND_NAME_ZONE) });
    }
    return zones;
}

/** Builds the "these areas are user-pinned, don't touch them" instruction block for non-text (graphic) zones. */
export function buildManualZoneInstruction(manualZones: ManualZones, effectiveLogoZone?: ZoneBox, effectiveConglomerateLogoZone?: ZoneBox): string {
    const graphicZones: Record<string, ZoneBox> = {};
    for (const [key, z] of Object.entries(manualZones)) {
        if (textZoneLabel(key) === null && key !== 'logo' && key !== 'conglomerate_logo') graphicZones[key] = z;
    }
    if (effectiveLogoZone) graphicZones.logo = effectiveLogoZone;
    if (effectiveConglomerateLogoZone) graphicZones.conglomerate_logo = effectiveConglomerateLogoZone;

    const EXTRA_LOGO_RE = /^extra_logo_(\d+)$/;
    return Object.entries(graphicZones)
        .map(([key, z]) => {
            const posSpec = `exactly ${z.x.toFixed(1)}% from left, ${z.y.toFixed(1)}% from top, spanning ${z.w.toFixed(1)}% width and ${z.h.toFixed(1)}% height of the frame`;
            const extraLogoMatch = key.match(EXTRA_LOGO_RE);
            if (key === 'logo' || key === 'conglomerate_logo' || extraLogoMatch) {
                const label = key === 'logo' ? 'BRAND LOGO' : key === 'conglomerate_logo' ? 'CONGLOMERATE/PARENT COMPANY LOGO' : `ADDITIONAL BRAND BADGE ${extraLogoMatch![1]} (e.g. manufacturer lockup, compliance/certification icons)`;
                return `- ${label} AREA: keep this area (${posSpec}) visually clean and empty — no text, no shape, no placeholder mark, no invented logo/badge. Do NOT draw anything here yourself. The real image will be composited on top after generation with pixel-perfect precision.`;
            }
            if (key === 'character') {
                return `- CHARACTER/PERSON: position the character so they are anchored around ${z.x.toFixed(1)}%-${(z.x + z.w).toFixed(1)}% from left and ${z.y.toFixed(1)}%-${(z.y + z.h).toFixed(1)}% from top as their general placement in the frame. This is a user-specified ANCHOR AREA, not a hard crop box — the full body (head to feet) must STILL remain completely visible within the overall frame; expand beyond this area rather than cropping any body part. Anatomy/no-crop rules elsewhere in this prompt take priority over fitting exactly inside this box.`;
            }
            return `- ${GRAPHIC_ZONE_LABEL[key] || key.toUpperCase()}: place this element at ${posSpec}. This is a MANDATORY user-specified position — do NOT reposition, resize, or omit this element regardless of any other guidance elsewhere in this prompt.`;
        })
        .join('\n');
}
