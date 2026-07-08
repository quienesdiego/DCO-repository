/**
 * Deterministic brand layer — ALL text and logos on a creative are drawn here, in
 * code (sharp + SVG + embedded professional fonts), never by the image-generation
 * model. This is the only reliable way to get real consistency at scale: a diffusion
 * model sometimes renders text well and sometimes doesn't (it's a coin flip); this
 * layer puts the same text, in the same place, with the same style, every time.
 *
 * Real display fonts (Anton, Archivo Black, Barlow Condensed Black/Italic…),
 * registered via fontconfig, layered outlines (fill + stroke + outline), skewX for
 * aggressive italics, offset drop shadows, and bars/pills that match your reference
 * creative's geometry — all parametrized by the brand identity you feed in
 * (either a hand-authored BrandLayerStyle or one derived from an extracted identity
 * via deriveBrandLayerStyle).
 */
// Order matters: fontSetup registers FONTCONFIG_PATH and must run before sharp is
// loaded (the native binding captures the env var when its DLL loads).
import './fontSetup.js';
import sharp from 'sharp';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ZoneBox { x: number; y: number; w: number; h: number } // % of frame (0-100)

export type BrandZoneKind = 'headline' | 'subhead' | 'chip' | 'cta' | 'benefit' | 'brand_name';

export interface BrandTextZone extends ZoneBox {
    kind: BrandZoneKind;
    text: string;
    index?: number; // for benefits (benefit_1 → 0)
}

export interface GraphicOverlayZone extends ZoneBox {
    key: string;
    imageBase64: string;
    imageMime: string;
}

// Full visual style of the layer — derived from an extracted/learned brand identity.
// Every field has a usable default so a brand with no identity yet still produces a
// decent layer instead of a plain black box.
export interface BrandLayerStyle {
    headlineFont: string;
    headlineFill: string;
    headlineStroke: string | null;   // thick outer outline
    headlineOutline: string | null;  // thin secondary outline (between stroke and fill)
    headlineSkewDeg: number;         // 0 = upright; negative = forward italic
    headlineCase: 'upper' | 'as-is';
    subheadFont: string;
    subheadFill: string;
    benefitBarColor: string;         // bar behind benefit bullet text
    benefitTextColor: string;
    benefitIconColor: string;        // the "+" / bullet icon
    benefitSkewDeg: number;
    benefitFont: string;
    ctaBgColor: string;
    ctaTextColor: string;
    ctaShape: 'pill' | 'rect';
    ctaFont: string;
    chipBgColor: string;
    chipTextColor: string;
    accentColor: string;
}

/**
 * Default style used whenever an identity doesn't specify a given field. Swap this
 * out (or pass your own base into deriveBrandLayerStyle by pre-merging) to set your
 * own house style defaults.
 */
export const DEFAULT_STYLE: BrandLayerStyle = {
    headlineFont: 'Anton',
    headlineFill: '#FFFFFF',
    headlineStroke: '#000000',
    headlineOutline: null,
    headlineSkewDeg: 0,
    headlineCase: 'upper',
    subheadFont: 'Barlow Condensed',
    subheadFill: '#FFFFFF',
    benefitBarColor: '#111111',
    benefitTextColor: '#FFFFFF',
    benefitIconColor: '#FFC907',
    benefitSkewDeg: -6,
    benefitFont: 'Barlow Condensed',
    ctaBgColor: '#FFC907',
    ctaTextColor: '#111111',
    ctaShape: 'pill',
    ctaFont: 'Barlow Condensed',
    chipBgColor: '#FFC907',
    chipTextColor: '#111111',
    accentColor: '#FFC907',
}

function isHex(v: any): v is string { return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()); }
function hex(v: any, fallback: string): string { return isHex(v) ? v.trim() : fallback; }

// Approximate relative luminance — picks legible text/icon color over a given
// background when there's no real extracted badge and we have to improvise with
// the accent color.
function contrastText(bgHex: string): string {
    const m = /^#([0-9a-fA-F]{6})$/.exec(bgHex);
    if (!m) return '#FFFFFF';
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.55 ? '#111111' : '#FFFFFF';
}

// Real color of a zone in the reference image, read by code — never guessed by a
// vision model. The caller already marked the exact rectangle of the badge on the
// reference image when defining the zone; that pixel exists and can be read with
// plain math (same bucket-quantization trick as dominantHexColors, but restricted
// to the zone's crop instead of the full frame). Zero hallucination possible: it's
// the color that's actually there.
export async function sampleZoneDominantColor(referenceImageBase64: string, zone: ZoneBox): Promise<string | null> {
    try {
        const buf = Buffer.from(referenceImageBase64, 'base64');
        const meta = await sharp(buf).metadata();
        const w = meta.width || 0, h = meta.height || 0;
        if (!w || !h) return null;
        // Inset 12% per side: if the user's rectangle isn't perfectly tight around the
        // badge, this avoids sampling background/neighboring pixels right at the edge.
        const inset = 0.12;
        const zx = zone.x + zone.w * inset, zy = zone.y + zone.h * inset;
        const zw = zone.w * (1 - 2 * inset), zh = zone.h * (1 - 2 * inset);
        const left   = Math.max(0, Math.min(w - 1, Math.round((zx / 100) * w)));
        const top    = Math.max(0, Math.min(h - 1, Math.round((zy / 100) * h)));
        const width  = Math.max(1, Math.min(w - left, Math.round((zw / 100) * w)));
        const height = Math.max(1, Math.min(h - top,  Math.round((zh / 100) * h)));
        const { data, info } = await sharp(buf)
            .extract({ left, top, width, height })
            .resize(32, 32, { fit: 'inside' })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const buckets = new Map<string, { r: number; g: number; b: number; count: number }>();
        const step = 24;
        for (let i = 0; i + 2 < data.length; i += info.channels) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const key = `${Math.floor(r / step)}_${Math.floor(g / step)}_${Math.floor(b / step)}`;
            const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
            bucket.r += r; bucket.g += g; bucket.b += b; bucket.count++;
            buckets.set(key, bucket);
        }
        const dominant = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
        if (!dominant) return null;
        const toHex = (v: number) => Math.round(v / dominant.count).toString(16).padStart(2, '0');
        return `#${toHex(dominant.r)}${toHex(dominant.g)}${toHex(dominant.b)}`;
    } catch (e: any) {
        console.warn('[overlay] sampleZoneDominantColor failed (non-blocking, falling back to vision-extracted color):', e.message);
        return null;
    }
}

// Picks the closest embedded font to the forensic descriptors of the identity
// ("italic ultra-condensed Black" → Barlow Condensed BlackItalic, etc.). To bring
// your own fonts, edit this map (and the font files under packages/server/fonts,
// or point DCO_FONTS_DIR at your own folder — see fontSetup.ts).
function pickFont(t: any): { family: string; skewDeg: number } {
    const style  = String(t?.fontStyle  || '').toLowerCase();
    const width  = String(t?.fontWidth  || '').toLowerCase();
    const weight = String(t?.fontWeight || '').toLowerCase();
    const italic = style.includes('italic') || style.includes('oblique');
    const condensed = width.includes('condensed');
    const heavy = /black|ultra|extra/.test(weight);

    if (condensed && heavy) {
        // Barlow Condensed Black has a real italic; Anton doesn't (simulated with skew).
        return italic ? { family: 'Barlow Condensed', skewDeg: 0 } : { family: 'Anton', skewDeg: 0 };
    }
    if (condensed) return { family: 'Barlow Condensed', skewDeg: 0 };
    if (heavy)     return { family: 'Archivo Black', skewDeg: italic ? -8 : 0 };
    return { family: 'Barlow', skewDeg: italic ? -8 : 0 };
}

// Derives the full layer style from an identity JSON (saved profile or
// auto-extracted). Missing fields fall back to sane defaults.
export function deriveBrandLayerStyle(identity: any, sampledBenefitColor?: string | null): BrandLayerStyle {
    const s: BrandLayerStyle = { ...DEFAULT_STYLE };
    if (identity && typeof identity === 'object') {
    const typo = identity.typography || {};
    const accent = hex(identity.accentColor, hex(identity.primaryColor, s.accentColor));
    s.accentColor = accent;

    const h = typo.headline || {};
    const hFont = pickFont(h);
    s.headlineFont = hFont.family;
    s.headlineFill = hex(h.fillColor, s.headlineFill);
    s.headlineStroke = isHex(h.strokeColor) ? h.strokeColor : (isHex(h.outlineColor) ? h.outlineColor : s.headlineStroke);
    s.headlineOutline = isHex(h.outlineColor) && isHex(h.strokeColor) ? h.outlineColor : null;
    const hStyle = String(h.fontStyle || '').toLowerCase();
    s.headlineSkewDeg = (hStyle.includes('italic') || hStyle.includes('oblique')) ? -8 : hFont.skewDeg;
    s.headlineCase = String(h.case || '').toLowerCase().includes('all') ? 'upper' : (h.case ? 'as-is' : s.headlineCase);

    const sub = typo.subhead || {};
    s.subheadFont = pickFont(sub).family;
    s.subheadFill = hex(sub.fillColor, s.subheadFill);

    // If the identity analysis didn't detect any badge (common: the vision model
    // doesn't always recognize bands/pills as a "badge"), don't fall back to
    // DEFAULT_STYLE's generic black — use the brand's real accentColor (already
    // extracted with higher confidence) as the bar background, so the worst case
    // still reads as "on brand" instead of an unrelated black box.
    const badge = Array.isArray(identity.badges) && identity.badges.length ? identity.badges[0] : null;
    if (!badge) console.warn('[overlay] identity has no detected badges — using accentColor as benefit-bar fallback instead of default black');
    s.benefitBarColor  = hex(badge?.bgColor, accent);
    const barIsAccent = s.benefitBarColor.toLowerCase() === accent.toLowerCase();
    s.benefitTextColor = hex(badge?.textColor, contrastText(s.benefitBarColor));
    s.benefitIconColor = barIsAccent ? contrastText(s.benefitBarColor) : accent;
    // The real badge shape (extracted from the reference image) decides whether the
    // pill gets a diagonal cut or stays a straight rectangle/pill.
    const badgeShape = String(badge?.shape || '').toLowerCase();
    if (badge && !/diagonal|banner|ribbon/.test(badgeShape)) s.benefitSkewDeg = 0;

    const cta = typo.cta || {};
    s.ctaBgColor   = hex(cta.bgColor, accent);
    s.ctaTextColor = hex(cta.fillColor, s.ctaTextColor);
    s.ctaShape     = String(cta.buttonShape || '').toLowerCase() === 'rectangle' ? 'rect' : 'pill';
    s.ctaFont      = pickFont(cta).family;

    s.chipBgColor   = hex(badge?.bgColor, accent);
    s.chipTextColor = hex(badge?.textColor, s.chipTextColor);
    }

    // A color sampled from real pixels of the reference image (sampleZoneDominantColor)
    // is more reliable than any hex guessed by the vision model or the fallback accent
    // color — it's the actual pixel of the zone the caller marked. It always wins when
    // present, whether or not an identity/badge was detected. A badge is not always a
    // vivid color (e.g. it can legitimately be near-black) — don't discard a sample
    // just because it comes out dark. The "+" icon still uses the brand accentColor
    // unless the bar already IS that same accent, in which case it needs contrast
    // instead (or the icon would be invisible against the bar).
    if (isHex(sampledBenefitColor)) {
        s.benefitBarColor = sampledBenefitColor;
        s.benefitTextColor = contrastText(sampledBenefitColor);
        const barMatchesAccent = sampledBenefitColor.toLowerCase() === s.accentColor.toLowerCase();
        s.benefitIconColor = barMatchesAccent ? contrastText(sampledBenefitColor) : s.accentColor;
    }
    return s;
}

// ─── Render helpers ─────────────────────────────────────────────────────────

function escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Heuristic word-wrap (doesn't measure real glyphs — uses a per-family width factor).
function wrapText(text: string, maxWidthPx: number, fontSizePx: number, condensed: boolean): string[] {
    const avgCharWidth = fontSizePx * (condensed ? 0.44 : 0.56);
    const maxChars = Math.max(1, Math.floor(maxWidthPx / avgCharWidth));
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length > maxChars && current) { lines.push(current); current = word; }
        else current = candidate;
    }
    if (current) lines.push(current);
    return lines;
}

// Auto-fit: shrinks the font until the wrapped block fits the available height/width.
function fitText(text: string, maxWidthPx: number, maxHeightPx: number, startFontSize: number, condensed: boolean, minFontSize = 9): { fontSize: number; lines: string[] } {
    let fontSize = startFontSize;
    let lines = wrapText(text, maxWidthPx, fontSize, condensed);
    while (fontSize > minFontSize) {
        const lineHeight = fontSize * 1.08;
        const widest = Math.max(...lines.map(l => l.length)) * fontSize * (condensed ? 0.44 : 0.56);
        if (lines.length * lineHeight <= maxHeightPx && widest <= maxWidthPx) break;
        fontSize = Math.max(minFontSize, fontSize * 0.9);
        lines = wrapText(text, maxWidthPx, fontSize, condensed);
    }
    return { fontSize, lines };
}

const CONDENSED_FAMILIES = new Set(['Anton', 'Barlow Condensed', 'Bebas Neue']);

// Display text with layered outlines + shadow — the "designed" look of a real KV.
// Layers (back to front): offset shadow → thick outer stroke → thin outline → fill.
// skewX tilts the whole block.
function displayText(opts: {
    lines: string[]; fontSize: number; x: number; y: number; // y = baseline of first line
    font: string; fill: string; stroke?: string | null; outline?: string | null;
    skewDeg?: number; anchor?: 'start' | 'middle'; letterSpacing?: number;
    shadow?: boolean; weight?: number;
}): string {
    const { lines, fontSize, x, y, font, fill } = opts;
    const anchor = opts.anchor || 'start';
    const lineHeight = fontSize * 1.04;
    const ls = opts.letterSpacing ?? 0;
    const weight = opts.weight ?? 900;
    const tspans = lines.map((l, i) => `<tspan x="${x.toFixed(1)}" y="${(y + i * lineHeight).toFixed(1)}">${escapeXml(l)}</tspan>`).join('');
    const base = (extra: string) =>
        `<text text-anchor="${anchor}" font-family="${font}" font-weight="${weight}" font-size="${fontSize.toFixed(1)}" style="letter-spacing:${ls}px" ${extra}>${tspans}</text>`;
    const layers: string[] = [];
    if (opts.shadow !== false) {
        const d = Math.max(1.5, fontSize * 0.045);
        layers.push(`<g transform="translate(${d.toFixed(1)},${d.toFixed(1)})">${base(`fill="rgba(0,0,0,0.55)"`)}</g>`);
    }
    if (opts.stroke)  layers.push(base(`fill="none" stroke="${opts.stroke}" stroke-width="${(fontSize * 0.16).toFixed(1)}" stroke-linejoin="round"`));
    if (opts.outline) layers.push(base(`fill="none" stroke="${opts.outline}" stroke-width="${(fontSize * 0.07).toFixed(1)}" stroke-linejoin="round"`));
    layers.push(base(`fill="${fill}"`));
    const inner = layers.join('');
    const skew = opts.skewDeg || 0;
    if (!skew) return inner;
    // skew pivoted around the block's start so it doesn't shift position
    return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) skewX(${skew}) translate(${(-x).toFixed(1)},${(-y).toFixed(1)})">${inner}</g>`;
}

// Parallelogram (slanted rect) — the bar behind benefit bullets.
function slantedBar(x: number, y: number, w: number, h: number, skewDeg: number, fill: string, dx = 0, dy = 0): string {
    const skewPx = Math.tan((Math.abs(skewDeg) * Math.PI) / 180) * h;
    const dir = skewDeg <= 0 ? 1 : -1;
    const p = [
        [x + dir * skewPx + dx, y + dy],
        [x + w + dx, y + dy],
        [x + w - dir * skewPx + dx, y + h + dy],
        [x + dx, y + h + dy],
    ].map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    return `<polygon points="${p}" fill="${fill}" />`;
}

// The "+" bullet icon — drawn as a shape (two rects), NEVER as a font glyph (glyphs
// vary between fonts; the shape is always identical).
function plusIcon(cx: number, cy: number, size: number, fill: string, shadow = true): string {
    const arm = size * 0.32;
    const full = size;
    const sh = shadow ? `<g transform="translate(${(size * 0.08).toFixed(1)},${(size * 0.08).toFixed(1)})">
        <rect x="${(cx - arm / 2).toFixed(1)}" y="${(cy - full / 2).toFixed(1)}" width="${arm.toFixed(1)}" height="${full.toFixed(1)}" fill="rgba(0,0,0,0.45)"/>
        <rect x="${(cx - full / 2).toFixed(1)}" y="${(cy - arm / 2).toFixed(1)}" width="${full.toFixed(1)}" height="${arm.toFixed(1)}" fill="rgba(0,0,0,0.45)"/>
    </g>` : '';
    return `${sh}<rect x="${(cx - arm / 2).toFixed(1)}" y="${(cy - full / 2).toFixed(1)}" width="${arm.toFixed(1)}" height="${full.toFixed(1)}" fill="${fill}"/>
    <rect x="${(cx - full / 2).toFixed(1)}" y="${(cy - arm / 2).toFixed(1)}" width="${full.toFixed(1)}" height="${arm.toFixed(1)}" fill="${fill}"/>`;
}

// ─── Per-zone-type rendering ───────────────────────────────────────────────

function renderZone(z: BrandTextZone, style: BrandLayerStyle, width: number, height: number): string {
    const px = (z.x / 100) * width, py = (z.y / 100) * height;
    const pw = (z.w / 100) * width, ph = (z.h / 100) * height;
    const text = (z.kind === 'headline' || z.kind === 'brand_name') && style.headlineCase === 'upper' ? z.text.toUpperCase() : z.text;

    switch (z.kind) {
        case 'headline':
        case 'brand_name': {
            const condensed = CONDENSED_FAMILIES.has(style.headlineFont);
            const maxFs = Math.min(ph * 0.92, pw / Math.max(3, text.length * (condensed ? 0.34 : 0.45)) * 1.6);
            const { fontSize, lines } = fitText(text, pw, ph, Math.max(20, maxFs), condensed);
            const blockH = lines.length * fontSize * 1.04;
            const startY = py + Math.max(0, (ph - blockH) / 2) + fontSize * 0.82;
            return displayText({
                lines, fontSize, x: px, y: startY,
                font: style.headlineFont, fill: style.headlineFill,
                stroke: style.headlineStroke, outline: style.headlineOutline,
                skewDeg: style.headlineSkewDeg, letterSpacing: 0.5,
            });
        }
        case 'subhead': {
            const condensed = CONDENSED_FAMILIES.has(style.subheadFont);
            const { fontSize, lines } = fitText(text, pw, ph, Math.min(ph * 0.44, 34), condensed);
            const blockH = lines.length * fontSize * 1.14;
            const startY = py + Math.max(0, (ph - blockH) / 2) + fontSize * 0.82;
            return displayText({
                lines, fontSize, x: px, y: startY,
                font: style.subheadFont, fill: style.subheadFill,
                stroke: null, outline: null, weight: 700, shadow: true,
            });
        }
        case 'benefit': {
            // "+" icon + slanted bar + text.
            const iconSize = Math.min(ph * 0.85, pw * 0.16);
            const gap = iconSize * 0.28;
            const barX = px + iconSize + gap;
            const barW = pw - iconSize - gap;
            const barH = ph * 0.82;
            const barY = py + (ph - barH) / 2;
            const condensed = CONDENSED_FAMILIES.has(style.benefitFont);
            const { fontSize, lines } = fitText(text, barW * 0.82, barH * 0.8, barH * 0.56, condensed);
            const textY = barY + barH / 2 + fontSize * 0.34;
            const shadow = slantedBar(barX, barY, barW, barH, style.benefitSkewDeg, 'rgba(0,0,0,0.4)', barH * 0.09, barH * 0.09);
            const bar = slantedBar(barX, barY, barW, barH, style.benefitSkewDeg, style.benefitBarColor);
            const icon = plusIcon(px + iconSize / 2, py + ph / 2, iconSize, style.benefitIconColor);
            const label = displayText({
                lines: [lines.join(' ')], fontSize, x: barX + barW * 0.09, y: textY,
                font: style.benefitFont, fill: style.benefitTextColor,
                stroke: null, outline: null, shadow: false, weight: 900, letterSpacing: 0.8,
            });
            return shadow + bar + icon + label;
        }
        case 'cta': {
            const rx = style.ctaShape === 'pill' ? ph / 2 : ph * 0.12;
            const condensed = CONDENSED_FAMILIES.has(style.ctaFont);
            const { fontSize, lines } = fitText(text, pw * 0.86, ph * 0.72, ph * 0.46, condensed);
            const textY = py + ph / 2 + fontSize * 0.34;
            const shadow = `<rect x="${(px + ph * 0.07).toFixed(1)}" y="${(py + ph * 0.09).toFixed(1)}" width="${pw.toFixed(1)}" height="${ph.toFixed(1)}" rx="${rx.toFixed(1)}" fill="rgba(0,0,0,0.4)"/>`;
            const btn = `<rect x="${px.toFixed(1)}" y="${py.toFixed(1)}" width="${pw.toFixed(1)}" height="${ph.toFixed(1)}" rx="${rx.toFixed(1)}" fill="${style.ctaBgColor}"/>`;
            const label = displayText({
                lines: [lines.join(' ')], fontSize, x: px + pw / 2, y: textY,
                font: style.ctaFont, fill: style.ctaTextColor,
                stroke: null, outline: null, anchor: 'middle', shadow: false, weight: 900, letterSpacing: 0.6,
            });
            return shadow + btn + label;
        }
        case 'chip': {
            const rx = ph / 2;
            const { fontSize, lines } = fitText(text, pw * 0.84, ph * 0.7, ph * 0.44, false);
            const textY = py + ph / 2 + fontSize * 0.34;
            const pill = `<rect x="${px.toFixed(1)}" y="${py.toFixed(1)}" width="${pw.toFixed(1)}" height="${ph.toFixed(1)}" rx="${rx.toFixed(1)}" fill="${style.chipBgColor}"/>`;
            const label = displayText({
                lines: [lines.join(' ')], fontSize, x: px + pw / 2, y: textY,
                font: 'Barlow', fill: style.chipTextColor,
                stroke: null, outline: null, anchor: 'middle', shadow: false, weight: 700,
            });
            return pill + label;
        }
    }
}

export function buildBrandLayerSvg(zones: BrandTextZone[], style: BrandLayerStyle, width: number, height: number): string {
    const parts = zones.filter(z => z.text && z.text.trim()).map(z => renderZone({ ...z, text: z.text.trim() }, style, width, height)).join('\n');
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${parts}</svg>`;
}

// ─── Final composition ─────────────────────────────────────────────────────────

export async function compositeBrandLayer(
    baseImageBase64: string,
    baseMime: string,
    width: number,
    height: number,
    textZones: BrandTextZone[],
    graphicZones: GraphicOverlayZone[],
    style: BrandLayerStyle,
): Promise<{ base64: string; mime: string }> {
    try {
        let img = sharp(Buffer.from(baseImageBase64, 'base64')).resize(width, height, { fit: 'cover' });
        const composites: { input: Buffer; left: number; top: number }[] = [];

        for (const gz of graphicZones) {
            try {
                const px = Math.round((gz.x / 100) * width);
                const py = Math.round((gz.y / 100) * height);
                const pw = Math.max(1, Math.round((gz.w / 100) * width));
                const ph = Math.max(1, Math.round((gz.h / 100) * height));
                const resized = await sharp(Buffer.from(gz.imageBase64, 'base64'))
                    .resize(pw, ph, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .png()
                    .toBuffer();
                composites.push({ input: resized, left: px, top: py });
            } catch (e: any) {
                console.warn(`[overlay] Could not composite graphic zone "${gz.key}":`, e.message);
            }
        }

        if (textZones.some(z => z.text && z.text.trim())) {
            const svg = buildBrandLayerSvg(textZones, style, width, height);
            const textLayer = await sharp(Buffer.from(svg)).png().toBuffer();
            composites.push({ input: textLayer, left: 0, top: 0 });
        }

        if (composites.length > 0) img = img.composite(composites);
        const outBuf = await img.png().toBuffer();
        return { base64: outBuf.toString('base64'), mime: 'image/png' };
    } catch (e: any) {
        console.error('[overlay] Error compositing brand layer, returning original image:', e.message);
        return { base64: baseImageBase64, mime: baseMime };
    }
}

// ─── Compat: flat zone shape for simple manual-overlay callers ────────────────
export interface TextOverlayZone {
    key: string;
    text: string;
    x: number; y: number; w: number; h: number;
    color?: string;
    bgColor?: string;
    shape?: 'rect' | 'pill';
    icon?: string;
    align?: 'center' | 'left';
}

function kindFromKey(key: string): BrandZoneKind {
    if (key === 'headline') return 'headline';
    if (key === 'subhead') return 'subhead';
    if (key === 'chip') return 'chip';
    if (key === 'cta') return 'cta';
    return 'benefit';
}

export async function compositeManualOverlays(
    baseImageBase64: string,
    baseMime: string,
    width: number,
    height: number,
    textZones: TextOverlayZone[],
    graphicZones: GraphicOverlayZone[],
    style?: BrandLayerStyle,
): Promise<{ base64: string; mime: string }> {
    const brandZones: BrandTextZone[] = textZones.map(z => ({
        kind: kindFromKey(z.key), text: z.text, x: z.x, y: z.y, w: z.w, h: z.h,
    }));
    return compositeBrandLayer(baseImageBase64, baseMime, width, height, brandZones, graphicZones, style || DEFAULT_STYLE);
}
