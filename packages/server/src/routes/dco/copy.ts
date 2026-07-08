// ─── Copy parsing, length governance, and hard-verified brevity contracts ─────
// Ported from the source system's parseCopyText / copy_adapter logic, with the
// brand-specific "vitamina" (nutrient) auto-extraction removed — that regex
// only ever matched one client's supplement-brand copy ("Complejo B", "Vitamina
// C", etc.). The generic system never infers a chip/badge from body text; it
// only uses whatever the caller (Excel column, form field, or the copy-writing
// LLM) explicitly provides.

export interface CopyFields {
    headline: string;
    subhead: string;
    /** Short badge/pill text (e.g. a certification, a feature callout). Was
     *  called `vitamina_chip` in the source system — renamed `chip` everywhere. */
    chip: string;
    body: string;
    cta: string;
    /** Optional short bullet list, rendered as "+Benefit" chips by the brand layer. */
    beneficios?: string[];
}

/**
 * Splits a free-text copy block (as typed into the Excel "COPY" column, using
 * the "COPY PRINCIPAL: / DESARROLLO: / CIERRE:" convention) into structured
 * fields. Generic: no brand-specific nutrient/vitamin extraction.
 */
export function parseCopyText(raw: string): CopyFields {
    const result: CopyFields = { headline: '', subhead: '', chip: '', body: '', cta: '' };
    if (!raw) return result;

    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    let section = '';
    const sectionBuffers: Record<string, string[]> = { headline: [], body: [], cta: [] };

    for (const line of lines) {
        const up = line.toUpperCase();

        if (up.startsWith('COPY PRINCIPAL') || up.startsWith('HEADLINE') || up.startsWith('TITULAR')) {
            section = 'headline';
            const after = line.slice(line.indexOf(':') + 1).trim();
            if (after) sectionBuffers.headline.push(after);
            continue;
        }
        if (up.startsWith('DESARROLLO') || up.startsWith('BODY') || up.startsWith('CUERPO')) {
            section = 'body';
            const after = line.slice(line.indexOf(':') + 1).trim();
            if (after) sectionBuffers.body.push(after);
            continue;
        }
        if (up.startsWith('CIERRE') || up.startsWith('CTA') || up.startsWith('LLAMADA')) {
            section = 'cta';
            const after = line.slice(line.indexOf(':') + 1).trim();
            if (after) sectionBuffers.cta.push(after);
            continue;
        }

        if (section && sectionBuffers[section]) {
            sectionBuffers[section].push(line);
        } else if (!section) {
            sectionBuffers.headline.push(line);
            section = 'headline';
        }
    }

    const headlineText = sectionBuffers.headline.join(' ').trim();
    const bodyText = sectionBuffers.body.join(' ').trim();
    const ctaText = sectionBuffers.cta.join(' ').trim();

    // Split an over-long headline into headline + subhead on " es " (Spanish copular verb) —
    // a generic heuristic, not brand-specific.
    if (headlineText.length > 50 && headlineText.includes(' es ')) {
        const splitIdx = headlineText.indexOf(' es ');
        result.headline = headlineText.slice(0, splitIdx).trim();
        result.subhead = headlineText.slice(splitIdx + 1).trim();
    } else {
        result.headline = headlineText;
        result.subhead = '';
    }

    result.body = bodyText;
    result.chip = '';
    result.cta = ctaText;

    return result;
}

// ─── Format-family length governance (port of the copy_adapter / brand_rules
// length caps) — groups every format family into a "length group" and trims
// copy to a max words-per-field so the text actually fits the rendered zone.
const FORMAT_FAMILY_GROUP: Record<string, 'vertical' | 'square' | 'horizontal' | 'micro'> = {
    story: 'vertical', portrait: 'vertical', halfpage: 'vertical',
    square: 'square',
    landscape: 'horizontal', billboard: 'horizontal',
    skyscraper: 'micro', mrec: 'micro',
};
const COPY_LIMITS: Record<string, { headline: number; subhead: number; body: number; cta: number }> = {
    vertical:   { headline: 8, subhead: 14, body: 22, cta: 6 },
    square:     { headline: 7, subhead: 12, body: 18, cta: 5 },
    horizontal: { headline: 6, subhead: 9,  body: 14, cta: 4 },
    micro:      { headline: 5, subhead: 0,  body: 8,  cta: 3 },
};

function trimWords(s: string, max: number): string {
    if (!max) return '';
    const words = (s || '').trim().split(/\s+/).filter(Boolean);
    if (words.length <= max) return (s || '').trim();
    return words.slice(0, max).join(' ');
}

export function adaptCopyToFamily(copy: CopyFields, family: string): CopyFields {
    const group = FORMAT_FAMILY_GROUP[family] || 'square';
    const lim = COPY_LIMITS[group];
    return {
        headline: trimWords(copy.headline, lim.headline),
        subhead:  trimWords(copy.subhead, lim.subhead),
        chip:     copy.chip,
        body:     trimWords(copy.body, lim.body),
        cta:      trimWords(copy.cta, lim.cta),
        beneficios: copy.beneficios,
    };
}

// Default copy-voice rules used until a saved brand profile's own copy identity
// (learned from its existing copy) overrides them. Generic advertising
// guardrails — not brand-specific claims.
export const DEFAULT_COPY_RULES = {
    tono: 'cercano, motivacional y positivo',
    palabras_positivas: ['energía', 'vitalidad', 'bienestar', 'ritmo', 'foco', 'rendimiento', 'resistencia'],
    palabras_prohibidas: ['cura', 'milagroso', 'garantizado', 'adelgaza', '100% efectivo', 'sin efectos secundarios', 'mejor del mundo'],
};

/** Assembles a raw copy block in the "COPY PRINCIPAL: / DESARROLLO: / CIERRE:" shape parseCopyText expects. */
export function buildCopyBlock(copyPrincipal: string, desarrollo: string, cierre: string): string {
    const lines: string[] = [];
    if (copyPrincipal) lines.push(`COPY PRINCIPAL: ${copyPrincipal.trim()}`);
    if (desarrollo) lines.push(`DESARROLLO: ${desarrollo.trim()}`);
    if (cierre) lines.push(`CIERRE: ${cierre.trim()}`);
    return lines.join('\n');
}

// ─── Real per-zone character budget, from hand-marked overlay zones ───────────
// Same geometry math services/overlay.ts uses to actually render the text —
// so the copy the LLM writes already fits the space marked on the reference
// image, instead of a generic word-count limit that may not fit.
export function estimateZoneCharBudget(zone: { w: number; h: number }, refWidth: number, refHeight: number): number {
    const pw = (zone.w / 100) * refWidth;
    const ph = (zone.h / 100) * refHeight;
    const fontSize = Math.max(11, Math.min(ph * 0.62, pw / 4));
    const avgCharWidth = fontSize * 0.56;
    const maxCharsPerLine = Math.max(1, Math.floor(pw / avgCharWidth));
    const lineHeight = fontSize * 1.18;
    const maxLines = Math.max(1, Math.floor(ph / lineHeight));
    return maxCharsPerLine * maxLines;
}

const COPY_ZONE_FIELD_LABEL: Record<string, string> = {
    headline: 'copy_principal (titular)', subhead: 'desarrollo/subhead', chip: 'chip/badge',
    cta: 'cierre (CTA)',
};
const COPY_BENEFIT_ZONE_RE = /^benefit_(\d+)$/;

function copyZoneFieldLabel(key: string): string | null {
    if (COPY_ZONE_FIELD_LABEL[key]) return COPY_ZONE_FIELD_LABEL[key];
    const m = key.match(COPY_BENEFIT_ZONE_RE);
    return m ? `beneficios[${Number(m[1]) - 1}] (bullet corto #${m[1]})` : null;
}

export type ZoneBoxLike = { x: number; y: number; w: number; h: number };

export function buildZoneLengthInstruction(
    manualZones: Partial<Record<string, ZoneBoxLike>> | null,
    refWidth: number, refHeight: number,
): string {
    if (!manualZones || !refWidth || !refHeight) return '';
    const lines = Object.entries(manualZones)
        .filter(([key, z]) => z && copyZoneFieldLabel(key))
        .map(([key, z]) => {
            const chars = estimateZoneCharBudget(z as ZoneBoxLike, refWidth, refHeight);
            return `- ${copyZoneFieldLabel(key)}: MÁXIMO ${chars} caracteres — es el espacio real que marcaste sobre la imagen para este elemento, no un límite genérico.`;
        });
    if (!lines.length) return '';
    return `\n\nLÍMITES DE LARGO REALES (calculados de las zonas que marcaste a mano — tienen prioridad sobre cualquier límite de palabras genérico de más arriba):\n${lines.join('\n')}`;
}

export function countBenefitZones(manualZones: Partial<Record<string, unknown>> | null): number {
    if (!manualZones) return 0;
    return Object.keys(manualZones).filter(k => COPY_BENEFIT_ZONE_RE.test(k) && manualZones[k]).length;
}

export function buildBeneficiosCountInstruction(count: number): string {
    if (count === 0) return '';
    return `\n\nESTRUCTURA DE BENEFICIOS (marcaste ${count} zona${count > 1 ? 's' : ''} de beneficio — el copy DEBE traer exactamente ${count} beneficio${count > 1 ? 's' : ''}, ni más ni menos):
- Devolvé un array "beneficios" con EXACTAMENTE ${count} string${count > 1 ? 's' : ''}.
- Cada uno es un bullet ULTRA CORTO estilo "+Palabra" o "+Dos Palabras" (ej: "+Velocidad", "+Ahorro", "+Durabilidad") — NUNCA una oración, NUNCA más de 2-3 palabras.
- No repitas la misma idea en dos bullets distintos; que cada uno cubra un beneficio real y distinto del producto/servicio.`;
}

/**
 * Whether to ask the copywriting LLM to look at the reference image itself and
 * decide whether the layout even has a subhead line, instead of always filling
 * one in just because the JSON schema has the field.
 */
export function buildSubheadInstruction(hasReferenceImage: boolean): string {
    if (hasReferenceImage) {
        return `\n\nDECISIÓN DE SUBHEAD/DESARROLLO — MIRÁ VOS MISMO LA IMAGEN ADJUNTA: analizá la referencia real y determiná si su diseño incluye una línea de subtítulo/desarrollo (una oración corta entre el titular y los beneficios) o si pasa directo del titular a los beneficios/CTA sin ninguna oración intermedia.
- Si la referencia SÍ muestra esa línea de subtítulo: escribí un "desarrollo" corto y coherente para cada copy, en el mismo lugar/función que cumple en la referencia real.
- Si la referencia NO muestra ninguna línea de subtítulo: dejá "desarrollo" como string vacío "" en cada copy — NO inventes una oración de relleno solo porque el campo existe en el JSON.
Esta decisión depende ÚNICAMENTE de lo que ves en la imagen real — nadie tiene que marcar ninguna zona a mano para que la tomes.`;
    }
    return `\n\nDECISIÓN DE SUBHEAD/DESARROLLO — sin imagen de referencia adjunta para verificarlo visualmente: si los copies existentes ya muestran un patrón claro de subtítulo/oración de desarrollo, seguí ese mismo patrón; si no hay evidencia de que la pieza real lleve esa línea, dejá "desarrollo" vacío "" — ante la duda, menos texto es mejor que inventar relleno.`;
}

// ─── Hard-verified brevity contract — never trust the prompt limit alone ──────
// The LLM receives length limits in the prompt, but a limit in a prompt is a
// suggestion; this turns it into a contract measured by code, with a targeted
// retry when violated.
export function copyBrevityViolations(cp: any): string[] {
    const v: string[] = [];
    const words = (s: any) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
    const len = (s: any) => String(s || '').trim().length;
    if (cp.copy_principal && (words(cp.copy_principal) > 7 || len(cp.copy_principal) > 42))
        v.push(`copy_principal demasiado largo ("${cp.copy_principal}") — máx 7 palabras / 42 caracteres`);
    if (cp.cierre && (words(cp.cierre) > 6 || len(cp.cierre) > 36))
        v.push(`cierre demasiado largo ("${cp.cierre}") — máx 6 palabras / 36 caracteres`);
    if (Array.isArray(cp.beneficios)) {
        for (const b of cp.beneficios) {
            if (words(b) > 3 || len(b) > 24) v.push(`beneficio demasiado largo ("${b}") — máx 3 palabras / 24 caracteres`);
        }
    }
    if (cp.chip && len(cp.chip) > 25)
        v.push(`chip demasiado largo ("${cp.chip}") — máx 25 caracteres`);
    return v;
}

export function collectCopyViolations(parsed: any): string[] {
    const all: string[] = [];
    for (const a of (parsed?.audiencias || [])) {
        for (const cp of (a.copies || [])) all.push(...copyBrevityViolations(cp));
    }
    return all;
}

export function brevityRetryFeedback(violations: string[]): string {
    return `⚠️ TU RESPUESTA ANTERIOR VIOLÓ LOS LÍMITES DE LONGITUD (verificado por código, no es opinable):
${[...new Set(violations)].slice(0, 12).map(v => '- ' + v).join('\n')}
Regenerá TODO el JSON corrigiendo cada violación — misma estructura, mismos campos, textos MÁS CORTOS. Los límites son contratos duros, no sugerencias. Ante la duda, siempre la versión más corta.`;
}
