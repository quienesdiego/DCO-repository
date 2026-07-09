// ─── QA del DCO Studio: un solo agente decide, sin arbitraje ──────────────────
// Filosofía: lo que se puede medir con código (texto, color) se mide con código,
// sin llamar a ningún modelo de IA. Solo lo que requiere criterio visual
// (anatomía, cumplimiento del checklist creativo) pasa por UNA sola llamada a
// Gemini, temperatura 0, JSON estricto — nunca dos modelos negociando un puntaje.
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import { converter, differenceCiede2000 } from 'culori';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const deltaE = differenceCiede2000();
const toLab = converter('lab');

// ─── Agente de texto (OCR, tesseract.js — corre local, cero tokens) ───────────

let ocrWorkerPromise: Promise<Worker> | null = null;
async function getOcrWorker(): Promise<Worker> {
    if (!ocrWorkerPromise) ocrWorkerPromise = createWorker('spa');
    return ocrWorkerPromise;
}

function normalizeText(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Distancia de Levenshtein → ratio de similitud (0-1), para comparar contra ruido real de OCR
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

// ¿El texto detectado por OCR contiene algo parecido al string esperado, en alguna ventana de palabras?
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

// Etiquetas de layout que NUNCA deben aparecer como texto literal en la imagen — si aparecen, es un
// error real (no una opinión): la IA de generación confundió el nombre del campo con su contenido.
const LAYOUT_LABEL_BLOCKLIST = ['cta', 'headline', 'subhead', 'body copy', 'badge', 'vitamina chip', 'line 1', 'line 2'];

export interface TextCheckResult {
    ocrText: string;
    ocrConfidence: number;
    missing: string[];       // campos de copy que probablemente NO aparecen (señal blanda)
    leakedLabels: string[];  // etiquetas de layout filtradas como texto literal (señal dura)
}

// ─── Portero anti-texto — para la arquitectura "un solo pintor" ───────────────
// La foto generada por Gemini debe venir SIN ningún texto (todo el copy/logos los pone
// la capa de marca determinística después). Este chequeo detecta si Gemini desobedeció
// y escribió algo — es la condición binaria y verificable que reemplaza a "confiar en
// que se porte bien". Palabras cortas/de baja confianza se descartan: OCR sobre una
// foto (texturas, ruido) siempre inventa fragmentos basura de 1-2 letras.
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
    // Umbral: 2+ palabras "reales" con confianza global decente = hay texto de verdad.
    // 1 palabra suelta con confianza baja suele ser ruido de OCR sobre textura de foto.
    const conf = data.confidence || 0;
    const hasText = words.length >= 2 || (words.length === 1 && conf > 65);
    return { hasText, detectedWords: words.slice(0, 12), confidence: conf };
}

export async function checkTextPresence(
    imageBuffer: Buffer,
    copy: { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string }
): Promise<TextCheckResult> {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(imageBuffer);
    const ocrNorm = normalizeText(data.text || '');

    const missing: string[] = [];
    const fields: [string, string][] = [
        ['headline', copy.headline], ['subhead', copy.subhead], ['vitamina_chip', copy.vitamina_chip],
        ['body', copy.body], ['cta', copy.cta],
    ];
    for (const [field, value] of fields) {
        const v = (value || '').trim();
        if (!v) continue;
        // OCR sobre tipografía publicitaria estilizada es ruidoso (~55% de confianza medido en pruebas
        // reales) — se trata como señal blanda: solo se marca "missing" si no aparece NADA parecido.
        if (!containsFuzzy(ocrNorm, normalizeText(v), 0.45)) missing.push(field);
    }

    const leakedLabels = LAYOUT_LABEL_BLOCKLIST.filter(label => ocrNorm.includes(label));

    return { ocrText: data.text || '', ocrConfidence: data.confidence || 0, missing, leakedLabels };
}

// ─── Agente de color (sharp + culori, matemática pura — cero tokens) ──────────
// No compara la foto completa contra la marca (el fondo/escena varía legítimamente) — solo
// verifica que el color insignia de la marca aparezca de forma prominente en algún lado.

async function dominantHexColors(buf: Buffer, n = 6): Promise<string[]> {
    const { data, info } = await sharp(buf).resize(48, 48, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const buckets = new Map<string, { r: number; g: number; b: number; count: number }>();
    const step = 24; // cuantiza por canal para agrupar colores parecidos
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
    // ΔE < 15 ≈ el color de marca (o algo perceptualmente muy cercano) SÍ está presente y es prominente
    return { present: minDeltaE < 15, minDeltaE, brandHex, dominantColors: colors };
}

// ─── Único pase de modelo: solo para lo que de verdad requiere criterio visual ─
// Anatomía/defectos y cumplimiento del checklist creativo no tienen forma determinística
// confiable. Un solo modelo (Gemini, temperatura 0, JSON estricto) decide — nunca dos
// modelos compitiendo, nunca se le pide al usuario que arbitre.

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
    imageBase64: string; imageMime: string;
    kvBase64: string; kvMime: string;
    copy: { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string };
    checklist: string[];
    customQaRules: string[];
    brandColorHex?: string;
    characterPhoto?: { base64: string; mime: string; name: string };
    geminiApiKey: string;
}): Promise<QaVerdict> {
    const imageBuf = Buffer.from(params.imageBase64, 'base64');

    const [textCheck, colorCheck] = await Promise.all([
        checkTextPresence(imageBuf, params.copy).catch(err => { console.warn('[dcoQa] OCR falló (no bloqueante):', err.message); return null; }),
        params.brandColorHex ? checkBrandColorPresence(imageBuf, params.brandColorHex).catch(() => null) : Promise.resolve(null),
    ]);

    const deterministicNotes: string[] = [];
    if (textCheck?.missing.length) {
        deterministicNotes.push(`OCR no detectó (señal blanda — la tipografía estilizada puede confundir al OCR, verificá visualmente): ${textCheck.missing.join(', ')}`);
    }
    if (textCheck?.leakedLabels.length) {
        deterministicNotes.push(`ALERTA (señal dura, esto SIEMPRE es un error real): apareció como texto literal en la imagen: ${textCheck.leakedLabels.join(', ')}`);
    }
    if (colorCheck && !colorCheck.present) {
        deterministicNotes.push(`El color insignia de marca (${colorCheck.brandHex}) no aparece de forma prominente (ΔE=${colorCheck.minDeltaE.toFixed(1)} — señal blanda, puede ser una escena/foto legítimamente distinta, usá tu criterio).`);
    }

    const checklistBlock = params.checklist.length ? `\nCHECKLIST DEL BRIEF CREATIVO:\n${params.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : '';
    const rulesBlock = params.customQaRules.length ? `\nREGLAS DE MARCA (deben cumplirse):\n${params.customQaRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}` : '';
    const detBlock = deterministicNotes.length ? `\nHALLAZGOS YA VERIFICADOS POR CÓDIGO (no los vuelvas a inferir de la imagen, incorporalos a tu veredicto):\n${deterministicNotes.map(n => `- ${n}`).join('\n')}` : '';

    const copyLines = ([
        ['headline', params.copy.headline], ['subhead', params.copy.subhead], ['badge', params.copy.vitamina_chip],
        ['body', params.copy.body], ['cta', params.copy.cta],
    ] as const).filter(([, v]) => v).map(([k, v]) => `- ${k}: "${v}"`).join('\n');

    const prompt = `Sos el único control de calidad de este creativo publicitario generado por IA. No hay un segundo modelo revisando esto en paralelo ni un panel de arbitraje — tu veredicto es el final, y nunca se le pide al usuario que elija entre versiones.

COPY ESPERADO (debe aparecer, cada uno una sola vez):
${copyLines}
${checklistBlock}${rulesBlock}${detBlock}

CHEQUEOS DE ANATOMÍA (siempre aplican — no existe forma determinística de verificar esto, usá tu criterio visual):
A. EXTRA_LIMBS: ¿alguna persona tiene más de 2 brazos o 2 piernas visibles?
B. FINGER_DEFORMITY: ¿manos/dedos claramente malformados (conteo incorrecto, dedos fusionados/derretidos)?
C. FACE_ANOMALY: ¿ojos/rasgos faciales duplicados, o asimetría severa antinatural?
D. FLOATING_LIMB: ¿partes del cuerpo desconectadas, flotando sin estar unidas a un cuerpo?
${params.characterPhoto ? `
CONSISTENCIA DE PERSONAJE — se incluyó una TERCERA imagen: la foto de referencia de "${params.characterPhoto.name}". Comparala con la persona protagonista de la imagen generada:
E. CHARACTER_MATCH: ¿es reconociblemente la MISMA persona (mismo rostro, mismo tono de piel, mismo tipo de cabello)? No hace falta que sea pixel-perfecto — pequeñas variaciones de pose/luz/expresión son normales, lo que importa es si un humano diría "sí, es la misma persona".` : ''}

EQUILIBRIO MARCA vs CREATIVIDAD (la primera imagen adjunta es el KV real de la marca — comparala con la imagen generada):
F. STYLE_FIDELITY (0-10): ¿la foto generada usa el mismo lenguaje visual de marca que el KV — misma paleta de colores dominante, misma energía gráfica (franjas/diagonales/gradientes/iluminación), mismo mood? 0-3 = podría ser de cualquier marca, no hay relación visible. 4-6 = hay algún eco de la marca pero débil. 7-10 = inconfundiblemente la misma marca.
G. CREATIVE_FRESHNESS (0-10): ¿la escena (pose, encuadre, fondo, acción, momento) es una variación genuinamente nueva y NO una copia/reencuadre disimulado del KV? 0-3 = es prácticamente la misma foto del KV con retoques. 4-6 = cambios menores, se siente reciclada. 7-10 = momento/ángulo claramente distinto y con personalidad propia, pero coherente con la marca.
Un buen resultado tiene AMBOS puntajes altos — alto en F y bajo en G es "calco sin vida", alto en G y bajo en F es "bonito pero no es de esta marca". Si cualquiera de los dos queda por debajo de 5, es motivo de reintento.

Devolvé SOLO JSON válido, sin markdown:
{
  "passed": true o false,
  "score": 0-100,
  "styleFidelity": 0-10,
  "creativeFreshness": 0-10,
  "issues": ["CHECK_NAME: qué viste"],
  "correctionsForPrompt": "correcciones específicas y accionables para el siguiente intento de generación, o string vacío si passed=true"${params.characterPhoto ? ',\n  "characterMatch": true o false' : ''}
}`;

    try {
        const res = await fetch(`${GEMINI_BASE}/models/gemini-2.5-pro:generateContent?key=${params.geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [
                    { inlineData: { mimeType: params.kvMime, data: params.kvBase64 } },
                    { inlineData: { mimeType: params.imageMime, data: params.imageBase64 } },
                    ...(params.characterPhoto ? [{ inlineData: { mimeType: params.characterPhoto.mime, data: params.characterPhoto.base64 } }] : []),
                    { text: prompt },
                ] }],
                // gemini-2.5-pro gasta tokens de "thinking" antes del JSON final — con maxOutputTokens
                // bajo, el thinking se come todo el presupuesto y el texto visible queda vacío.
                generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 8192 },
            }),
            signal: AbortSignal.timeout(45_000),
        });
        const data: any = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || `Gemini QA ${res.status}`);
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = JSON.parse(text);

        const issues: string[] = Array.isArray(parsed.issues) ? [...parsed.issues] : [];
        // Una etiqueta de layout filtrada como texto SIEMPRE es un error real (chequeo determinístico,
        // no una opinión) — se fuerza el fallo aunque el modelo no lo haya marcado.
        const labelLeakFail = !!textCheck?.leakedLabels.length;
        if (labelLeakFail && !issues.some(i => i.includes('LAYOUT_LABEL_LEAK'))) {
            issues.push(`LAYOUT_LABEL_LEAK: ${textCheck!.leakedLabels.join(', ')}`);
        }
        // Si se pidió verificar personaje y el modelo dice que NO es la misma persona, es un
        // motivo de reintento tan fuerte como cualquier otro — se fuerza el fallo.
        const characterMismatch = !!params.characterPhoto && parsed.characterMatch === false;
        if (characterMismatch && !issues.some(i => i.includes('CHARACTER_MATCH'))) {
            issues.push(`CHARACTER_MATCH: no se reconoce como "${params.characterPhoto!.name}"`);
        }

        // Equilibrio marca/creatividad: un puntaje general alto no puede tapar que la pieza
        // no se parezca a la marca (calco sin identidad) o que sea un calco literal del KV
        // (sin creatividad real). Cualquiera de los dos por debajo de 5/10 fuerza reintento,
        // aunque el modelo haya marcado passed=true en su veredicto general.
        const styleFidelity = typeof parsed.styleFidelity === 'number' ? Math.min(10, Math.max(0, parsed.styleFidelity)) : null;
        const creativeFreshness = typeof parsed.creativeFreshness === 'number' ? Math.min(10, Math.max(0, parsed.creativeFreshness)) : null;
        const lowFidelity = styleFidelity !== null && styleFidelity < 5;
        const lowFreshness = creativeFreshness !== null && creativeFreshness < 5;
        if (lowFidelity && !issues.some(i => i.includes('STYLE_FIDELITY'))) {
            issues.push(`STYLE_FIDELITY: ${styleFidelity}/10 — no se parece lo suficiente al lenguaje visual de la marca`);
        }
        if (lowFreshness && !issues.some(i => i.includes('CREATIVE_FRESHNESS'))) {
            issues.push(`CREATIVE_FRESHNESS: ${creativeFreshness}/10 — se siente un calco del KV, no una variación creativa`);
        }
        const forcedFail = labelLeakFail || characterMismatch || lowFidelity || lowFreshness;

        // El puntaje general que devuelve el modelo es holístico y puede no reflejar debilidad
        // real de marca/creatividad (el bug reportado: "100/100" en una pieza sin relación
        // visual con el KV). Se limita el techo del score en función de F y G — un score de
        // 100 ya no es posible si la fidelidad de marca o la frescura creativa son bajas.
        let score = typeof parsed.score === 'number' ? Math.min(100, Math.max(0, parsed.score)) : 50;
        if (styleFidelity !== null) score = Math.min(score, 40 + styleFidelity * 6);
        if (creativeFreshness !== null) score = Math.min(score, 40 + creativeFreshness * 6);

        return {
            passed: parsed.passed === true && !forcedFail,
            score,
            issues,
            correctionsForPrompt: (typeof parsed.correctionsForPrompt === 'string' && parsed.correctionsForPrompt)
                || (labelLeakFail ? `Eliminá el texto literal de etiqueta de layout que aparece en la imagen: ${textCheck!.leakedLabels.join(', ')}. Ese texto nunca debe ser visible en el creativo.` : '')
                || (characterMismatch ? `El protagonista debe ser reconociblemente la misma persona que la foto de referencia de "${params.characterPhoto!.name}" (mismo rostro, tono de piel y cabello) — reforzá la instrucción de identidad.` : '')
                || (lowFidelity ? 'Reforzá la paleta de colores y la energía gráfica de marca (franjas/diagonales/gradientes/mood del KV) en la escena — se ve genérica, sin relación visual con la marca.' : '')
                || (lowFreshness ? 'La escena es demasiado parecida al KV de referencia — cambiá pose, encuadre o momento para que sea una variación creativa real, no una copia.' : ''),
            deterministic: { text: textCheck, color: colorCheck },
            styleFidelity, creativeFreshness,
        };
    } catch (err: any) {
        console.error('[dcoQa] Pase de modelo falló (no bloqueante, se entrega la imagen igual):', err.message);
        return {
            passed: true,
            score: 70,
            issues: ['QA_MODEL_ERROR: no se pudo verificar por fallo de red, se entregó sin bloquear'],
            correctionsForPrompt: '',
            deterministic: { text: textCheck, color: colorCheck },
        };
    }
}
