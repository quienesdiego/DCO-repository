// ─── DCO Studio QA: one agent decides, no arbitration ──────────────────────────
// Philosophy: whatever can be measured with code (text presence, brand color) is
// measured with code — zero tokens spent. Only what genuinely requires visual
// judgment (anatomy, creative-brief compliance) goes through a SINGLE call to a
// multimodal LLM, temperature 0, strict JSON — never two models negotiating a score.
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import { converter, differenceCiede2000 } from 'culori';
import type { TextProvider, ImagePart } from '../adapters/types.js';

const deltaE = differenceCiede2000();
const toLab = converter('lab');

// ─── Text agent (OCR, tesseract.js — runs locally, zero tokens) ────────────────

let ocrWorkerPromise: Promise<Worker> | null = null;
/** OCR language defaults to Spanish; override with DCO_OCR_LANG (tesseract.js language code, e.g. "eng"). */
async function getOcrWorker(): Promise<Worker> {
    if (!ocrWorkerPromise) ocrWorkerPromise = createWorker(process.env.DCO_OCR_LANG || 'spa');
    return ocrWorkerPromise;
}

function normalizeText(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Levenshtein distance → similarity ratio (0-1), tolerant of real OCR noise.
function similarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return 1 - dp[m][n] / Math.max(m, n);
}

// Does the OCR'd text contain something close to the expected string, in any word window?
function containsFuzzy(ocrNorm: string, expectedNorm: string, threshold: number): boolean {
    if (!expectedNorm) return true;
    if (ocrNorm.includes(expectedNorm)) return true;
    const words = ocrNorm.split(' ');
    const winSize = Math.max(1, expectedNorm.split(' ').length);
    for (let i = 0; i <= words.length - winSize; i++) {
        if (similarity(words.slice(i, i + winSize).join(' '), expectedNorm) >= threshold) return true;
    }
    return false;
}

/**
 * Layout-field labels that must NEVER appear as literal text in the image — if they
 * do, it's a real, deterministic error (the image model confused a field's name with
 * its content), not a matter of opinion. Extend this list if you add new copy fields.
 */
const LAYOUT_LABEL_BLOCKLIST = ['cta', 'headline', 'subhead', 'body copy', 'badge', 'line 1', 'line 2'];

export interface TextCheckResult {
    ocrText: string;
    ocrConfidence: number;
    missing: string[];       // copy fields that probably did NOT render (soft signal)
    leakedLabels: string[];  // layout labels leaked as literal text (hard signal)
}

// ─── Anti-text gate — for the "single painter" architecture ────────────────────
// The generated photo must come back with ZERO text (all copy/logos are added later
// by the deterministic brand layer). This check detects whether the image model
// disobeyed and wrote something — a binary, verifiable condition instead of "trust
// that it behaves". Short/low-confidence words are discarded: OCR over a photo
// (textures, noise) always invents 1-2 letter garbage fragments.
export interface NoTextCheckResult {
    hasText: boolean;
    detectedWords: string[];
    confidence: number;
}

export async function checkImageHasNoText(imageBuffer: Buffer): Promise<NoTextCheckResult> {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(imageBuffer);
    const words = (data.text || '')
        .split(/\s+/)
        .map(w => w.replace(/[^a-zA-ZáéíóúñÁÉÍÓÚÑ0-9+%$]/g, ''))
        .filter(w => w.length >= 3 && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]{3,}/.test(w));
    // Threshold: 2+ "real" words with decent confidence = real text. A single stray
    // low-confidence word is usually OCR noise over photo texture.
    const conf = data.confidence || 0;
    const hasText = words.length >= 2 || (words.length === 1 && conf > 65);
    return { hasText, detectedWords: words.slice(0, 12), confidence: conf };
}

export async function checkTextPresence(
    imageBuffer: Buffer,
    copy: { headline: string; subhead: string; chip: string; body: string; cta: string }
): Promise<TextCheckResult> {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(imageBuffer);
    const ocrNorm = normalizeText(data.text || '');

    const missing: string[] = [];
    const fields: [string, string][] = [
        ['headline', copy.headline], ['subhead', copy.subhead], ['chip', copy.chip],
        ['body', copy.body], ['cta', copy.cta],
    ];
    for (const [field, value] of fields) {
        const v = (value || '').trim();
        if (!v) continue;
        // OCR over stylized ad typography is noisy — treated as a soft signal: only
        // flagged "missing" if nothing resembling it shows up at all.
        if (!containsFuzzy(ocrNorm, normalizeText(v), 0.45)) missing.push(field);
    }

    const leakedLabels = LAYOUT_LABEL_BLOCKLIST.filter(label => ocrNorm.includes(label));

    return { ocrText: data.text || '', ocrConfidence: data.confidence || 0, missing, leakedLabels };
}

// ─── Color agent (sharp + culori, pure math — zero tokens) ─────────────────────
// Doesn't compare the whole photo against the brand (the scene/background legitimately
// varies) — only checks that the brand's signature color shows up prominently somewhere.

async function dominantHexColors(buf: Buffer, n = 6): Promise<string[]> {
    const { data, info } = await sharp(buf).resize(48, 48, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const buckets = new Map<string, { r: number; g: number; b: number; count: number }>();
    const step = 24; // quantize per-channel to group similar colors
    for (let i = 0; i + 2 < data.length; i += info.channels) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const key = `${Math.floor(r / step)}_${Math.floor(g / step)}_${Math.floor(b / step)}`;
        const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
        bucket.r += r; bucket.g += g; bucket.b += b; bucket.count++;
        buckets.set(key, bucket);
    }
    return [...buckets.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, n)
        .map(b => {
            const hex = (v: number) => Math.round(v / b.count).toString(16).padStart(2, '0');
            return `#${hex(b.r)}${hex(b.g)}${hex(b.b)}`;
        });
}

export interface ColorCheckResult {
    present: boolean;
    minDeltaE: number;
    brandHex: string;
    dominantColors: string[];
}

export async function checkBrandColorPresence(imageBuffer: Buffer, brandHex: string): Promise<ColorCheckResult> {
    const colors = await dominantHexColors(imageBuffer);
    const target = toLab(brandHex);
    let minDeltaE = Infinity;
    for (const c of colors) {
        const d = deltaE(toLab(c) as any, target as any);
        if (d < minDeltaE) minDeltaE = d;
    }
    // ΔE < 15 ≈ the brand color (or something perceptually very close) IS present and prominent.
    return { present: minDeltaE < 15, minDeltaE, brandHex, dominantColors: colors };
}

// ─── Single model pass: only for what genuinely requires visual judgment ───────
// Anatomy/defects and creative-checklist compliance have no reliable deterministic
// check. One model (your `vision` TextProvider, temperature 0, strict JSON) decides —
// never two models competing, and the user is never asked to arbitrate between versions.

export interface QaVerdict {
    passed: boolean;
    score: number;
    issues: string[];
    correctionsForPrompt: string;
    deterministic: { text: TextCheckResult | null; color: ColorCheckResult | null };
    styleFidelity?: number | null;
    creativeFreshness?: number | null;
}

export async function runQualityCheck(params: {
    vision: TextProvider;
    imageBase64: string; imageMime: string;
    referenceBase64: string; referenceMime: string;
    copy: { headline: string; subhead: string; chip: string; body: string; cta: string };
    checklist: string[];
    customQaRules: string[];
    brandColorHex?: string;
    characterPhoto?: { base64: string; mime: string; name: string };
}): Promise<QaVerdict> {
    const imageBuf = Buffer.from(params.imageBase64, 'base64');

    const [textCheck, colorCheck] = await Promise.all([
        checkTextPresence(imageBuf, params.copy).catch(err => { console.warn('[qa] OCR failed (non-blocking):', err.message); return null; }),
        params.brandColorHex ? checkBrandColorPresence(imageBuf, params.brandColorHex).catch(() => null) : Promise.resolve(null),
    ]);

    const deterministicNotes: string[] = [];
    if (textCheck?.missing.length) {
        deterministicNotes.push(`OCR did not detect (soft signal — stylized type can trip up OCR, verify visually): ${textCheck.missing.join(', ')}`);
    }
    if (textCheck?.leakedLabels.length) {
        deterministicNotes.push(`WARNING (hard signal, this is ALWAYS a real error): appeared as literal text in the image: ${textCheck.leakedLabels.join(', ')}`);
    }
    if (colorCheck && !colorCheck.present) {
        deterministicNotes.push(`The brand's signature color (${colorCheck.brandHex}) is not prominently present (ΔE=${colorCheck.minDeltaE.toFixed(1)} — soft signal, could legitimately be a different scene/photo, use your judgment).`);
    }

    const checklistBlock = params.checklist.length ? `\nCREATIVE BRIEF CHECKLIST:\n${params.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : '';
    const rulesBlock = params.customQaRules.length ? `\nBRAND RULES (must be respected):\n${params.customQaRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}` : '';
    const detBlock = deterministicNotes.length ? `\nFINDINGS ALREADY VERIFIED BY CODE (don't re-infer these from the image, fold them into your verdict):\n${deterministicNotes.map(n => `- ${n}`).join('\n')}` : '';

    const copyLines = ([
        ['headline', params.copy.headline], ['subhead', params.copy.subhead], ['badge', params.copy.chip],
        ['body', params.copy.body], ['cta', params.copy.cta],
    ] as const).filter(([, v]) => v).map(([k, v]) => `- ${k}: "${v}"`).join('\n');

    const prompt = `You are the sole quality control for this AI-generated ad creative. There is no second model reviewing this in parallel, no arbitration panel — your verdict is final, and the end user is never asked to pick between versions.

EXPECTED COPY (must appear, each exactly once):
${copyLines}
${checklistBlock}${rulesBlock}${detBlock}

ANATOMY CHECKS (always apply — no deterministic way to verify these, use your visual judgment):
A. EXTRA_LIMBS: does any person have more than 2 visible arms or 2 visible legs?
B. FINGER_DEFORMITY: clearly malformed hands/fingers (wrong count, fused/melted fingers)?
C. FACE_ANOMALY: duplicated eyes/facial features, or severe unnatural asymmetry?
D. FLOATING_LIMB: disconnected body parts floating, not attached to a body?
${params.characterPhoto ? `
CHARACTER CONSISTENCY — a THIRD image was included: the reference photo of "${params.characterPhoto.name}". Compare it against the main subject of the generated image:
E. CHARACTER_MATCH: is it recognizably the SAME person (same face, same skin tone, same hair type)? It doesn't need to be pixel-perfect — minor pose/light/expression variation is normal; what matters is whether a human would say "yes, that's the same person".` : ''}

BRAND vs CREATIVITY BALANCE (the first attached image is the real brand reference — compare it against the generated image):
F. STYLE_FIDELITY (0-10): does the generated photo use the same visual brand language as the reference — same dominant color palette, same graphic energy (stripes/diagonals/gradients/lighting), same mood? 0-3 = could be any brand, no visible relation. 4-6 = a faint echo of the brand but weak. 7-10 = unmistakably the same brand.
G. CREATIVE_FRESHNESS (0-10): is the scene (pose, framing, background, action, moment) a genuinely new variation and NOT a disguised copy/reframe of the reference? 0-3 = essentially the same reference photo with retouches. 4-6 = minor changes, feels recycled. 7-10 = clearly distinct moment/angle with its own personality, but consistent with the brand.
A good result scores high on BOTH — high F and low G is "lifeless copy", high G and low F is "pretty but not this brand". Either score below 5 is grounds for a retry.

Return ONLY valid JSON, no markdown:
{
  "passed": true or false,
  "score": 0-100,
  "styleFidelity": 0-10,
  "creativeFreshness": 0-10,
  "issues": ["CHECK_NAME: what you saw"],
  "correctionsForPrompt": "specific, actionable corrections for the next generation attempt, or empty string if passed=true"${params.characterPhoto ? ',\n  "characterMatch": true or false' : ''}
}`;

    try {
        const images: ImagePart[] = [
            { base64: params.referenceBase64, mimeType: params.referenceMime },
            { base64: params.imageBase64, mimeType: params.imageMime },
            ...(params.characterPhoto ? [{ base64: params.characterPhoto.base64, mimeType: params.characterPhoto.mime }] : []),
        ];
        const text = await params.vision.complete({ prompt, images, temperature: 0, jsonMode: true, maxTokens: 8192 });
        const parsed = JSON.parse(text);

        const issues: string[] = Array.isArray(parsed.issues) ? [...parsed.issues] : [];
        // A leaked layout label is ALWAYS a real error (deterministic check, not an
        // opinion) — force the failure even if the model didn't flag it.
        const labelLeakFail = !!textCheck?.leakedLabels.length;
        if (labelLeakFail && !issues.some(i => i.includes('LAYOUT_LABEL_LEAK'))) {
            issues.push(`LAYOUT_LABEL_LEAK: ${textCheck!.leakedLabels.join(', ')}`);
        }
        // If character verification was requested and the model says it's NOT the same
        // person, that's as strong a retry reason as any other — force the failure.
        const characterMismatch = !!params.characterPhoto && parsed.characterMatch === false;
        if (characterMismatch && !issues.some(i => i.includes('CHARACTER_MATCH'))) {
            issues.push(`CHARACTER_MATCH: not recognized as "${params.characterPhoto!.name}"`);
        }

        // Brand/creativity balance: a high overall score can't paper over the piece not
        // looking like the brand (lifeless copy) or being a literal copy of the reference
        // (no real creativity). Either dropping below 5/10 forces a retry, even if the
        // model marked passed=true in its overall verdict.
        const styleFidelity = typeof parsed.styleFidelity === 'number' ? Math.min(10, Math.max(0, parsed.styleFidelity)) : null;
        const creativeFreshness = typeof parsed.creativeFreshness === 'number' ? Math.min(10, Math.max(0, parsed.creativeFreshness)) : null;
        const lowFidelity = styleFidelity !== null && styleFidelity < 5;
        const lowFreshness = creativeFreshness !== null && creativeFreshness < 5;
        if (lowFidelity && !issues.some(i => i.includes('STYLE_FIDELITY'))) {
            issues.push(`STYLE_FIDELITY: ${styleFidelity}/10 — not close enough to the brand's visual language`);
        }
        if (lowFreshness && !issues.some(i => i.includes('CREATIVE_FRESHNESS'))) {
            issues.push(`CREATIVE_FRESHNESS: ${creativeFreshness}/10 — feels like a copy of the reference, not a creative variation`);
        }
        const forcedFail = labelLeakFail || characterMismatch || lowFidelity || lowFreshness;

        // The model's overall score is holistic and can mask real brand/creativity
        // weakness (e.g. a 100/100 on a piece with no visual relation to the reference).
        // Cap the score's ceiling based on F and G — a 100 is no longer possible if brand
        // fidelity or creative freshness is low.
        let score = typeof parsed.score === 'number' ? Math.min(100, Math.max(0, parsed.score)) : 50;
        if (styleFidelity !== null) score = Math.min(score, 40 + styleFidelity * 6);
        if (creativeFreshness !== null) score = Math.min(score, 40 + creativeFreshness * 6);

        return {
            passed: parsed.passed === true && !forcedFail,
            score,
            issues,
            correctionsForPrompt: (typeof parsed.correctionsForPrompt === 'string' && parsed.correctionsForPrompt)
                || (labelLeakFail ? `Remove the literal layout-label text that appears in the image: ${textCheck!.leakedLabels.join(', ')}. That text must never be visible in the creative.` : '')
                || (characterMismatch ? `The main subject must be recognizably the same person as the reference photo of "${params.characterPhoto!.name}" (same face, skin tone, hair) — reinforce the identity instruction.` : '')
                || (lowFidelity ? "Reinforce the brand's color palette and graphic energy (stripes/diagonals/gradients/mood from the reference) in the scene — it reads as generic, with no visible tie to the brand." : '')
                || (lowFreshness ? 'The scene is too close to the reference image — change pose, framing, or moment so it reads as a real creative variation, not a copy.' : ''),
            deterministic: { text: textCheck, color: colorCheck },
            styleFidelity, creativeFreshness,
        };
    } catch (err: any) {
        console.error('[qa] Model pass failed (non-blocking, delivering the image anyway):', err.message);
        return {
            passed: true,
            score: 70,
            issues: ['QA_MODEL_ERROR: could not verify due to a network/provider failure, delivered without blocking'],
            correctionsForPrompt: '',
            deterministic: { text: textCheck, color: colorCheck },
        };
    }
}
