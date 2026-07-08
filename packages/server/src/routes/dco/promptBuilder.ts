// ─── Prompt construction — the "single painter" architecture ─────────────────
// buildPrompt() NEVER receives the real copy as text-to-render (the caller
// always blanks headline/subhead/chip/body/cta before calling it — see
// routes/dco.ts /generate) — it only describes layout/zones/style. All real
// copy is rendered afterward, deterministically, by services/overlay.ts. The
// image model's job is a clean advertising PHOTOGRAPH; the brand layer's job
// is every pixel of text and logo. See docs/ARCHITECTURE.md.
//
// This file is a direct, de-hardcoded port of the source system's
// routes/dco.ts buildPrompt()/buildVideoPrompt()/buildCopyPlacementMap(). What
// was removed: the entire BRAND_PROFILES.tarrito_rojo branch (a specific
// client's identity + ~45 hardcoded lifestyle scenes), all product-category
// detection and per-category interaction rules (TV/nevera/lavadora/phone/
// laptop/audio/aire-acondicionado/moto — all tied to specific past clients'
// product lines), and the audience-archetype character-option banks (soccer
// fans, gamers, families-watching-TV, etc.) that were built around those same
// product categories. What remains is the "generic" branch from the source
// system — the one that already worked from a learned/auto-extracted brand
// identity instead of hardcoded brand knowledge — simplified further so it no
// longer depends on a fixed profile id, only on an identity object.
import type { CopyFields } from './copy.js';
import type { FormatSpec } from './formats.js';
import type { TextProvider, ImagePart } from '../../adapters/types.js';

export const GENERIC_IDENTITY_BLOCK =
    `BRAND IDENTITY: Follow the reference image faithfully — same layout zones, typography positions, brand bands. Only the scene content changes (new background, new character, new moment). Derive ALL design decisions from the reference image provided.`;

// Mood modifier map used when a task carries an explicit "tono" (brief column) —
// generic advertising moods, not tied to any brand.
export const TONO_MODIFIERS: Record<string, string> = {
    aspiracional:  'inspirational, aspirational light, triumphant expression, golden hour glow',
    celebratorio:  'celebratory, joyful energy, vibrant colors, big smiles, festive atmosphere',
    empatico:      'warm and empathetic, soft natural light, genuine caring expression, intimate moment',
    urgente:       'dynamic, urgent energy, strong contrast, determined intense expression',
    motivacional:  'high energy, motivational, powerful body language, bold dynamic light',
    tranquilo:     'calm, peaceful, soft diffused light, relaxed natural expression',
    familiar:      'warm family feeling, soft golden light, genuine connection between people',
    profesional:   'clean, professional, confident expression, bright modern environment',
};

// ─── Generic per-format layout guidance, driven by a learned identity ────────
export function genericFormatGuidance(w: number, h: number, family: string, identity?: any): string {
    const band    = identity?.bandColor         || 'brand primary color from the reference image';
    const bandH   = identity?.bandHeightPercent ? `${identity.bandHeightPercent}%` : '~27%';
    const bandPos = identity?.bandPosition      || 'bottom';
    const hlCol   = identity?.headlineColor     || '#FFFFFF';
    const hlWt    = identity?.headlineWeight    || 'Bold';
    const hlCase  = identity?.headlineCase      || 'match reference exactly';
    const logoPos = identity?.logoPosition      || 'match reference exactly';
    const logoSz  = identity?.logoSizePercent   ? `~${identity.logoSizePercent}% of frame width` : 'match reference';
    const dna     = Array.isArray(identity?.brandDNA) ? identity.brandDNA.slice(0, 3).join(' | ') : '';

    const brandSystem = identity ? `
BRAND SYSTEM (extracted from reference-image analysis):
• Brand band: ${band} at ${bandPos}, height ${bandH}
• Headline: ${hlWt} weight, ${hlCase}, color ${hlCol}
• Logo: ${logoPos}, size ${logoSz}
${dna ? `• Brand DNA: ${dna}` : ''}` : '';

    if (family === 'portrait')   return `FORMAT: ${w}x${h}px (portrait 4:5). FULL-BLEED photographic lifestyle scene fills ENTIRE frame top to bottom — NO split layout, NO left-text/right-photo division. Text overlaid directly on scene photo. Brand band ${bandPos} ${bandH}.${brandSystem}`;
    if (family === 'square')     return `FORMAT: ${w}x${h}px (square 1:1). FULL-BLEED photographic scene covers entire frame — NO split layout. Text overlaid on scene. Brand band ${bandPos} ${bandH}.${brandSystem}`;
    if (family === 'story')      return `FORMAT: ${w}x${h}px (9:16 story). FULL-BLEED scene from top to brand band. NO split layout. Text overlaid on scene photo. Brand band ${bandPos} ${bandH}.${brandSystem}`;
    if (family === 'landscape')  return `FORMAT: ${w}x${h}px. Left 42% text/brand zone. Right 58% lifestyle scene. Band full width ${bandPos} ~22%.${brandSystem}`;
    if (family === 'billboard')  return `FORMAT: ${w}x${h}px (billboard). Left ${Math.floor(w * 0.42)}px brand zone with copy+product. Right ${Math.floor(w * 0.58)}px lifestyle scene.${brandSystem}`;
    if (family === 'skyscraper') return `FORMAT: ${w}x${h}px (skyscraper). Top: headline. Center: scene. Brand band ${bandPos}.${brandSystem}`;
    if (family === 'halfpage')   return `FORMAT: ${w}x${h}px. Top scene. Bottom 40% band with copy and CTA.${brandSystem}`;
    if (family === 'mrec')       return `FORMAT: ${w}x${h}px. Top 35% scene. Bottom 65% brand band with headline and CTA.${brandSystem}`;
    return `FORMAT: ${w}x${h}px. FULL-BLEED scene. NO split layouts.${brandSystem}`;
}

// ─── Intelligent copy placement map — universal for any brand ────────────────
export function buildCopyPlacementMap(copy: CopyFields, identity: any): string {
    const { headline, subhead, chip, body, cta } = copy;

    const antiBoxHeader = [
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        'STEP A — COPY RENDERING (anti-hallucination)',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '⛔ TEXT CONTAINERS ABSOLUTELY FORBIDDEN: Do NOT render any text inside a box, rectangle, oval, bubble, banner, bar, or any container shape.',
        '⛔ ALL body text and subhead text must float DIRECTLY over the photo as styled typography — NO background shape behind them.',
        '⛔ Only BADGES/CHIPS and CTA BUTTONS may have a background shape (pill or rectangle as specified).',
        '⛔ If a text element cannot fit cleanly without a container, make it SMALLER and integrate it into the photo overlay.',
        '',
    ].join('\n');

    const tz      = identity?.textZones  || {};
    const typo    = identity?.typography || {};
    const badges  = Array.isArray(identity?.badges) ? identity.badges : [];
    const iconRow = identity?.iconRow    || {};
    const primary = identity?.primaryColor || identity?.bandColor || '#6b7280';
    const hlColor = identity?.headlineColor || typo.headline?.fillColor || '#FFFFFF';

    const wordCount     = (t: string) => t.trim().split(/\s+/).length;
    const isFeatureList = (t: string) => Boolean(t && (t.includes(';') || (t.match(/\|/g) || []).length >= 2 || t.split(',').filter((x: string) => x.trim().split(/\s+/).length <= 6).length >= 3));
    const isPowerPhrase = (t: string) => Boolean(t && wordCount(t) <= 5);
    const isBadgeText   = (t: string) => Boolean(t && wordCount(t) <= 4);
    const isIntroText   = (t: string) => Boolean(t && /^(presentando|nuevo|nueva|introducing|ahora con|ahora)/i.test(t.trim()));

    const hlTypo = typo.headline || {};
    const shTypo = typo.subhead  || {};
    const bdTypo = typo.body     || {};
    const ctTypo = typo.cta      || {};

    const hlZone  = tz.headline?.zone               || 'photo-overlay-center';
    const hlVert  = tz.headline?.verticalPercent      ?? 50;
    const hlAlign = tz.headline?.horizontalAlignment  || 'left';
    const hlWidth = tz.headline?.maxWidthPercent      || 88;
    const hlWeight= hlTypo.fontWeight || 'Black';
    const hlStyle = hlTypo.fontStyle  || 'upright';
    const hlFWidth= hlTypo.fontWidth  || 'condensed';

    const lines: string[] = [
        '━━━ COPY PLACEMENT MAP — WHERE + HOW to render each element ━━━',
        '(Design instructions only. Render ONLY the quoted strings as visible image text.)',
    ];

    // ── HEADLINE ────────────────────────────────────────────────────────────
    if (headline) {
        // A short, punchy headline (≤5 words) reads as hero text regardless of brand vertical.
        const isBig = isPowerPhrase(headline);
        const hlSize = hlTypo.sizePercentOfFrameHeight || (isBig ? 18 : 8);
        lines.push('');
        lines.push(`HEADLINE "${headline}":`);
        lines.push(`  Position: ${hlZone}, ~${hlVert}% from top, ${hlAlign}-aligned, max-width ${hlWidth}%`);
        lines.push(`  Font: ${hlStyle} ${hlFWidth} ${hlWeight}`);
        lines.push(`  Size: ~${hlSize}% of frame height${isBig ? ' — HERO TEXT, largest element in the image' : ''}`);
        lines.push(`  Fill: ${hlTypo.fillType === 'gradient' && hlTypo.fillGradient ? 'gradient ' + hlTypo.fillGradient : hlColor}`);
        if (hlTypo.strokeColor) lines.push(`  Stroke: ${hlTypo.strokeColor} ${hlTypo.strokeWidthPx || 3}px`);
        if (hlTypo.shadowColor) lines.push(`  Shadow: ${hlTypo.shadowColor} ${hlTypo.shadowDirection || 135}deg ${hlTypo.shadowDistancePx || 4}px blur ${hlTypo.shadowBlurPx || 8}px`);
        if (hlTypo.glowColor)   lines.push(`  Glow: ${hlTypo.glowColor} ${hlTypo.glowRadiusPx || 12}px`);
        if (hlTypo.notes)       lines.push(`  Note: ${hlTypo.notes}`);
    }

    // ── SUBHEAD / INTRO TEXT ────────────────────────────────────────────────
    if (subhead?.trim()) {
        lines.push('');
        if (isIntroText(subhead)) {
            lines.push(`INTRO TEXT "${subhead}":`);
            lines.push('  Position: top-left zone, 6-10% from top, left-aligned');
            lines.push('  Font: upright regular ALL_CAPS, wide letter-spacing');
            lines.push('  Size: ~1.8% of frame height — small, secondary to badge and logo');
            lines.push(`  Fill: ${shTypo.fillColor || '#FFFFFF'}`);
        } else {
            const shZone = tz.subhead?.zone || 'photo-overlay-bottom';
            const shVert = tz.subhead?.verticalPercent ?? 40;
            lines.push(`SUBHEAD "${subhead}":`);
            lines.push(`  Position: ${shZone}, ~${shVert}% from top, ${tz.subhead?.horizontalAlignment || 'left'}-aligned`);
            lines.push(`  Font: ${shTypo.fontStyle || 'upright'} ${shTypo.fontWeight || 'SemiBold'}`);
            lines.push(`  Size: ~${shTypo.sizePercentOfFrameHeight || 3.5}% of frame height`);
            lines.push(`  Fill: ${shTypo.fillColor || '#FFFFFF'}`);
            if (shTypo.strokeColor) lines.push(`  Stroke: ${shTypo.strokeColor} ${shTypo.strokeWidthPx || 2}px`);
        }
    }

    // ── BADGE / CHIP ────────────────────────────────────────────────────────
    if (chip?.trim()) {
        const bd    = badges[0] || {};
        const bgCol = bd.bgColor   || primary;
        const txCol = bd.textColor || '#FFFFFF';
        const shape = bd.shape     || 'pill';
        const bVert = bd.verticalPercent || tz.chip?.verticalPercent || 8;
        lines.push('');
        if (isBadgeText(chip)) {
            lines.push(`BADGE "${chip}":`);
            lines.push(`  Render as ${shape} graphic element — background ${bgCol}, text ${txCol} Bold ALL_CAPS`);
            lines.push(`  Position: top zone ~${bVert}% from top, inline or next to INTRO text`);
            lines.push(`  Size: text ~2.5% frame height inside padded ${shape}`);
        } else {
            lines.push(`CHIP "${chip}":`);
            lines.push(`  Render as pill badge — bg ${bgCol}, text ${txCol} Bold, top zone`);
        }
    }

    // ── BODY — feature list → icon row | plain paragraph → text ───────────────
    if (body?.trim()) {
        lines.push('');
        if (isFeatureList(body)) {
            const sep      = body.includes(';') ? ';' : body.includes('|') ? '|' : ',';
            const features = body.split(sep).map((f: string) => f.trim()).filter(Boolean);
            const irPos    = iconRow.present ? iconRow.position : 'bottom area';
            const irVert   = iconRow.verticalPercent || 82;
            const irIcCol  = iconRow.iconColor  || '#FFFFFF';
            const irTxCol  = iconRow.textColor  || '#FFFFFF';
            const irBg     = iconRow.bgColor    || 'dark semi-transparent overlay matching photo tone — NOT a solid bright color band';
            lines.push('BODY → ICON ROW (feature list detected):');
            lines.push(`  Position: ${irPos}, ~${irVert}% from top, full width`);
            lines.push(`  Background: ${irBg}`);
            lines.push(`  Layout: horizontal row of ${features.length} items separated by pipe (|) dividers`);
            features.forEach((f: string, i: number) => {
                lines.push(`  Item ${i + 1}: [white outline icon] + label "${f}"`);
            });
            lines.push(`  Icon style: ${iconRow.iconStyle || 'outline'}, color ${irIcCol}`);
            lines.push(`  Label: ${irTxCol} Regular ~1.8% frame height, centered below each icon`);
            lines.push('  ⚠️ NOT a paragraph — render as graphical icon grid, each feature = icon + label');
        } else {
            const bZone = tz.body?.zone || 'photo-overlay-bottom';
            const bVert = tz.body?.verticalPercent ?? 45;
            lines.push(`BODY "${body}":`);
            lines.push(`  Position: ${bZone}, ~${bVert}% from top, ${tz.body?.horizontalAlignment || 'left'}-aligned`);
            lines.push(`  Font: ${bdTypo.fontStyle || 'upright'} ${bdTypo.fontWeight || 'Regular'}`);
            lines.push(`  Size: ~${bdTypo.sizePercentOfFrameHeight || 2.5}% of frame height`);
            lines.push(`  Fill: ${bdTypo.fillColor || '#FFFFFF'}`);
            lines.push('  ⚠️ Plain text overlay directly on photo — NO box, NO oval, NO container around this text.');
        }
    }

    // ── CTA ─────────────────────────────────────────────────────────────────
    if (cta?.trim()) {
        const ctZone  = tz.cta?.zone || 'standalone-button';
        const ctVert  = tz.cta?.verticalPercent ?? 88;
        const ctShape = ctTypo.buttonShape || 'pill';
        const ctBg    = ctTypo.bgColor    || primary;
        const ctCol   = ctTypo.fillColor  || '#FFFFFF';
        lines.push('');
        lines.push(`CTA "${cta}":`);
        lines.push(`  Render as ${ctShape} button — bg ${ctBg}, text ${ctCol} Bold ALL_CAPS`);
        lines.push(`  Position: ${ctZone}, ~${ctVert}% from top, ${tz.cta?.horizontalAlignment || 'left'}-aligned`);
        lines.push(`  Size: text ~${ctTypo.sizePercentOfFrameHeight || 2.5}% frame height`);
        lines.push('  ⚠️ CTA text color = white or brand primary ONLY — NEVER an invented color not in the reference.');
    }

    lines.push('');
    lines.push('⛔ PLACEMENT RULES — ABSOLUTE:');
    lines.push('⛔ NO solid colored rectangle/band invented at bottom — any dark strip for the icon row must match the photo dark tone, semi-transparent, NOT a bright opaque block.');
    lines.push('⛔ Feature list in BODY → icon row graphic, NEVER a text paragraph on a colored bar.');
    lines.push('⛔ BADGE/CHIP → pill/badge graphic, NEVER plain floating text.');
    lines.push('⛔ Each element appears ONCE in its designated zone only.');
    lines.push('⛔ ZERO text outside the zones specified above.');
    lines.push('⛔ ZERO text inside boxes, ovals, rectangles, bubbles, or any container — text floats directly on the image as styled typography.');

    return antiBoxHeader + lines.join('\n');
}

// ─── Main prompt builder ───────────────────────────────────────────────────
// `identity` is either undefined (no brand learned yet — falls back to
// GENERIC_IDENTITY_BLOCK) or the analysis object produced by
// brandIdentity.ts#analyzeBrandIdentity / a saved BrandProfileRecord's
// analysisSummary (which embeds `identityPrompt`, `textZones`, `typography`,
// `badges`, etc).
export function buildPrompt(
    sceneDesc: string,
    copy: CopyFields,
    fmt: FormatSpec,
    identity: any | undefined,
    observaciones?: string,
    hasProductImage: boolean = false,
    audienciaRef: string = '',
    drivers: string = '',
    hasLogoImage: boolean = false,
    hasConglomerateLogo: boolean = false,
): string {
    const identityBlock = (identity && typeof identity.identityPrompt === 'string' && identity.identityPrompt)
        || GENERIC_IDENTITY_BLOCK;
    const formatGuide = genericFormatGuidance(fmt.width, fmt.height, fmt.family, identity);

    const observacionesBlock = observaciones && observaciones.trim()
        ? `\nCREATIVE DIRECTOR NOTES — apply these specific constraints to this piece:\n${observaciones.trim()}\n`
        : '';
    const productBlock = hasProductImage
        ? `\nPRODUCT REFERENCES (images provided after the main reference): Multiple angles of the product are provided. Integrate THIS EXACT product into the scene as a NATURAL ENVIRONMENTAL PROP — same shape, label, colors, proportions shown in the reference photos. Place it where it would realistically live in the scene context. CRITICAL INTEGRATION RULES: (a) The product must inherit the EXACT lighting direction and color temperature of the scene. (b) Cast a natural contact shadow on the surface it rests on. (c) Feel PHOTOGRAPHED as part of the scene, NOT digitally composited. (d) Size: realistically proportional to its real-world size. Label legible and facing camera. Person remains the clear main subject.\n`
        : '';
    // Logos are never asked to be "reproduced pixel-faithfully" by the image
    // model — that's the same hallucination risk as free-text (it invents its
    // own similar-looking version). The real logo file is ALWAYS composited
    // afterward with pixel precision (see services/overlay.ts) — here we only
    // ask the model to leave the marked area clean.
    const logoBlock = hasLogoImage
        ? `\nBRAND LOGO: Do NOT draw, redraw, reinterpret, or invent the brand logo/wordmark yourself anywhere in this image — leave its designated area (see user-marked positions below) clean and empty. The real official logo file will be composited on top afterward with pixel-perfect precision.\n`
        : '';
    const conglomerateLogoBlock = hasConglomerateLogo
        ? `\nCONGLOMERATE/PARENT COMPANY LOGO: Do NOT draw, redraw, or invent this logo yourself — leave its designated area (see user-marked positions below) clean and empty. The real official logo file will be composited on top afterward with pixel-perfect precision.\n`
        : '';

    // ─── Audience mandate — gender/age enforcement parsed from free-text audience ──
    const audText = (audienciaRef || '').toLowerCase();
    const onlyMale   = /\bhombres?\b/.test(audText) && !/\bmujeres?\b/.test(audText);
    const onlyFemale = /\bmujeres?\b/.test(audText) && !/\bhombres?\b/.test(audText);
    const ageMatch = audText.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);
    const ageRange = ageMatch ? `${ageMatch[1]}–${ageMatch[2]} años` : '';
    const gPerson = (age = ageRange) => onlyMale ? `Hombre latinoamericano${age ? ' ' + age : ''}`
        : onlyFemale ? `Mujer latinoamericana${age ? ' ' + age : ''}`
        : `Persona latinoamericana${age ? ' ' + age : ''}`;

    const audienceRule = audienciaRef
        ? [
            '⛔ AUDIENCE MANDATE — NON-NEGOTIABLE:',
            `Target: ${audienciaRef}`,
            onlyMale   ? '⛔ ALL characters MUST be MALE. ZERO women in the image. No exceptions.' : '',
            onlyFemale ? '⛔ ALL characters MUST be FEMALE. ZERO men in the image. No exceptions.' : '',
            ageRange   ? `⛔ Character age MUST be within ${ageRange}. No children, no elderly outside this range.` : '',
            '⛔ This overrides ALL other creative guidance below. Gender and age are fixed by the brief.',
          ].filter(Boolean).join('\n')
        : '';

    // No hardcoded product-category / audience-archetype option banks (the
    // source system's soccer-fans/gamers/family-watching-TV/moto-riders
    // switch-cases lived here) — a single generic character instruction lets
    // the image model derive the specific moment from sceneDesc + audience.
    const characterBlock = [
        audienceRule,
        '',
        `CHARACTER: ${gPerson()} (or a small authentic group if the scene calls for it), naturally engaged in the moment described in the scene below — genuine expression and body language, not a stock-photo pose.`,
        `Ages 18+${ageRange ? ', within ' + ageRange : ''}. ${onlyMale ? 'MALE ONLY — ZERO women.' : onlyFemale ? 'FEMALE ONLY — ZERO men.' : ''} Authentic Latin American photorealistic appearance, ZERO stock-photo aesthetic.`,
    ].filter(Boolean).join('\n');

    const interactionRule = [
        'CHARACTER-PRODUCT INTERACTION:',
        '• The character uses, holds, or naturally reacts to the product/service in a way that fits the scene description below — infer the specific interaction from the scene, do not default to a generic "standing next to it" pose.',
        '• The interaction reads as genuine and specific to this moment, not posed or generic.',
    ].join('\n');

    const productInstruction = hasProductImage
        ? [
            'PRODUCT FIDELITY — CRITICAL:',
            '• Reference photos show EXACTLY how the product looks — replicate with 100% fidelity.',
            '• Shape, dimensions, color, label, finish — zero deviation from the reference photos.',
            '• Product photographed as part of the scene — same light direction, natural contact shadow on the surface it rests on.',
          ].join('\n')
        : [
            'PRODUCT PRECISION:',
            '• Infer the product\'s appearance ONLY from the main reference image — do not invent or generalize.',
            '• Never show a generic or placeholder version of the product.',
          ].join('\n');

    // ── STEP C: fixed brand elements — always present regardless of brief ─────
    // (Per-field typography instructions — font style/width/weight/color/stroke/
    // shadow per copy element — are already embedded in buildCopyPlacementMap()
    // above via the identity's textZones/typography; this section only covers
    // the elements that are NOT tied to a specific copy string.)
    const fixedBadges = Array.isArray(identity?.badges) && identity.badges.length
        ? identity.badges.map((b: any) =>
            `  • "${b.text}" — ${b.shape || 'pill'} bg:${b.bgColor || '?'} text:${b.textColor || '#FFF'} ${b.textWeight || 'Bold'} ${b.textCase || 'ALL_CAPS'} at ${b.position || 'top area'}`
          ).join('\n')
        : '';
    const fixedIconRow = identity?.iconRow?.present
        ? `  • ICON ROW (${identity.iconRow.iconCount} icons) at ${identity.iconRow.position}: ${identity.iconRow.description} — icon color: ${identity.iconRow.iconColor}, text color: ${identity.iconRow.textColor}, bg: ${identity.iconRow.bgColor || 'transparent'}`
        : '';
    const fixedDeco = identity?.decorativeElements && identity.decorativeElements !== 'none'
        ? `  • DECORATIVE EFFECTS: ${identity.decorativeElements}` : '';
    const fixedSpeed = identity?.speedLines && identity.speedLines !== 'none'
        ? `  • MOTION/SPEED EFFECTS: ${identity.speedLines}` : '';
    const fixedElements = [fixedBadges, fixedIconRow, fixedDeco, fixedSpeed].filter(Boolean).join('\n');

    const productRef = hasProductImage ? '\n• Additional images — product reference photos: exact shape, colors, label, finish from every angle provided' : '';
    const audienceCtx = [
        audienciaRef ? 'TARGET AUDIENCE PROFILE: ' + audienciaRef : '',
        drivers ? 'KEY PURCHASE DRIVERS (what matters most to them): ' + drivers : '',
    ].filter(Boolean).join('\n');

    return [
        `TASK: Generate a production-ready advertising image at ${fmt.width}x${fmt.height}px for ${fmt.platform}.`,
        '',
        'REFERENCES:',
        '• IMAGE 1 — brand reference: visual reference for the brand.' + productRef,
        '',
        'REFERENCE USAGE — SPLIT RULE:',
        "  ✅ REPLICATE from the reference: logo (exact shape, colors, size, position), brand bands (exact hex, proportions), badges/seals (shape, colors, text), the brand's own decorative effects, exact color palette, typography weight/color per element — AND ALSO the background/brand-energy graphic system (stripes, motion blur, gradients, general lighting type — see STEP C below). The piece must feel unmistakably of THIS brand, not a generic background.",
        '  ⛔ DO NOT copy from the reference: the specific person shown there, their exact pose, or the literal camera framing/angle — who the protagonist is (per the audience) and the specific shot composition are 100% new in every piece, but ALWAYS live within the same brand visual system above, never in a different environment/setting than the brand\'s.',
        '',
        'SCENE: ' + sceneDesc,
        audienceCtx ? '\n' + audienceCtx : '',
        '',
        characterBlock,
        'FORBIDDEN: copy the person, face, body, pose, or style of any character shown in the reference image.',
        '',
        interactionRule,
        '',
        productInstruction,
        '',
        'BRAND IDENTITY SYSTEM (learned from real reference images):',
        identityBlock,
        '',
        `FORMAT — ${fmt.width}x${fmt.height}px:`,
        formatGuide,
        '',
        buildCopyPlacementMap(copy, identity),
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        'STEP C — FIXED BRAND ELEMENTS (always present, every execution)',
        '⚠️ THESE ELEMENTS ARE PART OF THE BRAND TEMPLATE. They appear in EVERY ad for this brand,',
        'independent of the brief copy above. Render them exactly as described.',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        fixedElements || '  Reproduce from the reference: logo (exact shape/colors/size), brand color bands (exact hex/proportions), badges/seals. Scene (background, person, environment) is 100% new — do NOT copy the reference photo.',
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        'ABSOLUTE RULES',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '⛔ NEVER render "HEADLINE:", "SUBHEAD:", "CTA:", "STEP A", "STEP B", "STEP C" or any instruction label as visible text in the image.',
        '⛔ ZERO invented colored bands, bars, or graphic elements not present in the reference — do not add a colored banner that is not in the reference.',
        '⛔ BRAND LOGO appears EXACTLY ONCE — single placement per the reference. NEVER repeat or duplicate the logo.',
        '⛔ Typography treatment from Step B is MANDATORY — apply font style, color, stroke, shadow exactly.',
        '⛔ ZERO invented copy. ZERO lorem ipsum. ZERO text not in Step A.',
        '⛔ Every fixed element from Step C MUST appear — missing one = wrong generation.',
        '⛔ Photorealistic quality — zero AI artifacts, zero flat design.',
        '⛔ HUMAN ANATOMY: ALL characters MUST have BOTH legs fully visible. ZERO missing limbs, ZERO cropped lower body. Every person: 1 head, 2 arms, 2 legs, 2 feet — complete and correct.',
        '⛔ All people fully in frame — no cropped heads, no cropped legs, no missing body parts.',
        `⛔ FULL CANVAS: Fill the ENTIRE ${fmt.width}x${fmt.height}px canvas — ZERO empty dark zones on any side.`,
        '⛔ CTA text color: ONLY colors in the reference — NEVER invent a color absent from the reference.',
        '⛔ ZERO text containers: no boxes, ovals, outlines or shapes around body or subhead text.',
        '⛔ Each text element appears EXACTLY ONCE — zero duplicates.',
        `⛔ Output: exactly ${fmt.width}x${fmt.height}px.`,
        observacionesBlock,
        productBlock, logoBlock, conglomerateLogoBlock,
    ].filter(s => s !== '' && s !== undefined).join('\n');
}

// ─── Scene variety engine (deterministic — no API call) ───────────────────────
// Generates unique scene variants per task to avoid repetition across formats.
// Fully generic: audience-aware/driver-aware modifiers use broad regex buckets
// (young/family/professional; price/performance/status/trust), not any brand's
// product category.
export function buildSceneVariant(
    sceneDesc: string,
    audienciaRef: string,
    drivers: string,
    variantIndex: number,
): string {
    const isGeneric = !sceneDesc || /^Authentic person matching/i.test(sceneDesc.trim());

    const times = [
        'morning — warm golden light, soft long shadows, fresh and energetic mood',
        'midday — bright natural light, vibrant colors, high-energy atmosphere',
        'late afternoon — warm amber light, relaxed and confident mood',
        'evening — soft blue hour light, aspirational and premium feel',
    ];
    const timeCtx = times[((variantIndex % times.length) + times.length) % times.length];

    const compVariants = [
        'hero person fills left 60% of frame, product/text right side', 'person centered, looking slightly off-camera with natural expression',
        'dynamic angle — slight low angle, person dominant', 'environmental portrait — person in context of their world',
    ];
    const compCtx = compVariants[((variantIndex % compVariants.length) + compVariants.length) % compVariants.length];

    const audienceLower = (audienciaRef || '').toLowerCase();
    let audienceCtx = '';
    const idx = ((variantIndex % 3) + 3) % 3;
    if (/joven|young|18|25|millennial|gen z/i.test(audienceLower)) {
        audienceCtx = ['urban young adult, street-style confident', 'campus or city environment, peers nearby', 'active lifestyle, movement implied'][idx];
    } else if (/famil|family|madre|padre|pap|mam/i.test(audienceLower)) {
        audienceCtx = ['family warmth, genuine connection between people', 'home environment, comfortable and real', 'shared moment, multiple generations'][idx];
    } else if (/profesion|ejecutiv|business|trabaj/i.test(audienceLower)) {
        audienceCtx = ['professional setting, purposeful and competent', 'modern workspace or urban environment', 'achievement moment, quiet confidence'][idx];
    } else {
        audienceCtx = ['authentic person, relatable and real', 'everyday moment elevated', 'genuine expression, not posed'][idx];
    }

    const driversLower = (drivers || '').toLowerCase();
    let driverCtx = '';
    if (/precio|ahorro|value|econom/i.test(driversLower)) driverCtx = 'Scene implies smart choice, value, and satisfaction.';
    else if (/rendimiento|performance|potencia|power|speed/i.test(driversLower)) driverCtx = 'Scene implies capability, power, and performance.';
    else if (/estatus|status|premium|lujo|luxury/i.test(driversLower)) driverCtx = 'Scene implies aspiration, premium quality, and distinction.';
    else if (/confianza|trust|reliable|segur/i.test(driversLower)) driverCtx = 'Scene implies reliability, trust, and peace of mind.';

    const base = isGeneric ? `${audienceCtx}. ${compCtx}.` : sceneDesc;

    return `${base} Lighting: ${timeCtx}. Composition: ${compCtx}. ${driverCtx} Style: photorealistic, cinematic, not stock-photo-posed.`.replace(/\.\s*\./, '.').trim();
}

// ─── Vision-model quick tagging of a generated image (cheap pre-pass before the
// text model writes the video brief) — generic, no product-category assumptions.
export async function analyzeGeneratedImage(vision: TextProvider, image: ImagePart): Promise<string | null> {
    try {
        const prompt = `Eres un director creativo. Analiza esta imagen publicitaria generada con máximo detalle visual.
Responde EXACTAMENTE con este formato (si hay múltiples personas, descríbelas TODAS en PERSONAJES):
PERSONAJES: [lista TODOS los visibles — para cada uno: género, edad estimada, outfit completo con colores exactos, expresión, postura, qué hace.]
AMBIENTE: [locación exacta, hora del día, temperatura de luz en K, paleta de colores dominante, elementos de fondo fijos]
PRODUCTO: [qué producto/servicio se ve, posición en frame, cómo interactúa con los personajes]
MARCA: [logo posición, colores de marca, tagline visible, elementos gráficos]
BENEFICIO_HÉROE: [el beneficio o feature más prominente y cinematográfico de esta imagen]
MOMENTO: [micro-momento emocional — qué pasa exactamente, qué sienten los personajes]`;
        const text = await vision.complete({ prompt, images: [image], maxTokens: 700, temperature: 0.2 });
        return text?.trim() || null;
    } catch (err: any) {
        console.warn('[dco] analyzeGeneratedImage failed (non-blocking):', err.message);
        return null;
    }
}

// ─── Video brief — primary path (text model + the actual generated image) ────
// Generic: no fixed product-category "interaction map" (the source system's
// TV/fridge/washer/laptop/audio/AC bullet list) — the model is asked to infer
// the single most cinematic interaction directly from what's actually in the
// image, which is exactly what the "single painter" architecture already
// guarantees is present (it painted the real scene).
export async function buildVideoPromptFromImage(
    text: TextProvider,
    image: ImagePart,
    copy: CopyFields,
    fmt: FormatSpec,
    drivers: string,
    geminiAnalysis: string | null,
): Promise<string> {
    const { headline, body, cta, subhead, chip } = copy;
    const ar = fmt.family === 'story' ? '9:16' : fmt.family === 'square' ? '1:1' : fmt.family === 'landscape' ? '16:9' : fmt.family === 'portrait' ? '4:5' : '1:1';
    const ctaLine = cta && !/(compra|llama|visita|descarga|regístrate|lleva)/i.test(cta) ? cta : '¿Listo para sentirlo?';
    const badgeLine = chip ? `Badge "${chip}" aparece a los 4s` : 'sin badge';
    const bodyVO = (body || subhead || headline).slice(0, 140);

    const visualCtx = geminiAnalysis
        ? `ANÁLISIS VISUAL (pre-análisis de un modelo de visión — úsalo como referencia pero CONFÍA en lo que ves en la imagen adjunta):
${geminiAnalysis}

INSTRUCCIÓN CRÍTICA: Tienes la imagen real adjunta. Si el análisis de arriba no coincide con lo que ves (e.g. describe 1 persona pero ves un grupo), USA LO QUE VES en la imagen. La imagen manda.`
        : `INSTRUCCIÓN: Analiza la imagen adjunta directamente para extraer personajes, ambiente, producto y contexto — no asumas ninguna categoría de producto de antemano.`;

    const userPrompt = `${visualCtx}

COPY:
- Headline: "${headline}"
- Body VO: "${bodyVO}"
- Drivers: "${drivers || 'calidad de vida, aspiración, bienestar'}"
- CTA/cierre: "${ctaLine}"
- ${badgeLine}

INTERACCIÓN PRODUCTO — CLIP 2: identifica en la imagen adjunta la forma MÁS cinematográfica y natural en que el/los personaje(s) interactúan con el producto/servicio real que ves ahí (no asumas una categoría fija) y úsala como el momento héroe.

Write a PROFESSIONAL 30-SECOND TV COMMERCIAL PRODUCTION BRIEF — 3 clips of 10s forming ONE continuous ad with dramatic arc: INICIO → NUDO → DESENLACE. The story sells the product's key benefits.

LANGUAGE RULES — CRITICAL:
- ALL technical content in ENGLISH: character bible, environment bible, hero benefit, shot descriptions, camera angles, lens choices, blocking, lighting, SFX, Veo3 prompts, specs
- VO lines ONLY in Spanish: neutral, professional Latin Spanish — like a real premium TV commercial voice-over. NOT conversational, NOT like a friend. Think: authoritative, warm, aspirational — a professional announcer who believes in the product.

COPY ANCHOR — the VO must reflect the actual ad copy:
- INICIO VO → based on headline: "${headline}"
- NUDO VO → based on body/benefits: "${bodyVO}"
- DESENLACE VO → exact CTA: "${ctaLine}"

CONSISTENCY RULE: SAME characters, SAME space, SAME clothing across all 3 clips. ONE story, not 3 separate videos. ALL characters 18+ — if image shows minors, treat as young adults 18–22.

IF IMAGE SHOWS A GROUP: bible describes ALL visible characters equally. Full group appears in every clip — never reduce to one person.

━━━ CHARACTER BIBLE — identical across all 3 clips ━━━
[IN ENGLISH. Extract ALL visible characters from the image. For each: gender, estimated age (18+), skin tone, hair, EXACT outfit with precise colors, base expression, position. Group: "Character 1: ...", "Character 2: ...", etc. Repeats word-for-word every clip.]

━━━ ENVIRONMENT BIBLE — identical across all 3 clips ━━━
[IN ENGLISH. From the image: exact location, time of day, light temperature in K, dominant palette, fixed background elements, character positioning relative to product. Repeats word-for-word every clip.]

━━━ HERO BENEFIT ━━━
[IN ENGLISH. The one product feature this commercial is built around + how it looks cinematographically.]

━━━ CLIP 1 — INICIO (0–10s) ━━━
Emotional beat: establish desire — the character's world BEFORE the product solves their need. NO product reveal yet.
Shot 1 [0–3s]: [IN ENGLISH — lens, framing, blocking, lighting; character in their natural world, desire or need established]
Shot 2 [3–6s]: [IN ENGLISH — close-up detail; the tension, the "before" state, microexpression]
Shot 3 [6–10s]: [IN ENGLISH — camera move; product enters frame for the first time, natural and inviting]
VO (Spanish, professional TV announcer): "${headline}"
SFX: [IN ENGLISH — specific ambient sound anchored to this exact scene from the image]

━━━ CLIP 2 — NUDO (10–20s) ━━━
Emotional beat: the product delivers — the hero benefit in full cinematic action. This is the commercial's climax.
Shot 1 [0–3s]: [IN ENGLISH — push-in or macro on product; hero benefit begins, razor-sharp]
Shot 2 [3–7s]: [IN ENGLISH — the character-product interaction identified above; most cinematic selling moment; lens, blocking, emotion]
Shot 3 [7–10s]: [IN ENGLISH — reaction shot; genuine unscripted emotion, not performed]
VO (Spanish, professional — slightly more intimate, product benefits land naturally): "${bodyVO}"
SFX: [IN ENGLISH — specific sound of the product's hero benefit in action]
${badgeLine}

━━━ CLIP 3 — DESENLACE (20–30s) ━━━
Emotional beat: life improved — satisfaction, aspiration fulfilled. The CTA lands with conviction.
Shot 1 [0–4s]: [IN ENGLISH — character at peak satisfaction; the benefit has already improved their life; warm framing]
Shot 2 [4–7s]: [IN ENGLISH — wider shot; character + product together in the full space; aspirational composition]
Shot 3 [7–10s]: [IN ENGLISH — final camera move; logo + brand tagline appears naturally; character's last gesture seals the emotion]
VO (Spanish, professional — authoritative close, CTA delivered with full conviction): "${ctaLine}"
SFX: [IN ENGLISH — gentle audio fade | Brand logo + tagline on screen]

━━━ SPECS ━━━
${fmt.width}×${fmt.height}px | ${ar} | 24fps | Warm cinematic color grade
FORBIDDEN: changing character/outfit/environment between clips, artificial expressions, unrealistic anatomy, stock aesthetic

━━━ GOOGLE VEO 3 / FLOW PROMPTS ━━━
CRITICAL: The generated static image is FRAME 0. Every Veo3 prompt starts from this exact image — same character(s), same outfit(s), same space, same lighting. Google Flow reads the image as the visual anchor.

VEO3 CLIP 1 — INICIO:
[IN ENGLISH, max 200 chars. Anchored to the EXACT person(s) and space in the image. Subtle movement: breathing, gaze toward product, small anticipatory gesture. Same outfit, same room, same light. NO product interaction yet.]
VO: "${headline}"
SFX: [IN ENGLISH]

VEO3 CLIP 2 — NUDO:
[IN ENGLISH, max 200 chars. Continuation from same frame. Identical character(s), same outfit, same room — now the hero benefit interaction happens. Most cinematic moment.]
VO: "${bodyVO}"
SFX: [IN ENGLISH]

VEO3 CLIP 3 — DESENLACE:
[IN ENGLISH, max 200 chars. Continuation from same frame. Same character(s), same space — peak satisfaction. Camera slowly widens. Logo appears.]
VO: "${ctaLine}"
SFX: [IN ENGLISH — fade | Logo appears]

━━━ 🎬 MASTER ONE-SHOT FLOW PROMPT ━━━
THE MOST IMPORTANT DELIVERABLE. One single self-contained prompt for Google Flow that produces the ENTIRE commercial in ONE generation — the user pastes exactly this, nothing else. Write it as ONE dense paragraph, IN ENGLISH, 600-1000 characters, professional cinematography language, zero filler. It must pack, in this order:
1. Anchor: "Starting from the provided image as frame 0:" + one-line character bible (exact person(s), outfit, exact colors) + one-line environment (location, light temp, palette).
2. The full 3-act arc with timecodes: [0-10s] desire established, subtle movement, product enters frame — camera move named (e.g. slow push-in); [10-20s] the hero benefit interaction (the climax, most cinematic moment, lens/move named); [20-30s] satisfaction, camera widens, brand logo reveal.
3. VO cues embedded in Spanish inside quotes at each act: "${headline}" → "${bodyVO}" → "${ctaLine}", voice spec (professional announcer, gender from image).
4. Global specs at the end: ${ar}, 24fps, warm cinematic grade, same character/outfit/space across all acts, no morphing, no new characters, realistic anatomy.
[WRITE THE ACTUAL PROMPT HERE — not a description of it]

VOICE SPEC: Detect gender from the image → write exactly "Voz masculina, español neutro profesional" or "Voz femenina, español neutro profesional". Tone: authoritative yet warm, premium TV commercial cadence — natural pauses between product claims, microsilence before CTA. NEVER casual, NEVER TTS, NEVER generic.`;

    try {
        const result = await text.complete({
            system: 'You are a senior creative director specializing in hyperrealistic TV commercials. You write production briefs and Veo3 prompts so precise they execute perfectly in a single generation. You always detect the gender and group composition from the visual analysis and adjust accordingly. ALL characters must be adults 18+ — if the image shows minors, treat them as young adults 18–22.',
            prompt: userPrompt,
            images: [image],
            maxTokens: 3200,
        });
        return result?.trim() || '';
    } catch (err: any) {
        console.warn('[dco] buildVideoPromptFromImage failed (non-blocking, falls back to text-only prompt):', err.message);
        return '';
    }
}

// ─── Video brief — text-only fallback (used if the vision-based path above
// fails or no text provider is configured for it). Generic 3-clip structure,
// no hardcoded product category or audience-archetype character bibles.
export function buildVideoPrompt(
    sceneDesc: string,
    copy: CopyFields,
    fmt: FormatSpec,
    hasProductImage: boolean = false,
    audienceLabel: string = '',
    audienciaRef: string = '',
    drivers: string = '',
): string {
    const { headline, body, cta, subhead, chip } = copy;
    const f = fmt.family;
    const aspectRatio =
        f === 'story'     ? '9:16'   :
        f === 'portrait'  ? '4:5'    :
        f === 'square'    ? '1:1'    :
        f === 'landscape' ? '16:9'   :
        f === 'billboard' ? '3.88:1' :
        f === 'halfpage'  ? '1:2'    :
        f === 'mrec'      ? '6:5'    : '1:1';

    const explicitAudience = audienceLabel.trim();
    const audience = {
        label: explicitAudience || 'AUDIENCIA GENERAL',
        voiceTone: 'profesional neutra cálida — conversacional y humana',
        energy: 'media-alta, optimista',
        characterBible: `PERSONAJE PRINCIPAL: persona${audienciaRef ? ` cuyo perfil es: ${audienciaRef}` : ' adulta, auténtica'}, expresión natural, no publicitaria. MANTENER EN LOS 3 CLIPS: mismo outfit, peinado y rasgos físicos exactos.`,
        seg1Mood: 'entorno cotidiano auténtico, luz natural cálida',
        seg3Mood: 'momento de satisfacción real y genuina, sonrisa auténtica',
    };

    const productAntiHallucination = hasProductImage
        ? `PRODUCT FIDELITY — MANDATORY ALL 3 CLIPS:
• Reference photo = only visual truth for the product
• Replicate EXACTLY: shape, dimensions, color, label/logo text, surface finish
• Product sharp and legible in minimum 2 frames per clip`
        : `PRODUCT ANTI-HALLUCINATION:
• Infer appearance ONLY from the reference image — NEVER invent or generalize
• Product identifiable as the specific brand — NEVER a generic stock version`;

    const productHeroShot = 'Cinematic dolly in to product — label and brand sharp, well-lit, soft depth of field, 2 seconds on frame.';

    const voSeg1 = headline || 'Hay momentos que merecen lo mejor…';
    const voSeg2 = body ? body.slice(0, 150) : (subhead || headline || 'Descubre la diferencia.');
    const voSeg3 = cta && !/(compra|llama|visita|descarga|regístrate|lleva)/i.test(cta)
        ? cta
        : 'Así se siente cuando todo está en su lugar.';

    const anatomyRule = `HUMAN ANATOMY — ABSOLUTE RULE EVERY FRAME:
• Each person: EXACTLY 2 arms, 2 hands, 2 legs, 2 feet
• Each hand: EXACTLY 5 fingers with natural human proportions
• Face: 2 symmetric eyes, 1 nose, 1 mouth — perfect photorealistic proportions
• FORBIDDEN: extra limbs, fused or deformed fingers, duplicated bodies, floating extremities, unreal CGI anatomy`;

    return `VIDEO PRODUCTION BRIEF — 3 CLIPS FOR ONE UNIFIED 30-SECOND COMMERCIAL
Platform: ${fmt.platform} | Aspect ratio: ${aspectRatio} | Resolution: ${fmt.width}×${fmt.height}px
Audience: ${explicitAudience || audience.label} | Energy: ${audience.energy}

IMPORTANT: These 3 clips are generated SIMULTANEOUSLY but will be STITCHED INTO ONE continuous 30-second video.
Each clip must feel like part of the SAME scene, SAME story, SAME world.
Narrative arc: CLIP 1 = Inicio → CLIP 2 = Nudo → CLIP 3 = Desenlace.

━━━ CHARACTER BIBLE — IDENTICAL IN ALL 3 CLIPS ━━━
${audience.characterBible}${audienciaRef ? '\nAudience profile: ' + audienciaRef : ''}${drivers ? '\nKey motivations: ' + drivers : ''}
CRITICAL: Same actor/character must appear identically in clips 1, 2, and 3. When stitched, the viewer sees the SAME person throughout the full 30 seconds.
FORBIDDEN: changing hairstyle, outfit, skin tone, build, or character between clips.

━━━ VISUAL BIBLE — IDENTICAL IN ALL 3 CLIPS ━━━
• Color palette: derived EXCLUSIVELY from the brand reference (colors, typography, logo, brand bands)
• Reference image: USE FOR BRAND IDENTITY ONLY — DO NOT copy or reference the person/face/style from it
• Color temperature: consistent warm cinematic grade across all 3 clips
• Setting: same location or connected locations — continuous physical world
• Camera style: same lens character, same depth of field aesthetic throughout
FORBIDDEN: different color grade per clip, changing location feel, changing camera aesthetic, copying the reference character.

━━━ PRODUCT — PRECISION ━━━
${productAntiHallucination}

━━━ HUMAN ANATOMY ━━━
${anatomyRule}

━━━ BASE SCENE ━━━
${sceneDesc}

━━━ VOICE OVER — SPECIFICATIONS ━━━
Voice: ${audience.voiceTone}
Language: neutral Latin Spanish — intimate, conversational, NEVER commercial announcer tone
Technique: dramatic pause before key phrases, slightly audible natural breathing, human rhythm
Audio mix: VO 70% | Organic ambient SFX 30% (environment sounds: textures, space, natural ambience)

━━━ CLIP 1 — "INICIO: EL MUNDO ANTES" (0–10s) ━━━
Narrative purpose: Introduce the character in their authentic everyday world BEFORE the product. The viewer recognizes themselves.
Setting: ${audience.seg1Mood}
STITCH NOTE: This clip opens the story. End with character in motion or looking off-frame → seamless cut into Clip 2.

[0s–3s] Wide shot — character in their world, natural light, NO product visible
  Movement: smooth steadicam or elegant static | Light: 5500K clean natural
[3s–7s] Aspirational moment — authentic expression of desire or need, not forced
  Rack focus from environment to character face | Microexpression: latent desire, internal reflection
[7s–10s] Character begins moving toward or looks off-frame → CUT POINT to Clip 2

VO [2s–8s]: "${voSeg1}"
On-screen text: "${headline}" at 2s, brand typography, 3s duration, soft fade out
NO CTA. NO price. NO product visible.

━━━ CLIP 2 — "NUDO: EL DESCUBRIMIENTO" (0–10s) ━━━
Narrative purpose: The product enters as the NATURAL solution. The benefit is SEEN, not explained with text.
STITCH NOTE: Opens continuing the motion from Clip 1 — SAME character arriving at or reaching for the product. Ends with character fully engaged → seamless cut into Clip 3.

[0s–2s] SAME CHARACTER from Clip 1 arrives or reaches — continuous motion
  PRODUCT REVEAL: ${productHeroShot}
[2s–6s] HERO MOMENT — character discovers, uses, or experiences the product
  Reaction: real satisfaction microexpression | Real physical contact with product
  Detail shot: character hands (2 hands, 5 natural fingers) in contact with product
[8s–10s] Character looks up or outward, transformation beginning → CUT POINT to Clip 3

VO [3s–9s]: "${voSeg2}"
On-screen text: ${chip ? '"' + chip + '" as brand badge at 4s, 2s duration' : 'none — only images and VO'}

━━━ CLIP 3 — "DESENLACE: LA TRANSFORMACIÓN" (0–10s) ━━━
Narrative purpose: Emotional payoff. Life transformed. The viewer must DESIRE that state.
STITCH NOTE: Opens with SAME CHARACTER from Clip 2, now in their transformed world — story complete.
Setting: ${audience.seg3Mood}

[0s–3s] SAME CHARACTER at their best moment — ${audience.energy}, light 10% brighter than Clip 1
  Movement: gentle upward crane or dolly out revealing transformed world
[3s–7s] Transformed world — environment reflects the benefit: warmer, more alive, more complete
  Product naturally integrated | Color grade: +5% saturation vs Clip 1
[7s–9s] Direct look to camera — genuine connection with viewer, real smile (2 symmetric eyes, authentic expression)
[9s–10s] Clean cut → solid brand color + logo — clean, powerful, NO additional text

VO [0s–8s]: "${voSeg3}"
  Warmest and most intimate voice of the piece — soft fade with ambience in last 2s
On-screen text: NONE until 9s. At 9s: brand logo ONLY.

━━━ TECHNICAL SPECS (ALL 3 CLIPS) ━━━
• Resolution: ${fmt.width}×${fmt.height}px | Aspect: ${aspectRatio}
• Duration: EXACTLY 10.0 seconds each clip
• Frame rate: 24fps cinematic — organic movement, NOT digitally interpolated
• Color grade: warm and cinematic — consistent with brand palette across ALL 3 clips
• Characters: authentic, photorealistic, 100% perfect human anatomy
• Audio: VO + organic ambient SFX only — no background music tracks
FORBIDDEN: stock footage aesthetic, artificial expressions, generic CGI environments, unreal anatomy (extra arms, fused fingers, deformed faces), explicit CTA text on screen, generic product not matching the reference, different character appearance between clips, copying the reference character/person.`;
}
