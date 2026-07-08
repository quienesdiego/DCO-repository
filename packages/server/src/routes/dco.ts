/**
 * DCO Studio — main engine router.
 *
 * Generic, provider-agnostic port of the source system's routes/dco.ts. Every
 * AI/storage call goes through the `DcoProviders` bundle (see
 * adapters/types.ts) — nothing here imports a concrete SDK or reads a
 * provider-specific env var. To mount:
 *
 *   app.route('/api/dco', createDcoRoutes(providers));
 *
 * See promptBuilder.ts for the notes on exactly what was removed from the
 * source system's brand-specific prompt logic.
 */
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import sharp from 'sharp';
import type { DcoProviders, ImagePart, BrandProfileRecord } from '../adapters/types.js';
import { runQualityCheck, checkImageHasNoText } from '../services/qa.js';
import { listCharacters, createCharacter, deleteCharacter, getCharacterPhotoBase64 } from '../services/characters.js';
import { planStoryboard, createStory, saveSlide, listStories, getStory } from '../services/stories.js';
import { compositeBrandLayer, deriveBrandLayerStyle, sampleZoneDominantColor, type GraphicOverlayZone } from '../services/overlay.js';

import { FORMATS, CAROUSEL_FORMATS } from './dco/formats.js';
import {
    type CopyFields, parseCopyText, adaptCopyToFamily, buildCopyBlock, DEFAULT_COPY_RULES,
    buildZoneLengthInstruction, countBenefitZones, buildBeneficiosCountInstruction, buildSubheadInstruction,
    collectCopyViolations, brevityRetryFeedback,
} from './dco/copy.js';
import {
    buildPrompt, buildSceneVariant, buildVideoPrompt, buildVideoPromptFromImage,
    analyzeGeneratedImage, TONO_MODIFIERS, GENERIC_IDENTITY_BLOCK,
} from './dco/promptBuilder.js';
import { analyzeBrandIdentity, deriveProposedZones, deriveDefaultLogoZone, KV_FORMAT_LABELS, type LabeledReferenceImage } from './dco/brandIdentity.js';
import { buildTemplateWorkbook, buildCuadroWorkbook } from './dco/excelTemplate.js';
import { parseBriefFile, extractBriefAudiences, updateBriefStatus } from './dco/briefParser.js';
import { buildAnimatedGif } from './dco/gif.js';
import { parseJsonLoose } from './dco/jsonUtils.js';
import {
    type ManualZones, resolveBrandTextZones, buildManualZoneInstruction,
    DEFAULT_LOGO_ZONE, DEFAULT_CONGLOMERATE_LOGO_ZONE,
} from './dco/zones.js';

function sseLine(type: string, payload: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** Node Buffer → real ArrayBuffer, the exact shape Hono's c.body() Data type wants (Buffer's
 *  underlying ArrayBufferLike isn't narrow enough for TS's Uint8Array<ArrayBuffer> generic). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Resolves which configured ImageProvider a request wants. `providers.image`
 * is always the default; `providers.imageAlt` (if configured) is selectable
 * via the `imageProvider` form/body field set to `"alt"`. This replaces the
 * source system's hardcoded 'gemini' | 'gpt' selector — which concrete vendor
 * "default" and "alt" actually are is entirely up to how the app wired
 * adapters/providers/*.ts in src/index.ts.
 */
function pickImageProvider(providers: DcoProviders, requested: string | null | undefined) {
    if ((requested || '').trim() === 'alt') {
        if (!providers.imageAlt) throw new Error('No alternate image provider configured (providers.imageAlt)');
        return providers.imageAlt;
    }
    return providers.image;
}

export function createDcoRoutes(providers: DcoProviders): Hono {
    const app = new Hono();

    // ─── GET /formats ──────────────────────────────────────────────────────
    app.get('/formats', c => c.json(Object.entries(FORMATS).map(([id, f]) => ({ id, ...f }))));

    // ─── GET /template ─────────────────────────────────────────────────────
    app.get('/template', async c => {
        const buf = await buildTemplateWorkbook();
        c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        c.header('Content-Disposition', 'attachment; filename="dco_studio_template.xlsx"');
        return c.body(toArrayBuffer(buf));
    });

    // ─── GET /profiles — saved (learned) brand profiles only ──────────────
    // The source system also returned a hardcoded `builtIn` list here
    // (BRAND_PROFILES.tarrito_rojo + .generic) — removed; this system only
    // ever has learned profiles (see POST /analyze-brand + POST /save-profile).
    app.get('/profiles', async c => {
        try {
            const saved = await providers.repository.brandProfiles.list();
            return c.json({ profiles: saved.map(p => ({ ...p, type: 'saved' as const })) });
        } catch (e: any) {
            return c.json({ error: e.message }, 500);
        }
    });

    // ─── POST /analyze-brand — forensic identity extraction from reference images ──
    app.post('/analyze-brand', async c => {
        const formData = await c.req.formData();
        const kvFiles = formData.getAll('kvImages') as File[];
        const kvFormats = formData.getAll('kvFormats') as string[];
        if (!kvFiles.length) return c.json({ error: 'Se requiere al menos 1 imagen de referencia' }, 400);

        const images: LabeledReferenceImage[] = await Promise.all(kvFiles.slice(0, 100).map(async (f, i) => ({
            base64: Buffer.from(await f.arrayBuffer()).toString('base64'),
            mimeType: f.type || 'image/jpeg',
            formatLabel: KV_FORMAT_LABELS[kvFormats[i] || 'general'] || KV_FORMAT_LABELS.general,
        })));
        const formatsUsed = Array.from(new Set(kvFormats.slice(0, images.length).filter(Boolean)));
        const multiFormatNote = formatsUsed.length > 1
            ? `\n⚠️ These reference images span ${formatsUsed.length} DIFFERENT formats (labeled above per image). COLOR SYSTEM, TYPOGRAPHY, and LOGO are brand-wide — extract them from ALL images combined. LAYOUT GRID, BRAND BAND position, and zone percentages are FORMAT-SPECIFIC — do NOT blend layout rules from one format into another. If a layout rule only holds for one format, say so explicitly instead of averaging it across formats.\n`
            : '';

        try {
            const analysis = await analyzeBrandIdentity(providers.vision, images, multiFormatNote);
            const proposedZones = deriveProposedZones(analysis);
            return c.json({ ok: true, analysis, proposedZones, kvCount: kvFiles.length });
        } catch (e: any) {
            return c.json({ error: e.message || 'Error analizando identidad de marca' }, 500);
        }
    });

    // ─── POST /save-profile ────────────────────────────────────────────────
    app.post('/save-profile', async c => {
        const body = await c.req.json().catch(() => ({})) as any;
        const { name, color, emoji, identityPrompt, analysisSummary, qaRules, copyIdentity, kvCount, createdBy } = body;
        if (!name || !identityPrompt) return c.json({ error: 'name e identityPrompt son requeridos' }, 400);
        const qa = Array.isArray(qaRules) && qaRules.length ? qaRules : (analysisSummary?.qaRules || []);
        try {
            const profile = await providers.repository.brandProfiles.save({
                name: String(name).trim(),
                color: color || '#6b7280',
                emoji: emoji || '🏷️',
                identityPrompt,
                analysisSummary: analysisSummary || {},
                qaRules: qa,
                copyIdentity: copyIdentity || {},
                kvCount: kvCount || 0,
                createdBy: createdBy || '',
            });
            return c.json({ ok: true, profile: { ...profile, type: 'saved' as const } });
        } catch (e: any) {
            return c.json({ error: e.message }, 500);
        }
    });

    // ─── DELETE /profiles/:id ──────────────────────────────────────────────
    app.delete('/profiles/:id', async c => {
        try {
            await providers.repository.brandProfiles.delete(c.req.param('id'));
            return c.json({ ok: true });
        } catch (e: any) {
            return c.json({ error: e.message }, 500);
        }
    });

    // ─── Characters ─────────────────────────────────────────────────────────
    app.get('/characters', async c => {
        const profileId = c.req.query('profileId') || undefined;
        const characters = await listCharacters(providers.repository, profileId);
        return c.json({ characters });
    });

    app.post('/characters', async c => {
        const formData = await c.req.formData();
        const name = ((formData.get('name') as string) || '').trim();
        const photoFile = formData.get('photo') as File | null;
        const profileId = ((formData.get('profileId') as string) || '').trim() || null;
        const physicalNotes = ((formData.get('physicalNotes') as string) || '').trim();
        if (!name || !photoFile) return c.json({ error: 'name y photo son requeridos' }, 400);

        const createdBy = ((formData.get('createdBy') as string) || '').trim();
        const photoBase64 = Buffer.from(await photoFile.arrayBuffer()).toString('base64');
        const result = await createCharacter(
            { storage: providers.storage, repository: providers.repository },
            { name, profileId, photoBase64, physicalNotes, createdBy },
        );
        if (result.error) return c.json({ error: result.error }, 500);
        return c.json({ ok: true, character: result.character });
    });

    app.delete('/characters/:id', async c => {
        const result = await deleteCharacter({ storage: providers.storage, repository: providers.repository }, c.req.param('id'));
        if (result.error) return c.json({ error: result.error }, 500);
        return c.json({ ok: true });
    });

    // ─── POST /parse-brief ─────────────────────────────────────────────────
    app.post('/parse-brief', async c => {
        const formData = await c.req.formData();
        const file = formData.get('brief') as File | null;
        if (!file) return c.json({ error: 'Archivo requerido' }, 400);
        const buf = Buffer.from(await file.arrayBuffer());
        const result = await parseBriefFile(buf, providers.text);
        if (result.error) return c.json({ error: result.error, debug: result.debug }, 400);
        return c.json({ pieces: result.pieces, total: result.total, debug: result.debug });
    });

    // ─── POST /generate-copies — infers copy identity from an existing brief ──
    app.post('/generate-copies', async c => {
        const formData = await c.req.formData();
        const file = formData.get('brief') as File | null;
        if (!file) return c.json({ error: 'Se requiere el cuadro de materiales (brief)' }, 400);

        const variantsPerAudience = Math.min(parseInt(String(formData.get('variantsPerAudience') || '3')) || 3, 6);
        const newAudiencesCount = Math.min(parseInt(String(formData.get('newAudiences') || '2')) || 0, 6);
        const extraInstructions = String(formData.get('instructions') || '').trim();

        let manualZonesForCopy: ManualZones | null = null;
        try { const raw = formData.get('manualZones') as string | null; if (raw) manualZonesForCopy = JSON.parse(raw); } catch { /* ignore */ }
        const refWidth = parseInt(String(formData.get('refWidth') || '0')) || 0;
        const refHeight = parseInt(String(formData.get('refHeight') || '0')) || 0;
        const zoneLengthInstruction = buildZoneLengthInstruction(manualZonesForCopy, refWidth, refHeight);
        const benefitZoneCount = countBenefitZones(manualZonesForCopy);
        const beneficiosCountInstruction = buildBeneficiosCountInstruction(benefitZoneCount);

        const kvImageFile = formData.get('kvImage') as File | null;
        let kvImagePart: ImagePart | null = null;
        if (kvImageFile) {
            const kvBuf = Buffer.from(await kvImageFile.arrayBuffer());
            kvImagePart = { base64: kvBuf.toString('base64'), mimeType: kvImageFile.type || 'image/jpeg' };
        }

        const buf = Buffer.from(await file.arrayBuffer());
        const brief = extractBriefAudiences(buf);
        if (!brief.audiencias.length) {
            return c.json({ error: 'No se encontraron audiencias/copies en el cuadro. Verifica que tenga columnas AUDIENCIAS y COPY.', debug: { usedSheet: brief.usedSheet } }, 400);
        }

        const briefDigest = brief.audiencias.map((a, i) =>
            `AUDIENCIA ${i + 1}: ${a.audiencia}\n  Personas (referencia): ${a.audienciaRef || '—'}\n  Drivers: ${a.drivers || '—'}\n  Objetivo: ${a.objetivo || '—'}\n  Copies existentes:\n${a.copies.map(cp => '   • ' + cp.replace(/\n+/g, ' / ')).join('\n') || '   (sin copies)'}`
        ).join('\n\n');

        const prompt = buildGenerateCopiesPrompt({
            marca: brief.marca, campaña: brief.campaña, medios: brief.medios, briefDigest,
            variantsPerAudience, newAudiencesCount, extraInstructions, hasKvImage: !!kvImagePart,
            zoneLengthInstruction, beneficiosCountInstruction, benefitZoneCount,
        });

        let parsed: any;
        try {
            const callOnce = async (feedback: string): Promise<any> => {
                const fullPrompt = feedback ? `${prompt}\n\n${feedback}` : prompt;
                const text = await providers.text.complete({ prompt: fullPrompt, images: kvImagePart ? [kvImagePart] : undefined, maxTokens: 8000, jsonMode: true });
                return parseJsonLoose(text);
            };
            parsed = await callOnce('');
            const violations = collectCopyViolations(parsed);
            if (violations.length) {
                try {
                    const retried = await callOnce(brevityRetryFeedback(violations));
                    if (collectCopyViolations(retried).length < violations.length) parsed = retried;
                } catch (e: any) { console.warn('[dco] generate-copies retry failed, keeping first response:', e.message); }
            }
        } catch (e: any) {
            return c.json({ error: 'Error generando copies: ' + e.message }, 500);
        }

        const defaultMedio = brief.medios[0] || 'META';
        const pieces = buildCopyPieces(parsed, { defaultMedio, mes: brief.mes, campana: brief.campaña });

        return c.json({
            identity: { ...DEFAULT_COPY_RULES, ...(parsed.identity || {}) },
            pieces,
            sourceAudiences: brief.audiencias.map(a => a.audiencia).filter(Boolean),
            total: pieces.length,
        });
    });

    // ─── POST /generate-copies-from-audiences — no Excel needed ────────────
    app.post('/generate-copies-from-audiences', async c => {
        const body = await c.req.json().catch(() => ({})) as any;
        const profileId: string = String(body.profileId || '').trim();
        const audiences: { name: string; ageRange: string; interests: string; characterId?: string; wardrobe?: string; headwear?: string; environment?: string }[] = Array.isArray(body.audiences) ? body.audiences : [];
        const variantsPerAudience = Math.min(Math.max(parseInt(String(body.variantsPerAudience || '3')) || 3, 1), 6);
        const extraInstructions = String(body.instructions || '').trim();
        const kvImagePart: ImagePart | null = body.kvImageBase64 ? { base64: String(body.kvImageBase64), mimeType: String(body.kvImageMime || 'image/jpeg') } : null;
        const manualZonesForCopy: ManualZones | null = body.manualZones && typeof body.manualZones === 'object' ? body.manualZones : null;
        const refWidth = parseInt(String(body.refWidth || '0')) || 0;
        const refHeight = parseInt(String(body.refHeight || '0')) || 0;
        const zoneLengthInstruction = buildZoneLengthInstruction(manualZonesForCopy, refWidth, refHeight);
        const benefitZoneCount = countBenefitZones(manualZonesForCopy);
        const beneficiosCountInstruction = buildBeneficiosCountInstruction(benefitZoneCount);

        if (!audiences.length) return c.json({ error: 'Se requiere al menos 1 audiencia' }, 400);

        let brandName = '';
        let copyIdentityBlock = '';
        if (profileId) {
            const profile = await providers.repository.brandProfiles.get(profileId).catch(() => null);
            if (profile) {
                brandName = profile.name || '';
                const savedCopyIdentity: any = profile.copyIdentity || {};
                const hasSavedIdentity = savedCopyIdentity && (savedCopyIdentity.tono || savedCopyIdentity.formula);
                if (hasSavedIdentity) {
                    copyIdentityBlock = `IDENTIDAD DE COPY YA CONOCIDA de esta marca (de una generación anterior — reutilízala tal cual, no la reinventes):
Tono: ${savedCopyIdentity.tono || '—'}
Fórmula/estructura recurrente: ${savedCopyIdentity.formula || '—'}
Palabras que SÍ usa: ${(savedCopyIdentity.palabras_positivas || []).join(', ') || '—'}
Palabras PROHIBIDAS: ${(savedCopyIdentity.palabras_prohibidas || []).join(', ') || '—'}`;
                } else {
                    copyIdentityBlock = `Esta marca todavía no tiene una identidad de copy guardada de generaciones anteriores. Derívala de su identidad VISUAL ya aprendida:
${JSON.stringify(profile.analysisSummary || {}).slice(0, 2000)}
Infiere un tono de copy coherente con esta identidad visual (ej: si la marca es vibrante/juvenil visualmente, el copy debe sonar así también).`;
                }
            }
        }
        if (!copyIdentityBlock) copyIdentityBlock = 'No hay identidad de marca previa disponible — usa buenas prácticas generales de copywriting publicitario, tono cercano y claro.';

        const audienceDigest = audiences.map((a, i) =>
            `AUDIENCIA ${i + 1}: ${a.name || `Audiencia ${i + 1}`}\n  Edad: ${a.ageRange || '—'}\n  Intereses: ${a.interests || '—'}`
        ).join('\n\n');

        const prompt = buildGenerateCopiesFromAudiencesPrompt({
            brandName, copyIdentityBlock, audienceDigest, variantsPerAudience, extraInstructions,
            hasKvImage: !!kvImagePart, zoneLengthInstruction, beneficiosCountInstruction, benefitZoneCount,
        });

        let parsed: any;
        try {
            const callOnce = async (feedback: string): Promise<any> => {
                const fullPrompt = feedback ? `${prompt}\n\n${feedback}` : prompt;
                const text = await providers.text.complete({ prompt: fullPrompt, images: kvImagePart ? [kvImagePart] : undefined, maxTokens: 8000, jsonMode: true });
                return parseJsonLoose(text);
            };
            parsed = await callOnce('');
            const violations = collectCopyViolations(parsed);
            if (violations.length) {
                try {
                    const retried = await callOnce(brevityRetryFeedback(violations));
                    if (collectCopyViolations(retried).length < violations.length) parsed = retried;
                } catch (e: any) { console.warn('[dco] generate-copies-from-audiences retry failed, keeping first response:', e.message); }
            }
        } catch (e: any) {
            return c.json({ error: 'Error generando copies: ' + e.message }, 500);
        }

        const findMatchingInput = (nombreGenerado: string) => {
            const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
            const n1 = norm(nombreGenerado || '');
            return audiences.find(a => a.name && (norm(a.name) === n1 || n1.includes(norm(a.name)) || norm(a.name).includes(n1)));
        };
        const pieces = buildCopyPieces(parsed, { defaultMedio: 'META' }, findMatchingInput);

        return c.json({
            identity: { ...DEFAULT_COPY_RULES, ...(parsed.identity || {}) },
            pieces,
            sourceAudiences: audiences.map(a => a.name).filter(Boolean),
            total: pieces.length,
        });
    });

    // ─── POST /suggest-audiences — proposes audiences from a reference image alone ──
    app.post('/suggest-audiences', async c => {
        const formData = await c.req.formData();
        const kvFile = formData.get('kvImage') as File | null;
        if (!kvFile) return c.json({ error: 'Imagen de referencia requerida' }, 400);
        const businessContext = ((formData.get('businessContext') as string) || '').trim();
        const count = Math.min(Math.max(parseInt(String(formData.get('count') || '3')) || 3, 1), 6);

        const kvBuf = Buffer.from(await kvFile.arrayBuffer());
        const kvImagePart: ImagePart = { base64: kvBuf.toString('base64'), mimeType: kvFile.type || 'image/jpeg' };

        const prompt = `Eres un ESTRATEGA DE AUDIENCIAS publicitario. Se adjunta la imagen de referencia real de una marca.${businessContext ? ` CONTEXTO DEL NEGOCIO (dado por el usuario, tomalo como fuente de verdad — no lo contradigas ni lo ignores por lo que creas ver en la imagen): "${businessContext}".` : ''} No tienes ninguna audiencia previa — tenés que proponerlas vos mismo, mirando lo que la imagen comunica${businessContext ? ' y lo que sabés del negocio por el contexto de arriba' : ''}.

PASO 1 — LEÉ el copy visible literal en la imagen (titular, subtítulo, bullets de beneficio, CTA) y detectá su mensaje central y, si existe, su fórmula rellenable (ej. si la imagen dice literalmente "HECHA PA' TRABAJAR", eso implica una plantilla "HECHA PA' ___" — identificá el equivalente para esta referencia, si lo hay).

PASO 2 — Con base en ESE mensaje (no genérico, no inventado) proponé exactamente ${count} audiencias reales y DIVERSAS entre sí para las que este producto/mensaje tiene sentido.

⛔ PROHIBIDO EL CLICHÉ DE MANUAL DE MARKETING: nada de segmentos genéricos de power point tipo "Millennials activos", "Madres modernas", "Profesionales exitosos" o "Amantes de la tecnología" — esos podrían pegarse en CUALQUIER marca y no dicen nada real. Cada audiencia tiene que ser un personaje específico y reconocible de la vida real, con una situación concreta. Si te imaginás a una persona real y no a una categoría de PowerPoint, vas bien.

Para CADA audiencia devolvé:
- "name": nombre corto identificable (2-4 palabras).
- "ageRange": rango de edad realista (ej. "22-38 años").
- "interests": sus drivers/motivaciones reales en relación al mensaje leído en la imagen (1 frase corta).
- "wardrobe": ropa realista y específica que usaría ESTA audiencia en la escena, distinta de lo que lleva puesto el personaje de la imagen de referencia si el perfil de audiencia lo amerita — NO copies la ropa de la referencia literal, pensá qué usaría de verdad esta persona. ⛔ NUNCA menciones marcas/plataformas reales de terceros ni "logo de la empresa" — describí la ropa siempre genérica y sin marca.
- "headwear": qué lleva en la cabeza si aplica (tipo de casco/gorra/ninguno) — coherente con la actividad de la audiencia. Mismo criterio: genérico, sin calcomanías/logos de marcas o plataformas reales de terceros.
- "environment": entorno/escenario realista donde se movería esta audiencia — debe seguir siendo compatible con el mood/iluminación de la marca, no un entorno genérico desconectado del estilo de la referencia.

DEVOLVÉ SOLO JSON VÁLIDO (sin markdown, sin texto adicional) con esta forma EXACTA:
{
  "audiences": [
    { "name": "string", "ageRange": "string", "interests": "string", "wardrobe": "string", "headwear": "string", "environment": "string" }
  ]
}
El array "audiences" debe tener EXACTAMENTE ${count} elementos.`;

        try {
            const text = await providers.text.complete({ prompt, images: [kvImagePart], maxTokens: 2000, jsonMode: true });
            const parsed = parseJsonLoose(text);
            const audiences = (Array.isArray(parsed.audiences) ? parsed.audiences : []).slice(0, count).map((a: any) => ({
                name: String(a.name || '').trim(),
                ageRange: String(a.ageRange || '').trim(),
                interests: String(a.interests || '').trim(),
                wardrobe: String(a.wardrobe || '').trim(),
                headwear: String(a.headwear || '').trim(),
                environment: String(a.environment || '').trim(),
            }));
            if (!audiences.length) return c.json({ error: 'El modelo no devolvió audiencias válidas' }, 500);
            return c.json({ audiences });
        } catch (e: any) {
            return c.json({ error: 'Error sugiriendo audiencias: ' + e.message }, 500);
        }
    });

    // ─── POST /recreate-formats — recomposes an APPROVED reference piece into new sizes (SSE) ──
    // Unlike /generate ("single painter": the model only paints the photo, code
    // draws the copy on top), this starts from an already-approved piece and
    // resizes/recomposes it like a designer adapting the same ad to another
    // canvas — same photo, same text/logos, only the framing changes. It edits
    // the real reference image directly and draws its own text, so it does NOT
    // go through the anti-text gate / OCR QA that /generate uses (those exist
    // for exactly the opposite case).
    app.post('/recreate-formats', async c => {
        const formData = await c.req.formData();
        const kvFile = formData.get('kvImage') as File | null;
        if (!kvFile) return c.json({ error: 'Imagen de referencia requerida' }, 400);
        const formatIds = ((formData.get('formats') as string) || '').split(',').map(f => f.trim()).filter(f => f && FORMATS[f]);
        if (!formatIds.length) return c.json({ error: 'Al menos 1 formato válido requerido' }, 400);

        let newCopy: { headline?: string; subhead?: string; cta?: string; beneficios?: string[] } | null = null;
        try { const raw = formData.get('copy') as string | null; if (raw) newCopy = JSON.parse(raw); } catch { /* ignore */ }
        const hasNewCopy = !!(newCopy && (newCopy.headline || newCopy.subhead || newCopy.cta || newCopy.beneficios?.length));

        const characterWardrobe = ((formData.get('characterWardrobe') as string) || '').trim();
        const characterHeadwear = ((formData.get('characterHeadwear') as string) || '').trim();
        const environment = ((formData.get('environment') as string) || '').trim();
        const hasVisualProfile = !!(characterWardrobe || characterHeadwear || environment);
        const varyScene = ((formData.get('varyScene') as string) || '').trim() === 'true';

        let imageProvider;
        try { imageProvider = pickImageProvider(providers, formData.get('imageProvider') as string | null); }
        catch (e: any) { return c.json({ error: e.message }, 500); }

        const kvBuf = Buffer.from(await kvFile.arrayBuffer());
        const kvRef: ImagePart = { base64: kvBuf.toString('base64'), mimeType: kvFile.type || 'image/jpeg' };

        const buildCreativePrompt = (w: number, h: number, platform: string) => {
            const copyBlock = hasNewCopy ? `
- REEMPLAZO DE COPY — NO conserves las palabras originales del titular/subtítulo/beneficios/CTA. Reemplazalas por este copy nuevo, manteniendo EXACTAMENTE el mismo estilo tipográfico, tamaño, color, contorno y layout que usaba el texto original (misma fórmula visual, solo cambian las palabras):
${newCopy?.headline ? `  Titular: "${newCopy.headline}"` : ''}
${newCopy?.subhead ? `  Subtítulo: "${newCopy.subhead}"` : ''}
${newCopy?.beneficios?.length ? `  Bullets de beneficio (mismo formato visual que los originales, mismo íconos +): ${newCopy.beneficios.map(b => `"${b}"`).join(', ')}` : ''}
${newCopy?.cta ? `  CTA: "${newCopy.cta}"` : ''}` : `
- El texto (titular, subtítulos, bullets de beneficio, CTA) tiene que seguir apareciendo con EXACTAMENTE las mismas palabras, la misma tipografía/estilo/color que en la referencia — no inventes texto nuevo, no cambies ni una palabra, no "corrijas" ni reinterpretes nada.`;
            return `Sos un editor de imágenes profesional. Se te da una pieza publicitaria REAL${hasNewCopy ? '' : ' y YA APROBADA'} de una marca. Tu tarea es recomponerla para un lienzo nuevo de ${w}x${h}px (${platform}) — EXACTAMENTE como lo haría un diseñador adaptando el mismo aviso a otro tamaño${hasNewCopy ? ' y otra audiencia' : ''}, no una pieza desde cero.

REGLAS ABSOLUTAS:${copyBlock}
- El/los logo(s), badges e íconos deben seguir apareciendo, reconocibles y fieles a como se ven en la referencia (mismo diseño, mismos colores), ubicados en una esquina/zona equivalente.
${varyScene ? `- MODO CREATIVO — ESCENA Y ÁNGULO LIBRES: para esta audiencia, proponé una escena, ángulo de cámara, pose y acción NUEVOS y frescos — NO repitas la composición/encuadre/entorno literal de la referencia. Lo ÚNICO que se mantiene 100% fiel, sin excepción, es el PRODUCTO PROTAGONISTA (mismo tipo/modelo/color/detalles EXACTOS que en la referencia, perfectamente reconocible) y el sistema visual de marca (paleta de colores, franjas/patrones, calidad/mood de luz que lo conecten con esta marca). El personaje${characterWardrobe || characterHeadwear ? ` (${[characterWardrobe, characterHeadwear].filter(Boolean).join(', ')})` : ''}, su pose, el entorno${environment ? ` (ej. ${environment})` : ''}, el ángulo de cámara y la acción SÍ pueden reinventarse por completo respecto a la referencia.
  ⛔ PROHIBIDO ABSOLUTO: NO agregues logos, marcas, stickers ni nombres de NINGUNA empresa/plataforma real de terceros en accesorios, ropa, vallas o cualquier parte de la escena. Toda la ropa/accesorios deben ser genéricos y sin marca, salvo los logos de ESTA marca ya autorizados arriba.` : hasVisualProfile ? `- CAMBIO DE PERSONAJE Y ENTORNO — esta pieza es para una audiencia distinta a la de la referencia original, así que el personaje y el fondo SÍ deben adaptarse (a diferencia del texto/logos, que no cambian):
${characterWardrobe ? `  Ropa del personaje: ${characterWardrobe}` : ''}
${characterHeadwear ? `  Accesorio de cabeza: ${characterHeadwear}` : ''}
${environment ? `  Entorno/fondo: ${environment}` : ''}
  El personaje sigue siendo el protagonista humano de la escena, en la MISMA acción/interacción general con el producto o servicio que se ve en la referencia — solo cambian su vestuario y el escenario de fondo. El PRODUCTO PROTAGONISTA de la referencia y el sistema visual de marca se mantienen intactos — el entorno nuevo debe seguir sintiéndose de esta marca, no un estilo fotográfico distinto.
  ⛔ PROHIBIDO ABSOLUTO: NO agregues logos, marcas, stickers ni nombres de NINGUNA empresa/plataforma real de terceros en ropa, accesorios, vallas o cualquier parte de la escena. Toda la ropa/accesorios deben ser genéricos y sin marca, salvo los logos de ESTA marca que ya están explícitamente autorizados arriba.` : `- La foto/escena (persona, producto, fondo, iluminación, franjas/diagonales de marca) es LA MISMA — extendé/rellená el fondo de forma natural y coherente con el estilo de la referencia para cubrir el nuevo lienzo, en vez de generar una escena distinta.`}
- Reacomodá tamaños/posiciones de texto, logos y foto para que la composición se vea profesional en el nuevo aspect ratio — todo debe quedar legible, nada cortado ni apretado.
- No agregues elementos que no estén en la referencia. No quites ninguno de los que sí están (salvo el texto reemplazado arriba y el personaje/entorno si aplica cambio de audiencia).

Devolvé SOLO la imagen final, sin texto adicional.`;
        };

        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');
        c.header('X-Accel-Buffering', 'no');

        return stream(c, async s => {
            for (const formatId of formatIds) {
                const fmt = FORMATS[formatId];
                await s.write(sseLine('start', { formatId, platform: fmt.platform }));
                const heartbeat = setInterval(() => { s.write(': ping\n\n').catch(() => clearInterval(heartbeat)); }, 5000);
                try {
                    // Note: the source system branched here on GPT-image's fixed size list
                    // (banners fell back to a 2-request Gemini flow — see docs in
                    // formats.ts). Concrete adapters now own their own size negotiation
                    // (see adapters/providers/openaiImage.ts pickSize()); if a provider
                    // genuinely can't satisfy an extreme aspect ratio it should throw, and
                    // this loop reports it as a normal per-format SSE 'error' event — no
                    // special-cased 2-request flow needed anymore.
                    const promptText = buildCreativePrompt(fmt.width, fmt.height, fmt.platform);
                    const result = await imageProvider.generate({ prompt: promptText, references: [kvRef], targetWidth: fmt.width, targetHeight: fmt.height });
                    const cropped = await sharp(Buffer.from(result.base64, 'base64')).resize(fmt.width, fmt.height, { fit: 'cover' }).png().toBuffer();
                    await s.write(sseLine('result', { formatId, platform: fmt.platform, width: fmt.width, height: fmt.height, imageBase64: cropped.toString('base64'), mimeType: 'image/png' }));
                } catch (err: any) {
                    await s.write(sseLine('error', { formatId, error: err.message || 'Error' }));
                } finally {
                    clearInterval(heartbeat);
                }
            }
            await s.write(sseLine('done'));
        });
    });

    // ─── POST /resize-image — recomposes one image to a new aspect ratio ───
    // Renamed from /resize-with-gemini (now provider-agnostic); the old path
    // is kept as a compat alias.
    const resizeImageHandler = async (c: any) => {
        const formData = await c.req.formData();
        const imageFile = formData.get('image') as File | null;
        if (!imageFile) return c.json({ error: 'image requerido' }, 400);
        const width = parseInt(String(formData.get('width') || '0'), 10);
        const height = parseInt(String(formData.get('height') || '0'), 10);
        if (!width || !height) return c.json({ error: 'width y height requeridos' }, 400);

        let imageProvider;
        try { imageProvider = pickImageProvider(providers, formData.get('imageProvider') as string | null); }
        catch (e: any) { return c.json({ error: e.message }, 500); }

        const imgBuf = Buffer.from(await imageFile.arrayBuffer());
        const imgMime = imageFile.type || 'image/png';

        const prompt = `Sos un editor de imágenes profesional. Se te da una pieza publicitaria REAL y YA FINALIZADA (texto, logos y personaje son EXACTAMENTE los correctos, no los toques). Tu ÚNICA tarea es recomponer/extender esta imagen para un lienzo nuevo de ${width}x${height}px, un aspect ratio mucho más extremo que el actual — como lo haría un diseñador ajustando el mismo arte ya aprobado a un banner de otro tamaño.

REGLAS ABSOLUTAS:
- NO cambies ni una palabra del texto, ni el personaje, ni los logos — se muestran EXACTAMENTE como están en la imagen de entrada, no los reinterpretes ni los redibujes distinto.
- Extendé/rellená el fondo de forma natural y coherente para cubrir el nuevo lienzo (mismas franjas diagonales, misma paleta, mismo mood de luz).
- Reacomodá tamaños/posiciones de los elementos existentes (sin alterar su contenido) para que la composición quede profesional en el nuevo aspect ratio — todo legible, nada cortado ni apretado, y CADA elemento (titular, cada bullet, logos) debe aparecer UNA SOLA VEZ, nunca duplicado.
- No agregues elementos que no estén en la imagen de entrada. No quites ninguno de los que sí están.

Devolvé SOLO la imagen final, sin texto adicional.`;

        try {
            const result = await imageProvider.generate({
                prompt, references: [{ base64: imgBuf.toString('base64'), mimeType: imgMime }],
                targetWidth: width, targetHeight: height,
            });
            const cropped = await sharp(Buffer.from(result.base64, 'base64')).resize(width, height, { fit: 'cover' }).png().toBuffer();
            return c.json({ imageBase64: cropped.toString('base64'), mimeType: 'image/png' });
        } catch (err: any) {
            return c.json({ error: err.message || 'Error' }, 500);
        }
    };
    app.post('/resize-image', resizeImageHandler);
    app.post('/resize-with-gemini', resizeImageHandler); // backward-compat alias

    // ─── POST /export-cuadro ────────────────────────────────────────────────
    app.post('/export-cuadro', async c => {
        const body = await c.req.json().catch(() => ({})) as any;
        const pieces: any[] = body.pieces || [];
        const meta = body.meta || {};
        if (!pieces.length) return c.json({ error: 'No hay piezas para exportar' }, 400);
        const out = await buildCuadroWorkbook(pieces, meta);
        c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        c.header('Content-Disposition', 'attachment; filename="cuadro_materiales_generado.xlsx"');
        return c.body(toArrayBuffer(out));
    });

    // ─── POST /export-brief ─────────────────────────────────────────────────
    app.post('/export-brief', async c => {
        const formData = await c.req.formData();
        const file = formData.get('brief') as File | null;
        const rowsJson = formData.get('rows') as string | null;
        if (!file || !rowsJson) return c.json({ error: 'Faltan parámetros' }, 400);

        const doneRowIndices: number[] = JSON.parse(rowsJson);
        const videoPromptsJson = formData.get('videoPrompts') as string | null;
        const videoPromptsMap: Record<number, string> = videoPromptsJson ? JSON.parse(videoPromptsJson) : {};

        const buf = Buffer.from(await file.arrayBuffer());
        const outBuf = updateBriefStatus(buf, doneRowIndices, videoPromptsMap);

        c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        c.header('Content-Disposition', 'attachment; filename="cuadro_materiales_actualizado.xlsx"');
        return c.body(toArrayBuffer(outBuf));
    });

    // ─── POST /generate — the main SSE generation pipeline ─────────────────
    app.post('/generate', async c => {
        const formData = await c.req.formData();
        const kvFile = formData.get('kvImage') as File | null;
        if (!kvFile) return c.json({ error: 'Imagen de referencia requerida' }, 400);

        const tasksJson = formData.get('tasks') as string | null;
        const formatsStr = ((formData.get('formats') as string) || 'feed_square').trim();
        // Empty / 'generic' = no saved profile; the batch's identity is either an
        // explicit override (customIdentityBlock) or auto-extracted once below.
        const profileId = ((formData.get('brandProfile') as string) || '').trim().replace(/^generic$/, '');
        const customIdentityBlock = ((formData.get('customIdentityBlock') as string) || '').trim() || undefined;
        let customQaRules: string[] = [];
        try { const raw = formData.get('customQaRules') as string | null; if (raw) customQaRules = JSON.parse(raw); } catch { /* ignore */ }

        let imageProvider;
        try { imageProvider = pickImageProvider(providers, formData.get('imageProvider') as string | null); }
        catch (e: any) { return c.json({ error: e.message }, 500); }

        let manualZones: ManualZones = {};
        try { const raw = formData.get('manualZones') as string | null; if (raw) manualZones = JSON.parse(raw); } catch { /* ignore */ }

        const kvBase64 = Buffer.from(await kvFile.arrayBuffer()).toString('base64');
        const kvMime = kvFile.type || 'image/jpeg';
        const kvRef: ImagePart = { base64: kvBase64, mimeType: kvMime };

        // ── Identity resolution: explicit override > saved profile > per-batch auto-extraction ──
        let identityJson: any;
        let profileRecord: BrandProfileRecord | null = null;
        if (customIdentityBlock) {
            try { identityJson = JSON.parse(customIdentityBlock); } catch { identityJson = { identityPrompt: customIdentityBlock }; }
        } else if (profileId) {
            profileRecord = await providers.repository.brandProfiles.get(profileId).catch(() => null);
            if (profileRecord) {
                identityJson = (profileRecord.analysisSummary && Object.keys(profileRecord.analysisSummary).length)
                    ? profileRecord.analysisSummary
                    : { identityPrompt: profileRecord.identityPrompt };
            }
        }
        if (!identityJson) {
            try {
                identityJson = await analyzeBrandIdentity(providers.vision, [{ base64: kvBase64, mimeType: kvMime, formatLabel: KV_FORMAT_LABELS.general }], '');
                console.log('[dco] Auto-extracted identity from reference image:', identityJson?.brandName || '(unnamed)');
            } catch (e: any) {
                console.warn('[dco] Auto brand-identity extraction failed (continuing with generic identity):', e.message);
            }
        }
        const hasRealIdentity = !!identityJson && Object.keys(identityJson).length > 0;
        const effectiveQaRules = customQaRules.length ? customQaRules : (profileRecord?.qaRules?.length ? profileRecord.qaRules : (identityJson?.qaRules || []));
        const brandColorFallback = identityJson?.accentColor || identityJson?.primaryColor || profileRecord?.color || '#6b7280';

        // Real pixel-sampled badge/benefit color from the reference image (never a
        // vision-model "guess") — see services/overlay.ts#sampleZoneDominantColor.
        let sampledBenefitColor: string | null = null;
        const firstBenefitZoneEntry = Object.entries(manualZones).find(([k]) => /^benefit_\d+$/.test(k));
        if (firstBenefitZoneEntry) {
            sampledBenefitColor = await sampleZoneDominantColor(kvBase64, firstBenefitZoneEntry[1]);
        }

        const productFileList = formData.getAll('productImage') as File[];
        const productParts: ImagePart[] = [];
        for (const f of productFileList.slice(0, 2)) {
            const buf = await f.arrayBuffer();
            const b64 = Buffer.from(buf).toString('base64');
            if (b64.length > 800_000) { console.warn('[dco] product image too large, skipping:', f.name); continue; }
            productParts.push({ base64: b64, mimeType: f.type || 'image/jpeg' });
        }
        const hasProduct = productParts.length > 0;

        const logoFile = formData.get('logoImage') as File | null;
        let logoPart: ImagePart | null = null;
        if (logoFile) { const buf = await logoFile.arrayBuffer(); logoPart = { base64: Buffer.from(buf).toString('base64'), mimeType: logoFile.type || 'image/png' }; }
        const hasLogo = !!logoPart;

        const conglomerateLogoFile = formData.get('conglomerateLogoImage') as File | null;
        let conglomerateLogoPart: ImagePart | null = null;
        if (conglomerateLogoFile) { const buf = await conglomerateLogoFile.arrayBuffer(); conglomerateLogoPart = { base64: Buffer.from(buf).toString('base64'), mimeType: conglomerateLogoFile.type || 'image/png' }; }
        const hasConglomerateLogo = !!conglomerateLogoPart;

        const extraLogoFiles = (formData.getAll('extraLogoImage') as File[]).slice(0, 4);
        const extraLogoParts: ImagePart[] = [];
        for (const f of extraLogoFiles) { const buf = await f.arrayBuffer(); extraLogoParts.push({ base64: Buffer.from(buf).toString('base64'), mimeType: f.type || 'image/png' }); }
        const effectiveExtraLogoZones = extraLogoParts.map((_, i) => manualZones[`extra_logo_${i + 1}`]);

        const smartLogoZone = deriveDefaultLogoZone(identityJson);
        const effectiveLogoZone = manualZones.logo || (hasLogo ? (smartLogoZone || DEFAULT_LOGO_ZONE) : undefined);
        const effectiveConglomerateLogoZone = manualZones.conglomerate_logo || (hasConglomerateLogo ? DEFAULT_CONGLOMERATE_LOGO_ZONE : undefined);
        const manualZoneInstruction = buildManualZoneInstruction(manualZones, effectiveLogoZone, effectiveConglomerateLogoZone);

        const defaultCharacterId = ((formData.get('characterId') as string) || '').trim() || undefined;
        async function resolveCharacterForTask(taskCharacterId?: string) {
            const effectiveId = taskCharacterId || defaultCharacterId;
            const character = effectiveId ? await getCharacterPhotoBase64(providers.repository, effectiveId) : null;
            const characterIdentityInstruction = character
                ? `\n\n⚠️ CONSISTENCIA DE PERSONAJE: el protagonista humano de esta escena DEBE ser la misma persona que aparece en la foto de referencia adjunta (mismo rostro, tono de piel, tipo de cabello) — NO inventes una persona distinta. ${character.physicalNotes ? `Notas físicas: ${character.physicalNotes}.` : ''}`
                : '';
            return { character, characterIdentityInstruction };
        }

        interface Task {
            taskId: string; formatId: string; sceneDesc: string; copy: CopyFields;
            observaciones?: string; variante?: string; characterId?: string;
            audienceLabel?: string; audienciaRef?: string; drivers?: string;
        }
        let tasks: Task[] = [];

        if (tasksJson) {
            const briefTasks: any[] = JSON.parse(tasksJson);
            tasks = briefTasks.map(t => {
                if (t.explicitSceneDesc && t.explicitCopy) {
                    return {
                        taskId: t.taskId || `regen_${t.formatId}_${Date.now()}`,
                        formatId: t.formatId, sceneDesc: t.explicitSceneDesc, copy: t.explicitCopy,
                        observaciones: t.observaciones || '', variante: t.variante || '',
                    };
                }
                const who = t.audienciaRef || t.audience || 'a real person';
                const why = t.drivers || '';
                const what = why ? `experiencing or benefiting from ${why}` : 'in an authentic moment relevant to the brand';
                let sceneDesc = `Real photograph of ${who}, ${what}. The person is the clear subject — large in frame, genuine expression, natural body language. Authentic real-world environment where this product belongs (home, outdoors, work, lifestyle). Cinematic natural light, shallow depth of field, editorial photography quality. Emotional and relatable.`;
                if (t.tono) {
                    const tonoKey = String(t.tono).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
                    const modifier = TONO_MODIFIERS[tonoKey] || t.tono;
                    sceneDesc = `${sceneDesc} Mood: ${modifier}.`;
                }
                const varianteSuffix = t.variante ? `_v${t.variante}` : '';
                const parsedTaskCopy = parseCopyText(t.copyFull || '');
                if (Array.isArray(t.beneficios) && t.beneficios.length > 0) parsedTaskCopy.beneficios = t.beneficios;
                return {
                    taskId: `row_${t.rowIndex}${varianteSuffix}`, formatId: t.formatId || 'feed_square', sceneDesc,
                    copy: parsedTaskCopy, observaciones: t.observaciones || '', variante: t.variante || '',
                    audienceLabel: t.audience || '', audienciaRef: t.audienciaRef || '', drivers: t.drivers || '',
                    characterId: t.characterId || undefined,
                };
            });
        } else {
            const formats = formatsStr.split(',').map(f => f.trim()).filter(f => f && FORMATS[f]);
            const sceneDesc = ((formData.get('sceneDesc') as string) || '').trim()
                || 'Authentic person matching the target audience, warm cinematic golden light, natural expression.';
            let beneficios: string[] = [];
            try { const raw = formData.get('beneficios') as string | null; if (raw) beneficios = JSON.parse(raw).filter(Boolean); } catch { /* ignore */ }
            const copy: CopyFields = {
                headline: ((formData.get('headline') as string) || '').trim(),
                subhead: ((formData.get('subhead') as string) || '').trim(),
                chip: ((formData.get('chip') as string) || '').trim(),
                body: ((formData.get('body') as string) || '').trim(),
                beneficios,
                cta: ((formData.get('cta') as string) || '').trim(),
            };
            tasks = formats.map(fmtId => ({ taskId: fmtId, formatId: fmtId, sceneDesc, copy }));
        }

        if (tasks.length === 0) return c.json({ error: 'Al menos 1 tarea requerida' }, 400);

        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');
        c.header('X-Accel-Buffering', 'no');

        const feedbackProfileKey = profileId || 'generic';

        return stream(c, async s => {
            let taskIdx = 0;

            const processTask = async (task: Task, variantIndex: number): Promise<void> => {
                const fmt = FORMATS[task.formatId] || FORMATS['feed_square'];
                await s.write(sseLine('start', { taskId: task.taskId, format: task.formatId, platform: fmt.platform, sceneDesc: task.sceneDesc, copy: task.copy }));

                const heartbeat = setInterval(() => { s.write(': ping\n\n').catch(() => clearInterval(heartbeat)); }, 5000);

                try {
                    const feedbackCtx = await providers.repository.feedback.contextFor({ profileId: feedbackProfileKey, formatFamily: fmt.family }).catch(() => '');
                    const identityForPrompt = { ...(identityJson || {}), identityPrompt: (identityJson?.identityPrompt || GENERIC_IDENTITY_BLOCK) + feedbackCtx };

                    const { character, characterIdentityInstruction } = await resolveCharacterForTask(task.characterId);

                    // ── "single painter" — the image model NEVER sees the real copy ──
                    const copyForImage: CopyFields = { ...task.copy, headline: '', subhead: '', chip: '', body: '', cta: '' };
                    const renderZones = resolveBrandTextZones(task.copy, fmt.family, manualZones, identityJson?.brandName, hasLogo);
                    const cleanAreasList = renderZones.map(z => `- ${z.x.toFixed(0)}%,${z.y.toFixed(0)}% → ${z.w.toFixed(0)}% wide × ${z.h.toFixed(0)}% tall`).join('\n');

                    const variantSceneDesc = buildSceneVariant(task.sceneDesc, task.audienciaRef || '', task.drivers || '', variantIndex);
                    const rawPrompt = buildPrompt(variantSceneDesc, copyForImage, fmt, identityForPrompt, task.observaciones, hasProduct, task.audienciaRef || '', task.drivers || '', hasLogo, hasConglomerateLogo);

                    const noTextRule = `

⛔⛔ PHOTOGRAPHY ONLY — ABSOLUTE FINAL RULE (overrides EVERYTHING above): this image must contain ZERO text of any kind — no words, letters, numbers, logos, wordmarks, badges, buttons, price tags, watermarks or typography of any size, not even blurred, partial, or in the background. Any typography/layout/badge guidance above describes the FINAL composed advertisement, NOT this image: all text and logos are added later by a separate pixel-perfect compositing system. Your job is a clean advertising PHOTOGRAPH: the scene, the person, the product, and the brand's background energy (colors, diagonal stripes, motion blur, light — graphic shapes WITHOUT any letters).
KEEP THESE AREAS VISUALLY CALM (text will be composited there afterward — do not place the subject's face or key product details inside them; simple background there is ideal):
${cleanAreasList || '- (none — keep the left third and the bottom strip calm)'}`;

                    const agentPrompt = rawPrompt + characterIdentityInstruction
                        + (manualZoneInstruction ? `\n\n⚠️ USER-MARKED POSITIONS (override any zone/layout guidance above for these elements):\n${manualZoneInstruction}` : '')
                        + noTextRule;

                    await s.write(sseLine('agent1_done', { taskId: task.taskId, checklistItems: 0, typoSpecItems: renderZones.length }));

                    // Logos are NEVER sent as generation references (see logoBlock /
                    // conglomerateLogoBlock in promptBuilder.ts) — the image model must
                    // not attempt to draw them at all; the real files are composited
                    // afterward with pixel precision.
                    const references: ImagePart[] = [kvRef, ...productParts];
                    if (character) references.push({ base64: character.base64, mimeType: character.mime });

                    const callImage = async (promptText: string) => {
                        try {
                            const image = await imageProvider.generate({ prompt: promptText, references, targetWidth: fmt.width, targetHeight: fmt.height });
                            return { image, err: null as string | null };
                        } catch (err: any) {
                            console.error('[dco] image generation error:', err.message);
                            return { image: null, err: err.message || 'Image generation failed' };
                        }
                    };

                    const initial = await callImage(agentPrompt);
                    let img = initial.image;
                    const genErr = initial.err;
                    let qaAttempts = 0;
                    let bestScore = 0;
                    let bestImg = img;

                    const EMPTY_COPY = { headline: '', subhead: '', chip: '', body: '', cta: '' };
                    if (img) {
                        let currentPrompt = agentPrompt;
                        for (let qaRound = 0; qaRound < 3; qaRound++) {
                            qaAttempts++;
                            const imgBuf = Buffer.from(img.base64, 'base64');
                            await s.write(sseLine('qa_start', { taskId: task.taskId, round: qaRound + 1 }));

                            // Gate 1: deterministic anti-text OCR check — did the image model disobey?
                            const noText = await checkImageHasNoText(imgBuf).catch(() => null);
                            if (noText?.hasText) {
                                await s.write(sseLine('qa_score', { taskId: task.taskId, attempt: qaRound + 1, score: 5, passed: false, errors: [`TEXT_IN_PHOTO: ${noText.detectedWords.slice(0, 6).join(', ')}`] }));
                                if (qaRound === 2) break;
                                const retryPrompt = [
                                    `⚡ REJECTED — your previous image contained visible text/lettering ("${noText.detectedWords.slice(0, 6).join('", "')}"). This is FORBIDDEN. Regenerate the SAME scene as a pure photograph with ABSOLUTELY ZERO letters, words, numbers, logos or typography anywhere — remove signage, labels and any written marks. Graphic energy (stripes, colors, motion) stays, letters do not.`,
                                    '', '─── ORIGINAL BRIEF ───', currentPrompt,
                                ].join('\n');
                                const retry = await callImage(retryPrompt);
                                if (retry.image) { img = retry.image; currentPrompt = retryPrompt; continue; }
                                break;
                            }

                            // Gate 2: single model pass — anatomy, character consistency, brand/creativity balance.
                            const verdict = await runQualityCheck({
                                vision: providers.vision,
                                imageBase64: img.base64, imageMime: img.mimeType,
                                referenceBase64: kvBase64, referenceMime: kvMime,
                                copy: EMPTY_COPY,
                                checklist: [], customQaRules: effectiveQaRules,
                                brandColorHex: sampledBenefitColor || brandColorFallback,
                                characterPhoto: character ? { base64: character.base64, mime: character.mime, name: character.name } : undefined,
                            });

                            if (verdict.score > bestScore) { bestScore = verdict.score; bestImg = img; }
                            await s.write(sseLine('qa_score', { taskId: task.taskId, attempt: qaRound + 1, score: verdict.score, passed: verdict.passed, errors: verdict.issues }));
                            if (verdict.passed || qaRound === 2) break;
                            await s.write(sseLine('qa_retry', { taskId: task.taskId, score: verdict.score, fixes: verdict.issues }));

                            const retryPrompt = [
                                `⚡ CORRECCIONES DEL QA (score anterior: ${verdict.score}/100):`,
                                verdict.correctionsForPrompt || verdict.issues.join(' | '),
                                '', '─── BRIEF ORIGINAL ───', currentPrompt,
                            ].join('\n');
                            const retry = await callImage(retryPrompt);
                            if (retry.image) { img = retry.image; currentPrompt = retryPrompt; } else break;
                        }
                        if (bestImg) img = bestImg;
                        qaAttempts = Math.max(1, Math.min(qaAttempts, 3));
                    }

                    // ── Deterministic brand layer — ALWAYS applied, even if QA never fully passed ──
                    if (img) {
                        const graphicOverlayZones: GraphicOverlayZone[] = [];
                        if (effectiveLogoZone && logoPart) graphicOverlayZones.push({ key: 'logo', imageBase64: logoPart.base64, imageMime: logoPart.mimeType, ...effectiveLogoZone });
                        if (effectiveConglomerateLogoZone && conglomerateLogoPart) graphicOverlayZones.push({ key: 'conglomerate_logo', imageBase64: conglomerateLogoPart.base64, imageMime: conglomerateLogoPart.mimeType, ...effectiveConglomerateLogoZone });
                        extraLogoParts.forEach((part, i) => {
                            const zone = effectiveExtraLogoZones[i];
                            if (zone && part) graphicOverlayZones.push({ key: `extra_logo_${i + 1}`, imageBase64: part.base64, imageMime: part.mimeType, ...zone });
                        });

                        const brandStyle = deriveBrandLayerStyle(hasRealIdentity ? identityJson : { primaryColor: brandColorFallback }, sampledBenefitColor);
                        if (renderZones.length > 0 || graphicOverlayZones.length > 0) {
                            const composited = await compositeBrandLayer(img.base64, img.mimeType, fmt.width, fmt.height, renderZones, graphicOverlayZones, brandStyle);
                            img = { base64: composited.base64, mimeType: composited.mime };
                        }
                    }

                    if (img) {
                        const geminiAnalysis = await analyzeGeneratedImage(providers.vision, { base64: img.base64, mimeType: img.mimeType });
                        const videoPromptRaw = await buildVideoPromptFromImage(providers.text, { base64: img.base64, mimeType: img.mimeType }, task.copy, fmt, task.drivers || '', geminiAnalysis).catch((err: any) => { console.warn('[dco] video prompt (vision path) failed:', err.message); return ''; });
                        const videoPrompt = videoPromptRaw || buildVideoPrompt(task.sceneDesc, task.copy, fmt, hasProduct, task.audienceLabel || '', task.audienciaRef || '', task.drivers || '');

                        clearInterval(heartbeat);
                        await s.write(sseLine('result', { taskId: task.taskId, format: task.formatId, platform: fmt.platform, width: fmt.width, height: fmt.height, imageBase64: img.base64, mimeType: img.mimeType, qaAttempts, videoPrompt }));
                    } else {
                        clearInterval(heartbeat);
                        await s.write(sseLine('error', { taskId: task.taskId, format: task.formatId, error: genErr || 'Sin imagen generada' }));
                    }
                } catch (err: any) {
                    console.error('[dco] error in task', task.taskId, err.message);
                    clearInterval(heartbeat);
                    await s.write(sseLine('error', { taskId: task.taskId, format: task.formatId, error: err.message || 'Error' }));
                }
            };

            const runWorker = async (): Promise<void> => {
                while (taskIdx < tasks.length) { const i = taskIdx++; await processTask(tasks[i], i); }
            };
            await Promise.all([runWorker(), runWorker()]); // 2 concurrent workers
            await s.write(sseLine('done'));
        });
    });

    // ─── POST /generate-gif — 3-frame animated GIF from an already-generated piece ──
    app.post('/generate-gif', async c => {
        const body = await c.req.json() as {
            imageBase64: string; mimeType: string; formatId: string; width: number; height: number;
            logoBase64?: string; logoMime?: string;
        };
        const { imageBase64, mimeType, formatId, width, height } = body;
        const fmt = FORMATS[formatId] || { width, height, family: 'square', platform: '' };
        const mime = mimeType.includes('png') ? 'image/png' : 'image/jpeg';

        const makeFrame = async (prompt: string): Promise<{ data: string; mime: string } | null> => {
            try {
                const img = await providers.image.generate({ prompt, references: [{ base64: imageBase64, mimeType: mime }], targetWidth: fmt.width, targetHeight: fmt.height });
                return { data: img.base64, mime: img.mimeType };
            } catch { return null; }
        };

        try {
            const productPrompt = `Extract and feature the main product from this advertising image. Create a clean close-up product shot: the product centered with professional studio lighting, slight background blur, brand advertising quality. Same product, no characters. ABSOLUTE RULE: zero text, zero letters, zero logos, zero badges anywhere in the image — remove any lettering visible on packaging/labels if needed by framing tighter. Photorealistic.`;
            const logoPrompt = `Closing background frame inspired by this advertising image. Clean elegant background using the exact dominant brand colors from this image — gradients, diagonal energy stripes or soft light allowed. Premium cinematic advertising finish. ABSOLUTE RULE: completely EMPTY of content — no logo, no text, no letters, no characters, no product. Just the branded background; the real logo will be composited on top separately.`;

            const [frame2, frame3raw] = await Promise.all([makeFrame(productPrompt), makeFrame(logoPrompt)]);

            let frame3 = frame3raw;
            if (frame3 && body.logoBase64) {
                try {
                    const composited = await compositeBrandLayer(
                        frame3.data, frame3.mime, fmt.width, fmt.height, [],
                        [{ key: 'logo', imageBase64: body.logoBase64, imageMime: body.logoMime || 'image/png', x: 25, y: 32, w: 50, h: 36 }],
                        deriveBrandLayerStyle(null),
                    );
                    frame3 = { data: composited.base64, mime: composited.mime };
                } catch (e: any) { console.warn('[dco] could not composite logo on closing frame:', e.message); }
            }

            const frames = [
                { data: imageBase64, mime },
                ...(frame2 ? [frame2] : []),
                ...(frame3 ? [frame3] : []),
            ];
            if (frames.length < 2) return c.json({ error: 'Not enough frames generated' }, 500);

            const gif = await buildAnimatedGif(frames);
            if (!gif) return c.json({ error: 'GIF build failed' }, 500);
            return c.json({ gifBase64: gif });
        } catch (err: any) {
            return c.json({ error: err.message }, 500);
        }
    });

    // ─── Stories / carousel ─────────────────────────────────────────────────
    app.get('/stories', async c => {
        const profileId = c.req.query('profileId') || undefined;
        const stories = await listStories(providers.repository, profileId);
        return c.json({ stories });
    });

    app.get('/stories/:id', async c => {
        const result = await getStory(providers.repository, c.req.param('id'));
        if (!result) return c.json({ error: 'No encontrada' }, 404);
        return c.json(result);
    });

    app.post('/generate-carousel', async c => {
        const formData = await c.req.formData();
        const kvFile = formData.get('kvImage') as File | null;
        if (!kvFile) return c.json({ error: 'Imagen de referencia requerida' }, 400);

        const profileId = ((formData.get('brandProfile') as string) || '').trim() || undefined;
        const characterId = ((formData.get('characterId') as string) || '').trim() || undefined;
        const narrative = ((formData.get('narrative') as string) || '').trim();
        const title = ((formData.get('title') as string) || narrative.slice(0, 60) || 'Historia sin título').trim();
        const format = (((formData.get('format') as string) || '1:1').trim()) as '1:1' | '4:5';
        const slideCount = Math.max(3, Math.min(6, parseInt((formData.get('slideCount') as string) || '4', 10) || 4));

        if (!narrative) return c.json({ error: 'narrative es requerido' }, 400);
        const fmt = CAROUSEL_FORMATS[format] || CAROUSEL_FORMATS['1:1'];

        const kvBase64 = Buffer.from(await kvFile.arrayBuffer()).toString('base64');
        const kvMime = kvFile.type || 'image/jpeg';

        const character = characterId ? await getCharacterPhotoBase64(providers.repository, characterId) : null;

        const logoFile = formData.get('logoImage') as File | null;
        let logoPart: ImagePart | null = null;
        if (logoFile) { const buf = await logoFile.arrayBuffer(); logoPart = { base64: Buffer.from(buf).toString('base64'), mimeType: logoFile.type || 'image/png' }; }

        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');
        c.header('X-Accel-Buffering', 'no');

        return stream(c, async s => {
            let storyId = '';
            try {
                const beats = await planStoryboard(providers.text, narrative, slideCount);
                const story = await createStory(providers.repository, { profileId, characterId, title, narrative, platform: 'meta_carousel', format, slideCount: beats.length });
                storyId = story.id;
                await s.write(sseLine('story_start', { storyId, beats }));

                const callSlideImage = async (promptText: string, refs: ImagePart[]) => {
                    try { return await providers.image.generate({ prompt: promptText, references: refs, targetWidth: fmt.width, targetHeight: fmt.height }); }
                    catch (err: any) { console.warn('[dco] carousel slide generation failed:', err.message); return null; }
                };

                let previousSlide: ImagePart | null = null;
                for (let i = 0; i < beats.length; i++) {
                    const beat = beats[i];
                    await s.write(sseLine('slide_start', { index: i }));

                    const buildRefs = (): ImagePart[] => {
                        const refs: ImagePart[] = [{ base64: kvBase64, mimeType: kvMime }];
                        if (logoPart) refs.push(logoPart);
                        if (character) refs.push({ base64: character.base64, mimeType: character.mime });
                        if (previousSlide) refs.push(previousSlide);
                        return refs;
                    };
                    const buildSlidePrompt = (extraInstruction: string) => `Advertising carousel slide ${i + 1}/${beats.length}. Brand identity: use the first reference image for colors/typography/logo only.${logoPart ? ' A dedicated logo reference image is also provided — reproduce that EXACT logo pixel-faithfully, never redraw or reinterpret it.' : ''}${character ? ' The protagonist MUST be the exact same person as the character reference photo — same face, skin tone, hair.' : ''}${previousSlide ? ' Continue the SAME visual world, lighting, and character continuity as the previous slide image provided.' : ''}

SCENE: ${beat.sceneDesc}

TEXT TO RENDER (exactly, no more no less):
${beat.copy.headline ? `- Headline: "${beat.copy.headline}"` : ''}
${beat.copy.cta ? `- CTA: "${beat.copy.cta}"` : ''}

${extraInstruction}
Output size: ${fmt.width}x${fmt.height}px, aspect ratio ${format}.`;

                    let slide = await callSlideImage(buildSlidePrompt(''), buildRefs());
                    let bestSlide = slide;
                    let bestScore = 0;
                    if (slide) {
                        for (let round = 0; round < 2 && slide; round++) {
                            const verdict = await runQualityCheck({
                                vision: providers.vision,
                                imageBase64: slide.base64, imageMime: slide.mimeType,
                                referenceBase64: kvBase64, referenceMime: kvMime,
                                copy: { headline: beat.copy.headline, subhead: '', chip: '', body: '', cta: beat.copy.cta },
                                checklist: [], customQaRules: [],
                                characterPhoto: character ? { base64: character.base64, mime: character.mime, name: character.name } : undefined,
                            });
                            if (verdict.score > bestScore) { bestScore = verdict.score; bestSlide = slide; }
                            await s.write(sseLine('slide_qa', { index: i, score: verdict.score, passed: verdict.passed, issues: verdict.issues }));
                            if (verdict.passed) break;
                            const retry = await callSlideImage(buildSlidePrompt(`CORRECCIONES DEL INTENTO ANTERIOR: ${verdict.correctionsForPrompt || verdict.issues.join(' | ')}`), buildRefs());
                            if (!retry) break;
                            slide = retry;
                        }
                    }

                    if (!bestSlide) { await s.write(sseLine('slide_error', { index: i, error: 'No se pudo generar este slide' })); continue; }

                    await saveSlide({ storage: providers.storage, repository: providers.repository }, {
                        storyId, slideIndex: i, sceneDesc: beat.sceneDesc, copy: beat.copy,
                        imageBase64: bestSlide.base64, imageMime: bestSlide.mimeType, qaScore: bestScore,
                        width: fmt.width, height: fmt.height,
                    });
                    previousSlide = { base64: bestSlide.base64, mimeType: bestSlide.mimeType };
                    await s.write(sseLine('slide_done', { index: i, imageBase64: bestSlide.base64, mimeType: bestSlide.mimeType, score: bestScore }));
                }

                await s.write(sseLine('done', { storyId }));
            } catch (err: any) {
                console.error('[dco] carousel error:', err.message);
                await s.write(sseLine('error', { storyId, error: err.message || 'Error' }));
            }
        });
    });

    // ─── POST /retouch — surgical correction on an already-generated image ──
    app.post('/retouch', async c => {
        const formData = await c.req.formData();
        const originalImageBase64 = (formData.get('originalImageBase64') as string || '').trim();
        const originalMime = (formData.get('originalMime') as string || 'image/jpeg').trim();
        const correction = (formData.get('correction') as string || '').trim();
        const formatId = (formData.get('formatId') as string || 'feed_square').trim();
        const kvFile = formData.get('kvImage') as File | null;

        if (!kvFile) return c.json({ error: 'kvImage requerido' }, 400);
        if (!originalImageBase64) return c.json({ error: 'originalImageBase64 requerido' }, 400);
        if (!correction) return c.json({ error: 'correction requerido' }, 400);

        let imageProvider;
        try { imageProvider = pickImageProvider(providers, formData.get('imageProvider') as string | null); }
        catch (e: any) { return c.json({ error: e.message }, 500); }

        const kvBase64 = Buffer.from(await kvFile.arrayBuffer()).toString('base64');
        const kvMime = kvFile.type || 'image/jpeg';
        const fmt = FORMATS[formatId] || FORMATS['feed_square'];

        const surgicalPrompt = `You are performing a SURGICAL CORRECTION on an existing advertisement (first image provided).

CRITICAL PRESERVATION RULE — keep EVERY visual element exactly as it is:
• Scene, people, expressions, poses, lighting, color grade, composition
• All brand elements: bands, badges, seals, logo placement and exact colors
• All visible text: headline, subhead, body, CTA, badges — unchanged

Make ONLY this specific targeted fix — change ABSOLUTELY NOTHING else:
${correction}

Reference the second image (brand reference) only to confirm correct brand colors/style for the fix.
Output the corrected ad at exactly ${fmt.width}×${fmt.height}px.`;

        try {
            const result = await imageProvider.generate({
                prompt: surgicalPrompt,
                references: [{ base64: originalImageBase64, mimeType: originalMime }, { base64: kvBase64, mimeType: kvMime }],
                targetWidth: fmt.width, targetHeight: fmt.height,
            });
            return c.json({ imageBase64: result.base64, mimeType: result.mimeType, width: fmt.width, height: fmt.height });
        } catch (err: any) {
            return c.json({ error: err.message || 'Error generando corrección' }, 500);
        }
    });

    // ─── POST /feedback ─────────────────────────────────────────────────────
    app.post('/feedback', async c => {
        const body = await c.req.json().catch(() => ({})) as Record<string, string>;
        const { profileId, formatId, audience, sceneDesc, headline, rating, comment, userEmail } = body;
        if (rating !== 'good' && rating !== 'bad') return c.json({ error: "rating debe ser 'good' o 'bad'" }, 400);
        try {
            await providers.repository.feedback.add({
                profileId: profileId || 'generic', formatId: formatId || '', audience: audience || '',
                sceneDesc: sceneDesc || '', headline: headline || '', rating, comment: comment || '', userEmail: userEmail || '',
            });
            return c.json({ ok: true });
        } catch (e: any) {
            return c.json({ error: e.message }, 500);
        }
    });

    return app;
}

// ─── Copy-generation prompt builders + shared "pieces" assembler ──────────────
// Kept below the route table for readability; pure functions, no I/O.

function buildGenerateCopiesPrompt(input: {
    marca: string; campaña: string; medios: string[]; briefDigest: string;
    variantsPerAudience: number; newAudiencesCount: number; extraInstructions: string;
    hasKvImage: boolean; zoneLengthInstruction: string; beneficiosCountInstruction: string; benefitZoneCount: number;
}): string {
    const { marca, campaña, medios, briefDigest, variantsPerAudience, newAudiencesCount, extraInstructions, hasKvImage, zoneLengthInstruction, beneficiosCountInstruction, benefitZoneCount } = input;
    return `Eres el COPYWRITER LÍDER de la marca. Te entrego el cuadro de materiales actual con sus audiencias y los copies YA EXISTENTES. Tu trabajo tiene dos fases.

DATOS DEL CUADRO (marca aproximada: "${marca || 'desconocida'}", campaña: "${campaña || '—'}", medios: ${medios.join(', ') || '—'}):

${briefDigest}

FASE 1 — ENTENDER LA IDENTIDAD DE COPY:
Analiza los copies existentes e infiere con precisión: el TONO de voz, la FÓRMULA o estructura recurrente, el patrón del beneficio/badge, las palabras que la marca SÍ usa (positivas) y las que NUNCA debe usar (prohibidas / claims regulatorios riesgosos).

FASE 2 — GENERAR COPIES NUEVOS (mismo ADN, frescos, no repetir literalmente los existentes):
1) Para CADA audiencia existente genera ${variantsPerAudience} variantes nuevas (A_brand=enfoque marca/emocional, B_producto=enfoque beneficio/producto, C_lifestyle=enfoque estilo de vida).
${newAudiencesCount > 0 ? `2) Propón ${newAudiencesCount} AUDIENCIAS NUEVAS coherentes con la marca (que aún no existan en el cuadro), cada una con su "audiencia_referencia" (personas reales), sus "drivers", y ${variantsPerAudience} variantes de copy con la misma estructura.` : '2) No propongas audiencias nuevas.'}

REGLAS CRÍTICAS DE COMPATIBILIDAD CON EL DCO (para que el texto se vea PERFECTO en la imagen):
- "copy_principal" (titular): MÁXIMO 7 palabras, contundente.
- "desarrollo" (cuerpo): 1 frase, máximo ~18 palabras, sin repetir el nombre del beneficio textual (eso va en el chip).
- "cierre" (CTA): máximo 6 palabras, accionable.
- "chip": el beneficio/feature corto (ej: "Sin conservantes", "3 años de garantía"), máx 25 caracteres. Si no aplica, deja "".
- Respeta tono y palabras de la marca; jamás uses las palabras prohibidas.
${extraInstructions ? `- Instrucción adicional del usuario: ${extraInstructions}` : ''}
${hasKvImage ? '- Se adjunta la imagen de referencia (key visual) que se va a usar en el DCO — mirala antes de escribir: el copy debe encajar con lo que efectivamente se ve ahí (producto, escena, mood, colores, personas), no ser genérico. No describas la imagen en el copy, solo dejate influenciar por ella.\n- CRÍTICO — IGUALÁ LA BREVEDAD REAL DE LA REFERENCIA: si la imagen tiene texto visible (titular, beneficios, CTA), tu copy_principal/beneficios/cierre deben tener UNA LONGITUD SIMILAR a esos textos reales — no una oración larga. Un titular real casi siempre son 2-6 palabras contundentes, NUNCA una frase completa. Si dudás entre una versión corta y una elaborada, elegí SIEMPRE la más corta.' : ''}
- CRÍTICO — COHERENCIA: copy_principal, beneficios, desarrollo y cierre son UN SOLO MENSAJE, no piezas sueltas. Alguien que lea SOLO el titular + los beneficios (sin nada más) tiene que entender de qué trata sin esfuerzo. PROHIBIDO un copy_principal que sea una palabra de jerga o doble sentido aislada que no se explique sola ni conecte directo con los beneficios/drivers de esa audiencia.
${hasKvImage ? '- CRÍTICO — FÓRMULA DEL TITULAR: mirá si el titular visible en la referencia sigue un patrón rellenable. Si detectás un patrón así, TODAS las variantes de copy_principal deben usar ese mismo patrón literal — solo cambia la palabra/frase del espacio en blanco. El resto del patrón se mantiene IDÉNTICO. Si el titular es una frase única sin un espacio evidente para rellenar, no inventes un patrón — generá libremente respetando las demás reglas.\n- ⛔ EL RELLENO NO PUEDE SER UN SINÓNIMO GENÉRICO INTERCAMBIABLE: la palabra/frase que completa el patrón tiene que ser tan específica de ESA audiencia puntual que sonaría raro o falso puesta en boca de otra audiencia.' : ''}
- CRÍTICO — VOZ CREATIVA, NO ROBÓTICA: el copy tiene que sonar como lo escribió un humano con personalidad y punto de vista, no una plantilla corporativa con el sustantivo cambiado. Prohibido el piloto automático publicitario. Buscá SIEMPRE un ángulo específico, una imagen mental concreta, un dejo de humor/ironía/ternura o una tensión emocional real que ESA audiencia puntual reconocería como propia. Si al leer dos titulares de audiencias distintas notás que son la misma frase con una palabra cambiada, reescribilos.
- CRÍTICO — CONTEXTO Y TONO CONGRUENTE: todo el copy debe sonar como español natural (expresiones, giros, tuteo/voseo según corresponda a la marca) — nunca un español panlatino genérico de manual de traducción. El copy nuevo tiene que ser CONGRUENTE con el tono que YA tiene la referencia: si es urgente y directa, no lo vuelvas poético; si es cercana y coloquial, no lo vuelvas corporativo o formal; si tiene humor, mantené ese humor.
${zoneLengthInstruction}
${beneficiosCountInstruction}
${buildSubheadInstruction(hasKvImage)}

DEVUELVE SOLO JSON VÁLIDO (sin texto adicional, sin markdown) con esta forma EXACTA:
{
  "identity": {
    "marca": "string", "tono": "string", "formula": "string (la estructura recurrente detectada)",
    "palabras_positivas": ["..."], "palabras_prohibidas": ["..."],
    "resumen": "string (2-3 frases de la identidad de copy)"
  },
  "audiencias": [
    {
      "nombre": "string", "audiencia_referencia": "string", "drivers": "string", "nueva": false,
      "copies": [
        { "variante": "A_brand", "concepto": "string corto", "copy_principal": "string", "desarrollo": "string", "cierre": "string", "chip": "string"${benefitZoneCount > 0 ? `, "beneficios": ["exactamente ${benefitZoneCount} bullets cortos"]` : ''} }
      ]
    }
  ]
}`;
}

function buildGenerateCopiesFromAudiencesPrompt(input: {
    brandName: string; copyIdentityBlock: string; audienceDigest: string; variantsPerAudience: number;
    extraInstructions: string; hasKvImage: boolean; zoneLengthInstruction: string; beneficiosCountInstruction: string; benefitZoneCount: number;
}): string {
    const { brandName, copyIdentityBlock, audienceDigest, variantsPerAudience, extraInstructions, hasKvImage, zoneLengthInstruction, beneficiosCountInstruction, benefitZoneCount } = input;
    return `Eres el COPYWRITER LÍDER de la marca "${brandName || 'la marca'}". No tienes un cuadro de materiales previo — el usuario te da las audiencias directamente y vos generás los copys desde cero, respetando la identidad de la marca.

${copyIdentityBlock}

AUDIENCIAS A CUBRIR (definidas por el usuario):
${audienceDigest}

GENERA, para CADA audiencia de arriba, ${variantsPerAudience} variantes de copy (A_brand=enfoque marca/emocional, B_producto=enfoque beneficio/producto, C_lifestyle=enfoque estilo de vida — usa las que correspondan según cuántas variantes se piden).

REGLAS CRÍTICAS DE COMPATIBILIDAD CON EL DCO (para que el texto se vea PERFECTO en la imagen):
- "copy_principal" (titular): MÁXIMO 7 palabras, contundente.
- "desarrollo" (cuerpo): 1 frase, máximo ~18 palabras.
- "cierre" (CTA): máximo 6 palabras, accionable.
- "chip": beneficio/feature corto si aplica (máx 25 caracteres), si no aplica deja "".
${extraInstructions ? `- Instrucción adicional del usuario: ${extraInstructions}` : ''}
${hasKvImage ? '- Se adjunta la imagen de referencia (key visual) que se va a usar en el DCO — mirala antes de escribir: el copy debe encajar con lo que efectivamente se ve ahí (producto, escena, mood, colores, personas), no ser genérico. No describas la imagen en el copy, solo dejate influenciar por ella.\n- CRÍTICO — IGUALÁ LA BREVEDAD REAL DE LA REFERENCIA: si la imagen tiene texto visible, tu copy_principal/beneficios/cierre deben tener una longitud similar — no una oración larga. Si dudás, elegí siempre la versión más corta.' : ''}
- CRÍTICO — COHERENCIA: copy_principal, beneficios, desarrollo y cierre son UN SOLO MENSAJE, no piezas sueltas.
${hasKvImage ? '- CRÍTICO — FÓRMULA DEL TITULAR: si detectás un patrón rellenable en el titular visible de la referencia, TODAS las variantes de copy_principal deben usar ese mismo patrón literal — solo cambia la palabra/frase del espacio en blanco. ⛔ El relleno no puede ser un sinónimo genérico intercambiable entre audiencias.' : ''}
- CRÍTICO — VOZ CREATIVA, NO ROBÓTICA: sonar como lo escribió un humano con personalidad y punto de vista, no una plantilla corporativa. Cada audiencia necesita su propio ángulo, no una variación cosmética del mismo molde.
- CRÍTICO — CONTEXTO Y TONO CONGRUENTE: español natural, congruente con el tono que ya tiene la referencia.
${zoneLengthInstruction}
${beneficiosCountInstruction}
${buildSubheadInstruction(hasKvImage)}

DEVUELVE SOLO JSON VÁLIDO (sin texto adicional, sin markdown) con esta forma EXACTA:
{
  "identity": {
    "marca": "string", "tono": "string", "formula": "string",
    "palabras_positivas": ["..."], "palabras_prohibidas": ["..."],
    "resumen": "string (2-3 frases)"
  },
  "audiencias": [
    {
      "nombre": "string", "audiencia_referencia": "string", "drivers": "string", "nueva": false,
      "copies": [{ "variante": "A_brand", "concepto": "string corto", "copy_principal": "string", "desarrollo": "string", "cierre": "string", "chip": "string"${benefitZoneCount > 0 ? `, "beneficios": ["exactamente ${benefitZoneCount} bullets cortos"]` : ''} }]
    }
  ]
}`;
}

/** Turns the copy-generation JSON response into DCO-ready "pieces" (rows), shared by both copy endpoints. */
function buildCopyPieces(
    parsed: any,
    defaults: { defaultMedio: string; mes?: string; campana?: string },
    matchInput?: (nombreGenerado: string) => { characterId?: string; wardrobe?: string; headwear?: string; environment?: string } | undefined,
): any[] {
    const pieces: any[] = [];
    let n = 1;
    for (const a of (parsed.audiencias || [])) {
        const matchedInput = matchInput?.(a.nombre || '');
        for (const cp of (a.copies || [])) {
            const copyBlock = buildCopyBlock(cp.copy_principal || '', cp.desarrollo || '', cp.cierre || '');
            const parsedCopy = parseCopyText(copyBlock);
            if (cp.chip) parsedCopy.chip = String(cp.chip).slice(0, 25);
            // The "texto" column is a short preview trimmed to the square-format
            // word budget (these pieces default to feed_square below).
            const adapted = adaptCopyToFamily(parsedCopy, 'square');
            pieces.push({
                rowIndex: pieces.length,
                piezas: n++,
                mes: defaults.mes || '',
                campana: defaults.campana || '',
                territorio: a.territorio || 'NACIONAL',
                referencia: '',
                characterId: matchedInput?.characterId || undefined,
                wardrobe: matchedInput?.wardrobe || '',
                headwear: matchedInput?.headwear || '',
                environment: matchedInput?.environment || '',
                audiencia: a.nombre || '',
                audienciaRef: a.audiencia_referencia || '',
                drivers: a.drivers || '',
                medio: defaults.defaultMedio,
                formatoAnuncio: 'Link Ad',
                creativo: '',
                tamano: '1080x1080',
                formato: 'Feed Square 1:1',
                peso: '80KB',
                texto: adapted.headline,
                objetivo: a.objetivo || 'Awareness',
                geografia: 'NACIONAL',
                concepto: cp.concepto || '',
                imagenVideo: 'Imagen',
                copyFull: copyBlock,
                copy_principal: cp.copy_principal || '',
                desarrollo: cp.desarrollo || '',
                cierre: cp.cierre || '',
                beneficios: Array.isArray(cp.beneficios) ? cp.beneficios.filter(Boolean) : [],
                copyPreview: `${cp.copy_principal || ''} — ${cp.desarrollo || ''}`.slice(0, 200),
                parsedCopy,
                chip: parsedCopy.chip,
                tono: parsed.identity?.tono || '',
                variante: cp.variante || '',
                observaciones: '',
                nuevaAudiencia: !!a.nueva,
                formatId: 'feed_square',
                platform: FORMATS['feed_square'].platform,
            });
        }
    }
    return pieces;
}
