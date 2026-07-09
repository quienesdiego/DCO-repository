/**
 * Capa de marca determinística — TODO el texto y los logos de un creativo se dibujan
 * acá, con código (sharp + SVG + fuentes profesionales embebidas), nunca por el modelo
 * de imagen. Es la única forma de garantizar consistencia real en producción masiva:
 * un modelo de difusión a veces escribe bien y a veces no (ruleta); esta capa pone lo
 * mismo, en el mismo lugar, con el mismo estilo, siempre.
 *
 * El "sale plano" del intento anterior se debía a Arial del sistema + relleno plano.
 * Ahora: fuentes display reales (Anton, Archivo Black, Barlow Condensed Black/Italic…)
 * registradas vía fontconfig, contornos en capas (fill + stroke + outline), inclinación
 * skewX para itálicas agresivas, sombras desplazadas y barras/pills con la geometría
 * del KV — todo parametrizado por la identidad extraída de la marca.
 */
// El orden importa: fontSetup registra FONTCONFIG_PATH y debe ejecutarse antes de que
// se cargue sharp (la librería nativa captura el env al cargar su DLL).
import './fontSetup.js';
import sharp from 'sharp';

// ─── Tipos ─────────────────────────────────────────────────────────────────────

export interface ZoneBox { x: number; y: number; w: number; h: number } // % del frame (0-100)

export type BrandZoneKind = 'headline' | 'subhead' | 'chip' | 'cta' | 'benefit' | 'brand_name';

export interface BrandTextZone extends ZoneBox {
    kind: BrandZoneKind;
    text: string;
    index?: number; // para benefits (benefit_1 → 0)
}

export interface GraphicOverlayZone extends ZoneBox {
    key: string;
    imageBase64: string;
    imageMime: string;
}

// Estilo visual completo de la capa — derivado de la identidad de marca extraída
// (analyze-brand / auto-extracción del KV). Todo tiene default utilizable para que
// una marca sin identidad igual produzca una capa digna, no una caja negra.
export interface BrandLayerStyle {
    headlineFont: string;
    headlineFill: string;
    headlineStroke: string | null;   // contorno exterior grueso
    headlineOutline: string | null;  // segundo contorno fino (entre stroke y fill)
    headlineSkewDeg: number;         // 0 = recto; negativo = itálica hacia adelante
    headlineCase: 'upper' | 'as-is';
    subheadFont: string;
    subheadFill: string;
    benefitBarColor: string;         // barra detrás del texto de beneficio
    benefitTextColor: string;
    benefitIconColor: string;        // el "+" / badge a la izquierda
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

const DEFAULT_STYLE: BrandLayerStyle = {
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

// Luminancia relativa aproximada — para elegir texto/ícono legible sobre un fondo dado
// cuando no hay badge real extraído del KV y hay que improvisar con el color de acento.
function contrastText(bgHex: string): string {
    const m = /^#([0-9a-fA-F]{6})$/.exec(bgHex);
    if (!m) return '#FFFFFF';
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.55 ? '#111111' : '#FFFFFF';
}

// Color real de una zona del KV, leído por código — no adivinado por un modelo de visión.
// El usuario ya marcó el rectángulo exacto del badge sobre el KV al definir la zona de
// beneficio; ese pixel existe y se puede leer con matemática pura (mismo truco de
// cuantización por buckets que dominantHexColors, pero restringido al recorte de la zona
// en vez del frame completo). Cero alucinación posible: es el color que hay ahí, punto.
export async function sampleZoneDominantColor(kvBase64: string, zone: ZoneBox): Promise<string | null> {
    try {
        const buf = Buffer.from(kvBase64, 'base64');
        const meta = await sharp(buf).metadata();
        const w = meta.width || 0, h = meta.height || 0;
        if (!w || !h) return null;
        // Margen hacia adentro (12% por lado): si el rectángulo que marcó el usuario no
        // quedó perfectamente ajustado al badge, evita leer píxeles del fondo/foto vecina
        // que están justo en el borde de la zona marcada.
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
        console.warn('[dcoOverlay] sampleZoneDominantColor falló (no bloqueante, se sigue con el color extraído por visión):', e.message);
        return null;
    }
}

// Elige la fuente embebida que más se parece a los descriptores forenses de la
// identidad ("italic ultra-condensed Black" → Barlow Condensed BlackItalic, etc.).
function pickFont(t: any): { family: string; skewDeg: number } {
    const style  = String(t?.fontStyle  || '').toLowerCase();
    const width  = String(t?.fontWidth  || '').toLowerCase();
    const weight = String(t?.fontWeight || '').toLowerCase();
    const italic = style.includes('italic') || style.includes('oblique');
    const condensed = width.includes('condensed');
    const heavy = /black|ultra|extra/.test(weight);

    if (condensed && heavy) {
        // Barlow Condensed Black tiene itálica real; Anton no (se simula con skew)
        return italic ? { family: 'Barlow Condensed', skewDeg: 0 } : { family: 'Anton', skewDeg: 0 };
    }
    if (condensed) return { family: 'Barlow Condensed', skewDeg: 0 };
    if (heavy)     return { family: 'Archivo Black', skewDeg: italic ? -8 : 0 };
    return { family: 'Barlow', skewDeg: italic ? -8 : 0 };
}

// Deriva el estilo completo de la capa desde el JSON de identidad (guardada o
// auto-extraída). Campos ausentes caen a defaults dignos.
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

    // Si el análisis de identidad no detectó ningún badge en el KV (pasa seguido: el
    // vision model no siempre reconoce bandas/pills como "badge"), NO caemos en el
    // negro genérico de DEFAULT_STYLE — usamos el accentColor real de la marca (ya
    // extraído con más confiabilidad) como fondo de la barra, para que en el peor
    // caso el resultado se vea "de la marca" y no una caja negra sin relación.
    const badge = Array.isArray(identity.badges) && identity.badges.length ? identity.badges[0] : null;
    if (!badge) console.warn('[dcoOverlay] identity sin badges detectados — usando accentColor como fallback de barra de beneficio en vez del negro por defecto');
    s.benefitBarColor  = hex(badge?.bgColor, accent);
    const barIsAccent = s.benefitBarColor.toLowerCase() === accent.toLowerCase();
    s.benefitTextColor = hex(badge?.textColor, contrastText(s.benefitBarColor));
    s.benefitIconColor = barIsAccent ? contrastText(s.benefitBarColor) : accent;
    // La forma real del badge (extraída del KV) decide si el pill lleva corte diagonal o
    // es un rectángulo/pill recto — antes esta señal se extraía pero nunca se usaba.
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

    // El color muestreado por píxeles reales del KV (sampleZoneDominantColor) es más
    // confiable que cualquier hex adivinado por el modelo de visión o que el accentColor
    // de respaldo — es el pixel real de la zona que el usuario marcó a mano. Gana siempre
    // que exista, haya o no identidad/badge detectado. Verificado con el KV real de BOXER:
    // el badge real ES negro (#0d0c0d) — un badge NO siempre es un color vívido, así que
    // NO se descarta un muestreo solo por salir oscuro (eso fue un error: rechazaba
    // exactamente el color correcto). El ícono "+" sigue siendo el accentColor de marca
    // (amarillo en el KV real) salvo que el bar YA sea ese mismo accent (ahí sí hace
    // falta contraste porque, si no, el ícono quedaría invisible sobre el bar).
    if (isHex(sampledBenefitColor)) {
        s.benefitBarColor = sampledBenefitColor;
        s.benefitTextColor = contrastText(sampledBenefitColor);
        const barMatchesAccent = sampledBenefitColor.toLowerCase() === s.accentColor.toLowerCase();
        s.benefitIconColor = barMatchesAccent ? contrastText(sampledBenefitColor) : s.accentColor;
    }
    return s;
}

// ─── Helpers de render ─────────────────────────────────────────────────────────

function escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Word-wrap heurístico (no mide glyphs reales — factor por familia condensada/normal).
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

// Auto-fit: reduce la fuente hasta que el bloque envuelto entra en el alto disponible.
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

// Texto display con contornos en capas + sombra — el "look diseñado" del KV real.
// Capas (de atrás hacia adelante): sombra desplazada → stroke exterior grueso →
// outline fino → fill. skewX inclina el bloque completo.
function displayText(opts: {
    lines: string[]; fontSize: number; x: number; y: number; // y = baseline de la primera línea
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
    // skew alrededor del inicio del bloque para que no se desplace
    return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) skewX(${skew}) translate(${(-x).toFixed(1)},${(-y).toFixed(1)})">${inner}</g>`;
}

// Paralelogramo (rect inclinado) — la barra detrás de los bullets de beneficio.
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

// El ícono "+" de los bullets — dibujado como forma (dos rects), NUNCA como glyph
// de fuente (los glyphs varían entre fuentes; la forma es idéntica siempre).
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

// ─── Render de cada tipo de zona ───────────────────────────────────────────────

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
            // Ícono "+" + barra inclinada + texto — el sistema del KV de referencia.
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

// ─── Composición final ─────────────────────────────────────────────────────────

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
                console.warn(`[dcoOverlay] No se pudo componer zona gráfica "${gz.key}":`, e.message);
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
        console.error('[dcoOverlay] Error componiendo capa de marca, devolviendo imagen original:', e.message);
        return { base64: baseImageBase64, mime: baseMime };
    }
}

// ─── Compat: firma anterior usada por código existente ────────────────────────
// (routes viejas siguen llamando compositeManualOverlays con TextOverlayZone plano)
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
    if (key === 'vitamina_chip' || key === 'chip') return 'chip';
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
