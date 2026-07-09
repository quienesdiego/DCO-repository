import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { supabase } from '../services/supabase.js';
import Anthropic from '@anthropic-ai/sdk';
import { runQualityCheck, checkImageHasNoText } from '../services/dcoQa.js';
import { listCharacters, createCharacter, deleteCharacter, getCharacterPhotoBase64 } from '../services/dcoCharacters.js';
import { planStoryboard, createStory, saveSlide, listStories, getStory } from '../services/dcoStories.js';
import { compositeBrandLayer, deriveBrandLayerStyle, sampleZoneDominantColor, type BrandTextZone, type ZoneBox, type GraphicOverlayZone } from '../services/dcoOverlay.js';
import sharp from 'sharp';

// Meta/Instagram carousel: 2-10 cards, mismo aspect ratio en todo el set.
const CAROUSEL_FORMATS: Record<string, { width: number; height: number }> = {
    '1:1': { width: 1080, height: 1080 },
    '4:5': { width: 1080, height: 1350 },
};

export const dcoRoutes = new Hono();

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = 'gemini-3.1-flash-image-preview';
const OPENAI_IMAGE_MODEL = 'gpt-image-2';

// GPT-image exige: multiplos de 16px, lado maximo <=3840px, ratio <=3:1, y entre 655,360 y
// 8,294,400 pixeles totales — los formatos banner (billboard/skyscraper/half-page/MREC) no
// entran en ese rango de ninguna forma (ni por ratio ni por cantidad minima de pixeles), así
// que ese proveedor no los soporta. Para las familias que sí entran, se pide el tamaño válido
// más parecido al aspect ratio real — el compositor ya redimensiona/recorta (`fit: 'cover'`)
// al tamaño final exacto de todos modos, así que no hace falta que coincida pixel a pixel acá.
function gptImageSizeFor(family: string): string | null {
    switch (family) {
        case 'square':    return '1024x1024';
        case 'portrait':  return '1024x1280';
        case 'story':     return '1024x1824';
        case 'landscape': return '1216x640';
        default:          return null; // 'micro' (banners) — no soportado por GPT-image
    }
}

// ─── Robust JSON extractor — handles markdown code blocks, leading text, truncation ──
function extractJSON(text: string): string | null {
    if (!text) return null;
    // 1. Try ```json ... ``` block
    const mdBlock = text.match(/```(?:json)?\s*(\{[\s\S]+?\})\s*```/);
    if (mdBlock) { try { JSON.parse(mdBlock[1]); return mdBlock[1]; } catch {} }
    // 2. Try largest { } block
    const raw = text.match(/\{[\s\S]+\}/);
    if (raw) { try { JSON.parse(raw[0]); return raw[0]; } catch {} }
    // 3. Try to find + repair truncated JSON (last resort)
    const start = text.indexOf('{');
    if (start !== -1) {
        let depth = 0, end = -1;
        for (let i = start; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end !== -1) { try { JSON.parse(text.slice(start, end + 1)); return text.slice(start, end + 1); } catch {} }
    }
    return null;
}

// ─── Formatos soportados ───────────────────────────────────────────────────────
const FORMATS: Record<string, { width: number; height: number; family: string; platform: string }> = {
    feed_portrait:     { width: 1080, height: 1350, family: 'portrait',   platform: 'Meta Feed Portrait 4:5' },
    feed_square:       { width: 1080, height: 1080, family: 'square',     platform: 'Meta Feed Square 1:1' },
    story_vertical:    { width: 1080, height: 1920, family: 'story',      platform: 'Stories / Reels 9:16' },
    banner_billboard:  { width: 970,  height: 250,  family: 'billboard',  platform: 'Display 970×250' },
    banner_skyscraper: { width: 160,  height: 600,  family: 'skyscraper', platform: 'Display 160×600' },
    banner_halfpage:   { width: 300,  height: 600,  family: 'halfpage',   platform: 'Display 300×600' },
    banner_mrec:       { width: 300,  height: 250,  family: 'mrec',       platform: 'Display 300×250' },
    feed_landscape:    { width: 1200, height: 628,  family: 'landscape',  platform: 'Landscape 1200×628' },
};

// Nota: el mapeo banner→formato proxy (para el paso 1 del flujo de 2 solicitudes) vive en
// el FRONTEND (DCOView.tsx) — es quien orquesta las 2 llamadas separadas ahora (ver
// /resize-with-gemini más abajo para el paso 2).

// Mapa de dimensiones → formato
const DIM_TO_FORMAT: Record<string, string> = {
    '1080x1080': 'feed_square',   '1080x1350': 'feed_portrait',  '1080x1920': 'story_vertical',
    '970x250':   'banner_billboard', '160x600': 'banner_skyscraper', '300x600': 'banner_halfpage',
    '300x250':   'banner_mrec',   '1200x628': 'feed_landscape',  '1200x630': 'feed_landscape',
};

function dimToFormatId(dim: string): string | null {
    const norm = dim.toLowerCase().replace(/\s+/g, '').replace(/[×*]/g, 'x');
    return DIM_TO_FORMAT[norm] || null;
}

function normalizeKey(str: string): string {
    return String(str).toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ0-9]/g, '');
}

// ─── Perfiles de marca ────────────────────────────────────────────────────────
// Cada perfil tiene identidad visual hardcodeada + múltiples escenas por audiencia.
// Para agregar una marca: duplica la entrada generic y configura colores/escenas.
interface BrandProfile {
    name: string;
    emoji: string;
    color: string;
    identityBlock: string;
    audienceScenes: Record<string, string[]>; // keyword → múltiples escenas (se elige al azar)
    buildFormatGuidance: (fmtId: string, w: number, h: number, family: string) => string;
}

const BRAND_PROFILES: Record<string, BrandProfile> = {

    tarrito_rojo: {
        name: 'SOFA · Corferias',
        emoji: '🔴',
        color: '#E30613',

        // 5-7 escenas por audiencia — se elige UNA al azar en cada generación
        // Todas las escenas muestran interacción natural con el producto en la rutina diaria.
        // REGLA: SOFA siempre se toma con agua, jugo de naranja o leche — NUNCA con café.
        audienceScenes: {
            familia: [
                'Colombian mother in a bright sunny Bogotá kitchen at 6am, squeezing fresh oranges into two tall glasses — she stirs a spoonful of SOFA kola granulada into each glass, the red jar open on the counter beside the orange halves, two children in school uniforms reaching for their glasses, warm morning light, proud daily ritual',
                'Colombian family of four at a colorful Sunday breakfast table in Cali — a big pitcher of freshly squeezed orange juice and the open SOFA jar at the center, the mother stirs a measure of kola granulada into each glass with a small spoon, everyone raising their orange glasses together, vibrant and joyful',
                'Colombian grandmother in a coastal Pacífico kitchen at dawn, blending a thick batido de mango, banana and milk — she adds a generous spoonful of SOFA kola granulada into the blender before pressing start, the red jar sitting on the tiled counter, grandchildren watching from the doorway with curiosity, lush tropical morning light through open window',
                'Colombian father in an Eje Cafetero mountain home at dawn, pouring cold fresh milk into tall glasses for the family — he stirs a spoonful of SOFA kola granulada into each glass, the red jar open beside the milk jug, children running downstairs to the misty mountain kitchen, cozy and grounded',
                'Colombian couple in their 30s preparing morning drinks together in their Medellín apartment — she pours fresh orange juice while he stirs SOFA kola granulada into each glass with a small spoon, the open red jar between them on the counter, natural teamwork, morning light, sense of healthy shared life',
            ],
            hogares: [
                'Colombian mother of three in a warm Barranquilla kitchen after the school rush, sitting down for a quiet moment — she stirs a spoonful of SOFA kola granulada into a tall glass of natural orange juice, the red jar open on the table beside a cut orange, sunlight through the window, the house finally quiet',
                'Colombian woman in her 40s in a Cali home kitchen blending a fresh batido de leche con banano — she adds a full spoonful of SOFA kola granulada into the blender before pressing start, smiling at her own healthy ritual, the red jar on the colorful tiled counter, tropical plants on the windowsill',
                'Colombian grandmother and adult daughter in a Medellín kitchen on a Sunday morning — the grandmother proudly stirs SOFA kola granulada into two tall glasses of cold orange juice, the open red jar on the table between them, warm golden light, masato and fresh fruit on the table, three generations sharing the ritual',
            ],
            motores: [
                'Hard-working Colombian man from the Pacífico coast at dawn before his construction shift, stirring a spoonful of SOFA kola granulada into his thermos of cold water with a long spoon — the red jar open on the simple kitchen counter, thick energizing batido also prepared beside it, determined pride, early morning tropical light before heading out',
                'Colombian mechanic in Bogotá at the end of his shift, washing grease from his hands at the workshop sink — his young son at the doorway holds a prepared glass of orange juice with SOFA already stirred in, the red jar tucked under his arm, proud family moment, warm workshop light fading',
                'Colombian truck driver at an Andean highway rest stop at 4am, stirring SOFA kola granulada into his thermos of cold water — the red jar on the truck dashboard, arepas unwrapped beside him, Andes silhouette against the pre-dawn sky, the quiet ritual of a long-distance worker',
                'Colombian coffee farmer in the Eje Cafetero at sunrise after the first harvest hours, sitting on a wooden bench outside the farmhouse — his wife places a tall glass of cold fresh milk with SOFA already stirred in on the bench beside him, the red jar on the window ledge, mist rising from the valley, powerful and grounded',
                'Colombian baker at 4:30am in Medellín after pulling the first bread from the oven, sitting on a stool — a glass of cold water with SOFA kola granulada swirling in it sits on the floury wooden table beside the open red jar, flour-dusted hands wrapping around the glass, warm bakery amber light',
                'Colombian delivery rider in Cali during a 10-minute break under a mango tree, helmet on the seat — a cold water bottle with SOFA already mixed sits beside him on the curb, the red jar in his open delivery bag, city heat, shade, the small ritual that keeps him going through the day',
            ],
            energia: [
                'Energetic young Colombian woman in her Bogotá apartment at 5:30am preparing her pre-workout protein shake — she stirs a heaped spoonful of SOFA kola granulada into the blender with banana, oat and cold water, the red jar open on the kitchen counter, gym bag by the door, focused determined expression, dark city lights still on outside',
                'Athletic Colombian woman from the Pacífico at a lush outdoor gym at dawn, sitting on a bench between sets — a prepared cold orange juice with SOFA mixed in sits in her gym bag holder, the red jar visible in the open bag beside her water bottle, she takes a long refreshing sip, dynamic tropical morning light, authentic athletic energy',
                'Colombian woman on a Cartagena rooftop after finishing her sunrise yoga session, sitting cross-legged on the mat — she stirs a spoonful of SOFA kola granulada into a glass of cold water with mindful intention, the red jar on the small rattan table beside her mat, old city walls glowing warm behind her',
                'Colombian woman from Cali at a scenic Andes valley viewpoint after a mountain cycling session, catching her breath — her water bottle with SOFA already mixed sits in the bike bottle cage, the red jar visible in her jersey pocket, she takes a long satisfying drink, wind-swept hair, vast green landscape stretching behind',
                'Colombian woman in Medellín after a salsa dance class, sitting with classmates — a small table holds glasses of cold milk with SOFA stirred in, the open red jar at the center, she picks up her glass and offers a toast to her friends with a laugh, warm amber studio light, mirrors and dance energy behind them',
            ],
            vitalidad: [
                'Elegant Colombian couple in their late 50s at breakfast in their Bogotá home — she squeezes fresh oranges into two tall glasses while the open SOFA jar sits ready on the table, he stirs a spoonful of kola granulada into each glass, they clink their orange glasses with a warm smile, sunlit dining room, sense of shared daily ritual',
                'Active Colombian man in his 60s in his lush Caribbean garden after his morning walk, sitting on a wooden bench — his wife brings him a tall glass of cold fresh milk with SOFA kola granulada already stirred in, the red jar in her other hand, he takes the glass with a proud satisfied smile, tropical flowers blooming around him',
                'Vibrant Colombian woman in her 50s poolside in Cali after water aerobics, toweling off with friends — prepared glasses of cold water with SOFA sit on the pool table in front of them, the open red jar at the center, they raise their glasses together with laughter and energy, bright morning community',
                'Colombian grandfather in a Manizales kitchen at 6am, carefully preparing his morning ritual — he stirs SOFA kola granulada into a tall glass of fresh-squeezed orange juice, the open red jar and a cut orange on the counter, grandchildren appearing at the doorway with sleepy eyes, sense of wisdom and quiet discipline',
                'Colombian couple in their 50s at a Coffee Region finca, pausing at a hiking trail viewpoint — they share a water bottle with SOFA mixed in between them, the small red jar tucked in the backpack side pocket, laughing together as they take turns drinking, spectacular valley behind them, mountain air and authentic joy',
            ],
            deportistas: [
                'Athletic young Colombian trail runner in the Andes at a misty mountain checkpoint at golden hour — he pours cold water from his hydration pack into a cup and stirs in SOFA kola granulada from the small red jar in his vest pocket, drinks it down with a focused recovery expression, cloud sea stretching below',
                'Colombian cyclist in full racing gear at a valley rest stop after a grueling Eje Cafetero climb, leaning on his bike — a prepared water bottle with SOFA kola granulada mixed in hangs in the bottle cage, he takes a long slow drink with a tired proud expression, the red jar visible in his jersey pocket, lush green landscape behind',
                'Colombian basketball player on an outdoor court in Bogotá at sunset after training, sitting on the bench — a tall cup of cold orange juice with SOFA already stirred in sits on the bench beside him, the open red jar next to it, he picks up the cup and drinks with ritual calm, Bogotá skyline glowing behind',
                'Colombian amateur boxer in a raw Medellín urban gym between rounds, sitting on the corner stool — the SOFA jar sits on the stool beside his water bottle, his trainer hands him the prepared cold water with SOFA already mixed, he drinks it down, hand wraps, sweat, the gritty authenticity of daily training',
                'Colombian woman at a Cartagena beach volleyball game at sunrise — on a break she sits on the sand, a coconut water with SOFA kola granulada mixed in beside her in the sand, the red jar open in her bag nearby, she takes a long refreshing drink, sea breeze, early light, natural athlete energy',
                'Colombian swimmer at the pool at 5am before morning training, sitting on the lane edge — a cup of cold water with SOFA kola granulada freshly stirred in rests on the pool ledge beside him, the red jar beside the cup, he drinks it down before slipping on his goggles, discipline and ritual, pool lights still on, dark sky outside',
            ],
            comprometidos: [
                'Dedicated Colombian professional woman in her early 30s at her Bogotá home office at 6am — she stirs SOFA kola granulada into a tall glass of cold orange juice with a small spoon, the open red jar beside her laptop, takes a long first sip while looking out the window at the waking city, calendar full, focused and energized',
                'Colombian female doctor in scrubs in the Medellín hospital break room during a short rest — a glass of cold water with SOFA kola granulada already mixed sits in her open locker, she takes it out and drinks it in one slow restorative moment, the red jar tucked beside her bag, honest and human',
                'Colombian male teacher in his 40s in his Cali classroom at 7am before students arrive — a glass of cold water with SOFA kola granulada sits on his desk beside the open red jar, he takes a slow sip while reviewing the day\'s lesson plan, morning light through school windows, quiet dedication',
                'Colombian female entrepreneur in a glass-walled Bogotá startup office at sunrise — she stirs SOFA kola granulada into a glass of cold fresh milk with a small spoon, the open red jar on the standing desk, takes the glass and walks to the window overlooking the city waking below, purposeful morning energy',
                'Colombian executive chef in white jacket during kitchen prep at 8am on his break — a glass of cold water with SOFA kola granulada freshly stirred in sits on his small office desk beside the open red jar, he drinks it with the practiced efficiency of someone who manages every minute, proud and disciplined',
            ],
            estudiantes: [
                'Young Colombian university student from Cali studying late at her apartment desk — a glass of cold milk with SOFA kola granulada stirred in sits open beside her laptop, the red jar next to it, she reaches for the glass and takes a long sip, desk lamp casting warm light on her open notebooks, authentic late-night grind',
                'Colombian student in the university cafeteria in Bogotá before an 8am exam — she stirs SOFA kola granulada into a tall glass of freshly squeezed orange juice from the cafeteria counter, the red jar from her backpack open on the tray, takes it with focused nervous energy, real student life',
                'Young Colombian man from the Pacífico studying at a colorful juice bar in Medellín El Poblado — a fresh batido de lulo sits beside his open books, the red SOFA jar on the wooden table, he stirs a spoonful of kola granulada into his batido and takes a sip, focused and grounded, tropical morning energy',
                'Colombian students during a study group break on a university terrace in Bogotá — the open SOFA jar sits at the center of the table, each person stirs a spoonful into their cold water bottles, raise them together laughing, campus energy, midday sun, solidarity and community',
                'Colombian pre-med student in Cali during a break between lab experiments — a glass of cold water with SOFA kola granulada freshly stirred in sits on her bench beside the open red jar, she drinks it in her lab coat, bright lab environment, scientific focus, relatable human moment amid the work',
            ],
        },

        identityBlock: `CREATIVE DIRECTION — SOFA (Corferias Colombian Kola Granulada):
⚠️ CRITICAL: Use the reference KV image as the EXACT visual template — replicate its color palette, composition, typography style, lighting quality, brand band proportions, and overall visual DNA with pixel-perfect fidelity. Do NOT invent a new layout — reproduce the KV identity.
- Product: SOFA is a KOLA GRANULADA (granulated powder supplement) — NOT a capsule, NOT a tablet. The red cylindrical jar with white lid is the product. In lifestyle scenes the product jar sits naturally on surfaces (counter, table, bench) — never forced into a hand during physical activity.
- Bottle silhouette: RED stroke outline (#E30613 or slightly lighter red) centered over person, with a semi-transparent red-tinted interior. ~2:1 tall-to-wide ratio. Balanced cylindrical jar — NOT a tube, NOT a white stroke.
- Brand band: Solid red #E30613 at the bottom. No gradients. Exact red. Match KV proportions exactly.
- Accent badge: Solid yellow pill #FFD700. Bold black text. Simple rounded rectangle — NO oval border, NO circle outline around it.
- FMC seal (Federación Médica Colombiana): Circular certification seal at bottom-right corner. EXACTLY ONCE. Never duplicate.
- Typography: Extract and replicate the EXACT typeface weight, size, and style from the KV headline. Match exactly — do not substitute.
- Person: Real Colombian, mestizo complexion, dark hair, authentic proud natural expression. LARGE and dominant in scene. Copy the exact photography style (depth of field, color grade, subject framing) from the KV.`,

        buildFormatGuidance: (_fmtId, w, h, family) => {
            if (family === 'portrait')   return `FORMAT: ${w}x${h}px (portrait 4:5). FULL-BLEED: lifestyle scene fills ENTIRE frame from top edge to red band. ABSOLUTELY NO white or solid-color panel at top — scene photo reaches the very top edge. Headline and subhead float directly over the scene photo. Red bottom band solid #E30613 approx bottom 28%. Bottle silhouette centered over person, ~2:1 ratio.`;
            if (family === 'square')     return `FORMAT: ${w}x${h}px (square 1:1). FULL-BLEED: scene fills entire frame top to red band. NO white panel at top. Headline and subhead overlaid on scene. Red band solid #E30613 approx bottom 30%. Bottle silhouette centered over person.`;
            if (family === 'story')      return `FORMAT: ${w}x${h}px (9:16 story/reels). FULL-BLEED: scene fills entire frame. Headline and subhead overlaid at top of scene. Red band solid #E30613 bottom 25%. Bottle silhouette centered over person full body.`;
            if (family === 'landscape')  return `FORMAT: ${w}x${h}px (landscape 1200×628). Left 42%: lifestyle scene with soft bright treatment for text legibility — NOT a white box, scene photo extends here. Headline/subhead/copy overlaid left. Right 58%: full lifestyle scene with bottle silhouette and FMC seal. Red band full width bottom ~22%.`;
            if (family === 'billboard')  return `FORMAT: ${w}x${h}px (ultra-wide horizontal billboard). TWO VERTICAL ZONES — LEFT ${Math.floor(w * 0.42)}px: solid red #E30613 background containing ALL copy (headline white bold top, subhead white below, vitamina chip + body + CTA center-bottom, product jar alone at bottom-left corner). RIGHT ${Math.floor(w * 0.58)}px: full-height lifestyle photo with NO text overlays — only the lifestyle scene, a subtle red-stroke bottle silhouette centered on the main adult person (max 15% opacity interior), and FMC seal bottom-right. The left red zone must NEVER be empty — it must contain the headline, subhead, and all copy elements.`;
            if (family === 'skyscraper') return `FORMAT: ${w}x${h}px (narrow 160px skyscraper). Top: headline text. Center: lifestyle scene with bottle silhouette over person. Red band bottom with yellow chip, body, closing line. Everything within ${w}px width.`;
            if (family === 'halfpage')   return `FORMAT: ${w}x${h}px (half-page 300×600). Top 12%: headline. Middle 48%: lifestyle scene with bottle silhouette. Bottom 40%: red band #E30613 with yellow chip badge, body copy, closing line.`;
            if (family === 'mrec')       return `FORMAT: ${w}x${h}px (MREC 300×250). Top 35%: lifestyle scene cropped to upper body and face. Bottom 65%: solid red band #E30613 with yellow chip badge, headline, and closing line.`;
            return `FORMAT: ${w}x${h}px.`;
        },
    },

    // ── Nueva marca: duplica este bloque y configura ──────────────────────────
    generic: {
        name: 'Genérico (desde KV)',
        emoji: '⬜',
        color: '#6b7280',
        audienceScenes: {},
        identityBlock: `BRAND IDENTITY: Follow the KV template faithfully — same layout zones, typography positions, brand bands. Only the scene content changes (new background, new character, new moment). Derive ALL design decisions from the reference KV image.`,
        buildFormatGuidance: (_fmtId, w, h, family) => {
            if (family === 'portrait')   return `FORMAT: ${w}x${h}px. Full-bleed scene top to brand band. Brand band bottom ~28%. Product over person.`;
            if (family === 'square')     return `FORMAT: ${w}x${h}px. Full-bleed scene. Brand band bottom ~30%. Product over person.`;
            if (family === 'story')      return `FORMAT: ${w}x${h}px. Full-bleed scene. Brand band bottom ~25%. Product over person.`;
            if (family === 'landscape')  return `FORMAT: ${w}x${h}px. Left 42% text zone, right 58% scene. Brand band bottom ~22%.`;
            if (family === 'billboard')  return `FORMAT: ${w}x${h}px. Left ${Math.floor(w * 0.42)}px brand zone. Right scene.`;
            if (family === 'skyscraper') return `FORMAT: ${w}x${h}px. Top headline, center scene, brand band bottom.`;
            if (family === 'halfpage')   return `FORMAT: ${w}x${h}px. Top headline, scene, brand band, copy, closing line.`;
            if (family === 'mrec')       return `FORMAT: ${w}x${h}px. Top scene, bottom brand band, headline, closing line.`;
            return `FORMAT: ${w}x${h}px.`;
        },
    },
};

// ─── Parser de copy desde Excel ──────────────────────────────────────────────
// Convierte el texto libre del cuadro de materiales en campos estructurados
// para que el prompt sea idéntico al modo manual (máxima consistencia).
function parseCopyText(raw: string, brandDefaults: boolean = true): { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string } {
    const result = { headline: '', subhead: '', vitamina_chip: '', body: '', cta: '' };
    if (!raw) return result;

    // Normalizar saltos de línea
    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    let section = '';
    const sectionBuffers: Record<string, string[]> = { headline: [], body: [], cta: [] };

    for (const line of lines) {
        const up = line.toUpperCase();

        // Detectar inicio de sección
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

        // Acumular en la sección actual
        if (section && sectionBuffers[section]) {
            sectionBuffers[section].push(line);
        } else if (!section) {
            // Sin sección aún → primera línea = headline
            sectionBuffers.headline.push(line);
            section = 'headline';
        }
    }

    const headlineText = sectionBuffers.headline.join(' ').trim();
    const bodyText     = sectionBuffers.body.join(' ').trim();
    const ctaText      = sectionBuffers.cta.join(' ').trim();

    // Separar headline en titular + subhead si es muy largo (>50 chars)
    if (headlineText.length > 50 && headlineText.includes(' es ')) {
        const splitIdx = headlineText.indexOf(' es ');
        result.headline = headlineText.slice(0, splitIdx).trim();
        result.subhead  = headlineText.slice(splitIdx + 1).trim();
    } else {
        result.headline = headlineText;
        result.subhead  = '';
    }

    // Extraer nutriente del body — solo el nombre corto (máx 30 chars para que quepa en el badge)
    // La extracción automática de "vitamina/nutriente" es específica de marcas tipo Tarrito;
    // para marcas custom NO se infiere nada (el chip llega explícito o queda vacío).
    const vitMatch = brandDefaults
        ? bodyText.match(/\b(Complejo B(?:\s*\+\s*Vit\.?\s*[A-Z])?|Vitaminas?\s+[A-Z][A-Z0-9]*(?:[,\s]+(?:B[0-9]+|[A-Z][0-9]?))*(?:\s+y\s+[A-Z][A-Z0-9]*)?|Multivitam[ií]nico|[Áa]cido\s+F[oó]lico|Hierro|Zinc|Calcio)\b/i)
        : null;
    if (vitMatch) {
        result.vitamina_chip = vitMatch[0].slice(0, 30).trim();
        // Quitar del body el prefijo "Contiene/Con/Incluye + vitamina" — el nombre queda SOLO en el pill badge.
        // Ej: "Contiene Complejo B que aporta energía..." → "que aporta energía..."
        const vitEscaped = vitMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result.body = bodyText
            .replace(new RegExp(`(?:Contiene|Con\\s+su(?:s)?|Incluye|Tiene|Con)\\s+${vitEscaped}\\s*`, 'gi'), '')
            .replace(new RegExp(`\\b${vitEscaped}\\b`, 'gi'), '') // eliminar cualquier mención restante inline
            .replace(/^[\s,\-–—]+/, '')                           // limpiar puntuación inicial sobrante
            .replace(/\s{2,}/g, ' ')
            .trim();
    } else {
        result.vitamina_chip = '';
        result.body = bodyText;
    }
    result.cta = ctaText || (brandDefaults ? 'Tómalo todos los días, 1 cucharada.' : '');

    return result;
}

// ─── Gobernanza + adaptación de copy (port del copy_adapter / brand_rules de Zalvaje) ──
// Agrupa cada familia de formato en un "grupo de longitud" y recorta el copy a un
// máximo de palabras por campo → garantiza que el texto SE VEA PERFECTO en la imagen.
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
type Copy5 = { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string };
function adaptCopyToFamily(copy: Copy5, family: string): Copy5 {
    const group = FORMAT_FAMILY_GROUP[family] || 'square';
    const lim = COPY_LIMITS[group];
    return {
        headline:      trimWords(copy.headline, lim.headline),
        subhead:       trimWords(copy.subhead,  lim.subhead),
        vitamina_chip: copy.vitamina_chip,
        body:          trimWords(copy.body, lim.body),
        cta:           trimWords(copy.cta,  lim.cta),
    };
}

// Reglas de copy por defecto (se enriquecen con la identidad inferida del cuadro)
const DEFAULT_COPY_RULES = {
    tono: 'cercano, motivacional y positivo',
    palabras_positivas: ['energía', 'vitalidad', 'bienestar', 'ritmo', 'foco', 'rendimiento', 'resistencia'],
    palabras_prohibidas: ['cura', 'milagroso', 'garantizado', 'adelgaza', '100% efectivo', 'sin efectos secundarios', 'mejor del mundo'],
};

// Compone el bloque COPY del cuadro de materiales en el formato que entiende parseCopyText
function buildCopyBlock(copyPrincipal: string, desarrollo: string, cierre: string): string {
    const lines: string[] = [];
    if (copyPrincipal) lines.push(`COPY PRINCIPAL: ${copyPrincipal.trim()}`);
    if (desarrollo)    lines.push(`DESARROLLO: ${desarrollo.trim()}`);
    if (cierre)        lines.push(`CIERRE: ${cierre.trim()}`);
    return lines.join('\n');
}

// ─── Generic format guidance (para perfiles guardados sin buildFormatGuidance) ──
function genericFormatGuidance(fmtId: string, w: number, h: number, family: string, identity?: any): string {
    const band    = identity?.bandColor         || 'brand primary color from KV';
    const bandH   = identity?.bandHeightPercent ? `${identity.bandHeightPercent}%` : '~27%';
    const bandPos = identity?.bandPosition      || 'bottom';
    const hlCol   = identity?.headlineColor     || '#FFFFFF';
    const hlWt    = identity?.headlineWeight    || 'Bold';
    const hlCase  = identity?.headlineCase      || 'match KV exactly';
    const logoPos = identity?.logoPosition      || 'match KV exactly';
    const logoSz  = identity?.logoSizePercent   ? `~${identity.logoSizePercent}% of frame width` : 'match KV';
    const dna     = Array.isArray(identity?.brandDNA) ? identity.brandDNA.slice(0,3).join(' | ') : '';

    const brandSystem = identity ? `
BRAND SYSTEM (extracted from KV analysis):
• Brand band: ${band} at ${bandPos}, height ${bandH}
• Headline: ${hlWt} weight, ${hlCase}, color ${hlCol}
• Logo: ${logoPos}, size ${logoSz}
${dna ? `• Brand DNA: ${dna}` : ''}` : '';

    if (family === 'portrait')   return `FORMAT: ${w}x${h}px (portrait 4:5). FULL-BLEED photographic lifestyle scene fills ENTIRE frame top to bottom — NO split layout, NO left-text/right-photo division. Text overlaid directly on scene photo. Brand band ${bandPos} ${bandH}.${brandSystem}`;
    if (family === 'square')     return `FORMAT: ${w}x${h}px (square 1:1). FULL-BLEED photographic scene covers entire frame — NO split layout. Text overlaid on scene. Brand band ${bandPos} ${bandH}.${brandSystem}`;
    if (family === 'story')      return `FORMAT: ${w}x${h}px (9:16 story). FULL-BLEED scene from top to brand band. NO split layout. Text overlaid on scene photo. Brand band ${bandPos} ${bandH}.${brandSystem}`;
    if (family === 'landscape')  return `FORMAT: ${w}x${h}px. Left 42% text/brand zone. Right 58% lifestyle scene. Band full width ${bandPos} ~22%.${brandSystem}`;
    if (family === 'billboard')  return `FORMAT: ${w}x${h}px (billboard). Left ${Math.floor(w*0.42)}px brand zone with copy+product. Right ${Math.floor(w*0.58)}px lifestyle scene.${brandSystem}`;
    if (family === 'skyscraper') return `FORMAT: ${w}x${h}px (skyscraper). Top: headline. Center: scene. Brand band ${bandPos}.${brandSystem}`;
    if (family === 'halfpage')   return `FORMAT: ${w}x${h}px. Top scene. Bottom 40% band with copy and CTA.${brandSystem}`;
    if (family === 'mrec')       return `FORMAT: ${w}x${h}px. Top 35% scene. Bottom 65% brand band with headline and CTA.${brandSystem}`;
    return `FORMAT: ${w}x${h}px. FULL-BLEED scene. NO split layouts.${brandSystem}`;
}

// ─── Refine video prompt with Claude (Director Creativo de Video) ─────────────
async function refineVideoPromptWithClaude(
    basePrompt: string,
    copy: { headline: string; body: string; cta: string; subhead: string; vitamina_chip: string },
    claudeApiKey: string,
    audienceLabel: string = '',
    audienciaRef: string = '',
    drivers: string = ''
): Promise<string> {
    try {
        const client = new Anthropic({ apiKey: claudeApiKey });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25_000);
        try {
            const response = await client.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 2200,
                messages: [{
                    role: 'user',
                    content: `You are an expert audiovisual creative director specializing in Latin American advertising. Take this video brief and enrich it with precise cinematographic details for AI video generation.

BASE BRIEF:
${basePrompt}

AUDIENCE:
- Target segment: "${audienceLabel || 'General Latin American audience'}"
- Demographic profile: "${audienciaRef || 'Authentic Latin American people'}"
- Key motivations: "${drivers || 'Wellbeing, quality of life, aspiration'}"

EXACT VO COPY (keep in Spanish — these are the spoken words):
- Clip 1 VO: "${copy.headline}"
- Clip 2 VO: "${copy.body || copy.subhead || copy.headline}"
- Clip 3 VO: emotional closing from the benefit — no price mention, no literal purchase command

ENRICHMENT INSTRUCTIONS:
1. Keep the exact structure of 3 clips × 10 seconds — they form ONE continuous 30s video when stitched
2. SAME CHARACTER (identical physical description, outfit, hair) in all 3 clips for editing continuity
3. Enrich each clip with:
   - Specific camera movement: dolly in/out, rack focus, pan, crane, steadicam, % slow motion
   - Exact light temperature: 2700K (warm), 5500K (daylight), 6500K (cool)
   - Light direction: backlight, 45° lateral, soft frontal, natural window light
   - Character performance: specific microexpressions, precise gestures, gaze direction
4. VO narration MUST speak the exact Spanish copy at the indicated timecodes — Colombian/neutral Latin voice
5. Add in each clip: "ANATOMY: character with exactly 2 arms, 5 fingers per hand, perfect human proportions"
6. Respond ONLY with the enriched prompt — no explanations. Technical instructions in English, VO copy stays in Spanish.`,
                }],
            }, { signal: controller.signal });
            clearTimeout(timeout);
            const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
            return text || basePrompt;
        } finally {
            clearTimeout(timeout);
        }
    } catch (err: any) {
        console.warn('[DCO Video] Claude refinement skipped:', (err as Error).message);
        return basePrompt;
    }
}

// ─── Video prompt builder — 3 clips for one unified 30s video ───────────────
function buildVideoPrompt(
    sceneDesc: string,
    copy: { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string },
    fmtId: string,
    fmt: { width: number; height: number; family: string; platform: string },
    profileId: string = 'generic',
    customIdentityBlock?: string,
    hasProductImage: boolean = false,
    audienceLabel: string = '',
    audienciaRef: string = '',
    drivers: string = ''
): string {
    const { headline, body, cta, subhead, vitamina_chip } = copy;
    const f = fmt.family;

    const aspectRatio =
        f === 'story'    ? '9:16'   :
        f === 'portrait' ? '4:5'    :
        f === 'square'   ? '1:1'    :
        f === 'landscape'? '16:9'   :
        f === 'billboard'? '3.88:1' :
        f === 'halfpage' ? '1:2'    :
        f === 'mrec'     ? '6:5'    : '1:1';

    const textAll = `${audienceLabel} ${audienciaRef} ${drivers} ${headline} ${body} ${subhead} ${sceneDesc}`.toLowerCase();
    const explicitAudience = audienceLabel.trim();

    // ─── Product detection ───────────────────────────────────────────────────
    const isTV       = /\btv\b|television|oled|qled|pantalla|televisor|monitor/.test(textAll);
    const isFridge   = /nevera|refrigerador|fridge|refriger/.test(textAll);
    const isBeverage = /bebida|jugo|gaseosa|agua|drink|juice|soda|kola|granulada/.test(textAll);
    const productLabel = isTV ? 'TV/PANTALLA' : isFridge ? 'REFRIGERADOR' : 'PRODUCTO';

    // ─── Audience detection — soccer BEFORE gaming (KV context priority) ────────
    const isSoccer       = /estadio|f[uú]tbol|futbol|partido|gol|selecci[oó]n|colombia|tribuna|cancha|mundial/.test(textAll);
    const isFamily       = /famil|ni[ñn]o|kid|child|hijo|hija|pap[aá]|mam[aá]|padre|madre|beb[eé]/.test(textAll);
    const isGamer        = !isSoccer && /gam(er|ing)|videojuego|consola|xbox|playstation|ps[45]|nintendo|esport/.test(textAll);
    const isYouth        = /joven|juventud|universitari|amigo|party|fiesta|urban|trend/.test(textAll);
    const isProfessional = /profesional|ejecutiv|trabajo|oficina|negocio|empresa|emprendedor/.test(textAll);
    const isSport        = /deporte|fitness|gym|atleta|entrenamiento|ejercicio|correr|running|ciclismo/.test(textAll);
    const isCooking      = /cocina|receta|alimentaci[oó]n|sabor|comida|gastronom|chef|ingrediente/.test(textAll);

    type AudienceConfig = {
        label: string; voiceTone: string; energy: string;
        cast: string; characterBible: string;
        seg1Mood: string; seg3Mood: string;
    };

    const audience: AudienceConfig = isSoccer
        ? {
            label: 'FÚTBOL',
            voiceTone: 'apasionada, vibrante, colombiana — como hincha real hablando del partido, no locutor',
            energy: 'alta energía, tensión y explosión de emoción',
            cast: 'grupo de adultos colombianos 24–42 años en sala familiar viendo el partido — camisetas de selección Colombia amarilla, algunos con camisetas de equipos locales',
            characterBible: 'PERSONAJES: grupo de 3–5 adultos colombianos (hombres y mujeres) 24–42 años, camisetas de Colombia amarilla o de equipos de fútbol colombiano, jeans/ropa casual de casa. Sala familiar amplia y luminosa, sofá, mesa con snacks/bebidas, TV grande LG en la pared mostrando el partido. TODOS MIRAN LA TV — cero espaldas a cámara. MANTENER EN LOS 3 CLIPS: mismo grupo, mismo outfit, misma sala.',
            seg1Mood: 'sala familiar, tarde de partido, luz cálida 3000K, anticipación colectiva antes del gol',
            seg3Mood: 'euforia post-gol, puños en alto, abrazos espontáneos — victoria compartida',
          }
        : isFamily
        ? {
            label: 'FAMILIA',
            voiceTone: 'cálida, pausada, emotiva — mamá o papá hablando con amor genuino',
            energy: 'emotiva y luminosa',
            cast: 'familia latinoamericana completa con adultos jóvenes — interacción natural auténtica, no posada',
            characterBible: 'PERSONAJE PRINCIPAL: madre o padre latinoamericano 32–42 años, cabello oscuro lacio/ondulado, piel morena clara, ropa casual doméstica (camisa/blusa colores cálidos). SECUNDARIOS: hijos adultos 20–28 años, mismo tono de piel. TODOS MIRAN LA TV/PRODUCTO — cero espaldas a cámara. MANTENER EN LOS 3 CLIPS: mismo peinado, ropa y rasgos físicos exactos.',
            seg1Mood: 'mañana familiar, sala iluminada, luz dorada 2700K',
            seg3Mood: 'familia unida en su mejor momento, risa genuina, conexión real',
          }
        : isGamer
        ? {
            label: 'GAMER',
            voiceTone: 'dinámica, cool, energética — joven 20s sin artificialismo publicitario',
            energy: 'alta energía, ritmo ágil y preciso',
            cast: 'joven 18–28 años en entorno gaming o tech, enfocado y apasionado',
            characterBible: 'PERSONAJE PRINCIPAL: joven hombre latinoamericano 20–26 años, cabello corto oscuro, piel morena, camiseta gráfica oscura (negro/gris/azul). Postura: inclinado, concentrado, ágil. MANTENER EN LOS 3 CLIPS: mismo outfit, peinado y rasgos físicos exactos.',
            seg1Mood: 'habitación con luces RGB, pantalla brillante, anticipación intensa',
            seg3Mood: 'victoria o logro alcanzado, pantalla reflejando éxito, satisfacción real',
          }
        : isYouth
        ? {
            label: 'JÓVENES',
            voiceTone: 'fresca, casual, auténtica — conversacional como entre amigos sin guión',
            energy: 'vibrante y social',
            cast: 'grupo de amigos 20–30 años, diverso y auténtico latinoamericano',
            characterBible: 'PERSONAJE PRINCIPAL: joven mujer latinoamericana 22–28 años, cabello largo oscuro suelto, piel morena media, ropa urbana casual (top o camiseta de color, jeans). SECUNDARIOS: 2–3 amigos mix hombre/mujer, tonos de piel variados. MANTENER EN LOS 3 CLIPS: mismo grupo, outfits y rasgos físicos exactos.',
            seg1Mood: 'espacio social vibrante — ciudad, rooftop, parque urbano, colores saturados',
            seg3Mood: 'conexión grupal espontánea, celebración auténtica no posada',
          }
        : isProfessional
        ? {
            label: 'PROFESIONAL',
            voiceTone: 'aspiracional, sobria, confiable — segura sin ser corporativa ni fría',
            energy: 'propósito claro, media-alta',
            cast: 'profesional 28–42 años latinoamericano auténtico, entorno ejecutivo moderno real',
            characterBible: 'PERSONAJE PRINCIPAL: profesional latinoamericano/a 30–38 años, cabello recogido o corto arreglado, piel morena, ropa formal-casual inteligente (blazer o camisa neutros — azul, blanco, gris). MANTENER EN LOS 3 CLIPS: mismo outfit profesional, peinado y rasgos físicos exactos.',
            seg1Mood: 'amanecer urbano latinoamericano, sentido de propósito, ciudad despertando',
            seg3Mood: 'logro profesional conseguido, confianza genuina, mirada clara al futuro',
          }
        : isSport
        ? {
            label: 'DEPORTE/FITNESS',
            voiceTone: 'motivadora, poderosa, directa — como un coach que cree genuinamente en ti',
            energy: 'máxima, física, real y sin filtro',
            cast: 'atleta latinoamericano 20–35 años, cuerpo real (no modelo genérico), en movimiento genuino',
            characterBible: 'PERSONAJE PRINCIPAL: atleta latinoamericano/a 24–32 años, cuerpo atlético real (no de catálogo), piel morena con sudor natural, ropa deportiva funcional (leggings/shorts + top deportivo en colores primarios o neutros). MANTENER EN LOS 3 CLIPS: mismo outfit deportivo, peinado y rasgos físicos exactos.',
            seg1Mood: 'amanecer al aire libre o gym al alba, esfuerzo genuino, sudor visible',
            seg3Mood: 'meta superada, respiración profunda de satisfacción, orgullo real',
          }
        : isCooking
        ? {
            label: 'COCINA/ALIMENTACIÓN',
            voiceTone: 'sensorial, cálida, cercana — como alguien compartiendo algo delicioso de corazón',
            energy: 'media, placentera y sensorial',
            cast: 'persona 25–50 años en cocina real — manos protagonistas del relato visual',
            characterBible: 'PERSONAJE PRINCIPAL: mujer o hombre latinoamericano 28–45 años, cabello recogido (para cocinar), piel morena cálida, delantal o ropa casual de casa (tonos tierra o colores vivos). Manos: siempre visibles, activas, expresivas. MANTENER EN LOS 3 CLIPS: mismo outfit de cocina, peinado y rasgos físicos exactos.',
            seg1Mood: 'cocina luminosa real, colores cálidos, ingredientes frescos, manos en acción',
            seg3Mood: 'primer bocado o sorbo, expresión genuina de placer, momento íntimo',
          }
        : {
            label: 'AUDIENCIA GENERAL',
            voiceTone: 'profesional neutra cálida, colombiana/latina — conversacional y humana',
            energy: 'media-alta, optimista',
            cast: 'persona 25–40 años latinoamericana auténtica, no modelo de stock',
            characterBible: 'PERSONAJE PRINCIPAL: persona latinoamericana 28–38 años, cabello oscuro natural, piel morena media, ropa casual contemporánea en colores neutros o de marca. Expresión: natural, auténtica, no publicitaria. MANTENER EN LOS 3 CLIPS: mismo outfit, peinado y rasgos físicos exactos.',
            seg1Mood: 'entorno cotidiano latinoamericano auténtico, luz natural cálida',
            seg3Mood: 'momento de satisfacción real y genuina, sonrisa auténtica',
          };

    const productAntiHallucination = hasProductImage
        ? `PRODUCT FIDELITY — MANDATORY ALL 3 CLIPS:
• Reference photo = only visual truth for the product
• Replicate EXACTLY: shape, dimensions, color, label/logo text, surface finish
• ${isTV ? 'TV: exact bezel, exact stand, logo on bezel — screen ALWAYS ON with vibrant content, NEVER black or grey' : ''}
• ${isFridge ? 'Fridge: exact door configuration, handles, brand panel, color finish' : ''}
• ${isBeverage ? 'Packaging: exact shape, full label design — occupies 30%+ of frame in hero shot' : ''}
• Product sharp and legible in minimum 2 frames per clip`
        : `PRODUCT ANTI-HALLUCINATION:
• Infer appearance ONLY from key visual — NEVER invent or generalize
• ${isTV ? 'EXACT TV from KV: screen-to-bezel ratio, stand, logo on bezel, screen ALWAYS ON' : ''}
• ${isFridge ? 'EXACT fridge from KV: door style, handles, finish, brand panel' : ''}
• Product identifiable as specific brand — NEVER generic stock version`;

    const productHeroShot = isTV
        ? 'Rack focus reveals complete TV in real setting — screen ON with vibrant content (sport, cinema, gaming). Brand on bezel clearly visible.'
        : isFridge
        ? 'Fridge door opens softly with dolly in — organized illuminated interior, fresh food. Camera pulls back revealing full appliance. Brand panel prominent.'
        : isBeverage
        ? 'Slow dolly in to packaging — label fills 35%+ of frame for 2 seconds. Natural condensation or shine on surface. Perfect focus on logo and label.'
        : 'Cinematic dolly in to product — label and brand sharp, well-lit, soft depth of field, 2 seconds on frame.';

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
• Color palette: derived EXCLUSIVELY from the KV reference (colors, typography, logo, brand bands)
• KV reference: USE FOR BRAND IDENTITY ONLY — DO NOT copy or reference the person/face/style from the KV image
• Color temperature: consistent warm cinematic grade across all 3 clips
• Setting: same location or connected locations — continuous physical world
• Camera style: same lens character, same depth of field aesthetic throughout
FORBIDDEN: different color grade per clip, changing location feel, changing camera aesthetic, copying KV character.

━━━ ${productLabel} — PRODUCT PRECISION ━━━
${productAntiHallucination}

━━━ HUMAN ANATOMY ━━━
${anatomyRule}

━━━ BASE SCENE ━━━
${sceneDesc}

━━━ VOICE OVER — SPECIFICATIONS ━━━
Voice: ${audience.voiceTone}
Language: Colombian Spanish / neutral Latin — intimate, conversational, NEVER commercial announcer tone
Technique: dramatic pause before key phrases, slightly audible natural breathing, human rhythm
Audio mix: VO 70% | Organic ambient SFX 30% (environment sounds: textures, space, natural ambience)

━━━ CLIP 1 — "INICIO: EL MUNDO ANTES" (0–10s) ━━━
Narrative purpose: Introduce the character in their authentic everyday world BEFORE the product. The viewer recognizes themselves.
Setting: ${audience.seg1Mood}
STITCH NOTE: This clip opens the story. End with character in motion or looking off-frame → seamless cut into Clip 2.

[0s–3s] Wide shot — character in their world, natural light, NO product visible
  Movement: smooth steadicam or elegant static | Light: ${audience.seg1Mood.includes('dorada') ? '2700K warm golden lateral' : '5500K clean natural'}
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
${isTV ? '[4s–7s] Screen ON with vibrant content — character reacts with genuine amazement, body oriented toward TV' : ''}
${isFridge ? '[4s–7s] Illuminated organized fridge interior — hands taking something with satisfaction, open door visible' : ''}
${isBeverage ? '[4s–7s] First sip or physical contact — genuine expression of energy or pleasure, not exaggerated' : ''}
[8s–10s] Character looks up or outward, transformation beginning → CUT POINT to Clip 3

VO [3s–9s]: "${voSeg2}"
On-screen text: ${vitamina_chip ? '"' + vitamina_chip + '" as brand badge at 4s, 2s duration' : 'none — only images and VO'}

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
• Color grade: warm and cinematic — consistent with KV palette across ALL 3 clips
• Characters: authentic Latin American, photorealistic, 100% perfect human anatomy
• Audio: VO + organic ambient SFX only — no background music tracks

FORBIDDEN: stock footage aesthetic, artificial expressions, generic CGI environments, unreal anatomy (extra arms, fused fingers, deformed faces), explicit CTA text on screen, generic product not matching KV, different character appearance between clips, copying the KV character/person.`;
}





// ─── Claude Sonnet enrichment — convierte identidad KV en brief de diseño preciso ─
// Solo para marcas guardadas (no tarrito, no generic). Fail-safe: devuelve '' si falla.
async function enrichPromptWithClaude(
    identityJson: any,
    family: string,
    w: number,
    h: number,
    copy: { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string },
    claudeApiKey: string
): Promise<string> {
    try {
        const client = new Anthropic({ apiKey: claudeApiKey });
        const brandName  = identityJson.brandName  || 'the brand';
        const primary    = identityJson.primaryColor || '';
        const band       = identityJson.bandColor   || '';
        const bandPos    = identityJson.bandPosition || 'bottom';
        const bandH      = identityJson.bandHeightPercent ? `${identityJson.bandHeightPercent}%` : '~27%';
        const hlColor    = identityJson.headlineColor || '#FFFFFF';
        const hlWt       = identityJson.headlineWeight || 'Bold';
        const hlCase     = identityJson.headlineCase  || 'match KV';
        const logoPos    = identityJson.logoPosition  || 'match KV';
        const dna        = Array.isArray(identityJson.brandDNA) ? identityJson.brandDNA.join('\n') : '';
        const negPrompt  = identityJson.negativePrompt || '';
        const tz         = identityJson.textZones     || {};

        const tzSummary = Object.entries(tz).filter(([, v]: any) => v?.zone && v.zone !== 'none').map(([k, v]: any) =>
            `${k.toUpperCase()}: ${v.zone}, ~${v.verticalPercent || '?'}% from top, ${v.horizontalAlignment || 'center'}, ${v.fontWeight || ''} ${v.case || ''} ${v.colorHex || ''} font ~${v.fontSizePercent || '?'}% frame height${v.shape && v.shape !== 'none' ? `, shape: ${v.shape}` : ''}${v.bgColor ? `, bg: ${v.bgColor}` : ''}`
        ).join('\n');

        const resp = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 600,
            messages: [{
                role: 'user',
                content: `You are a senior art director. Write precise DESIGN INSTRUCTIONS for an AI image generator to reproduce this brand's visual identity faithfully.

BRAND: ${brandName} | FORMAT: ${w}x${h}px (${family})
PRIMARY COLOR: ${primary} | BAND: ${band} at ${bandPos} height ${bandH}
HEADLINE TREATMENT: ${hlWt} weight, ${hlCase}, fill ${hlColor} | LOGO: ${logoPos}
${dna ? `BRAND DNA:\n${dna}` : ''}
${tzSummary ? `TEXT ZONES FROM REAL KVs:\n${tzSummary}` : ''}
${negPrompt ? `NEVER GENERATE: ${negPrompt}` : ''}

COPY STRINGS FOR THIS PIECE (these are the texts to render):
- HEADLINE: "${copy.headline}"
- SUBHEAD: "${copy.subhead}"
${copy.body ? `- BODY: "${copy.body}"` : ''}
- CTA: "${copy.cta}"
${copy.vitamina_chip ? `- CHIP/BADGE: "${copy.vitamina_chip}"` : ''}

Write 200 words of DESIGN INSTRUCTIONS (not copy, not descriptions — pure technical directives for the image generator). Structure as two sections:

TYPOGRAPHY RENDERING (how to visually render each copy string):
For each copy string above, specify: exact font style (italic/upright), width (ultra-condensed/normal), weight, case, fill color, stroke color+width if any, shadow specs, glow if any, frame position (% from top), alignment, size (% of frame height). These are instructions, NOT text to appear in the image.

FIXED BRAND TEMPLATE ELEMENTS (brand elements always present regardless of brief):
List every fixed graphic element that must appear in every execution: logo style/position/size, fixed text marks, badges/pills with their visual treatment, icon rows, motion effects, decorative elements. Be specific about visual treatment for each.`
            }],
        });
        return resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : '';
    } catch {
        return '';
    }
}

// ─── Agent 1: Claude Creative Architect ─────────────────────────────────────────
// Recibe brief + identidad JSON + escena variante → geminiPrompt + typographySpec + checklist
// geminiPrompt: el brief traducido al lenguaje visual concreto que Gemini entiende
// typographySpec: especificación exacta de fuente/posición/color por elemento de copy
// checklist: criterios YES/NO que los Agentes 4/5/6 validan contra la imagen
async function buildCreativeSpec(
    basePrompt: string,
    identityJson: any,
    copy: { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string },
    fmt: { width: number; height: number; family: string },
    claudeApiKey: string
): Promise<{ geminiPrompt: string; checklist: string[]; typographySpec: any[] }> {
    const fallback = { geminiPrompt: basePrompt, checklist: [], typographySpec: [] };
    try {
        const client = new Anthropic({ apiKey: claudeApiKey });

        // Build the allowed-text inventory for anti-hallucination
        const allowedTexts = [
            copy.headline      ? `"${copy.headline}"`      : null,
            copy.subhead       ? `"${copy.subhead}"`       : null,
            copy.vitamina_chip ? `"${copy.vitamina_chip}"` : null,
            copy.body          ? `"${copy.body}"`          : null,
            copy.cta           ? `"${copy.cta}"`           : null,
        ].filter(Boolean).join(', ');

        const resp = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 2400,
            messages: [{
                role: 'user',
                content: `You are a Creative Architect. Your job: translate an advertising brief into Gemini's native visual language AND define the exact typography spec for QA validation.

══ PART 1 — GEMINI PROMPT ══
Rewrite the brief in Gemini's language: concrete, photographic, spatial, measurable.
Rules for translation:
- Replace abstractions with hex codes, pixel-% distances, font descriptors
- Every text zone: "zone name, X% from left, Y% from top, W% wide, Z% tall — [font descriptor] fill #XXXXXX"
- Font descriptor format: "[style] [width] [weight] [size% of frame height]" e.g. "upright condensed Black 14%"
- BREATHING ROOM: minimum 8% vertical gap between any two text zones — specify explicitly
- DOMINANT ELEMENT: one hero element per zone; never stack two text blocks in the same zone
- Add at the start: "⛔ ALLOWED TEXT ONLY — render EXCLUSIVELY these strings as visible text: ${allowedTexts}. Render ZERO other words, labels, prices, descriptions, or decorative text."
- Add at the end: "⛔ OVERLAP FORBIDDEN — each text element occupies a non-overlapping zone. If any text would collide, omit the lower-priority one. ⛔ Output exactly ${fmt.width}x${fmt.height}px."

══ PART 2 — TYPOGRAPHY SPEC ══
For each copy element that has a non-empty value below, write an exact spec object.
This will be used by a QA agent to verify the generated image against the KV reference.

══ PART 3 — QA CHECKLIST ══
Write exactly 10 YES/NO verifiable criteria. First 4 are mandatory:
1. ZERO_INVENTED_TEXT: no text in image outside the allowed list above
2. NO_TEXT_OVERLAP: no two text zones share vertical space or overlap
3. VISUAL_HIERARCHY: one dominant element per zone, no overloaded composition
4. KV_COLORS_MATCH: primary and accent colors match the brand identity
Then add 6 more specific to this brief and brand.

══ BRIEF ══
${basePrompt}

══ BRAND IDENTITY ══
${JSON.stringify(identityJson, null, 2).slice(0, 1800)}

══ COPY TO RENDER ══
HEADLINE: "${copy.headline || '(empty — omit)'}"
SUBHEAD: "${copy.subhead || '(empty — omit)'}"
CHIP/BADGE: "${copy.vitamina_chip || '(empty — omit)'}"
BODY: "${copy.body || '(empty — omit)'}"
CTA: "${copy.cta || '(empty — omit)'}"
FORMAT: ${fmt.width}x${fmt.height}px (${fmt.family})

Respond ONLY with valid JSON:
{
  "geminiPrompt": "complete rewritten prompt with all anti-hallucination rules embedded",
  "typographySpec": [
    {
      "element": "headline",
      "text": "exact string",
      "fontStyle": "upright|italic",
      "fontWidth": "normal|condensed|ultra-condensed",
      "fontWeight": "Regular|SemiBold|Bold|Black",
      "fillColor": "#XXXXXX",
      "strokeColor": "#XXXXXX or none",
      "sizePercentOfFrameHeight": 12,
      "zone": "photo-overlay-top|photo-overlay-center|brand-band|pill-badge|standalone-button",
      "verticalPercent": 15,
      "horizontalAlignment": "left|center|right"
    }
  ],
  "checklist": ["ZERO_INVENTED_TEXT: ...", "NO_TEXT_OVERLAP: ...", ...]
}`
            }],
        });

        const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
        const jsonMatch = extractJSON(text);
        if (!jsonMatch) { console.warn('[Agent1] JSON parse fail — raw:', text.slice(0, 300)); return fallback; }
        const result = JSON.parse(jsonMatch);
        const geminiPrompt = typeof result.geminiPrompt === 'string' && result.geminiPrompt.length > 100
            ? result.geminiPrompt : basePrompt;
        const typographySpec = Array.isArray(result.typographySpec) ? result.typographySpec : [];
        const checklist = Array.isArray(result.checklist) ? result.checklist : [];
        console.log(`[Agent1] OK — prompt ${geminiPrompt.length}ch | typoSpec ${typographySpec.length} items | checklist ${checklist.length}`);
        return { geminiPrompt, typographySpec, checklist };
    } catch (err: any) {
        console.warn('[Agent1] error (fallback):', err.message);
        return fallback;
    }
}

// ─── Intelligent copy placement map — universal for any brand ─────────────────
function buildCopyPlacementMap(
    copy: { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string },
    identity: any,
    isMoto: boolean
): string {
    const { headline, subhead, vitamina_chip, body, cta } = copy;

    // Global anti-box rule — prepended to every copy placement map
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
    const primary = identity?.primaryColor || identity?.bandColor || '#E30613';
    const hlColor = identity?.headlineColor || typo.headline?.fillColor || '#FFFFFF';

    // ── Copy type detectors ──────────────────────────────────────────────────
    const wordCount     = (t: string) => t.trim().split(/\s+/).length;
    const isFeatureList = (t: string) => Boolean(t && (t.includes(';') || (t.match(/\|/g) || []).length >= 2 || t.split(',').filter((x: string) => x.trim().split(/\s+/).length <= 6).length >= 3));
    const isPowerPhrase = (t: string) => Boolean(t && wordCount(t) <= 5);
    const isBadgeText   = (t: string) => Boolean(t && wordCount(t) <= 4);
    const isIntroText   = (t: string) => Boolean(t && /^(presentando|nuevo|nueva|introducing|ahora con|ahora)/i.test(t.trim()));
    const hasSpecs      = (t: string) => Boolean(t && /\d+\s*(km|cv|ps|cc|hp|kg|rpm|\/h|seg|min|mah|mph)/i.test(t));

    // ── Typography helpers ───────────────────────────────────────────────────
    const hlTypo = typo.headline || {};
    const shTypo = typo.subhead  || {};
    const bdTypo = typo.body     || {};
    const ctTypo = typo.cta      || {};

    const hlZone  = tz.headline?.zone                  || (isMoto ? 'photo-overlay-bottom' : 'photo-overlay-center');
    const hlVert  = tz.headline?.verticalPercent        || (isMoto ? 62 : 50);
    const hlAlign = tz.headline?.horizontalAlignment    || 'left';
    const hlWidth = tz.headline?.maxWidthPercent        || 88;
    const hlSize  = hlTypo.sizePercentOfFrameHeight     || (isMoto && isPowerPhrase(headline) ? 22 : 8);
    const hlWeight= hlTypo.fontWeight || 'Black';
    const hlStyle = hlTypo.fontStyle  || (isMoto ? 'italic' : 'upright');
    const hlFWidth= hlTypo.fontWidth  || (isMoto ? 'ultra-condensed' : 'condensed');

    const lines: string[] = [
        '\u2501\u2501\u2501 COPY PLACEMENT MAP \u2014 WHERE + HOW to render each element \u2501\u2501\u2501',
        '(Design instructions only. Render ONLY the quoted strings as visible image text.)',
    ];

    // ── HEADLINE ────────────────────────────────────────────────────────────
    if (headline) {
        const isBig = isMoto && isPowerPhrase(headline);
        lines.push('');
        lines.push(`HEADLINE "${headline}":`);
        lines.push(`  Position: ${hlZone}, ~${hlVert}% from top, ${hlAlign}-aligned, max-width ${hlWidth}%`);
        lines.push(`  Font: ${hlStyle} ${hlFWidth} ${hlWeight}`);
        lines.push(`  Size: ~${hlSize}% of frame height${isBig ? ' \u2014 HERO TEXT, largest element in the image' : ''}`);
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
            lines.push('  Size: ~1.8% of frame height \u2014 small, secondary to badge and logo');
            lines.push(`  Fill: ${shTypo.fillColor || '#FFFFFF'}`);
        } else {
            const shZone = tz.subhead?.zone || 'photo-overlay-bottom';
            const shVert = tz.subhead?.verticalPercent || (isMoto ? 55 : 40);
            lines.push(`SUBHEAD "${subhead}":`);
            lines.push(`  Position: ${shZone}, ~${shVert}% from top, ${tz.subhead?.horizontalAlignment || 'left'}-aligned`);
            lines.push(`  Font: ${shTypo.fontStyle || 'upright'} ${shTypo.fontWeight || 'SemiBold'}`);
            lines.push(`  Size: ~${shTypo.sizePercentOfFrameHeight || 3.5}% of frame height`);
            lines.push(`  Fill: ${shTypo.fillColor || '#FFFFFF'}`);
            if (shTypo.strokeColor) lines.push(`  Stroke: ${shTypo.strokeColor} ${shTypo.strokeWidthPx || 2}px`);
        }
    }

    // ── BADGE / CHIP ────────────────────────────────────────────────────────
    if (vitamina_chip?.trim()) {
        const bd    = badges[0] || {};
        const bgCol = bd.bgColor   || primary;
        const txCol = bd.textColor || '#FFFFFF';
        const shape = bd.shape     || 'pill';
        const bVert = bd.verticalPercent || tz.chip?.verticalPercent || 8;
        lines.push('');
        if (isBadgeText(vitamina_chip)) {
            lines.push(`BADGE "${vitamina_chip}":`);
            lines.push(`  Render as ${shape} graphic element \u2014 background ${bgCol}, text ${txCol} Bold ALL_CAPS`);
            lines.push(`  Position: top zone ~${bVert}% from top, inline or next to INTRO text`);
            lines.push(`  Size: text ~2.5% frame height inside padded ${shape}`);
        } else {
            lines.push(`CHIP "${vitamina_chip}":`);
            lines.push(`  Render as pill badge \u2014 bg ${bgCol}, text ${txCol} Bold, top zone`);
        }
    }

    // ── BODY \u2014 feature list \u2192 icon row | specs \u2192 spec bar | paragraph \u2192 text ────────
    if (body?.trim()) {
        lines.push('');
        if (isFeatureList(body)) {
            const sep      = body.includes(';') ? ';' : body.includes('|') ? '|' : ',';
            const features = body.split(sep).map((f: string) => f.trim()).filter(Boolean);
            const irPos    = iconRow.present ? iconRow.position : (isMoto ? 'bottom strip of photo' : 'bottom area');
            const irVert   = iconRow.verticalPercent || 82;
            const irIcCol  = iconRow.iconColor  || '#FFFFFF';
            const irTxCol  = iconRow.textColor  || '#FFFFFF';
            const irBg     = iconRow.bgColor    || 'dark semi-transparent overlay matching photo tone \u2014 NOT a solid bright color band';
            lines.push('BODY \u2192 ICON ROW (feature list detected):');
            lines.push(`  Position: ${irPos}, ~${irVert}% from top, full width`);
            lines.push(`  Background: ${irBg}`);
            lines.push(`  Layout: horizontal row of ${features.length} items separated by pipe (|) dividers`);
            features.forEach((f: string, i: number) => {
                lines.push(`  Item ${i + 1}: [white outline icon] + label "${f}"`);
            });
            lines.push(`  Icon style: ${iconRow.iconStyle || 'outline'}, color ${irIcCol}`);
            lines.push(`  Label: ${irTxCol} Regular ~1.8% frame height, centered below each icon`);
            lines.push('  \u26a0\ufe0f NOT a paragraph \u2014 render as graphical icon grid, each feature = icon + label');
        } else if (hasSpecs(body) && isMoto) {
            lines.push(`BODY \u2192 SPEC BAR "AHORA CON | ${body}":`);
            lines.push('  Position: below the Pulsar brand logo, same left-alignment, single horizontal line');
            lines.push(`  Font: upright Regular ${bdTypo.fillColor || '#FFFFFF'}, ~2% frame height`);
            lines.push('  Pipe (|) separator after "AHORA CON" \u2014 spec values on same line');
        } else {
            const bZone = tz.body?.zone || 'photo-overlay-bottom';
            const bVert = tz.body?.verticalPercent || (isMoto ? 58 : 45);
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
        const ctVert  = tz.cta?.verticalPercent || 88;
        const ctShape = ctTypo.buttonShape || 'pill';
        const ctBg    = ctTypo.bgColor    || primary;
        const ctCol   = ctTypo.fillColor  || '#FFFFFF';
        lines.push('');
        lines.push(`CTA "${cta}":`);
        lines.push(`  Render as ${ctShape} button \u2014 bg ${ctBg}, text ${ctCol} Bold ALL_CAPS`);
        lines.push(`  Position: ${ctZone}, ~${ctVert}% from top, ${tz.cta?.horizontalAlignment || 'left'}-aligned`);
        lines.push(`  Size: text ~${ctTypo.sizePercentOfFrameHeight || 2.5}% frame height`);
        lines.push('  ⚠️ CTA text color = white or brand primary ONLY — NEVER red, blue, or any invented color not in the KV.');
    }

    // ── Universal anti-hallucination ─────────────────────────────────────────
    lines.push('');
    lines.push('\u26d4 PLACEMENT RULES \u2014 ABSOLUTE:');
    lines.push('\u26d4 NO solid colored rectangle/band invented at bottom \u2014 any dark strip for the icon row must match the photo dark tone, semi-transparent, NOT a bright opaque block.');
    lines.push('\u26d4 Feature list in BODY \u2192 icon row graphic, NEVER a text paragraph on a colored bar.');
    lines.push('\u26d4 BADGE/CHIP \u2192 pill/badge graphic, NEVER plain floating text.');
    lines.push('\u26d4 Each element appears ONCE in its designated zone only.');
    lines.push('\u26d4 ZERO text outside the zones specified above.');
    lines.push('\u26d4 ZERO text inside boxes, ovals, rectangles, bubbles, or any container — text floats directly on the image as styled typography.');

    return antiBoxHeader + lines.join('\n');
}

// ─── Prompt builder (usa perfil de marca) ─────────────────────────────────────
function buildPrompt(
    sceneDesc: string,
    copy: { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string },
    fmtId: string,
    fmt: { width: number; height: number; family: string },
    profileId: string = 'tarrito_rojo',
    customIdentityBlock?: string,
    observaciones?: string,
    hasProductImage: boolean = false,
    productCategory: string = '',
    productBenefits: string[] = [],
    audienciaRef: string = '',
    drivers: string = '',
    hasLogoImage: boolean = false,
    hasConglomerateLogo: boolean = false
): string {
    const builtinProfile = BRAND_PROFILES[profileId] || null;
    const identityBlock  = customIdentityBlock
        ? (() => { try { var _ip = JSON.parse(customIdentityBlock); return _ip.identityPrompt || customIdentityBlock; } catch(e) { return customIdentityBlock; } })()
        : builtinProfile?.identityBlock || BRAND_PROFILES['generic'].identityBlock;
    // Parse identity JSON for custom saved brands to extract textZones + pass to genericFormatGuidance
    let parsedIdentity: any = null;
    if (customIdentityBlock && !builtinProfile) {
        try { parsedIdentity = JSON.parse(customIdentityBlock); } catch { /* use as plain text */ }
    }
    const formatGuide    = builtinProfile
        ? builtinProfile.buildFormatGuidance(fmtId, fmt.width, fmt.height, fmt.family)
        : genericFormatGuidance(fmtId, fmt.width, fmt.height, fmt.family, parsedIdentity || undefined);
    const { headline, subhead, vitamina_chip, body, cta } = copy;
    const hasBadge = vitamina_chip && vitamina_chip.trim().length > 0;
    const observacionesBlock = observaciones && observaciones.trim()
        ? `\nCREATIVE DIRECTOR NOTES — apply these specific constraints to this piece:\n${observaciones.trim()}\n`
        : '';
    const productBlock = hasProductImage
        ? `\nPRODUCT REFERENCES (images provided after the KV): Multiple angles of the product are provided. Integrate THIS EXACT product into the scene as a NATURAL ENVIRONMENTAL PROP — same shape, label, colors, proportions shown in the reference photos. Place it where it would realistically live in the scene context. CRITICAL INTEGRATION RULES: (a) The product must inherit the EXACT lighting direction and color temperature of the scene. (b) Cast a natural contact shadow on the surface it rests on. (c) Feel PHOTOGRAPHED as part of the scene, NOT digitally composited. (d) Size: realistically proportional to its real-world size. Label legible and facing camera. Person remains the clear main subject.\n`
        : '';
    // Los logos YA NO se le piden a Gemini "reproducidos pixel-faithfully" — pedirle a un modelo
    // de difusión que copie un logo exacto es la misma alucinación que ya vimos con texto (inventa
    // su propia versión parecida). Ahora el logo real SIEMPRE se compone después con precisión de
    // píxel (ver compositeManualOverlays) — acá solo se le pide a Gemini que deje el espacio limpio.
    const logoBlock = hasLogoImage
        ? `\nBRAND LOGO: Do NOT draw, redraw, reinterpret, or invent the brand logo/wordmark yourself anywhere in this image — leave its designated area (see user-marked positions below) clean and empty. The real official logo file will be composited on top afterward with pixel-perfect precision.\n`
        : '';
    const conglomerateLogoBlock = hasConglomerateLogo
        ? `\nCONGLOMERATE/PARENT COMPANY LOGO: Do NOT draw, redraw, or invent this logo yourself — leave its designated area (see user-marked positions below) clean and empty. The real official logo file will be composited on top afterward with pixel-perfect precision.\n`
        : '';

    // ─── Marcas custom / aprendidas: SOLO su identidad, CERO elementos de Tarrito ──
    const isTarrito = profileId === 'tarrito_rojo';
    if (!isTarrito) {
        const sceneAllText = (sceneDesc + ' ' + headline + ' ' + body + ' ' + drivers + ' ' + audienciaRef).toLowerCase();
        // productCategory from KV analysis takes priority — text detection as fallback
        const prodIsTV     = productCategory === 'tv'      || productCategory === 'monitor' || (!productCategory && /\btv\b|television|oled|qled|pantalla|televisor/.test(sceneAllText));
        const prodIsFridge = productCategory === 'nevera'  || (!productCategory && /nevera|refrigerador|fridge|refriger/.test(sceneAllText));
        const prodIsWasher = productCategory === 'lavadora'|| (!productCategory && /lavadora|washer|washing/.test(sceneAllText));
        const prodIsPhone  = productCategory === 'phone'   || (!productCategory && /celular|smartphone|tel[eé]fono|phone/.test(sceneAllText));
        const prodIsLaptop = productCategory === 'laptop'  || (!productCategory && /laptop|port[aá]til|portatil|notebook/.test(sceneAllText));
        const prodIsAudio  = productCategory === 'audio'   || (!productCategory && /soundbar|parlante|altavoz|bocina|barra de sonido/.test(sceneAllText));
        const prodIsAire   = productCategory === 'aire'    || (!productCategory && /aire acondicionado|purificador|ventilador inteligente/.test(sceneAllText));
        const prodIsMoto   = productCategory === 'moto'    || productCategory === 'auto'   || (!productCategory && /\bmoto\b|motocicleta|motorcycle|ns400|pulsar|bajaj/.test(sceneAllText));

        // Moto: detect if scene involves riding/movement vs stopped interaction
        const _motoRiding  = prodIsMoto && /velocidad|curva|carretera|autopista|circuito|compite|compitiendo|aceler|conduciendo|en movimiento|lean|drift|speed/.test(sceneAllText);
        const _motoStopped = prodIsMoto && !_motoRiding;
        // Moto de trabajo/domicilios (BOXER y similares) vs. moto deportiva/adrenalina (Pulsar y
        // similares) son territorios creativos OPUESTOS — un domiciliario no compite en curvas de
        // montaña. Detectado desde audiencia/drivers/escena reales, nunca asumido por defecto.
        const _isMotoWork = prodIsMoto && /domiciliari|mensajer|repartidor|picap|delivery|domicilio|conductor de plataforma|carga(?!dor)|encomienda/.test(sceneAllText);

        const interactionRule = prodIsMoto
            ? [
                'INTERACCIÓN PERSONAJE-MOTO — OBLIGATORIO:',
                '• La moto es el HÉROE VISUAL — grande, dominante, en primer plano o protagonista de la escena. Usar SIEMPRE la moto real de las fotos de producto/KV provistas, nunca otro modelo.',
                '• La moto debe verse COMPLETA o casi completa — nunca cortada torpemente',
                _motoRiding
                    ? '• ESCENA DE CONDUCCIÓN: rider SOBRE la moto en movimiento — casco integral puesto, guantes, chaqueta, gear completo. CERO cara descubierta mientras conduce.'
                    : '• ESCENA DE PARADA: persona junto a la moto detenida — puede mostrar la cara, sin casco, pero con chaqueta/gear de moto puesto. Interacción natural con la moto (mano en manillar, apoyado, revisando).',
                _isMotoWork
                    ? '• Mood: ENFOCADO, DECIDIDO, auténtico de quien trabaja duro — NUNCA adrenalina de competencia ni sonrisa de catálogo.'
                    : '• Mood: INTENSO, CONCENTRADO, CONFIADO, adrenalina — NUNCA sonrisa casual o pose de catálogo. Expresión auténtica de quien ama las motos.',
                _isMotoWork
                    ? '• Fondo: entorno urbano real de trabajo — calle, tráfico, punto de entrega, negocio local. NUNCA carretera de montaña ni circuito de competencia, NUNCA estudio blanco.'
                    : '• Fondo: entorno real que potencie la moto — carretera, montaña, curva, urbano nocturno, túnel con motion blur. NUNCA estudio blanco ni fondo plano.',
                '• PROHIBIDO: persona posando sonriendo como en una foto de catálogo, moto al fondo pequeña, rider sin gear.',
              ].join('\n')
            : prodIsTV
            ? [
                'INTERACCIÓN PERSONAJE-PRODUCTO — OBLIGATORIO:',
                '• TODOS LOS PERSONAJES orientados HACIA el TV — CERO espaldas a la pantalla, CERO perfiles ignorando el TV',
                '• Cuerpos sentados/girados HACIA la pantalla — esta es la regla más crítica de composición',
                '• Mirada: a la pantalla (emoción), a otro personaje (compartir), o a cámara (invitar) — NUNCA away from TV',
                '• Pantalla TV: contenido VIVIDO (partido de fútbol, película, juego) — NUNCA negra ni gris',
                '• TV es el héroe visual del encuadre — marca en bisel legible, TV grande y prominente',
                '• Expresión = reacción emocional REAL al contenido de la pantalla',
                /estadio|f[uú]tbol|futbol|partido|gol|selecci[oó]n|colombia|mundial/.test(sceneAllText)
                    ? '• CONTEXTO FÚTBOL: personas en sala familiar/sofá, TV mostrando partido de fútbol, camisetas Colombia amarilla, emoción colectiva de gol — puños arriba, abrazos espontáneos, snacks en mesa'
                    : /gam(er|ing)|videojuego|consola|xbox|playstation/.test(sceneAllText)
                    ? '• CONTEXTO GAMING: persona en sofá frente a TV con consola, control en manos, pantalla mostrando juego, sala familiar — CERO silla gamer, CERO PC, CERO triple monitor'
                    : '• Grupo o persona en sala familiar real con TV grande — ambiente auténtico latinoamericano',
                '• PROHIBIDO: espaldas al TV, TV flotante, pantalla negra, personaje ignorando el producto',
              ].join('\n')
            : prodIsFridge
            ? [
                'INTERACCIÓN PERSONAJE-PRODUCTO — OBLIGATORIO:',
                '• Persona USANDO activamente la nevera: abriendo puerta, sacando alimentos, organizando',
                '• Manos en la manija o dentro de la nevera — contacto físico visible',
                '• Si puerta abierta: interior organizado, fresco, bien iluminado',
                '• PROHIBIDO: parada al lado de nevera cerrada sin tocarla',
              ].join('\n')
            : prodIsWasher
            ? [
                'INTERACCIÓN PERSONAJE-PRODUCTO — OBLIGATORIO:',
                '• Persona cargando, sacando ropa limpia, o revisando resultados',
                '• Contacto físico visible con la lavadora',
                '• PROHIBIDO: persona al lado sin interactuar',
              ].join('\n')
            : prodIsPhone
            ? [
                'INTERACCIÓN PERSONAJE-PRODUCTO — OBLIGATORIO:',
                '• Persona USANDO el teléfono: viendo pantalla, escribiendo, reaccionando',
                '• Pantalla muestra contenido relevante — NUNCA negro o en blanco',
              ].join('\n')
            : prodIsLaptop
            ? [
                'CHARACTER-PRODUCT INTERACTION — MANDATORY:',
                '• Person USING the laptop: typing, reacting to screen, creating content, or gaming',
                '• Screen must show relevant content (work, creative app, game) — NEVER black/blank',
                '• Hands naturally on keyboard or touchpad — visible and engaged',
                '• FORBIDDEN: laptop closed, person standing beside it without using it',
              ].join('\n')
            : prodIsAudio
            ? [
                'CHARACTER-PRODUCT INTERACTION — MANDATORY:',
                '• Person EXPERIENCING the sound: eyes partially closed, subtle head movement, expression of immersion',
                '• Soundbar/speaker visible and prominent — integrated naturally in the living space',
                '• Body language: relaxed, absorbed, transported by the audio experience',
                '• FORBIDDEN: person ignoring the speaker, generic sitting pose with no audio reaction',
              ].join('\n')
            : prodIsAire
            ? [
                'CHARACTER-PRODUCT INTERACTION — MANDATORY:',
                '• Person EXPERIENCING comfort: taking a deep breath, relaxed posture, comfortable expression',
                '• AC/purifier visible and prominent in the space',
                '• Environment: clean, fresh, comfortable — show the effect of the appliance',
                '• FORBIDDEN: person with no visible connection to the air quality or comfort',
              ].join('\n')
            : 'INTERACCIÓN PERSONAJE-PRODUCTO:\n• Persona usa, sostiene o reacciona naturalmente al producto';

        const productInstruction = hasProductImage
            ? [
                'ANTI-ALUCINACIÓN DE PRODUCTO — CRÍTICO:',
                '• Fotos de referencia muestran EXACTAMENTE cómo luce el producto — replicar con 100% fidelidad',
                '• Forma, dimensiones, color, etiqueta, diseño de bisel, soporte, acabado — cero desviación',
                prodIsTV ? '• TV: grosor exacto de bisel, soporte exacto, logo en bisel, pantalla con contenido — NO rectángulo negro' : '',
                prodIsFridge ? '• Nevera: configuración exacta de puertas, manijas, panel de marca' : '',
                '• Producto FOTOGRAFIADO en escena — misma dirección de luz, sombra de contacto en superficie',
              ].filter(Boolean).join('\n')
            : [
                'PRECISIÓN DE PRODUCTO:',
                '• Inferir apariencia SOLO del KV — NO inventar ni generalizar',
                prodIsTV ? '• TV EXACTO del KV: bisel correcto, soporte correcto, logo en bisel, pantalla con contenido' : '',
                prodIsFridge ? '• Nevera EXACTA del KV: estilo de puerta, manijas, panel de marca' : '',
                '• Nunca mostrar versión genérica o placeholder del producto',
              ].filter(Boolean).join('\n');

        // ─── Parse audience to enforce gender + age ───────────────────────────────
        const _audText = (audienciaRef || '').toLowerCase();
        const _onlyMale   = /\bhombres?\b/.test(_audText) && !/\bmujeres?\b/.test(_audText);
        const _onlyFemale = /\bmujeres?\b/.test(_audText) && !/\bhombres?\b/.test(_audText);
        const _mixed      = !_onlyMale && !_onlyFemale;

        // Extract age range from audienciaRef (e.g. "22-38 años" → "22-38")
        const _ageMatch = _audText.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);
        const _ageRange = _ageMatch ? `${_ageMatch[1]}–${_ageMatch[2]} años` : '';

        // Gender label for options
        const _gMale   = (age = _ageRange) => `Hombre latinoamericano${age ? ' ' + age : ''}`;
        const _gFemale = (age = _ageRange) => `Mujer latinoamericana${age ? ' ' + age : ''}`;
        const _gPerson = (age = _ageRange) => _onlyMale ? _gMale(age) : _onlyFemale ? _gFemale(age) : `Persona latinoamericana${age ? ' ' + age : ''}`;

        // Mandatory audience rule — placed BEFORE character options
        const audienceRule = audienciaRef
            ? [
                '⛔ AUDIENCE MANDATE — NON-NEGOTIABLE:',
                `Target: ${audienciaRef}`,
                _onlyMale   ? '⛔ ALL characters MUST be MALE. ZERO women in the image. No exceptions.' : '',
                _onlyFemale ? '⛔ ALL characters MUST be FEMALE. ZERO men in the image. No exceptions.' : '',
                _ageRange   ? `⛔ Character age MUST be within ${_ageRange}. No children, no elderly outside this range.` : '',
                '⛔ This overrides ALL other creative options below. Gender and age are fixed by the brief.',
              ].filter(Boolean).join('\n')
            : '';

        // ─── Character options — filtered by audience gender ──────────────────────
        const _sc = (sceneDesc + ' ' + headline + ' ' + body + ' ' + audienciaRef + ' ' + drivers).toLowerCase();
        const _isSoccer2  = /estadio|f[uú]tbol|futbol|partido|gol|selecci[oó]n|tribuna|cancha/.test(_sc);
        const _isGaming2  = /gam(er|ing)|videojuego|gaming|consola|xbox|playstation|nintendo/.test(_sc);
        const _isCinema2  = /pel[ií]cula|cine|serie|streaming|netflix|noche de/.test(_sc);
        const _isFam2     = /familia|ni[ñn]o|hijo|hija|pap[aá]|mam[aá]|padre|madre|hogar/.test(_sc);
        const _isCooking2 = /cocina|receta|comida|sabor|gastro|chef|ingrediente/.test(_sc);
        const _isSport2   = /deporte|fitness|gym|atleta|entrenamiento|ejercicio|correr/.test(_sc);
        const _isPro2b    = /profesional|ejecutiv|trabajo|oficina|negocio|empresa/.test(_sc);

        const _activity = prodIsTV && _isSoccer2
            ? 'viendo el partido de fútbol con pasión desbordante'
            : prodIsTV && _isGaming2
            ? 'jugando videojuegos con concentración total y reacción emocional intensa'
            : prodIsTV && _isCinema2
            ? 'disfrutando una película o serie en noche acogedora en casa'
            : prodIsTV
            ? 'experimentando la calidad de imagen con asombro genuino'
            : prodIsFridge
            ? 'usando la nevera, disfrutando alimentos frescos bien organizados'
            : prodIsWasher
            ? 'recogiendo ropa limpia y fresca, satisfacción visible'
            : prodIsPhone
            ? 'descubriendo las posibilidades del teléfono, sorpresa positiva real'
            : prodIsLaptop
            ? 'trabajando, creando contenido o haciendo gaming en el laptop — pantalla mostrando trabajo real'
            : prodIsAudio
            ? 'escuchando música o viendo una película con sonido inmersivo — expresión de absorción total en el audio'
            : prodIsAire
            ? 'respirando aire fresco y sintiéndose cómodo/a en su espacio — satisfacción visible de bienestar'
            : 'disfrutando el producto en su momento ideal del día';

        // ─── Moto: override all character options with motorcycle-specific ones ────
        if (prodIsMoto) {
            const _motoAge  = _ageRange || '22–38 años';
            const _motoGear = _motoRiding
                ? 'casco integral, guantes de moto, chaqueta técnica, botas — gear completo'
                : 'chaqueta técnica de moto, sin casco, expresión intensa y confiada';
            const _motoMood = _isMotoWork
                ? 'mirada enfocada y decidida, actitud de quien trabaja duro y conoce bien su oficio — auténtico, sin pose de catálogo.'
                : 'mirada intensa y concentrada — NO sonriendo, NO pose de catálogo. Expresión de quien vive para las motos.';

            // Dos menús de escena por completo distintos — moto de trabajo/domicilios (BOXER y
            // similares: calle urbana, carga, jornada laboral) vs. moto deportiva/adrenalina
            // (carretera de montaña, competencia, curvas) — nunca mezclados ni asumidos por
            // defecto, elegidos según _isMotoWork detectado de audiencia/drivers/escena reales.
            const _moA = _isMotoWork
                ? (_motoRiding
                    ? `OPTION A — ${_gPerson(_motoAge)} conduciendo la moto por una calle urbana durante su jornada de trabajo, bolso o caja de domicilios en la espalda o en la parrilla trasera, ${_motoGear}, tráfico/ciudad de fondo con motion blur, ${_motoMood}`
                    : `OPTION A — ${_gPerson(_motoAge)} junto a la moto detenida en un punto de entrega urbano, bolso o caja de domicilios visible, entregando o recibiendo un pedido, ${_motoGear}, AMBAS PIERNAS visibles apoyadas en los estribos, ${_motoMood}`)
                : (_motoRiding
                    ? `OPTION A — ${_gPerson(_motoAge)} solo sobre la moto en movimiento, ${_motoGear}, lean angle agresivo en curva, fondo borroso por velocidad (motion blur), ${_motoMood}`
                    : `OPTION A — ${_gPerson(_motoAge)} sentado sobre la moto detenida en mirador de montaña o curva de carretera, ${_motoGear}, cuerpo inclinado hacia adelante con postura natural de rider, manos en el manillar, AMBAS PIERNAS visibles apoyadas en los estribos, ${_motoMood}`);

            const _moB = _isMotoWork
                ? (_motoRiding
                    ? `OPTION B — ${_gPerson(_motoAge)} circulando entre el tráfico de una avenida concurrida, enfocado en llegar a tiempo, ${_motoGear}, ciudad de fondo, motion blur, ${_motoMood}`
                    : `OPTION B — ${_gPerson(_motoAge)} sentado sobre la moto detenida afuera de un negocio/restaurante local recogiendo un pedido, ${_motoGear}, postura de trabajo confiada, ${_motoMood}`)
                : (_motoRiding
                    ? `OPTION B — Dos hombres ${_motoAge} sobre sus motos compitiendo en carretera vacía de montaña, ambos con ${_motoGear}, motos en paralelo a alta velocidad, perspectiva lateral dramática, motion blur en el fondo`
                    : `OPTION B — ${_gPerson(_motoAge)} sentado sobre la moto detenida en carretera de montaña al atardecer, ${_motoGear}, casco colgado del manillar, postura relajada pero confiada, ${_motoMood}`);

            const _moC = _isMotoWork
                ? `OPTION C — ${_gPerson(_motoAge)} cargando o acomodando el bolso/caja de domicilios sobre la moto al inicio del turno${_motoRiding ? ', luego arrancando hacia la calle' : ', frente a su casa o punto de partida'}, ${_motoGear}, ${_motoMood}`
                : `OPTION C — Tres hombres ${_motoAge} con sus motos en grupo${_motoRiding ? ' en formación a alta velocidad, carretera sinuosa, todos con ' + _motoGear : ' detenidos en un punto panorámico de montaña, ' + _motoGear + ', actitud de camaradería entre riders'}, ${_motoMood}`;

            const _moD = _isMotoWork
                ? (_motoRiding
                    ? `OPTION D — ${_gPerson(_motoAge)} acelerando desde un semáforo en zona urbana nocturna en pleno turno de trabajo, ${_motoGear}, luz de la moto iluminando el asfalto húmedo, ciudad de fondo desenfocada, ${_motoMood}`
                    : `OPTION D — ${_gPerson(_motoAge)} revisando o alistando la moto en garaje o taller propio antes de empezar el turno, ${_motoGear}, agachado revisando la moto con orgullo de propietario, luz lateral dramática, ${_motoMood}`)
                : (_motoRiding
                    ? `OPTION D — ${_gPerson(_motoAge)} sobre la moto en aceleración desde semáforo urbano nocturno, ${_motoGear}, luz de la moto iluminando el asfalto húmedo, ciudad de fondo desenfocada, ${_motoMood}`
                    : `OPTION D — ${_gPerson(_motoAge)} inspeccionando la moto en garaje o taller propio, ${_motoGear}, agachado revisando la moto con orgullo de propietario, luz lateral dramática, ${_motoMood}`);

            const _moE = _isMotoWork
                ? (_motoRiding
                    ? `OPTION E — POV (punto de vista del domiciliario/mensajero) sobre la moto — manos con guantes en el manillar, bolso de domicilios visible en el espejo o parrilla, calle urbana extendiéndose al frente, perspectiva inmersiva de primera persona`
                    : `OPTION E — ${_gPerson(_motoAge)} apoyado en la moto en zona urbana o comercial, bolso de domicilios al hombro, postura de trabajo relajada pero atenta, ciudad en el fondo, luz natural de día, ${_motoMood}`)
                : (_motoRiding
                    ? `OPTION E — POV (punto de vista del rider) sobre la moto — manos con guantes en el manillar, tablero de instrumentos visible, carretera sinuosa de montaña extendiéndose al frente, perspectiva inmersiva de primera persona`
                    : `OPTION E — ${_gPerson(_motoAge)} apoyado en la moto en zona urbana industrial o bajo un puente al atardecer, ${_motoGear}, postura relajada y dominante, ciudad en el fondo, luz dramática lateral, ${_motoMood}`);

            const characterBlock = [
                audienceRule,
                '',
                _isMotoWork
                    ? 'CHARACTER OPTIONS — ALL specifically designed for a WORK/DELIVERY-oriented motorcycle brand (urban, utilitarian, workday context — NOT sport/racing). Choose the most visually compelling:'
                    : 'CHARACTER OPTIONS — ALL specifically designed for motorcycle brand. Choose the most visually compelling:',
                _moA,
                _moB,
                _moC,
                _moD,
                _moE,
                `SELECTION RULE: ${_motoRiding ? 'Scene involves riding — helmet and gear MANDATORY on all riders.' : 'Scene is a stop/interaction — face visible, gear on, no helmet required.'} ALL characters adults 18+${_ageRange ? ', ' + _ageRange : ''}. ${_onlyMale ? 'MALE ONLY — ZERO women.' : _onlyFemale ? 'FEMALE ONLY — ZERO men.' : ''} Authentic Latin American photorealistic. ZERO stock-photo smiling poses.`,
            ].filter(Boolean).join('\n');

            // Jump straight to the rest of the prompt using moto characterBlock
            const tz   = parsedIdentity?.textZones  || {};
            const typo = parsedIdentity?.typography || {};
            const copyStrings = [
                headline        ? `• HEADLINE: "${headline}"` : '',
                subhead?.trim() ? `• SUBHEAD: "${subhead}"`   : '',
                hasBadge        ? `• CHIP/BADGE: "${vitamina_chip}"` : '',
                body?.trim()    ? `• BODY: "${body}"`         : '',
                cta?.trim()     ? `• CTA: "${cta}"`           : '',
            ].filter(Boolean).join('\n');
            const typoInstruction2 = (field: 'headline'|'subhead'|'body'|'cta'|'chip', label: string): string => {
                const z = tz[field] || {}; const t = typo[field] || {};
                const p: string[] = [];
                if (z.zone && z.zone !== 'none')             p.push(`place in: ${z.zone}`);
                if (z.verticalPercent)                       p.push(`~${z.verticalPercent}% from top`);
                if (z.horizontalAlignment)                   p.push(`${z.horizontalAlignment}-aligned`);
                if (z.maxWidthPercent)                       p.push(`max-width ${z.maxWidthPercent}%`);
                if (t.fontStyle)                             p.push(`style: ${t.fontStyle}`);
                if (t.fontWidth && t.fontWidth !== 'normal') p.push(`width: ${t.fontWidth}`);
                if (t.fontWeight)                            p.push(`weight: ${t.fontWeight}`);
                if (t.case)                                  p.push(`case: ${t.case}`);
                if (t.sizePercentOfFrameHeight)              p.push(`size: ~${t.sizePercentOfFrameHeight}% frame height`);
                if (t.fillType === 'gradient' && t.fillGradient) p.push(`fill: gradient ${t.fillGradient}`);
                else if (t.fillColor)                        p.push(`fill: ${t.fillColor}`);
                if (t.strokeColor)                           p.push(`stroke: ${t.strokeColor}${t.strokeWidthPx ? ' ' + t.strokeWidthPx + 'px' : ''}`);
                if (t.shadowColor)                           p.push(`shadow: ${t.shadowColor} ${t.shadowDirection ?? 135}° ${t.shadowDistancePx ?? 4}px blur ${t.shadowBlurPx ?? 8}px`);
                if (t.bgColor)                               p.push(`button bg: ${t.bgColor}`);
                if (t.buttonShape && t.buttonShape !== 'none') p.push(`shape: ${t.buttonShape}`);
                return p.length ? `  ${label}: ${p.join(' | ')}` : '';
            };
            const typoSystemLines2 = [
                headline        ? typoInstruction2('headline','HEADLINE') : '',
                subhead?.trim() ? typoInstruction2('subhead', 'SUBHEAD')  : '',
                hasBadge        ? typoInstruction2('chip',    'CHIP')     : '',
                body?.trim()    ? typoInstruction2('body',    'BODY')     : '',
                cta?.trim()     ? typoInstruction2('cta',     'CTA')      : '',
            ].filter(Boolean).join('\n');
            const fixedBadges2   = Array.isArray(parsedIdentity?.badges) && parsedIdentity.badges.length
                ? parsedIdentity.badges.map((b: any) => `  • "${b.text}" — ${b.shape||'pill'} bg:${b.bgColor||'?'} text:${b.textColor||'#FFF'} ${b.textWeight||'Bold'} at ${b.position||'top area'}`).join('\n') : '';
            const fixedIconRow2  = parsedIdentity?.iconRow?.present
                ? `  • ICON ROW (${parsedIdentity.iconRow.iconCount} icons) at ${parsedIdentity.iconRow.position}: ${parsedIdentity.iconRow.description} — icon: ${parsedIdentity.iconRow.iconColor}, text: ${parsedIdentity.iconRow.textColor}` : '';
            const fixedDeco2     = parsedIdentity?.decorativeElements && parsedIdentity.decorativeElements !== 'none'
                ? `  • DECORATIVE: ${parsedIdentity.decorativeElements}` : '';
            const fixedSpeed2    = parsedIdentity?.speedLines && parsedIdentity.speedLines !== 'none'
                ? `  • MOTION EFFECTS: ${parsedIdentity.speedLines}` : '';
            const fixedElements2 = [fixedBadges2, fixedIconRow2, fixedDeco2, fixedSpeed2].filter(Boolean).join('\n');
            const productRef2    = hasProductImage ? '\n• IMÁGENES 2+ — Fotos producto: forma exacta, colores, etiqueta desde todos los ángulos' : '';
            const audienceCtx2   = [audienciaRef ? 'TARGET: ' + audienciaRef : '', drivers ? 'DRIVERS: ' + drivers : ''].filter(Boolean).join(' | ');
            return [
                `TASK: Generate a production-ready advertising image at ${fmt.width}x${fmt.height}px for ${FORMATS[fmtId]?.platform || fmtId}.`,
                '',
                'REFERENCES:',
                '• IMAGEN 1 — KV de marca: paleta, tipografía, posición de logo, sistema gráfico — sigue este template exactamente' + productRef2,
                'KV USAGE: Use KV ONLY for brand identity — DO NOT copy the person/face/pose from the KV.',
                '',
                audienceCtx2 ? audienceCtx2 : '',
                '',
                characterBlock,
                '',
                'ESCENA: ' + (function() { var _repairRx = /reparand|arreglando|arregl[oó]|mantenimiento|desmontando|desarm|taller t[eé]cnico/i; if (_repairRx.test(sceneDesc)) { return _motoRiding ? 'Pulsar NS400Z en carretera — rider en movimiento a alta velocidad, urbano nocturno o montaña sinuosa. Moto nueva, impecable, dominante.' : 'Rider junto a su Pulsar NS400Z nueva reluciente en mirador de montaña o zona urbana — moto impecable, nueva, protagonista de la escena.'; } return sceneDesc; })(),
                '',
                interactionRule,
                '',
                productInstruction,
                '',
                'BRAND IDENTITY SYSTEM:',
                identityBlock,
                '',
                'FORMAT — ' + fmt.width + 'x' + fmt.height + 'px:',
                formatGuide,
                '',
                buildCopyPlacementMap(copy, parsedIdentity, true),
                '',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                'STEP C — FIXED BRAND ELEMENTS (always present)',
                '⚠️ BRAND TEMPLATE — appears in EVERY execution regardless of brief',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                fixedElements2 || '  Replicate all fixed brand marks from KV exactly.',
                '',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                'ABSOLUTE RULES',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                '⛔ NEVER render "HEADLINE:", "STEP A", "STEP B" or any instruction label as visible text.',
                '⛔ ZERO invented colored bands, bars, or graphic elements not present in the KV reference.',
                '⛔ BRAND LOGO appears EXACTLY ONCE — single placement per Step C position. NEVER duplicate the logo anywhere in the image.',
                '⛔ Typography treatment from Step B is MANDATORY.',
                '⛔ All fixed brand elements from Step C MUST appear.',
                '⛔ ' + (_motoRiding ? 'Rider MUST wear full helmet + gear — ZERO bare face while riding.' : 'Rider NOT on moving moto — face visible, jacket/gear on, no helmet required.'),
                '⛔ Moto mood: INTENSE, FOCUSED, CONFIDENT — ZERO stiff/rigid poses. Character must feel naturally connected to the moto.',
                '⛔ HUMAN ANATOMY: Character MUST have BOTH legs fully visible and complete. ZERO missing limbs, ZERO cropped lower body. 1 head, 2 arms, 2 legs, 2 feet — all anatomically correct.',
                '⛔ FULL CANVAS: Fill the ENTIRE ' + fmt.width + 'x' + fmt.height + 'px canvas — ZERO empty dark zones or unused space on any side.',
                '⛔ CTA color: ONLY colors from the KV — NEVER red, blue or any invented color for CTA text.',
                '⛔ ZERO text containers: no boxes, ovals or outlines around body text — text overlays directly on photo.',
                '⛔ Zero AI artifacts. Photorealistic quality.',
                '⛔ Output: exactly ' + fmt.width + 'x' + fmt.height + 'px.',
                observacionesBlock,
            ].filter(s => s !== '').join('\n');
        }

        const _optA = _isSoccer2
            ? `OPTION A — ${_gMale()} en camiseta de Colombia amarilla, solo en sala familiar, gritando un gol con puño en alto frente a TV grande — sala real, sofá, luz cálida`
            : _isGaming2
            ? `OPTION A — ${_onlyFemale ? _gFemale() : _gMale()} sentado/a en sofá familiar frente a TV grande con consola, headset, pantalla del juego reflejada — CERO silla gamer, CERO PC`
            : _isFam2 && !_onlyMale
            ? `OPTION A — ${_gFemale()} 33–42 años con hija adulta 22–26 años, ${_activity}, complicidad entre adultas, luz cálida de tarde`
            : `OPTION A — ${_gPerson()} solo/a, ${_activity}, expresión de disfrute genuino y sorpresa`;

        const _optB = _isSoccer2
            ? _onlyMale
                ? `OPTION B — Dos amigos hombres ${_ageRange || '24–36 años'} en camisetas de equipos distintos, reaccionando a jugada clave frente a TV grande, snacks en mesa`
                : `OPTION B — Grupo de 4 amigos adultos (${_mixed ? '2 hombres + 2 mujeres' : _onlyMale ? '4 hombres' : '4 mujeres'}) ${_ageRange || '24–34 años'} en sala familiar, reaccionando al partido, TV grande`
            : _isGaming2
            ? `OPTION B — Dos amigos ${_onlyMale ? 'hombres' : _onlyFemale ? 'mujeres' : '(hombre + mujer)'} ${_ageRange || '22–30 años'} en sofá compartiendo control de consola frente a TV grande — sala iluminada`
            : `OPTION B — Grupo de 3 ${_onlyMale ? 'hombres' : _onlyFemale ? 'mujeres' : 'adultos (mix)'} ${_ageRange || '24–32 años'} latinoamericanos, ${_activity}, energía social real`;

        const _optC = _isSoccer2
            ? `OPTION C — Dos ${_onlyMale ? 'hermanos hombres' : _onlyFemale ? 'hermanas mujeres' : 'hermanos'} ${_ageRange || '26–38 años'} en sofá viendo el partido, discutiendo táctica con pasión, TV grande`
            : _isGaming2
            ? `OPTION C — ${_gMale()} recostado en sofá familiar, control de consola en manos, TV grande mostrando el juego, cara iluminada por pantalla`
            : _isPro2b
            ? `OPTION C — ${_gPerson()} profesional llegando a casa, ${_activity}, satisfacción de fin de jornada`
            : `OPTION C — ${_gPerson()} 36–46 años con ${_onlyMale ? 'hijo adulto 20–28 años' : _onlyFemale ? 'hija adulta 20–28 años' : 'hijo/a adulto/a 20–28 años'}, ${_activity}, complicidad intergeneracional`;

        const _optD = _isSoccer2
            ? _onlyMale
                ? `OPTION D — ${_gMale()} al borde del sofá, tensión máxima viendo el partido, puños cerrados en éxtasis de gol, TV grande en pared`
                : `OPTION D — Pareja ${_ageRange || '28–40 años'}: ${_onlyFemale ? 'ella señala la TV emocionada' : 'ella señala la TV emocionada, él de pie celebrando'} — sala familiar real`
            : _isGaming2
            ? _onlyMale
                ? `OPTION D — ${_gMale()} solo en sala familiar, inmersión total jugando en TV grande con consola, expresión de concentración intensa`
                : `OPTION D — Pareja ${_ageRange || '26–36 años'} en sala: ${_onlyFemale ? 'ella juega con consola, amiga mira la pantalla' : 'él juega con consola, ella mira con copa de vino'}`
            : _isCooking2 && _mixed
            ? `OPTION D — Pareja ${_ageRange || '28–38 años'} cocinando juntos, ${_activity}, complicidad y risa genuina`
            : `OPTION D — ${_gPerson()} en momento íntimo personal, ${_activity}, satisfacción y orgullo genuino`;

        const _optE = _isSoccer2
            ? `OPTION E — ${_gPerson()} solo/a ${_ageRange || '34–48 años'} en sala familiar casual, tensión máxima al borde del sofá, manos en la cabeza o puño en éxtasis de gol`
            : _isGaming2
            ? `OPTION E — Tres ${_onlyMale ? 'amigos hombres' : _onlyFemale ? 'amigas mujeres' : 'amigos'} ${_ageRange || '24–34 años'} turnándose el control de consola, TV grande, ambiente de noche en casa`
            : _isSport2
            ? `OPTION E — ${_gPerson()} atleta ${_ageRange || '24–34 años'}, cuerpo real no de catálogo, ${_activity}, esfuerzo y logro visibles`
            : `OPTION E — ${_gPerson()} solo/a ${_ageRange || '30–46 años'} (perfil diferente al del KV), ${_activity}, satisfacción y orgullo genuino`;

        const characterBlock = [
            audienceRule,
            '',
            'CHARACTER OPTIONS — Choose ONE. All options already comply with the audience mandate above:',
            _optA,
            _optB,
            _optC,
            _optD,
            _optE,
            `SELECTION RULE: context drives choice — fútbol brief → soccer option, gaming brief → gaming option. ALL characters adults 18+${_ageRange ? ', within ' + _ageRange : ''}. ${_onlyMale ? 'MALE ONLY.' : _onlyFemale ? 'FEMALE ONLY.' : ''} Authentic Latin American photorealistic appearance, ZERO stock aesthetic.`,
        ].filter(Boolean).join('\n');

        const tz   = parsedIdentity?.textZones  || {};
        const typo = parsedIdentity?.typography || {};

        // ── STEP A: clean copy strings — ONLY what goes in the image ──────────────
        const copyStrings = [
            headline        ? `• HEADLINE: "${headline}"` : '',
            subhead?.trim() ? `• SUBHEAD: "${subhead}"`   : '',
            hasBadge        ? `• CHIP/BADGE: "${vitamina_chip}"` : '',
            body?.trim()    ? `• BODY: "${body}"`         : '',
            cta?.trim()     ? `• CTA: "${cta}"`           : '',
        ].filter(Boolean).join('\n');

        // ── STEP B: typography system — HOW to render each string ─────────────────
        // These are DESIGN INSTRUCTIONS, never visible text in the image.
        const typoInstruction = (field: 'headline'|'subhead'|'body'|'cta'|'chip', label: string): string => {
            const z = tz[field]   || {};
            const t = typo[field] || {};
            const parts: string[] = [];
            if (z.zone && z.zone !== 'none')              parts.push(`place in: ${z.zone}`);
            if (z.verticalPercent)                        parts.push(`~${z.verticalPercent}% from top`);
            if (z.horizontalAlignment)                    parts.push(`${z.horizontalAlignment}-aligned`);
            if (z.maxWidthPercent)                        parts.push(`max-width ${z.maxWidthPercent}% of frame`);
            if (t.fontStyle)                              parts.push(`style: ${t.fontStyle}`);
            if (t.fontWidth && t.fontWidth !== 'normal')  parts.push(`width: ${t.fontWidth}`);
            if (t.fontWeight)                             parts.push(`weight: ${t.fontWeight}`);
            if (t.case)                                   parts.push(`case: ${t.case}`);
            if (t.letterSpacing && t.letterSpacing !== 'normal') parts.push(`tracking: ${t.letterSpacing}`);
            if (t.sizePercentOfFrameHeight)               parts.push(`size: ~${t.sizePercentOfFrameHeight}% of frame height`);
            if (t.fillType === 'gradient' && t.fillGradient) parts.push(`fill: gradient ${t.fillGradient}`);
            else if (t.fillColor)                         parts.push(`fill color: ${t.fillColor}`);
            if (t.strokeColor)                            parts.push(`stroke: ${t.strokeColor}${t.strokeWidthPx ? ' ' + t.strokeWidthPx + 'px' : ''}`);
            if (t.outlineColor)                           parts.push(`outline: ${t.outlineColor}`);
            if (t.shadowColor)                            parts.push(`shadow: ${t.shadowColor} dir:${t.shadowDirection ?? 135}° dist:${t.shadowDistancePx ?? 4}px blur:${t.shadowBlurPx ?? 8}px`);
            if (t.glowColor)                              parts.push(`glow: ${t.glowColor} ${t.glowRadiusPx ?? 0}px`);
            if (t.bgColor)                                parts.push(`button bg: ${t.bgColor}`);
            if (t.buttonShape && t.buttonShape !== 'none') parts.push(`button shape: ${t.buttonShape}`);
            if (t.notes)                                  parts.push(`note: ${t.notes}`);
            return parts.length ? `  ${label}: ${parts.join(' | ')}` : '';
        };

        const typoSystemLines = [
            headline        ? typoInstruction('headline', 'HEADLINE') : '',
            subhead?.trim() ? typoInstruction('subhead',  'SUBHEAD')  : '',
            hasBadge        ? typoInstruction('chip',     'CHIP')     : '',
            body?.trim()    ? typoInstruction('body',     'BODY')     : '',
            cta?.trim()     ? typoInstruction('cta',      'CTA')      : '',
        ].filter(Boolean).join('\n');

        // ── STEP C: fixed brand elements — always present regardless of brief ─────
        const fixedBadges = Array.isArray(parsedIdentity?.badges) && parsedIdentity.badges.length
            ? parsedIdentity.badges.map((b: any) =>
                `  • "${b.text}" — ${b.shape || 'pill'} bg:${b.bgColor || '?'} text:${b.textColor || '#FFF'} ${b.textWeight || 'Bold'} ${b.textCase || 'ALL_CAPS'} at ${b.position || 'top area'}`
              ).join('\n')
            : '';

        const fixedIconRow = parsedIdentity?.iconRow?.present
            ? `  • ICON ROW (${parsedIdentity.iconRow.iconCount} icons) at ${parsedIdentity.iconRow.position}: ${parsedIdentity.iconRow.description} — icon color: ${parsedIdentity.iconRow.iconColor}, text color: ${parsedIdentity.iconRow.textColor}, bg: ${parsedIdentity.iconRow.bgColor || 'transparent'}`
            : '';

        const fixedDeco = parsedIdentity?.decorativeElements && parsedIdentity.decorativeElements !== 'none'
            ? `  • DECORATIVE EFFECTS: ${parsedIdentity.decorativeElements}` : '';

        const fixedSpeed = parsedIdentity?.speedLines && parsedIdentity.speedLines !== 'none'
            ? `  • MOTION/SPEED EFFECTS: ${parsedIdentity.speedLines}` : '';

        const fixedElements = [fixedBadges, fixedIconRow, fixedDeco, fixedSpeed].filter(Boolean).join('\n');

        const productRef = hasProductImage ? '\n• IMÁGENES 2+ — Fotos de producto: forma exacta, colores, etiqueta, acabado desde todos los ángulos' : '';

        const audienceCtx = [
            audienciaRef ? 'TARGET AUDIENCE PROFILE: ' + audienciaRef : '',
            drivers ? 'KEY PURCHASE DRIVERS (what matters most to them): ' + drivers : '',
        ].filter(Boolean).join('\n');

        return [
            'TASK: Generate a production-ready advertising image at ' + fmt.width + 'x' + fmt.height + 'px for ' + (FORMATS[fmtId]?.platform || fmtId) + '.',
            '',
            'REFERENCES:',
            '• IMAGEN 1 — KV de marca: referencia visual de marca.' + productRef,
            '',
            'KV USAGE — SPLIT RULE:',
            '  ✅ REPLICA del KV: logo (forma exacta, colores, tamaño, posición), bandas de marca (hex exacto, proporciones), badges/sellos (forma, colores, texto), efectos decorativos propios de la marca, paleta de colores exacta, peso y color tipográfico de cada elemento — Y TAMBIÉN el sistema gráfico de fondo/energía de marca (franjas, motion blur, gradientes, tipo de iluminación general — ver STEP C más abajo). La pieza tiene que sentirse inconfundiblemente de ESTA marca, no un fondo genérico cualquiera.',
            '  ⛔ NO copies del KV: la persona específica que aparece ahí, su pose exacta, ni el encuadre/ángulo de cámara literal — quién es el protagonista (según la audiencia) y la composición puntual de la toma son 100% nuevos en cada pieza, pero SIEMPRE viven dentro del mismo sistema visual de marca de arriba, nunca en un ambiente/escenario distinto al de la marca.',
            '',
            'ESCENA: ' + sceneDesc,
            audienceCtx ? '\n' + audienceCtx : '',
            '',
            characterBlock,
            'FORBIDDEN: copy the person, face, body, pose, or style of any character shown in the KV reference image.',
            '',
            interactionRule,
            '',
            productInstruction,
            '',
            'BRAND IDENTITY SYSTEM (extracted from real KVs):',
            identityBlock,
            '',
            'FORMAT — ' + fmt.width + 'x' + fmt.height + 'px:',
            formatGuide,
            '',
            buildCopyPlacementMap(copy, parsedIdentity, false),
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            'STEP C — FIXED BRAND ELEMENTS (always present, every execution)',
            '⚠️ THESE ELEMENTS ARE PART OF THE BRAND TEMPLATE. They appear in EVERY ad for this brand,',
            'independent of the brief copy above. Render them exactly as described.',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            fixedElements || '  Reproduce from KV: logo (exact shape/colors/size), brand color bands (exact hex/proportions), badges/seals. Scene (background, person, environment) is 100% new — do NOT copy the KV photo.',
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            'ABSOLUTE RULES',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '⛔ NEVER render "HEADLINE:", "SUBHEAD:", "CTA:", "STEP A", "STEP B", "STEP C" or any instruction label as visible text in the image.',
            '⛔ ZERO invented colored bands, bars, or graphic elements not present in the KV reference — do not add blue, red or any colored banner that is not in the KV.',
            '⛔ BRAND LOGO appears EXACTLY ONCE — single placement per the KV. NEVER repeat or duplicate the logo.',
            '⛔ Typography treatment from Step B is MANDATORY — apply font style, color, stroke, shadow exactly.',
            '⛔ ZERO invented copy. ZERO lorem ipsum. ZERO text not in Step A.',
            '⛔ Every fixed element from Step C MUST appear — missing one = wrong generation.',
            '⛔ Photorealistic quality — zero AI artifacts, zero flat design.',
            '⛔ HUMAN ANATOMY: ALL characters MUST have BOTH legs fully visible. ZERO missing limbs, ZERO cropped lower body. Every person: 1 head, 2 arms, 2 legs, 2 feet — complete and correct.',
            '⛔ All people fully in frame — no cropped heads, no cropped legs, no missing body parts.',
            '⛔ FULL CANVAS: Fill the ENTIRE ' + fmt.width + 'x' + fmt.height + 'px canvas — ZERO empty dark zones on any side.',
            '⛔ CTA text color: ONLY colors in the KV — NEVER invent red, blue or any color absent from the KV.',
            '⛔ ZERO text containers: no boxes, ovals, outlines or shapes around body or subhead text.',
            '⛔ Each text element appears EXACTLY ONCE — zero duplicates.',
            '⛔ Output: exactly ' + fmt.width + 'x' + fmt.height + 'px.',
            observacionesBlock,
        ].join('\n');
    }
    return `Creative director instruction — use the reference image as the EXACT visual template with pixel-perfect fidelity. Every reference image provided (KV${hasProductImage ? ', product' : ''}) must be reproduced faithfully — colors, shapes, proportions, and any visible text/branding exactly as shown, never reinvented or approximated.${(hasLogoImage || hasConglomerateLogo) ? ' Logo(s) are the ONE exception: do not draw them yourself at all (see instructions below) — they are composited afterward from the exact file.' : ''}

SCENE: ${sceneDesc}
Person: large and dominant in scene, authentic expression, real-looking.
${productBlock}${logoBlock}${conglomerateLogoBlock}

${identityBlock}

${formatGuide}

${fmt.family === 'billboard' ? `⚠️ BILLBOARD FORMAT — SPECIAL LAYOUT (${fmt.width}×${fmt.height}px wide horizontal):
This image is divided into TWO VERTICAL ZONES — do NOT use the standard "overlaid on photo" layout below.

LEFT ZONE (leftmost ${Math.floor(fmt.width * 0.42)}px — solid red #E30613 background):
  Contains ALL text and the product — from top to bottom:
  • HEADLINE: "${headline}" — white bold, large font, top section of left zone
  • SUBHEAD: "${subhead}" — white, slightly smaller, directly below headline
${hasBadge
? `  • LINE 1: bold yellow "Contiene" + yellow pill badge "${vitamina_chip}"
  • LINE 2: white text "${body}"
  • LINE 3: yellow text "${cta}"`
: `  • LINE 1: white text "${body}"
  • LINE 2: yellow text "${cta}"`}
  • BOTTOM-LEFT CORNER: SOFA product jar ALONE (no glass, no other object beside it)

RIGHT ZONE (rightmost ${Math.floor(fmt.width * 0.58)}px — full lifestyle photo):
  • Real lifestyle photo fills this entire zone top to bottom — NO text overlays of any kind
  • Red-stroke bottle silhouette outline centered on the MAIN adult person
  • FMC seal at bottom-right corner
  • Silhouette interior: max 15% opacity — scene must be clearly visible through it

` : `VISIBLE TEXT — render EXACTLY these strings in this exact layout:
Overlaid on scene photo (top area):
  HEADLINE: "${headline}"
  SUBHEAD: "${subhead}"

Red brand band (bottom) — exact layout top-to-bottom:
${hasBadge
? `  LINE 1 (same line, no break): bold yellow text "Contiene" → immediately followed by yellow pill badge "${vitamina_chip}"
  LINE 2: white text "${body}" — continuation sentence below the pill line
  LINE 3: yellow closing text "${cta}"`
: `  LINE 1: white text "${body}"
  LINE 2: yellow closing text "${cta}"`}
  BOTTOM-LEFT: SOFA product jar (natural proportions)
  BOTTOM-RIGHT: FMC circular seal (exactly once)
`}

STRICT RULES — zero tolerance:
1. "${vitamina_chip}" appears EXACTLY ONCE — only inside the yellow pill badge on LINE 1. Never as plain text anywhere.
2. The word "Contiene" on LINE 1 is plain yellow bold text — it is NOT part of the pill badge. Badge contains only "${vitamina_chip}".
3. LINE 2 body copy "${body}" does NOT contain "${vitamina_chip}" — it is a continuation sentence (e.g. starts with "que...").
4. Badge is a SOLID PILL-SHAPED RECTANGLE — NO oval border, NO circle outline, NO blue ring.
5. Bottle silhouette: RED stroke outline with semi-transparent red-tinted interior. Never white stroke, never fully opaque fill.
6. Every pixel outside the brand band = real lifestyle photo. NEVER fill with solid color (no blue, gray, white blocks).
7. Every text element appears EXACTLY ONCE. Zero repetitions.
8. FMC seal appears EXACTLY ONCE at bottom-right of red band. Never duplicate.
9. DO NOT invent text, decorative banners, or extra badges beyond what is listed above.
10. NEVER render layout label words as visible text: do NOT write "CTA", "Headline", "Subhead", "Copy", "LINE 1", "LINE 2", or any structural label — only render the actual copy strings provided in quotes above.
11. ONE SPOON ONLY — if the scene shows someone measuring or stirring SOFA kola granulada, EXACTLY ONE spoon is visible at all times. Never two spoons, never multiple utensils simultaneously. One person, one spoon, one cucharada — consistent with the brand CTA.
12. ALL PEOPLE VISIBLE — if the scene description includes multiple people (couple, family, group), ALL of them must be fully visible within the frame. NEVER crop a person's head, face, or body at the frame edge. Compose the shot wide enough to include every person mentioned in the scene.
13. PRODUCT NATURAL INTEGRATION — the product jar must look PHOTOGRAPHED as part of the scene, not composited. It inherits the scene's lighting direction, color temperature, and has a natural contact shadow on the surface it rests on. It is realistically small (kitchen-jar sized beside a glass). It is NEVER floating, NEVER glowing with its own separate light source.
14. ONE ACTION AT A TIME — the person performs EXACTLY ONE product action in the scene: EITHER they are stirring/mixing the kola granulada into a drink, OR they are drinking the already-prepared beverage. NEVER both simultaneously. A person cannot stir one glass while drinking another at the same moment. Choose one coherent action and show it fully.
15. ONE UNIFIED SCENE — the entire image shows a SINGLE continuous environment with the SAME people throughout. The red bottle silhouette is a GRAPHIC DESIGN ELEMENT overlaid on the scene — it does NOT contain a separate scene, a different moment, or a second version of the same person. Every visual layer must belong to the same unified real-world moment.
16. WHITE HEADLINE TEXT — all headline and subhead text overlaid on the lifestyle scene photo must be WHITE (#FFFFFF). NEVER black, NEVER dark gray, NEVER any dark color. The only exception is if the KV reference explicitly shows colored text (red, yellow) — in that case match exactly. Default is always WHITE.
17. PRODUCT JAR ALONE IN BRAND BAND — in the bottom-left corner of the red brand band, the SOFA jar appears ALONE. NEVER place a glass, cup, or any beverage container next to or beside the product jar in the brand band. The jar is the only object in that bottom-left position.
18. SILHOUETTE CENTERED ON MAIN PERSON — the red jar/bottle silhouette outline graphic must be centered over the MAIN PROTAGONIST of the scene (the adult, the primary subject). NEVER over a secondary character (child, background person). The silhouette interior must be very subtle (max 15% opacity tint) so the person behind it remains fully visible.
${observacionesBlock}
Output size: ${fmt.width}x${fmt.height}px.`;
}

// ─── Scene variety engine (deterministic — no API call) ──────────────────────
// Generates unique scene variants per task to avoid repetition across formats
function buildSceneVariant(
    sceneDesc: string,
    audienciaRef: string,
    drivers: string,
    formatId: string,
    variantIndex: number
): string {
    const isGeneric = !sceneDesc || /^Authentic person matching/i.test(sceneDesc.trim());

    // Time-of-day rotation
    const times = [
        'morning — warm golden light, soft long shadows, fresh and energetic mood',
        'midday — bright natural light, vibrant colors, high-energy atmosphere',
        'late afternoon — warm amber light, relaxed and confident mood',
        'evening — soft blue hour light, aspirational and premium feel',
    ];
    const timeCtx = times[variantIndex % times.length];

    // Composition rotation based on format
    const isVertical = ['story_vertical', 'feed_portrait', 'banner_halfpage', 'banner_skyscraper'].includes(formatId);
    const compVariants = isVertical
        ? ['hero person fills left 60% of frame, product/text right side', 'person centered, looking slightly off-camera with natural expression', 'dynamic angle — slight low angle, person dominant', 'environmental portrait — person in context of their world']
        : ['wide establishing shot — person and environment both visible', 'medium shot — person 40% of frame, context 60%', 'product and person balanced left-right', 'action moment — person engaged with product naturally'];
    const compCtx = compVariants[variantIndex % compVariants.length];

    // Audience-aware emotional context
    const audienceLower = (audienciaRef || '').toLowerCase();
    let audienceCtx = '';
    if (/joven|young|18|25|millennial|gen z/i.test(audienceLower)) {
        audienceCtx = ['urban young adult, street-style confident', 'campus or city environment, peers nearby', 'active lifestyle, movement implied'][variantIndex % 3];
    } else if (/familia|family|madre|padre|pap|mam/i.test(audienceLower)) {
        audienceCtx = ['family warmth, genuine connection between people', 'home environment, comfortable and real', 'shared moment, multiple generations'][variantIndex % 3];
    } else if (/profesion|ejecutiv|business|trabaj/i.test(audienceLower)) {
        audienceCtx = ['professional setting, purposeful and competent', 'modern workspace or urban environment', 'achievement moment, quiet confidence'][variantIndex % 3];
    } else {
        audienceCtx = ['authentic person, relatable and real', 'everyday moment elevated', 'genuine expression, not posed'][variantIndex % 3];
    }

    // Driver-aware scene emphasis
    const driversLower = (drivers || '').toLowerCase();
    let driverCtx = '';
    if (/precio|precio|ahorro|value|econom/i.test(driversLower)) driverCtx = 'Scene implies smart choice, value, and satisfaction.';
    else if (/rendimiento|performance|potencia|power|speed/i.test(driversLower)) driverCtx = 'Scene implies capability, power, and performance.';
    else if (/estatus|status|premium|lujo|luxury/i.test(driversLower)) driverCtx = 'Scene implies aspiration, premium quality, and distinction.';
    else if (/confianza|trust|reliable|segur/i.test(driversLower)) driverCtx = 'Scene implies reliability, trust, and peace of mind.';

    const base = isGeneric
        ? `${audienceCtx}. ${compCtx}.`
        : sceneDesc;

    return `${base} Lighting: ${timeCtx}. Composition: ${compCtx}. ${driverCtx} Style: photorealistic, cinematic, not stock-photo-posed.`.replace(/\.\s*\./, '.').trim();
}


// ─── GET /formats ─────────────────────────────────────────────────────────────
dcoRoutes.get('/formats', (c) => c.json(Object.entries(FORMATS).map(([id, f]) => ({ id, ...f }))));


// ─── GET /template — descarga plantilla Excel lista para usar ──────────────────
dcoRoutes.get('/template', async (c) => {
    const wbx = new ExcelJS.Workbook();
    wbx.creator  = 'MUSE DCO';
    wbx.created  = new Date();

    // ── Colores ───────────────────────────────────────────────────────────────
    const RED_HEADER  = 'E06C75';  // salmon-rojo como en el cuadro real
    const RED_AI      = 'C0392B';  // rojo oscuro para columnas AI
    const RED_AUTO    = '7F8C8D';  // gris para columnas automáticas
    const DESC_BG     = 'F9EBEA';  // fondo muy suave para fila de descripciones
    const EX_BG       = 'FDFEFE';  // fondo blanco hueso para fila ejemplo
    const WHITE       = 'FFFFFF';

    // Helper: aplica estilo a celda de encabezado
    const styleHeader = (cell: ExcelJS.Cell, bgHex: string) => {
        cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgHex } };
        cell.font   = { bold: true, color: { argb: 'FF' + WHITE }, size: 10, name: 'Calibri' };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = {
            top:    { style: 'thin', color: { argb: 'FFFFFFFF' } },
            bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
            left:   { style: 'thin', color: { argb: 'FFFFFFFF' } },
            right:  { style: 'thin', color: { argb: 'FFFFFFFF' } },
        };
    };

    const styleDesc = (cell: ExcelJS.Cell) => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + DESC_BG } };
        cell.font      = { italic: true, color: { argb: 'FF555555' }, size: 8, name: 'Calibri' };
        cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
        cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
    };

    const styleExample = (cell: ExcelJS.Cell) => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + EX_BG } };
        cell.font      = { color: { argb: 'FF333333' }, size: 9, name: 'Calibri' };
        cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    };

    // ── Hoja 1: MARCA MATRICES ────────────────────────────────────────────────
    const ws1 = wbx.addWorksheet('MARCA MATRICES', { views: [{ state: 'frozen', ySplit: 2 }] });

    const columns: { header: string; key: string; width: number; type: 'normal' | 'ai' | 'auto' }[] = [
        { header: 'PIEZAS',                  key: 'piezas',   width: 10,  type: 'normal' },
        { header: 'MES',                     key: 'mes',      width: 12,  type: 'normal' },
        { header: 'CAMPAÑA',                 key: 'campana',  width: 28,  type: 'normal' },
        { header: 'TERRITORIO/ PORTAFOLIO',  key: 'terr',     width: 24,  type: 'normal' },
        { header: 'REFERENCIA',              key: 'ref',      width: 16,  type: 'normal' },
        { header: 'AUDIENCIAS',              key: 'aud',      width: 24,  type: 'normal' },
        { header: 'AUDIENCIAS REFERENCIA',   key: 'audref',   width: 38,  type: 'normal' },
        { header: 'DRIVERS',                 key: 'drivers',  width: 38,  type: 'normal' },
        { header: 'TONO',                    key: 'tono',     width: 18,  type: 'ai'     },
        { header: 'VARIANTE',                key: 'var',      width: 12,  type: 'ai'     },
        { header: 'MEDIO',                   key: 'medio',    width: 18,  type: 'normal' },
        { header: 'Formato de Anuncio',      key: 'fmtnom',   width: 20,  type: 'normal' },
        { header: 'Creativo',                key: 'creativo', width: 18,  type: 'normal' },
        { header: 'Tamaño (en pixeles)',     key: 'tamano',   width: 20,  type: 'normal' },
        { header: 'Formato',                 key: 'formato',  width: 16,  type: 'normal' },
        { header: 'Peso',                    key: 'peso',     width: 10,  type: 'normal' },
        { header: 'Texto',                   key: 'texto',    width: 20,  type: 'normal' },
        { header: 'OBJETIVO',                key: 'obj',      width: 16,  type: 'normal' },
        { header: 'geografía',               key: 'geo',      width: 16,  type: 'normal' },
        { header: 'CREATIVO CONCEPTO',       key: 'concepto', width: 26,  type: 'normal' },
        { header: 'IMAGEN O VIDEO',          key: 'imgvid',   width: 14,  type: 'normal' },
        { header: 'COPY',                    key: 'copy',     width: 52,  type: 'normal' },
        { header: 'OBSERVACIONES CREATIVAS', key: 'obs',      width: 40,  type: 'ai'     },
        { header: 'FECHA INICIO',            key: 'finicio',  width: 16,  type: 'normal' },
        { header: 'FECHA FINAL',             key: 'ffinal',   width: 16,  type: 'normal' },
        { header: 'FECHA SALIDA',            key: 'fsalida',  width: 20,  type: 'auto'   },
        { header: 'STATUS',                  key: 'status',   width: 24,  type: 'auto'   },
        { header: '(LINK DRIVE)',            key: 'link',     width: 30,  type: 'normal' },
        { header: 'COMENTARIOS',             key: 'coment',   width: 28,  type: 'normal' },
    ];

    ws1.columns = columns.map(c => ({ key: c.key, width: c.width }));
    ws1.getRow(1).height = 36;
    ws1.getRow(2).height = 60;
    ws1.getRow(3).height = 80;

    // Fila 1 — Encabezados con color según tipo
    const headerRow = ws1.getRow(1);
    columns.forEach((col, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = col.header;
        const bg = col.type === 'ai' ? RED_AI : col.type === 'auto' ? RED_AUTO : RED_HEADER;
        styleHeader(cell, bg);
    });

    // Fila 2 — Descripciones
    const descriptions = [
        'Número de la pieza. Ej: 1, 2, 3...',
        'Mes de pauta. Ej: Mayo 2025',
        'Nombre del vuelo o campaña.',
        'Territorio o portafolio. Ej: Nacional / Antioquia',
        'Referencia interna. Ej: TR-001',
        '★ CRÍTICO\nNombre del segmento. Define la escena generada.',
        '★ CRÍTICO\nPersonas reales del segmento. Enriquece la escena.',
        '★ CRÍTICO\nMotivaciones del segmento. Alimenta el contexto emocional.',
        '★ AI OPCIONAL\nMood: aspiracional / celebratorio / empático / urgente / motivacional / tranquilo / familiar / profesional',
        '★ AI OPCIONAL\nVersión A/B. Ej: A, B, C.',
        'Plataforma. Ej: Meta, Programática, TikTok',
        'Nombre del formato.',
        'Código del creativo.',
        '★ CRÍTICO\nDimensiones en píxeles. Ver hoja FORMATOS VÁLIDOS.',
        'Nombre del formato. Ej: Portrait 4:5',
        'Peso máx. Ej: 2MB',
        'Texto visual adicional.',
        'Objetivo. Ej: Awareness, Conversión',
        'Región. Ej: Bogotá, Nacional',
        'Concepto creativo del batch.',
        'Imagen o Video.',
        '★ CRÍTICO\nEstructura:\nCOPY PRINCIPAL: [titular]\nDESARROLLO: [cuerpo]\nCIERRE: [CTA]',
        '★ AI OPCIONAL\nNotas al AI por pieza. Ej: "No mostrar producto cerca del agua"',
        'Fecha de inicio de pauta.',
        'Fecha de fin de pauta.',
        '⚙ AUTOMÁTICO\nLo escribe el sistema.',
        '⚙ AUTOMÁTICO\nLo escribe el sistema.',
        'Link del Drive con archivos finales.',
        'Comentarios del equipo o cliente.',
    ];
    const descRow = ws1.getRow(2);
    descriptions.forEach((d, i) => {
        const cell = descRow.getCell(i + 1);
        cell.value = d;
        styleDesc(cell);
    });

    // Fila 3 — Ejemplo
    const exampleValues = [
        '1', 'Junio 2025', 'Campaña Bienestar Q2 2025', 'Nacional', 'TR-JUN-001',
        'Madres Trabajadoras',
        'Mujeres colombianas 25-40, profesionales, urbanas, con hijos en edad escolar',
        'Quieren más energía para rendir en el trabajo y en casa sin descuidar a sus hijos',
        'aspiracional', 'A', 'Meta', 'Feed Portrait 4:5', 'TR-ENE-MAD-001',
        '1080x1350', 'Portrait 4:5', '2MB', '', 'Awareness', 'Nacional',
        'Energía que te acompaña', 'Imagen',
        'COPY PRINCIPAL: La que puede con todo\nDESARROLLO: Contiene Complejo B que aporta la energía que necesitas para cada momento\nCIERRE: Tómalo todos los días, 1 cucharada.',
        '', '01/06/2025', '30/06/2025', '', '', '', '',
    ];
    const exRow = ws1.getRow(3);
    exampleValues.forEach((v, i) => {
        const cell = exRow.getCell(i + 1);
        cell.value = v;
        styleExample(cell);
    });

    // ── Hoja 2: FORMATOS VÁLIDOS ──────────────────────────────────────────────
    const ws2 = wbx.addWorksheet('FORMATOS VÁLIDOS');
    ws2.columns = [{ width: 22 }, { width: 26 }, { width: 42 }];
    const fmtHeaders = ws2.getRow(1);
    ['TAMAÑO (EN PIXELES)', 'NOMBRE DEL FORMATO', 'PLATAFORMA / USO'].forEach((h, i) => {
        const cell = fmtHeaders.getCell(i + 1);
        cell.value = h;
        styleHeader(cell, RED_HEADER);
    });
    ws2.getRow(1).height = 30;
    const fmtRows = [
        ['1080x1080', 'Feed Square 1:1',      'Meta Feed cuadrado'],
        ['1080x1350', 'Feed Portrait 4:5',    'Meta Feed vertical'],
        ['1080x1920', 'Stories / Reels 9:16', 'Instagram Stories, Reels, TikTok'],
        ['970x250',   'Billboard 970×250',    'Programática — banner horizontal'],
        ['160x600',   'Skyscraper 160×600',   'Programática — banner lateral'],
        ['300x600',   'Half Page 300×600',    'Programática — media página'],
        ['300x250',   'MREC 300×250',         'Programática — rectángulo medio'],
        ['1200x628',  'Landscape 1200×628',   'Google Display, LinkedIn, Twitter'],
        ['1200x630',  'Landscape 1200×630',   'Alias de 1200×628 (también válido)'],
    ];
    fmtRows.forEach((r, ri) => {
        const row = ws2.getRow(ri + 2);
        r.forEach((v, ci) => {
            const cell = row.getCell(ci + 1);
            cell.value = v;
            cell.font  = { size: 10, name: 'Calibri' };
            cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: ri % 2 === 0 ? 'FFF9EBEA' : 'FFFFFFFF' } };
            cell.alignment = { vertical: 'middle', horizontal: ci === 0 ? 'center' : 'left' };
        });
        row.height = 20;
    });

    // ── Hoja 3: GUÍA DE USO ───────────────────────────────────────────────────
    const ws3 = wbx.addWorksheet('GUÍA DE USO');
    ws3.columns = [{ width: 90 }];
    const guiaLines = [
        ['GUÍA DE USO — DCO MUSE', true],
        ['', false],
        ['COLUMNAS CRÍTICAS (el sistema las lee automáticamente):', true],
        ['  AUDIENCIAS            → Selecciona la escena según el segmento', false],
        ['  AUDIENCIAS REFERENCIA → Describe las personas reales del segmento', false],
        ['  DRIVERS               → Motivaciones del segmento', false],
        ['  COPY                  → Copy completo — ver estructura abajo', false],
        ['  Tamaño (en pixeles)   → Define el formato — ver hoja FORMATOS VÁLIDOS', false],
        ['  STATUS, FECHA SALIDA  → Los escribe el sistema automáticamente', false],
        ['', false],
        ['COLUMNAS AI OPCIONALES (mejoran los resultados, no son requeridas):', true],
        ['  TONO                  → Mood de la escena (aspiracional / celebratorio / empático / urgente / motivacional / tranquilo / familiar / profesional)', false],
        ['  VARIANTE              → Identificador A/B — aparece en la tarjeta de generación', false],
        ['  OBSERVACIONES CREATIVAS → Notas al AI por pieza — restricciones específicas', false],
        ['', false],
        ['ESTRUCTURA DEL COPY:', true],
        ['  COPY PRINCIPAL: [titular principal]', false],
        ['  DESARROLLO: [cuerpo — incluye el nutriente aquí, el sistema lo separa al badge automáticamente]', false],
        ['  CIERRE: [llamado a la acción]', false],
        ['', false],
        ['DETECCIÓN DE HOJA:', true],
        ['  El sistema busca la hoja que contenga "MATRICES" en su nombre.', false],
        ['  Puedes llamarla: MARCA MATRICES, SOFA MATRICES, MATRICES Q2, etc.', false],
    ];
    guiaLines.forEach(([text, bold], i) => {
        const row = ws3.getRow(i + 1);
        const cell = row.getCell(1);
        cell.value = text as string;
        cell.font  = { bold: bold as boolean, size: bold ? 11 : 10, name: 'Calibri', color: { argb: bold ? 'FF' + RED_HEADER : 'FF333333' } };
        cell.alignment = { wrapText: true };
        if (bold) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9EBEA' } };
        row.height = 18;
    });

    // Escribir buffer y devolver
    const buf = await wbx.xlsx.writeBuffer();
    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', 'attachment; filename="plantilla_dco_muse.xlsx"');
    return c.body(Buffer.from(buf));
});


// ─── Brand profiles (Supabase) ────────────────────────────────────────────────
let brandProfilesTableReady = false;
async function ensureBrandProfilesTable() {
    // La tabla se crea con la migración backend/supabase-dco.sql (NO con exec_sql,
    // que no existe por defecto y hacía que los insert fallaran en silencio).
    brandProfilesTableReady = true;
}

// ─── GET /profiles — built-in + guardados en Supabase ─────────────────────────
dcoRoutes.get('/profiles', async (c) => {
    const builtIn = Object.entries(BRAND_PROFILES).map(([id, p]) => ({
        id, name: p.name, emoji: p.emoji, color: p.color, type: 'builtin' as const,
    }));
    await ensureBrandProfilesTable();
    const { data, error } = await supabase
        .from('dco_brand_profiles')
        .select('id, name, color, emoji, kv_count, identity_prompt, analysis_summary, qa_rules, copy_identity, created_at')
        .order('created_at', { ascending: false });
    if (error) console.error('[DCO] /profiles select error:', error.message);
    const saved = (data || []).map((p: any) => ({
        id: p.id, name: p.name, emoji: p.emoji || '🏷️', color: p.color || '#6b7280',
        kvCount: p.kv_count, identityPrompt: p.identity_prompt,
        analysisSummary: p.analysis_summary || {},
        qaRules: Array.isArray(p.qa_rules) ? p.qa_rules : (p.analysis_summary?.qaRules || []),
        copyIdentity: p.copy_identity || {},
        type: 'saved' as const,
    }));
    return c.json({ profiles: [...builtIn, ...saved] });
});

// ─── POST /analyze-brand — Gemini analiza múltiples KVs y extrae identidad ────
const KV_FORMAT_LABELS: Record<string, string> = {
    square:   'SQUARE POST (~1:1, e.g. 1080×1080)',
    vertical: 'STORY / VERTICAL (~9:16, e.g. 1080×1920)',
    portrait: 'FEED PORTRAIT (~4:5, e.g. 1080×1350)',
    banner:   'DISPLAY BANNER (wide/narrow, e.g. 970×250 or 300×600)',
    general:  'UNSPECIFIED FORMAT',
};

// Extraído a función propia para poder reusar la MISMA extracción forense de identidad
// (colores, tipografía por elemento, badges, icon row, etc.) tanto desde el flujo explícito
// de "Aprender marca" (/analyze-brand, multi-KV) como desde una generación ad-hoc en /generate
// cuando el usuario sube un KV sin haber guardado antes un perfil — antes esa segunda ruta se
// quedaba sin NINGUNA identidad extraída, generando con estilo genérico sin relación al KV real.
async function analyzeBrandIdentity(labeledContent: any[], kvCount: number, multiFormatNote: string, apiKey: string): Promise<any> {
    const analysisPrompt = `You are a forensic brand analyst and senior creative director. Your analysis feeds DIRECTLY into an AI image generator — every field must be so precise that the generator can recreate this brand's visual system without ever seeing the originals. Be a scientist, not a poet. Measure everything. Assume nothing.

I am providing ${kvCount} Key Visual(s) from a brand's advertising campaign, each preceded by its format label. Study ALL of them before writing a single word.${multiFormatNote}

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

10. COPY STRUCTURE (read what the KV actually says)
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
  "speedLines": "none | describe: color, direction, opacity, density — present in high-energy brands like motorsports",
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
  "identityPrompt": "Write exactly 600 words of ultra-precise creative direction FOR AN AI IMAGE GENERATOR that has NEVER seen this brand before. Use these exact labeled sections with this exact structure:\\n\\nBRAND ESSENCE: In 2 sentences, what is the visual personality of this brand? What emotion does it project?\\n\\nCOLOR SYSTEM: List every color with its hex code and exactly which element uses it. Include gradient angles and stops. Include photo overlay colors and opacities.\\n\\nTYPOGRAPHY — THE MOST CRITICAL SECTION: For each text level (HEADLINE, SUBHEAD, BODY, CTA, LOGO, TAGLINE) write: font style (italic/upright), font width (ultra-condensed/normal), font weight, letter case, fill color and treatment (solid/gradient/multi-color), stroke color and width, shadow direction/distance/color, glow color if any, approximate size as % of frame height. If the brand uses italic ultra-condensed heavy fonts — say exactly that. If the headline has a red stroke on white fill — say exactly that.\\n\\nLAYOUT ARCHITECTURE: Describe the frame in zones (top 0-25%, 25-50%, 50-75%, bottom 75-100%). State exactly what element lives in each zone, its position, size, and stacking order. Include safe margins.\\n\\nBRAND BAND: If present — color or gradient (exact stops), position, height %, all elements inside from left to right, any border treatment.\\n\\nBEDGES AND PILLS: For each badge/pill — shape, background color, text color, font weight, case, position, content type.\\n\\nICON ROW: If present — position, number of icons, style, colors, what they represent. If absent — write NONE.\\n\\nPHOTO AND SCENE DIRECTION: Subject demographics, camera angle, lighting recipe (direction, kelvin temperature, hard/soft), color grade, required environment types that match the brand, energy level, depth of field. Any motion blur, speed lines, or atmospheric effects.\\n\\nDECORATIVE SYSTEM: Speed lines, particles, swooshes, geometric patterns — colors, opacity, position. Write NONE if the brand is clean.\\n\\nFIXED NON-NEGOTIABLE ELEMENTS: List every element that MUST appear in every execution — logo position and size, specific marks, seals, taglines, icon rows — anything that would make the ad look wrong if missing.\\n\\nNEVER GENERATE: List the top 8 specific things an AI image generator gets wrong for this brand style — wrong font treatment, wrong colors, wrong layout, generic-looking elements to avoid.",
  "productCategory": "tv | nevera | lavadora | laptop | audio | aire | monitor | phone | moto | auto | cosmetico | farmaceutico | bebida | alimento | ropa | telecomunicaciones | financiero | otro",
  "productSubcategory": "Specific subcategory. E.g. naked-sport-moto | smart_tv | door_in_door_nevera | crema-dental | etc.",
  "productBenefits": ["Array of 3-6 specific product technologies, features, or claims visible in the KVs. Use the real names as they appear in the copy or packaging."],
  "brandDNA": ["5 absolute visual rules that appear in EVERY KV — the non-negotiable fingerprints of this brand. Write each as a complete actionable sentence for an image generator."],
  "negativePrompt": "List 10-12 things that must NEVER appear in images for this brand: wrong colors, wrong font treatments, wrong layouts, generic AI mistakes. Format as comma-separated items.",
  "qaRules": ["Write 12 specific verifiable visual rules an AI QA system can check by looking at a generated image. Format: RULE_ID: what must be true. Cover logo position, color accuracy, typography treatment, band presence, badge rendering, text legibility, prohibited elements."]
}`;

    const res = await fetch(`${GEMINI_BASE}/models/gemini-2.5-pro:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [...labeledContent, { text: analysisPrompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 65536, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as any;
        throw new Error(`Gemini error: ${res.status} — ${errBody?.error?.message || errBody?.error?.status || JSON.stringify(errBody).slice(0, 200)}`);
    }
    const data = await res.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    try {
        // responseMimeType:application/json → text is pure JSON
        return JSON.parse(text);
    } catch {
        // fallback: extract JSON block si Gemini agregó texto alrededor
        const jsonMatch = extractJSON(text);
        if (jsonMatch) return JSON.parse(jsonMatch);
        throw new Error('No se pudo extraer JSON del análisis: ' + text.slice(0, 300));
    }
}

// Convierte lo que analyzeBrandIdentity ya extrae (posición/alineación de cada elemento de
// texto, posición/tamaño del logo, posición de cada badge) en un primer borrador de zonas
// (% del frame) para que el usuario ajuste arrastrando en vez de dibujar desde una hoja en
// blanco. Es heurístico (el schema de identidad es descriptivo, no coordenadas exactas) pero
// es un punto de partida real basado en SU KV, no una plantilla genérica igual para todos.
function deriveProposedZones(identity: any): Record<string, { x: number; y: number; w: number; h: number }> {
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
        zones[key === 'chip' ? 'vitamina_chip' : key] = { x, y, w, h };
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

dcoRoutes.post('/analyze-brand', async (c) => {
    const formData = await c.req.formData();
    const kvFiles   = formData.getAll('kvImages') as File[];
    const kvFormats = formData.getAll('kvFormats') as string[]; // paralelo a kvImages, uno por archivo
    if (!kvFiles.length) return c.json({ error: 'Se requiere al menos 1 imagen KV' }, 400);

    const apiKey  = process.env.GEMINI_API_KEY || '';
    const kvEntries = await Promise.all(kvFiles.slice(0, 100).map(async (f, i) => ({
        part: { inlineData: { data: Buffer.from(await f.arrayBuffer()).toString('base64'), mimeType: f.type || 'image/jpeg' } },
        format: kvFormats[i] || 'general',
    })));
    // Cada imagen va precedida de una etiqueta de formato explícita en la secuencia que Gemini
    // realmente ve — sin esto, mezclar KVs cuadrados/verticales/banner en un solo análisis
    // hacía que el layout de un formato se confundiera con el de otro.
    const labeledKvContent: any[] = [];
    kvEntries.forEach((e, i) => {
        labeledKvContent.push({ text: `Image ${i + 1} — format: ${KV_FORMAT_LABELS[e.format] || KV_FORMAT_LABELS.general}` });
        labeledKvContent.push(e.part);
    });
    const formatsUsed = Array.from(new Set(kvEntries.map(e => e.format)));
    const multiFormatNote = formatsUsed.length > 1
        ? `\n⚠️ These Key Visuals span ${formatsUsed.length} DIFFERENT formats (labeled above per image). COLOR SYSTEM, TYPOGRAPHY, and LOGO are brand-wide — extract them from ALL images combined. LAYOUT GRID, BRAND BAND position, and zone percentages are FORMAT-SPECIFIC — do NOT blend layout rules from one format into another. If a layout rule only holds for one format, say so explicitly instead of averaging it across formats.\n`
        : '';

    try {
        const analysis = await analyzeBrandIdentity(labeledKvContent, kvEntries.length, multiFormatNote, apiKey);
        const proposedZones = deriveProposedZones(analysis);
        return c.json({ ok: true, analysis, proposedZones, kvCount: kvFiles.length });
    } catch (e: any) {
        return c.json({ error: e.message || 'Error analizando identidad de marca' }, 500);
    }
});

// ─── POST /save-profile — guarda identidad de marca en Supabase ───────────────
dcoRoutes.post('/save-profile', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const { name, color, emoji, identityPrompt, analysisSummary, qaRules, copyIdentity, kvCount, createdBy } = body;
    if (!name || !identityPrompt) return c.json({ error: 'name e identityPrompt son requeridos' }, 400);

    await ensureBrandProfilesTable();
    // qa_rules: usa las explícitas, o las que vengan dentro del análisis (de-hardcode del QA)
    const qa = Array.isArray(qaRules) && qaRules.length ? qaRules : (analysisSummary?.qaRules || []);
    const { data, error } = await supabase.from('dco_brand_profiles').insert({
        name: name.trim(),
        color: color || '#6b7280',
        emoji: emoji || '🏷️',
        identity_prompt: identityPrompt,
        analysis_summary: analysisSummary || {},
        qa_rules: qa,
        copy_identity: copyIdentity || {},
        kv_count: kvCount || 0,
        created_by: createdBy || '',
    }).select('id, name, color, emoji, kv_count, identity_prompt, analysis_summary, qa_rules, copy_identity').single();

    if (error) { console.error('[DCO] save-profile error:', error.message); return c.json({ error: error.message }, 500); }
    return c.json({ ok: true, profile: { ...data, identityPrompt: data.identity_prompt, analysisSummary: data.analysis_summary || {}, qaRules: data.qa_rules, copyIdentity: data.copy_identity, type: 'saved' } });
});

// ─── DELETE /profiles/:id — elimina perfil guardado ───────────────────────────
dcoRoutes.delete('/profiles/:id', async (c) => {
    const id = c.req.param('id');
    await ensureBrandProfilesTable();
    const { error } = await supabase.from('dco_brand_profiles').delete().eq('id', id);
    if (error) return c.json({ error: error.message }, 500);
    return c.json({ ok: true });
});

// ─── Personajes — foto de referencia para consistencia entre generaciones ─────
dcoRoutes.get('/characters', async (c) => {
    const profileId = c.req.query('profileId') || undefined;
    const characters = await listCharacters(profileId);
    return c.json({ characters });
});

dcoRoutes.post('/characters', async (c) => {
    const formData = await c.req.formData();
    const name = ((formData.get('name') as string) || '').trim();
    const photoFile = formData.get('photo') as File | null;
    const profileId = ((formData.get('profileId') as string) || '').trim() || null;
    const physicalNotes = ((formData.get('physicalNotes') as string) || '').trim();
    if (!name || !photoFile) return c.json({ error: 'name y photo son requeridos' }, 400);

    const createdBy = ((formData.get('createdBy') as string) || '').trim();
    const photoBase64 = Buffer.from(await photoFile.arrayBuffer()).toString('base64');
    const result = await createCharacter({ name, profileId, photoBase64, physicalNotes, createdBy });
    if (result.error) return c.json({ error: result.error }, 500);
    return c.json({ ok: true, character: result.character });
});

dcoRoutes.delete('/characters/:id', async (c) => {
    const id = c.req.param('id');
    const result = await deleteCharacter(id);
    if (result.error) return c.json({ error: result.error }, 500);
    return c.json({ ok: true });
});

// ─── POST /parse-brief — lee Excel y extrae piezas ───────────────────────────
// ─── Fallback con IA para briefs sin formato reconocible ──────────────────────
// Solo se activa cuando el parser determinístico (arriba) no logra encontrar
// columnas AUDIENCIA/COPY reconocibles — una sola llamada a Claude, no reemplaza
// el parser normal (que sigue siendo gratis y determinístico para el caso común).
async function parseWithAI(rows: any[][], claudeApiKey: string): Promise<any[] | null> {
    if (!claudeApiKey) return null;
    const client = new Anthropic({ apiKey: claudeApiKey });

    const tableText = rows.slice(0, 80)
        .map((row, i) => `[fila ${i}] ` + row.map((c: any) => String(c ?? '').slice(0, 200)).join(' | '))
        .join('\n');

    const prompt = `Este es un cuadro de materiales publicitarios de una agencia, sin un formato de columnas estándar — puede tener nombres de columna distintos, en otro idioma, o venir sin encabezados claros. Tu trabajo es leer las filas e identificar, para CADA pieza publicitaria real que encuentres, los siguientes campos:

- audience: el segmento/audiencia objetivo (texto corto)
- audienciaRef: descripción de las personas reales de ese segmento (si existe, si no dejar vacío)
- drivers: motivaciones/insights del segmento (si existe)
- tono: mood o tono (aspiracional, celebratorio, empático, urgente, motivacional, tranquilo, familiar, profesional — o vacío)
- variante: identificador A/B si existe
- observaciones: notas creativas adicionales
- copyFull: el copy/texto publicitario completo de esa pieza (headline + cuerpo + CTA, tal como venga)
- dimensions: el tamaño/formato en píxeles si se menciona (ej "1080x1080"), o el nombre de plataforma si no hay píxeles (ej "Instagram Feed")
- campaña, medio, formato: si existen esos datos

FILAS DEL ARCHIVO:
${tableText}

Ignorá filas vacías, de encabezado, o que no representen una pieza real. Devolvé SOLO JSON válido, sin markdown:
{ "pieces": [{ "audience": "", "audienciaRef": "", "drivers": "", "tono": "", "variante": "", "observaciones": "", "copyFull": "", "dimensions": "" , "campaña": "", "medio": "", "formato": ""}] }`;

    const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = extractJSON(text);
    if (!jsonMatch) return null;
    try {
        const parsed = JSON.parse(jsonMatch);
        return Array.isArray(parsed.pieces) ? parsed.pieces : null;
    } catch { return null; }
}

dcoRoutes.post('/parse-brief', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('brief') as File | null;
    if (!file) return c.json({ error: 'Archivo requerido' }, 400);

    const buf = Buffer.from(await file.arrayBuffer());
    const wb  = XLSX.read(buf, { type: 'buffer' });

    // Priorizar hoja "SOFA MATRICES" (o la que más se parezca), luego la más grande
    const TARRITO_KEYWORDS = ['SOFA', 'MATRICES', 'SOFA'];
    const tarrSheet = wb.SheetNames.find(n =>
        TARRITO_KEYWORDS.some(kw => n.toUpperCase().includes(kw))
    );

    let rows: any[][] = [];
    let usedSheet = wb.SheetNames[0];
    if (tarrSheet) {
        rows = XLSX.utils.sheet_to_json(wb.Sheets[tarrSheet], { header: 1, defval: '' }) as any[][];
        usedSheet = tarrSheet;
    } else {
        for (const sheetName of wb.SheetNames) {
            const r: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
            if (r.length > rows.length) { rows = r; usedSheet = sheetName; }
        }
    }

    // ─── Detección de fila de encabezado — múltiples estrategias ──────────────
    // Términos que esperamos encontrar en el encabezado
    const HEADER_TERMS = ['AUDIENCIA', 'COPY', 'MEDIO', 'STATUS', 'FORMATO', 'CAMPAA', 'CAMPANA'];

    let hdrIdx = -1;
    const colMap: Record<string, number> = {};

    // Estrategia 1: fila que contiene AUDIENCIA y COPY (muy permisiva)
    for (let i = 0; i < Math.min(rows.length, 50); i++) {
        const row = rows[i];
        const cells = row.map((c: any) => String(c || '').toUpperCase().trim());
        const hasAud  = cells.some(c => c.includes('AUDIENCIA'));
        const hasCopy = cells.some(c => c.includes('COPY'));
        if (hasAud && hasCopy) {
            hdrIdx = i;
            row.forEach((cell: any, idx: number) => {
                const key = normalizeKey(String(cell || ''));
                if (key) colMap[key] = idx;
            });
            break;
        }
    }

    // Estrategia 2: fila con mayor número de columnas conocidas
    if (hdrIdx === -1) {
        let bestScore = 1; // mínimo 2 matches para considerar
        for (let i = 0; i < Math.min(rows.length, 50); i++) {
            const cells = rows[i].map((c: any) => String(c || '').toUpperCase().trim());
            const score = HEADER_TERMS.filter(t => cells.some(c => c.includes(t))).length;
            if (score > bestScore) {
                bestScore = score;
                hdrIdx = i;
            }
        }
        if (hdrIdx >= 0) {
            rows[hdrIdx].forEach((cell: any, idx: number) => {
                const key = normalizeKey(String(cell || ''));
                if (key) colMap[key] = idx;
            });
        }
    }

    // Si el parser determinístico no reconoce las columnas (agencia con formato propio,
    // otro idioma, o sin encabezados claros), un solo llamado a Claude interpreta el
    // archivo crudo y lo normaliza al mismo formato que espera el resto del sistema —
    // el parser determinístico sigue siendo el camino normal (gratis) para el caso común.
    if (hdrIdx === -1) {
        const claudeApiKey = process.env.ANTHROPIC_API_KEY || '';
        const aiPieces = await parseWithAI(rows, claudeApiKey).catch((err: any) => {
            console.error('[DCO] parse-brief AI fallback error:', err.message);
            return null;
        });

        if (aiPieces && aiPieces.length > 0) {
            const pieces = aiPieces.map((p: any, i: number) => {
                const dimRaw = String(p.dimensions || '').trim();
                const formatId = dimToFormatId(dimRaw) || 'feed_square';
                const fmt = FORMATS[formatId];
                return {
                    rowIndex: i,
                    audience: String(p.audience || '').trim(),
                    audienciaRef: String(p.audienciaRef || '').trim(),
                    drivers: String(p.drivers || '').trim(),
                    tono: String(p.tono || '').trim(),
                    variante: String(p.variante || '').trim(),
                    observaciones: String(p.observaciones || '').trim(),
                    copyPreview: String(p.copyFull || '').slice(0, 300),
                    copyFull: String(p.copyFull || '').trim(),
                    dimensions: dimRaw || `${fmt.width}×${fmt.height}`,
                    formatId,
                    formatLabel: `${fmt.width}×${fmt.height}`,
                    platform: fmt.platform,
                    campaña: String(p.campaña || '').trim(),
                    medio: String(p.medio || '').trim(),
                    formato: String(p.formato || '').trim(),
                };
            }).filter((p: any) => p.audience || p.copyFull);

            if (pieces.length > 0) {
                return c.json({ pieces, total: pieces.length, debug: { usedSheet, aiFallback: true } });
            }
        }

        const preview = rows.slice(0, 5).map((r, i) => ({
            row: i,
            cells: r.slice(0, 10).map((c: any) => String(c || '').slice(0, 40)),
        }));
        return c.json({
            error: 'No se encontró el encabezado y no se pudo interpretar el archivo automáticamente. Asegúrate de que el archivo tenga columnas AUDIENCIAS y COPY, o filas con esa información reconocible.',
            debug: { sheets: wb.SheetNames, usedSheet, firstRows: preview },
        }, 400);
    }

    // ─── Búsqueda flexible de índices de columna ───────────────────────────────
    const findCol = (...candidates: string[]): number | undefined => {
        // Match exacto primero
        for (const k of candidates) {
            if (colMap[k] !== undefined) return colMap[k];
        }
        // Match parcial: la clave del mapa contiene el candidato
        for (const ck of Object.keys(colMap)) {
            for (const k of candidates) {
                if (k.length >= 4 && ck.includes(k)) return colMap[ck];
            }
        }
        // Match inverso: el candidato contiene la clave del mapa
        for (const ck of Object.keys(colMap)) {
            for (const k of candidates) {
                if (ck.length >= 4 && k.includes(ck)) return colMap[ck];
            }
        }
        return undefined;
    };

    const copyIdx          = findCol('COPY');
    const audIdx           = findCol('AUDIENCIAS', 'AUDIENCIA');
    const audRefIdx        = findCol('AUDIENCIASREFERENCIA', 'AUDIENCIAREFERENCIA', 'REFERENCIA');
    const driversIdx       = findCol('DRIVERS', 'DRIVER', 'MOTIVADORES');
    const tonoIdx          = findCol('TONO', 'MOOD', 'ENERGIA');
    const varianteIdx      = findCol('VARIANTE', 'VARIANT', 'VERSION', 'VERSIONAB', 'AB');
    const observacionesIdx = findCol('OBSERVACIONESCREATIVAS', 'OBSERVACIONES', 'NOTAS', 'NOTASCREATIVAS');
    const dimIdx           = findCol('TAMAÑOENPIXELES', 'TAMAOENPIXELES', 'TAMAÑO', 'TAMAO', 'TAMAO', 'PIXELES');
    const campañaIdx       = findCol('CAMPAÑA', 'CAMPAA', 'CAMPANA');
    const medioIdx         = findCol('MEDIO');
    const formatoIdx       = findCol('FORMATODEANUNCIO', 'FORMATOANUNCIO', 'FORMATO');

    const pieces: any[] = [];
    for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row  = rows[i];
        const copy = copyIdx !== undefined ? String(row[copyIdx] || '').trim() : '';
        const aud  = audIdx  !== undefined ? String(row[audIdx]  || '').trim() : '';
        if (!copy && !aud) continue;

        const dimRaw  = dimIdx     !== undefined ? String(row[dimIdx]     || '').trim() : '';
        const campaña = campañaIdx !== undefined ? String(row[campañaIdx] || '').trim() : '';
        const medio   = medioIdx   !== undefined ? String(row[medioIdx]   || '').trim() : '';
        const formato = formatoIdx !== undefined ? String(row[formatoIdx] || '').trim() : '';

        const formatId = dimToFormatId(dimRaw) || 'feed_square';
        const fmt = FORMATS[formatId];

        pieces.push({
            rowIndex:      i,
            audience:      aud,
            audienciaRef:  audRefIdx        !== undefined ? String(row[audRefIdx]        || '').trim() : '',
            drivers:       driversIdx       !== undefined ? String(row[driversIdx]       || '').trim() : '',
            tono:          tonoIdx          !== undefined ? String(row[tonoIdx]          || '').trim() : '',
            variante:      varianteIdx      !== undefined ? String(row[varianteIdx]      || '').trim() : '',
            observaciones: observacionesIdx !== undefined ? String(row[observacionesIdx] || '').trim() : '',
            copyPreview:   copy.slice(0, 300),
            copyFull:      copy,
            dimensions:    dimRaw || `${fmt.width}×${fmt.height}`,
            formatId,
            formatLabel:   `${fmt.width}×${fmt.height}`,
            platform:      fmt.platform,
            campaña,
            medio,
            formato,
        });
    }

    return c.json({
        pieces,
        total: pieces.length,
        debug: { usedSheet, hdrIdx, colsFound: Object.keys(colMap) },
    });
});

// ─── Helper: extrae audiencias + copies existentes de un cuadro de materiales ──
function extractBriefAudiences(buf: Buffer): {
    usedSheet: string;
    marca: string;
    campaña: string;
    mes: string;
    medios: string[];
    audiencias: { audiencia: string; audienciaRef: string; drivers: string; objetivo: string; territorio: string; copies: string[] }[];
} {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const KW = ['MATRICES', 'SOFA', 'TARRITO'];
    let usedSheet = wb.SheetNames.find(n => KW.some(k => n.toUpperCase().includes(k))) || wb.SheetNames[0];
    let rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[usedSheet], { header: 1, defval: '' }) as any[][];
    // Si la hoja elegida no tiene encabezado con COPY, busca la más grande
    const hasCopyHeader = rows.slice(0, 30).some(r => r.some((c: any) => String(c).toUpperCase().includes('COPY')));
    if (!hasCopyHeader) {
        for (const sn of wb.SheetNames) {
            const r: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
            if (r.length > rows.length) { rows = r; usedSheet = sn; }
        }
    }

    let hdrIdx = -1;
    const colMap: Record<string, number> = {};
    for (let i = 0; i < Math.min(rows.length, 50); i++) {
        const cells = rows[i].map((c: any) => String(c || '').toUpperCase().trim());
        if (cells.some(c => c.includes('AUDIENCIA')) && cells.some(c => c.includes('COPY'))) {
            hdrIdx = i;
            rows[i].forEach((cell: any, idx: number) => { const k = normalizeKey(String(cell || '')); if (k) colMap[k] = idx; });
            break;
        }
    }
    if (hdrIdx === -1) return { usedSheet, marca: '', campaña: '', mes: '', medios: [], audiencias: [] };

    const find = (...cands: string[]): number | undefined => {
        for (const k of cands) if (colMap[k] !== undefined) return colMap[k];
        for (const ck of Object.keys(colMap)) for (const k of cands) if (k.length >= 4 && ck.includes(k)) return colMap[ck];
        return undefined;
    };
    const ci = {
        copy: find('COPY'), aud: find('AUDIENCIAS', 'AUDIENCIA'),
        audRef: find('AUDIENCIASREFERENCIA', 'AUDIENCIAREFERENCIA'),
        drivers: find('DRIVERS', 'DRIVER'), obj: find('OBJETIVO'),
        terr: find('TERRITORIOPORTAFOLIO', 'TERRITORIO', 'PORTAFOLIO'),
        medio: find('MEDIO'), campana: find('CAMPAÑA', 'CAMPAA', 'CAMPANA'), mes: find('MES'),
    };

    const map = new Map<string, { audiencia: string; audienciaRef: string; drivers: string; objetivo: string; territorio: string; copies: string[] }>();
    const medioSet = new Set<string>();
    let marca = '', campaña = '', mes = '';
    for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const get = (idx?: number) => idx !== undefined ? String(row[idx] || '').trim() : '';
        const aud = get(ci.aud), copy = get(ci.copy);
        if (!aud && !copy) continue;
        if (!campaña) campaña = get(ci.campana);
        if (!mes) mes = get(ci.mes);
        const medio = get(ci.medio); if (medio) medioSet.add(medio);
        const key = aud || '—';
        if (!map.has(key)) map.set(key, { audiencia: aud, audienciaRef: get(ci.audRef), drivers: get(ci.drivers), objetivo: get(ci.obj), territorio: get(ci.terr), copies: [] });
        const entry = map.get(key)!;
        if (!entry.audienciaRef) entry.audienciaRef = get(ci.audRef);
        if (!entry.drivers) entry.drivers = get(ci.drivers);
        if (copy && entry.copies.length < 6) entry.copies.push(copy.slice(0, 600));
    }
    // Marca: nombre de la hoja o primera celda B2 típica
    marca = (usedSheet.replace(/MATRICES/i, '').trim()) || '';
    return { usedSheet, marca, campaña, mes, medios: Array.from(medioSet), audiencias: Array.from(map.values()) };
}

// ─── Columnas EXACTAS del cuadro de materiales (TARRITO ROJO MATRICES) ─────────
// Orden idéntico al adjunto (B→AA) + columnas AI al final (TONO/VARIANTE/OBSERVACIONES).
const CUADRO_HEADERS = [
    '# PIEZAS', 'MES', 'CAMPAÑA', 'TERRITORIO/ PORTAFOLIO', 'REFERENCIA', 'AUDIENCIAS',
    'AUDIENCIAS REFERENCIA', 'DRIVERS', 'MEDIO', 'Formato de Anuncio', 'Creativo',
    'Tamaño (en pixeles)', 'Formato', 'Peso', 'Texto', 'OBJETIVO', 'geografía',
    'CREATIVO CONCEPTO', 'IMAGEN O VIDEO', 'COPY', 'FECHA INICIO', 'FECHA FINAL',
    'FECHA SALIDA', 'STATUS', '(LINK DRIVE)', 'COMENTARIOS',
    'TONO', 'VARIANTE', 'OBSERVACIONES CREATIVAS',
];

// Estima cuántos caracteres entran de verdad en una zona marcada a mano (mismo
// cálculo que dcoOverlay.ts usa para componer el texto real después) — así el
// copy que genera Claude ya viene con el largo que efectivamente cabe en esa
// caja, en vez de un límite de palabras genérico que puede no encajar.
function estimateZoneCharBudget(zone: { w: number; h: number }, refWidth: number, refHeight: number): number {
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
    headline: 'copy_principal (titular)', subhead: 'desarrollo/subhead', vitamina_chip: 'vitamina_chip',
    cta: 'cierre (CTA)',
};
const COPY_BENEFIT_ZONE_RE = /^benefit_(\d+)$/;
function copyZoneFieldLabel(key: string): string | null {
    if (COPY_ZONE_FIELD_LABEL[key]) return COPY_ZONE_FIELD_LABEL[key];
    const m = key.match(COPY_BENEFIT_ZONE_RE);
    return m ? `beneficios[${Number(m[1]) - 1}] (bullet corto #${m[1]})` : null;
}

// Arma el bloque de instrucción de largo real por zona marcada — usado por ambos
// endpoints de generación de copy (con y sin Excel).
function buildZoneLengthInstruction(
    manualZones: Partial<Record<string, { x: number; y: number; w: number; h: number }>> | null,
    refWidth: number, refHeight: number,
): string {
    if (!manualZones || !refWidth || !refHeight) return '';
    const lines = Object.entries(manualZones)
        .filter(([key, z]) => z && copyZoneFieldLabel(key))
        .map(([key, z]) => {
            const chars = estimateZoneCharBudget(z as any, refWidth, refHeight);
            return `- ${copyZoneFieldLabel(key)}: MÁXIMO ${chars} caracteres — es el espacio real que marcaste sobre el KV para este elemento, no un límite genérico.`;
        });
    if (!lines.length) return '';
    return `\n\nLÍMITES DE LARGO REALES (calculados de las zonas que marcaste a mano sobre el KV — tienen prioridad sobre cualquier límite de palabras genérico de más arriba):\n${lines.join('\n')}`;
}

// Cuenta cuántas zonas benefit_N se marcaron — para pedirle a Claude exactamente esa
// cantidad de bullets de beneficio (no un párrafo único "desarrollo").
function countBenefitZones(manualZones: Partial<Record<string, unknown>> | null): number {
    if (!manualZones) return 0;
    return Object.keys(manualZones).filter(k => COPY_BENEFIT_ZONE_RE.test(k) && manualZones[k]).length;
}

function buildBeneficiosCountInstruction(count: number): string {
    if (count === 0) return '';
    return `\n\nESTRUCTURA DE BENEFICIOS (marcaste ${count} zona${count > 1 ? 's' : ''} de beneficio sobre el KV — el copy DEBE traer exactamente ${count} beneficio${count > 1 ? 's' : ''}, ni más ni menos):
- Devolvé un array "beneficios" con EXACTAMENTE ${count} string${count > 1 ? 's' : ''}.
- Cada uno es un bullet ULTRA CORTO estilo "+Palabra" o "+Dos Palabras" (ej: "+Oportunidades", "+Movimiento", "+Ingresos", o "+Velocidad", "+Ahorro" si el rubro es otro) — NUNCA una oración, NUNCA más de 2-3 palabras.
- No repitas la misma idea en dos bullets distintos; que cada uno cubra un beneficio real y distinto del producto/servicio.`;
}

// El KV real puede no tener NINGÚN subhead/oración de desarrollo (solo titular + badges +
// logo, como muchos KVs de moto/utilitarios) — sin esto, el modelo llena "desarrollo" con
// una oración de relleno solo porque el campo existe en el JSON, aunque el diseño real no
// la necesite ("parafernalia" que el usuario no pidió). Antes esto se decidía según si el
// usuario había marcado una zona de "subhead" a mano; ahora Claude lo decide por sí mismo
// mirando el KV — no depende de que nadie haya dibujado nada.
function buildSubheadInstruction(hasKvImage: boolean): string {
    if (hasKvImage) {
        return `\n\nDECISIÓN DE SUBHEAD/DESARROLLO — MIRÁ VOS MISMO LA IMAGEN ADJUNTA: analizá el KV real y determiná si su diseño incluye una línea de subtítulo/desarrollo (una oración corta entre el titular y los beneficios) o si pasa directo del titular a los beneficios/CTA sin ninguna oración intermedia.
- Si el KV SÍ muestra esa línea de subtítulo: escribí un "desarrollo" corto y coherente para cada copy, en el mismo lugar/función que cumple en el KV real.
- Si el KV NO muestra ninguna línea de subtítulo: dejá "desarrollo" como string vacío "" en cada copy — NO inventes una oración de relleno solo porque el campo existe en el JSON.
Esta decisión depende ÚNICAMENTE de lo que ves en la imagen real — nadie tiene que marcar ninguna zona a mano para que la tomes.`;
    }
    return `\n\nDECISIÓN DE SUBHEAD/DESARROLLO — sin imagen de referencia adjunta para verificarlo visualmente: si los copies existentes ya muestran un patrón claro de subtítulo/oración de desarrollo, seguí ese mismo patrón; si no hay evidencia de que la pieza real lleve esa línea, dejá "desarrollo" vacío "" — ante la duda, menos texto es mejor que inventar relleno.`;
}

// ─── Validación DURA de brevedad de copy — no confiar, verificar ──────────────
// El modelo recibe límites en el prompt, pero un límite en el prompt es una sugerencia;
// esto lo convierte en un contrato: se mide por código y, si se violó, se reintenta con
// el detalle exacto de cada violación. Es la razón por la que el copy dejará de llegar
// como oración larga que desborda su zona.
function copyBrevityViolations(cp: any): string[] {
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
    if (cp.vitamina_chip && len(cp.vitamina_chip) > 25)
        v.push(`vitamina_chip demasiado largo ("${cp.vitamina_chip}") — máx 25 caracteres`);
    return v;
}

function collectCopyViolations(parsed: any): string[] {
    const all: string[] = [];
    for (const a of (parsed?.audiencias || [])) {
        for (const cp of (a.copies || [])) all.push(...copyBrevityViolations(cp));
    }
    return all;
}

function brevityRetryFeedback(violations: string[]): string {
    return `⚠️ TU RESPUESTA ANTERIOR VIOLÓ LOS LÍMITES DE LONGITUD (verificado por código, no es opinable):
${[...new Set(violations)].slice(0, 12).map(v => '- ' + v).join('\n')}
Regenerá TODO el JSON corrigiendo cada violación — misma estructura, mismos campos, textos MÁS CORTOS. Los límites son contratos duros, no sugerencias. Ante la duda, siempre la versión más corta.`;
}

// ─── POST /generate-copies — infiere identidad de copy del cuadro y genera nuevos ──
dcoRoutes.post('/generate-copies', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('brief') as File | null;
    if (!file) return c.json({ error: 'Se requiere el cuadro de materiales (brief)' }, 400);

    const variantsPerAudience = Math.min(parseInt(String(formData.get('variantsPerAudience') || '3')) || 3, 6);
    const newAudiencesCount   = Math.min(parseInt(String(formData.get('newAudiences')        || '2')) || 0, 6);
    const extraInstructions   = String(formData.get('instructions') || '').trim();

    // Zonas marcadas a mano (opcional) — si vienen, el largo del copy se calcula del
    // espacio real de cada zona en vez de un límite de palabras genérico.
    let manualZonesForCopy: Partial<Record<string, { x: number; y: number; w: number; h: number }>> | null = null;
    try { const raw = formData.get('manualZones') as string | null; if (raw) manualZonesForCopy = JSON.parse(raw); } catch { /* ignore */ }
    const refWidth  = parseInt(String(formData.get('refWidth')  || '0')) || 0;
    const refHeight = parseInt(String(formData.get('refHeight') || '0')) || 0;
    const zoneLengthInstruction = buildZoneLengthInstruction(manualZonesForCopy, refWidth, refHeight);
    const benefitZoneCount = countBenefitZones(manualZonesForCopy);
    const beneficiosCountInstruction = buildBeneficiosCountInstruction(benefitZoneCount);

    // KV de referencia (opcional) — antes los copies se generaban solo a partir del
    // texto de copies existentes en el Excel, sin mirar la imagen real que se va a usar
    // en el DCO. Si viene, se la pasamos a Claude como contexto visual para que el copy
    // encaje con lo que efectivamente se ve (producto, escena, mood, colores).
    const kvImageFile = formData.get('kvImage') as File | null;
    let kvImagePart: { data: string; mime: string } | null = null;
    if (kvImageFile) {
        const kvBuf = Buffer.from(await kvImageFile.arrayBuffer());
        kvImagePart = { data: kvBuf.toString('base64'), mime: kvImageFile.type || 'image/jpeg' };
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const brief = extractBriefAudiences(buf);
    if (!brief.audiencias.length) {
        return c.json({ error: 'No se encontraron audiencias/copies en el cuadro. Verifica que tenga columnas AUDIENCIAS y COPY.', debug: { usedSheet: brief.usedSheet } }, 400);
    }

    const claudeApiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!claudeApiKey) return c.json({ error: 'Falta ANTHROPIC_API_KEY en el backend' }, 500);

    const briefDigest = brief.audiencias.map((a, i) =>
        `AUDIENCIA ${i + 1}: ${a.audiencia}\n  Personas (referencia): ${a.audienciaRef || '—'}\n  Drivers: ${a.drivers || '—'}\n  Objetivo: ${a.objetivo || '—'}\n  Copies existentes:\n${a.copies.map(cp => '   • ' + cp.replace(/\n+/g, ' / ')).join('\n') || '   (sin copies)'}`
    ).join('\n\n');

    const prompt = `Eres el COPYWRITER LÍDER de la marca. Te entrego el cuadro de materiales actual con sus audiencias y los copies YA EXISTENTES. Tu trabajo tiene dos fases.

DATOS DEL CUADRO (marca aproximada: "${brief.marca || 'desconocida'}", campaña: "${brief.campaña || '—'}", medios: ${brief.medios.join(', ') || '—'}):

${briefDigest}

FASE 1 — ENTENDER LA IDENTIDAD DE COPY:
Analiza los copies existentes e infiere con precisión: el TONO de voz, la FÓRMULA o estructura recurrente (ej: "Listos para la vida es..."), el patrón del beneficio/vitamina, las palabras que la marca SÍ usa (positivas) y las que NUNCA debe usar (prohibidas / claims regulatorios riesgosos).

FASE 2 — GENERAR COPIES NUEVOS (mismo ADN, frescos, no repetir literalmente los existentes):
1) Para CADA audiencia existente genera ${variantsPerAudience} variantes nuevas (A_brand=enfoque marca/emocional, B_producto=enfoque beneficio/producto, C_lifestyle=enfoque estilo de vida).
${newAudiencesCount > 0 ? `2) Propón ${newAudiencesCount} AUDIENCIAS NUEVAS coherentes con la marca (que aún no existan en el cuadro), cada una con su "audiencia_referencia" (personas reales), sus "drivers", y ${variantsPerAudience} variantes de copy con la misma estructura.` : '2) No propongas audiencias nuevas.'}

REGLAS CRÍTICAS DE COMPATIBILIDAD CON EL DCO (para que el texto se vea PERFECTO en la imagen):
- "copy_principal" (titular): MÁXIMO 7 palabras, contundente.
- "desarrollo" (cuerpo): 1 frase, máximo ~18 palabras, sin repetir el nombre de la vitamina/beneficio textual (eso va en el chip).
- "cierre" (CTA): máximo 6 palabras, accionable.
- "vitamina_chip": el nutriente/beneficio corto (ej: "Complejo B", "Vitaminas A, C y E"), máx 25 caracteres. Si la marca no maneja vitaminas, deja "".
- Respeta tono y palabras de la marca; jamás uses las palabras prohibidas.
${extraInstructions ? `- Instrucción adicional del usuario: ${extraInstructions}` : ''}
${kvImagePart ? '- Se adjunta la imagen KV (key visual) de referencia que se va a usar en el DCO — mirala antes de escribir: el copy debe encajar con lo que efectivamente se ve ahí (producto, escena, mood, colores, personas), no ser genérico. No describas la imagen en el copy, solo dejate influenciar por ella.\n- CRÍTICO — IGUALÁ LA BREVEDAD REAL DEL KV: si la imagen de referencia tiene texto visible (titular, beneficios, CTA), tu copy_principal/beneficios/cierre deben tener UNA LONGITUD SIMILAR a esos textos reales — no una oración larga. Un titular de KV real casi siempre son 2-6 palabras contundentes (ej: "HECHA PA\' TRABAJAR"), NUNCA una frase completa tipo "La moto que te acompaña en cada trayecto". Si dudás entre una versión corta y una elaborada, elegí SIEMPRE la más corta.' : ''}
- CRÍTICO — COHERENCIA: copy_principal, beneficios, desarrollo y cierre son UN SOLO MENSAJE, no piezas sueltas. Alguien que lea SOLO el titular + los beneficios (sin nada más) tiene que entender de qué trata sin esfuerzo. PROHIBIDO un copy_principal que sea una palabra de jerga o doble sentido aislada (tipo "Camella", "Ríndete", "Dale") que no se explique sola ni conecte directo con los beneficios/drivers de esa audiencia — si usás una palabra así, tiene que quedar claro por el resto del copy qué significa en el contexto de la marca/producto.
${kvImagePart ? '- CRÍTICO — FÓRMULA DEL TITULAR: mirá si el titular visible en el KV sigue un patrón rellenable (ej. el KV dice literalmente "HECHA PA\' TRABAJAR", lo que implica una plantilla repetible "HECHA PA\' ___"). Si detectás un patrón así, TODAS las variantes de copy_principal deben usar ese mismo patrón literal — solo cambia la palabra/frase del espacio en blanco. El resto del patrón (prefijo/sufijo, mayúsculas, apóstrofes) se mantiene IDÉNTICO al KV. Si el titular del KV es una frase única sin un espacio evidente para rellenar, no inventes un patrón — generá libremente respetando las demás reglas.\\n- ⛔ EL RELLENO NO PUEDE SER UN SINÓNIMO GENÉRICO INTERCAMBIABLE: la palabra/frase que completa el patrón tiene que ser tan específica de ESA audiencia puntual que sonaría raro o falso puesta en boca de otra audiencia. PROHIBIDO usar la misma familia de palabra vacía en varias audiencias solo cambiando el sustantivo (ej. si una audiencia usó "cada venta", la siguiente NO puede ser "cada subida" o "cada entrega" — son la misma idea reciclada con otro disfraz). Pensá en el verbo/momento/detalle CONCRETO de la vida de esa audiencia que nadie más usaría.' : ''}
- CRÍTICO — VOZ CREATIVA, NO ROBÓTICA: el copy tiene que sonar como lo escribió un humano con personalidad y punto de vista, no una plantilla corporativa con el sustantivo cambiado. Prohibido el piloto automático publicitario (frases tipo "lo que necesitas para triunfar", "vive tu mejor momento", "haz que pase" repetido sin variación real). Buscá SIEMPRE un ángulo específico, una imagen mental concreta, un dejo de humor/ironía/ternura o una tensión emocional real que ESA audiencia puntual reconocería como propia — algo que la haga sentir "esto lo escribieron pensando en mí", no "esto le sirve a cualquiera". Si al leer dos titulares de audiencias distintas notás que son la misma frase con una palabra cambiada, reescribilos: cada audiencia necesita su propio ángulo, no una variación cosmética del mismo molde.
- CRÍTICO — CONTEXTO COLOMBIANO Y TONO CONGRUENTE: todo el copy debe sonar como español colombiano real y natural (expresiones, giros, tuteo/voseo según corresponda a la marca) — nunca un español panlatino genérico de manual de traducción. Además, el copy nuevo tiene que ser CONGRUENTE con el tono que YA tiene el KV de referencia: si el KV es urgente y directo, no lo vuelvas poético; si es cercano y coloquial, no lo vuelvas corporativo o formal; si tiene humor, mantené ese humor. Tiene que sentirse escrito por la MISMA persona que escribió el titular original del KV, no por alguien con una voz distinta.
${zoneLengthInstruction}
${beneficiosCountInstruction}
${buildSubheadInstruction(!!kvImagePart)}

DEVUELVE SOLO JSON VÁLIDO (sin texto adicional, sin markdown) con esta forma EXACTA:
{
  "identity": {
    "marca": "string",
    "tono": "string",
    "formula": "string (la estructura recurrente detectada)",
    "palabras_positivas": ["..."],
    "palabras_prohibidas": ["..."],
    "resumen": "string (2-3 frases de la identidad de copy)"
  },
  "audiencias": [
    {
      "nombre": "string",
      "audiencia_referencia": "string",
      "drivers": "string",
      "nueva": false,
      "copies": [
        { "variante": "A_brand", "concepto": "string corto", "copy_principal": "string", "desarrollo": "string", "cierre": "string", "vitamina_chip": "string"${benefitZoneCount > 0 ? `, "beneficios": ["exactamente ${benefitZoneCount} bullets cortos"]` : ''} }
      ]
    }
  ]
}`;

    let parsed: any;
    try {
        const client = new Anthropic({ apiKey: claudeApiKey });
        const callOnce = async (feedback: string): Promise<any> => {
            const fullPrompt = feedback ? `${prompt}\n\n${feedback}` : prompt;
            const content: any = kvImagePart
                ? [{ type: 'image', source: { type: 'base64', media_type: kvImagePart.mime, data: kvImagePart.data } }, { type: 'text', text: fullPrompt }]
                : fullPrompt;
            const resp = await client.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 8000,
                messages: [{ role: 'user', content }],
            });
            let text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
            text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
            const start = text.indexOf('{'); const end = text.lastIndexOf('}');
            if (start >= 0 && end > start) text = text.slice(start, end + 1);
            return JSON.parse(text);
        };
        parsed = await callOnce('');
        // Validación dura de brevedad: medida por código, reintento con el detalle exacto.
        const violations = collectCopyViolations(parsed);
        if (violations.length) {
            console.warn(`[DCO copies] ${violations.length} violaciones de brevedad — reintentando con feedback`);
            try {
                const retried = await callOnce(brevityRetryFeedback(violations));
                if (collectCopyViolations(retried).length < violations.length) parsed = retried;
            } catch (e: any) { console.warn('[DCO copies] reintento falló, se conserva la primera respuesta:', e.message); }
        }
    } catch (e: any) {
        return c.json({ error: 'Error generando copies con Claude: ' + e.message }, 500);
    }

    // ── Construir las "piezas" (filas del cuadro) DCO-compatibles ──────────────
    const defaultMedio = brief.medios[0] || 'META';
    const pieces: any[] = [];
    let n = 1;
    for (const a of (parsed.audiencias || [])) {
        for (const cp of (a.copies || [])) {
            const copyBlock = buildCopyBlock(cp.copy_principal || '', cp.desarrollo || '', cp.cierre || '');
            const parsedCopy = parseCopyText(copyBlock);
            // si el modelo trajo vitamina_chip explícito, respétalo
            if (cp.vitamina_chip) parsedCopy.vitamina_chip = String(cp.vitamina_chip).slice(0, 25);
            const adapted = adaptCopyToFamily({ ...parsedCopy }, 'square');
            pieces.push({
                rowIndex:      pieces.length,
                piezas:        n++,
                mes:           brief.mes || '',
                campana:       brief.campaña || '',
                territorio:    a.territorio || 'NACIONAL',
                referencia:    '',
                audiencia:     a.nombre || '',
                audienciaRef:  a.audiencia_referencia || '',
                drivers:       a.drivers || '',
                medio:         defaultMedio,
                formatoAnuncio:'Link Ad',
                creativo:      '',
                tamano:        '1080x1080',
                formato:       'Feed Square 1:1',
                peso:          '80KB',
                texto:         adapted.headline,
                objetivo:      a.objetivo || 'Awareness',
                geografia:     'NACIONAL',
                concepto:      cp.concepto || '',
                imagenVideo:   'Imagen',
                copyFull:      copyBlock,
                copy_principal: cp.copy_principal || '',
                desarrollo:     cp.desarrollo || '',
                cierre:         cp.cierre || '',
                beneficios:    Array.isArray(cp.beneficios) ? cp.beneficios.filter(Boolean) : [],
                copyPreview:   `${cp.copy_principal || ''} — ${cp.desarrollo || ''}`.slice(0, 200),
                // parsed para el DCO
                parsedCopy,
                vitamina_chip: parsedCopy.vitamina_chip,
                tono:          parsed.identity?.tono || '',
                variante:      cp.variante || '',
                observaciones: '',
                nuevaAudiencia: !!a.nueva,
                formatId:      'feed_square',
                platform:      FORMATS['feed_square'].platform,
            });
        }
    }

    return c.json({
        identity: { ...DEFAULT_COPY_RULES, ...(parsed.identity || {}) },
        pieces,
        sourceAudiences: brief.audiencias.map(a => a.audiencia).filter(Boolean),
        total: pieces.length,
    });
});

// ─── POST /generate-copies-from-audiences — genera copys SIN Excel, desde un form ──
// A diferencia de /generate-copies (que exige un cuadro con copies existentes para
// inferir la identidad), acá la identidad de copy viene del perfil de marca ya
// aprendido (copy_identity guardado de una corrida previa, o si nunca se generó,
// se deriva del análisis visual de los KVs) — y las audiencias las tipea el usuario
// directo en un formulario (cantidad libre, no un número fijo).
dcoRoutes.post('/generate-copies-from-audiences', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const profileId: string = String(body.profileId || 'generic');
    const audiences: { name: string; ageRange: string; interests: string; characterId?: string; wardrobe?: string; headwear?: string; environment?: string }[] = Array.isArray(body.audiences) ? body.audiences : [];
    const variantsPerAudience = Math.min(Math.max(parseInt(String(body.variantsPerAudience || '3')) || 3, 1), 6);
    const extraInstructions = String(body.instructions || '').trim();
    // KV de referencia (opcional, base64 — este endpoint recibe JSON, no FormData) —
    // mismo motivo que en /generate-copies: sin esto el copy se generaba a ciegas de
    // la imagen real que se va a usar en el DCO.
    const kvImagePart: { data: string; mime: string } | null =
        body.kvImageBase64 ? { data: String(body.kvImageBase64), mime: String(body.kvImageMime || 'image/jpeg') } : null;
    // Zonas marcadas a mano (opcional) — mismo criterio que /generate-copies: el largo
    // del copy se calcula del espacio real de cada zona en vez de un límite genérico.
    const manualZonesForCopy: Partial<Record<string, { x: number; y: number; w: number; h: number }>> | null =
        body.manualZones && typeof body.manualZones === 'object' ? body.manualZones : null;
    const refWidth  = parseInt(String(body.refWidth  || '0')) || 0;
    const refHeight = parseInt(String(body.refHeight || '0')) || 0;
    const zoneLengthInstruction = buildZoneLengthInstruction(manualZonesForCopy, refWidth, refHeight);
    const benefitZoneCount = countBenefitZones(manualZonesForCopy);
    const beneficiosCountInstruction = buildBeneficiosCountInstruction(benefitZoneCount);

    if (!audiences.length) return c.json({ error: 'Se requiere al menos 1 audiencia' }, 400);

    const claudeApiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!claudeApiKey) return c.json({ error: 'Falta ANTHROPIC_API_KEY en el backend' }, 500);

    // ── Identidad de copy: reutilizar la guardada, o derivarla del análisis visual ──
    let brandName = '';
    let copyIdentityBlock = '';
    if (profileId !== 'generic') {
        await ensureBrandProfilesTable();
        const { data: profile } = await supabase
            .from('dco_brand_profiles')
            .select('name, analysis_summary, copy_identity')
            .eq('id', profileId)
            .single();
        if (profile) {
            brandName = (profile as any).name || '';
            const savedCopyIdentity = (profile as any).copy_identity || {};
            const hasSavedIdentity = savedCopyIdentity && (savedCopyIdentity.tono || savedCopyIdentity.formula);
            if (hasSavedIdentity) {
                copyIdentityBlock = `IDENTIDAD DE COPY YA CONOCIDA de esta marca (de una generación anterior — reutilízala tal cual, no la reinventes):
Tono: ${savedCopyIdentity.tono || '—'}
Fórmula/estructura recurrente: ${savedCopyIdentity.formula || '—'}
Palabras que SÍ usa: ${(savedCopyIdentity.palabras_positivas || []).join(', ') || '—'}
Palabras PROHIBIDAS: ${(savedCopyIdentity.palabras_prohibidas || []).join(', ') || '—'}`;
            } else {
                const visual = (profile as any).analysis_summary || {};
                copyIdentityBlock = `Esta marca todavía no tiene una identidad de copy guardada de generaciones anteriores. Derívala de su identidad VISUAL ya aprendida de sus KVs:
${JSON.stringify(visual).slice(0, 2000)}
Infiere un tono de copy coherente con esta identidad visual (ej: si la marca es vibrante/juvenil visualmente, el copy debe sonar así también).`;
            }
        }
    }
    if (!copyIdentityBlock) {
        copyIdentityBlock = 'No hay identidad de marca previa disponible — usa buenas prácticas generales de copywriting publicitario, tono cercano y claro.';
    }

    const audienceDigest = audiences.map((a, i) =>
        `AUDIENCIA ${i + 1}: ${a.name || `Audiencia ${i + 1}`}\n  Edad: ${a.ageRange || '—'}\n  Intereses: ${a.interests || '—'}`
    ).join('\n\n');

    const prompt = `Eres el COPYWRITER LÍDER de la marca "${brandName || 'la marca'}". No tienes un cuadro de materiales previo — el usuario te da las audiencias directamente y vos generás los copys desde cero, respetando la identidad de la marca.

${copyIdentityBlock}

AUDIENCIAS A CUBRIR (definidas por el usuario):
${audienceDigest}

GENERA, para CADA audiencia de arriba, ${variantsPerAudience} variantes de copy (A_brand=enfoque marca/emocional, B_producto=enfoque beneficio/producto, C_lifestyle=enfoque estilo de vida — usa las que correspondan según cuántas variantes se piden).

REGLAS CRÍTICAS DE COMPATIBILIDAD CON EL DCO (para que el texto se vea PERFECTO en la imagen):
- "copy_principal" (titular): MÁXIMO 7 palabras, contundente.
- "desarrollo" (cuerpo): 1 frase, máximo ~18 palabras.
- "cierre" (CTA): máximo 6 palabras, accionable.
- "vitamina_chip": nutriente/beneficio corto si aplica (máx 25 caracteres), si no aplica deja "".
${extraInstructions ? `- Instrucción adicional del usuario: ${extraInstructions}` : ''}
${kvImagePart ? '- Se adjunta la imagen KV (key visual) de referencia que se va a usar en el DCO — mirala antes de escribir: el copy debe encajar con lo que efectivamente se ve ahí (producto, escena, mood, colores, personas), no ser genérico. No describas la imagen en el copy, solo dejate influenciar por ella.\n- CRÍTICO — IGUALÁ LA BREVEDAD REAL DEL KV: si la imagen de referencia tiene texto visible (titular, beneficios, CTA), tu copy_principal/beneficios/cierre deben tener UNA LONGITUD SIMILAR a esos textos reales — no una oración larga. Un titular de KV real casi siempre son 2-6 palabras contundentes (ej: "HECHA PA\' TRABAJAR"), NUNCA una frase completa tipo "La moto que te acompaña en cada trayecto". Si dudás entre una versión corta y una elaborada, elegí SIEMPRE la más corta.' : ''}
- CRÍTICO — COHERENCIA: copy_principal, beneficios, desarrollo y cierre son UN SOLO MENSAJE, no piezas sueltas. Alguien que lea SOLO el titular + los beneficios (sin nada más) tiene que entender de qué trata sin esfuerzo. PROHIBIDO un copy_principal que sea una palabra de jerga o doble sentido aislada (tipo "Camella", "Ríndete", "Dale") que no se explique sola ni conecte directo con los beneficios/drivers de esa audiencia — si usás una palabra así, tiene que quedar claro por el resto del copy qué significa en el contexto de la marca/producto.
${kvImagePart ? '- CRÍTICO — FÓRMULA DEL TITULAR: mirá si el titular visible en el KV sigue un patrón rellenable (ej. el KV dice literalmente "HECHA PA\' TRABAJAR", lo que implica una plantilla repetible "HECHA PA\' ___"). Si detectás un patrón así, TODAS las variantes de copy_principal deben usar ese mismo patrón literal — solo cambia la palabra/frase del espacio en blanco. El resto del patrón (prefijo/sufijo, mayúsculas, apóstrofes) se mantiene IDÉNTICO al KV. Si el titular del KV es una frase única sin un espacio evidente para rellenar, no inventes un patrón — generá libremente respetando las demás reglas.\\n- ⛔ EL RELLENO NO PUEDE SER UN SINÓNIMO GENÉRICO INTERCAMBIABLE: la palabra/frase que completa el patrón tiene que ser tan específica de ESA audiencia puntual que sonaría raro o falso puesta en boca de otra audiencia. PROHIBIDO usar la misma familia de palabra vacía en varias audiencias solo cambiando el sustantivo (ej. si una audiencia usó "cada venta", la siguiente NO puede ser "cada subida" o "cada entrega" — son la misma idea reciclada con otro disfraz). Pensá en el verbo/momento/detalle CONCRETO de la vida de esa audiencia que nadie más usaría.' : ''}
- CRÍTICO — VOZ CREATIVA, NO ROBÓTICA: el copy tiene que sonar como lo escribió un humano con personalidad y punto de vista, no una plantilla corporativa con el sustantivo cambiado. Prohibido el piloto automático publicitario (frases tipo "lo que necesitas para triunfar", "vive tu mejor momento", "haz que pase" repetido sin variación real). Buscá SIEMPRE un ángulo específico, una imagen mental concreta, un dejo de humor/ironía/ternura o una tensión emocional real que ESA audiencia puntual reconocería como propia — algo que la haga sentir "esto lo escribieron pensando en mí", no "esto le sirve a cualquiera". Si al leer dos titulares de audiencias distintas notás que son la misma frase con una palabra cambiada, reescribilos: cada audiencia necesita su propio ángulo, no una variación cosmética del mismo molde.
- CRÍTICO — CONTEXTO COLOMBIANO Y TONO CONGRUENTE: todo el copy debe sonar como español colombiano real y natural (expresiones, giros, tuteo/voseo según corresponda a la marca) — nunca un español panlatino genérico de manual de traducción. Además, el copy nuevo tiene que ser CONGRUENTE con el tono que YA tiene el KV de referencia: si el KV es urgente y directo, no lo vuelvas poético; si es cercano y coloquial, no lo vuelvas corporativo o formal; si tiene humor, mantené ese humor. Tiene que sentirse escrito por la MISMA persona que escribió el titular original del KV, no por alguien con una voz distinta.
${zoneLengthInstruction}
${beneficiosCountInstruction}
${buildSubheadInstruction(!!kvImagePart)}

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
      "copies": [{ "variante": "A_brand", "concepto": "string corto", "copy_principal": "string", "desarrollo": "string", "cierre": "string", "vitamina_chip": "string"${benefitZoneCount > 0 ? `, "beneficios": ["exactamente ${benefitZoneCount} bullets cortos"]` : ''} }]
    }
  ]
}`;

    let parsed: any;
    try {
        const client = new Anthropic({ apiKey: claudeApiKey });
        const callOnce = async (feedback: string): Promise<any> => {
            const fullPrompt = feedback ? `${prompt}\n\n${feedback}` : prompt;
            const content: any = kvImagePart
                ? [{ type: 'image', source: { type: 'base64', media_type: kvImagePart.mime, data: kvImagePart.data } }, { type: 'text', text: fullPrompt }]
                : fullPrompt;
            const resp = await client.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 8000,
                messages: [{ role: 'user', content }],
            });
            let text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
            text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
            const start = text.indexOf('{'); const end = text.lastIndexOf('}');
            if (start >= 0 && end > start) text = text.slice(start, end + 1);
            return JSON.parse(text);
        };
        parsed = await callOnce('');
        // Validación dura de brevedad: medida por código, reintento con el detalle exacto.
        const violations = collectCopyViolations(parsed);
        if (violations.length) {
            console.warn(`[DCO copies-audiences] ${violations.length} violaciones de brevedad — reintentando con feedback`);
            try {
                const retried = await callOnce(brevityRetryFeedback(violations));
                if (collectCopyViolations(retried).length < violations.length) parsed = retried;
            } catch (e: any) { console.warn('[DCO copies-audiences] reintento falló, se conserva la primera respuesta:', e.message); }
        }
    } catch (e: any) {
        return c.json({ error: 'Error generando copies con Claude: ' + e.message }, 500);
    }

    // ── Construir las "piezas" (mismas reglas que /generate-copies) ──
    const pieces: any[] = [];
    let n = 1;
    // Empatar cada audiencia GENERADA (Claude las devuelve con su propio texto) con la
    // audiencia ORIGINAL que tipeó el usuario, por nombre — para heredar el characterId
    // que Claude no conoce ni debe inventar (el personaje lo elige el usuario, no la IA).
    const findMatchingInput = (nombreGenerado: string) => {
        const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
        const n1 = norm(nombreGenerado || '');
        return audiences.find(a => a.name && (norm(a.name) === n1 || n1.includes(norm(a.name)) || norm(a.name).includes(n1)));
    };
    for (const a of (parsed.audiencias || [])) {
        const matchedInput = findMatchingInput(a.nombre || '');
        for (const cp of (a.copies || [])) {
            const copyBlock = buildCopyBlock(cp.copy_principal || '', cp.desarrollo || '', cp.cierre || '');
            const parsedCopy = parseCopyText(copyBlock);
            if (cp.vitamina_chip) parsedCopy.vitamina_chip = String(cp.vitamina_chip).slice(0, 25);
            const adapted = adaptCopyToFamily({ ...parsedCopy }, 'square');
            pieces.push({
                rowIndex:      pieces.length,
                piezas:        n++,
                mes:           '',
                campana:       '',
                territorio:    'NACIONAL',
                referencia:    '',
                characterId:   matchedInput?.characterId || undefined,
                // Perfil visual de la audiencia (ropa/casco/entorno) — viaja tal cual desde
                // /suggest-audiences para alimentar /recreate-formats sin que el frontend
                // tenga que re-mapear nada por nombre.
                wardrobe:      matchedInput?.wardrobe || '',
                headwear:      matchedInput?.headwear || '',
                environment:   matchedInput?.environment || '',
                audiencia:     a.nombre || '',
                audienciaRef:  a.audiencia_referencia || '',
                drivers:       a.drivers || '',
                medio:         'META',
                formatoAnuncio:'Link Ad',
                creativo:      '',
                tamano:        '1080x1080',
                formato:       'Feed Square 1:1',
                peso:          '80KB',
                texto:         adapted.headline,
                objetivo:      'Awareness',
                geografia:     'NACIONAL',
                concepto:      cp.concepto || '',
                imagenVideo:   'Imagen',
                copyFull:      copyBlock,
                copy_principal: cp.copy_principal || '',
                desarrollo:     cp.desarrollo || '',
                cierre:         cp.cierre || '',
                // Directo del JSON de Claude, sin pasar por el round-trip de texto
                // (buildCopyBlock/parseCopyText) que no sabe de beneficios como lista.
                beneficios:    Array.isArray(cp.beneficios) ? cp.beneficios.filter(Boolean) : [],
                copyPreview:   `${cp.copy_principal || ''} — ${cp.desarrollo || ''}`.slice(0, 200),
                parsedCopy,
                vitamina_chip: parsedCopy.vitamina_chip,
                tono:          parsed.identity?.tono || '',
                variante:      cp.variante || '',
                observaciones: '',
                nuevaAudiencia: false,
                formatId:      'feed_square',
                platform:      FORMATS['feed_square'].platform,
            });
        }
    }

    return c.json({
        identity: { ...DEFAULT_COPY_RULES, ...(parsed.identity || {}) },
        pieces,
        sourceAudiences: audiences.map(a => a.name).filter(Boolean),
        total: pieces.length,
    });
});

// ─── POST /suggest-audiences — propone audiencias SOLO a partir del KV (sin tipear nada) ──
// Lee el copy visible del KV (titular/subtítulo/beneficios/CTA) y su fórmula/patrón (misma
// detección que ya usa /generate-copies-from-audiences, ej. "HECHA PA' TRABAJAR" → "HECHA
// PA' ___"), y propone `count` audiencias reales cuyos drivers conecten con ese mensaje —
// devuelve el mismo shape que el estado `audienceList` del frontend (name/ageRange/interests)
// para poblarlo directo, sin transformar nada del lado del cliente.
dcoRoutes.post('/suggest-audiences', async (c) => {
    const formData = await c.req.formData();
    const kvFile = formData.get('kvImage') as File | null;
    if (!kvFile) return c.json({ error: 'KV image requerido' }, 400);
    const productCategory = ((formData.get('productCategory') as string) || '').trim();
    // Contexto de negocio libre y opcional (ej. "ETB — telefonía móvil e internet en
    // Colombia") — no depende de que la IA adivine bien la categoría/rubro solo mirando
    // la imagen; ancla las audiencias/copy al negocio real declarado por el usuario.
    const businessContext = ((formData.get('businessContext') as string) || '').trim();
    const count = Math.min(Math.max(parseInt(String(formData.get('count') || '3')) || 3, 1), 6);

    const claudeApiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!claudeApiKey) return c.json({ error: 'Falta ANTHROPIC_API_KEY en el backend' }, 500);

    const kvBuf = Buffer.from(await kvFile.arrayBuffer());
    const kvImagePart = { data: kvBuf.toString('base64'), mime: kvFile.type || 'image/jpeg' };

    const prompt = `Eres un ESTRATEGA DE AUDIENCIAS publicitario. Se adjunta el KV (key visual) real de una marca${productCategory ? ` de categoría "${productCategory}"` : ''}.${businessContext ? ` CONTEXTO DEL NEGOCIO (dado por el usuario, tomalo como fuente de verdad — no lo contradigas ni lo ignores por lo que creas ver en la imagen): "${businessContext}".` : ''} No tienes ninguna audiencia previa — tenés que proponerlas vos mismo, mirando lo que la imagen comunica${businessContext ? ' y lo que sabés del negocio por el contexto de arriba' : ''}.

PASO 1 — LEÉ el copy visible literal en la imagen (titular, subtítulo, bullets de beneficio, CTA) y detectá su mensaje central y, si existe, su fórmula rellenable (ej. si el KV dice literalmente "HECHA PA' TRABAJAR", eso implica una plantilla "HECHA PA' ___" — identificá el equivalente para este KV, si lo hay).

PASO 2 — Con base en ESE mensaje (no genérico, no inventado) proponé exactamente ${count} audiencias reales y DIVERSAS entre sí para las que este producto/mensaje tiene sentido (ej. si el copy habla de trabajo/ingresos/movimiento, pensá en perfiles que viven de eso de formas distintas — repartidor/domiciliario, mototaxista/independiente, microempresario/vendedor ambulante — no repitas el mismo perfil con otro nombre).

⛔ PROHIBIDO EL CLICHÉ DE MANUAL DE MARKETING: nada de segmentos genéricos de power point tipo "Millennials activos", "Madres modernas", "Profesionales exitosos" o "Amantes de la tecnología" — esos podrían pegarse en CUALQUIER marca y no dicen nada real. Cada audiencia tiene que ser un personaje específico y reconocible de la vida real, con una situación concreta (ej. no "emprendedores", sino "vendedora ambulante de arepas que necesita coordinar pedidos por WhatsApp mientras atiende su puesto"). Si te imaginás a una persona real y no a una categoría de PowerPoint, vas bien.

Para CADA audiencia devolvé:
- "name": nombre corto identificable (2-4 palabras, ej. "Domiciliarios urbanos").
- "ageRange": rango de edad realista (ej. "22-38 años").
- "interests": sus drivers/motivaciones reales en relación al mensaje leído en el KV (1 frase corta).
- "wardrobe": ropa realista y específica que usaría ESTA audiencia en la escena (ej. "chaqueta de mensajería con reflectivos, jean, tenis"), distinta de lo que lleva puesto el personaje del KV si el perfil de audiencia lo amerita — NO copies la ropa del KV literal, pensá qué usaría de verdad esta persona. ⛔ NUNCA menciones marcas/plataformas reales de terceros (ej. Rappi, PedidosYa, DiDi, Uber Eats, u otras) ni "logo de la empresa" — describí la ropa siempre genérica y sin marca (reflectivos, colores, cortes, sin nombres ni logos de terceros).
- "headwear": qué lleva en la cabeza si aplica (tipo de casco/gorra/ninguno) — coherente con la actividad de la audiencia (ej. casco integral con visera para repartidor urbano, casco abierto para mototaxista). Mismo criterio: genérico, sin calcomanías/logos de marcas o plataformas reales de terceros.
- "environment": entorno/escenario realista donde se movería esta audiencia (ej. "calle urbana congestionada de una ciudad latinoamericana, edificios y locales comerciales", "avenida con tráfico de motos y buses", "zona de mercado/plaza con puestos ambulantes") — debe seguir siendo compatible con el mood/iluminación de la marca (franjas diagonales, luz cálida), no un entorno genérico desconectado del estilo del KV.

DEVOLVÉ SOLO JSON VÁLIDO (sin markdown, sin texto adicional) con esta forma EXACTA:
{
  "audiences": [
    { "name": "string", "ageRange": "string", "interests": "string", "wardrobe": "string", "headwear": "string", "environment": "string" }
  ]
}
El array "audiences" debe tener EXACTAMENTE ${count} elementos.`;

    try {
        const client = new Anthropic({ apiKey: claudeApiKey });
        const resp = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: kvImagePart.mime as any, data: kvImagePart.data } },
                    { type: 'text', text: prompt },
                ],
            }],
        });
        let text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
        text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        const start = text.indexOf('{'); const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) text = text.slice(start, end + 1);
        const parsed = JSON.parse(text);
        const audiences = (Array.isArray(parsed.audiences) ? parsed.audiences : []).slice(0, count).map((a: any) => ({
            name: String(a.name || '').trim(),
            ageRange: String(a.ageRange || '').trim(),
            interests: String(a.interests || '').trim(),
            wardrobe: String(a.wardrobe || '').trim(),
            headwear: String(a.headwear || '').trim(),
            environment: String(a.environment || '').trim(),
        }));
        if (!audiences.length) return c.json({ error: 'Claude no devolvió audiencias válidas' }, 500);
        return c.json({ audiences });
    } catch (e: any) {
        return c.json({ error: 'Error sugiriendo audiencias con Claude: ' + e.message }, 500);
    }
});

// ─── POST /recreate-formats — redimensiona/extiende el KV REAL a nuevos formatos ──────
// A diferencia de /generate ("un solo pintor": la IA solo pinta la foto, el texto lo pone
// código encima), acá el objetivo es OTRO: partir de una pieza YA APROBADA y adaptarla a
// otros tamaños como lo haría un diseñador — la MISMA foto, el MISMO texto/logos, solo el
// encuadre/composición cambia para el nuevo aspect ratio. GPT-image edita el KV real
// (outpainting) y dibuja el texto él mismo — por eso NO pasa por el gate "cero texto" ni
// por el QA de OCR que usa /generate, que existen justamente para el caso contrario.
dcoRoutes.post('/recreate-formats', async (c) => {
    const formData = await c.req.formData();
    const kvFile = formData.get('kvImage') as File | null;
    if (!kvFile) return c.json({ error: 'KV image requerido' }, 400);
    const formatIds = ((formData.get('formats') as string) || '').split(',').map(f => f.trim()).filter(f => f && FORMATS[f]);
    if (!formatIds.length) return c.json({ error: 'Al menos 1 formato válido requerido' }, 400);
    // Copy nuevo opcional (ej. para otra audiencia) — si no viene, se preserva el texto
    // literal del KV tal cual (comportamiento original). Si viene, se le pide a GPT-image
    // que REEMPLACE el texto por este, manteniendo el mismo estilo/tipografía/layout.
    let newCopy: { headline?: string; subhead?: string; cta?: string; beneficios?: string[] } | null = null;
    try {
        const raw = formData.get('copy') as string | null;
        if (raw) newCopy = JSON.parse(raw);
    } catch { /* ignore */ }
    const hasNewCopy = !!(newCopy && (newCopy.headline || newCopy.subhead || newCopy.cta || newCopy.beneficios?.length));

    // Perfil visual de audiencia (opcional, viene de /suggest-audiences) — a diferencia del
    // copy (que solo cambia texto), esto le pide a GPT-image que cambie REALMENTE al
    // personaje (ropa/casco) y el entorno de fondo, mantieniendo moto + sistema visual de
    // marca + logos intactos. Sin esto, se preserva el personaje/entorno del KV tal cual
    // (mismo comportamiento que antes de este campo).
    const characterWardrobe = ((formData.get('characterWardrobe') as string) || '').trim();
    const characterHeadwear = ((formData.get('characterHeadwear') as string) || '').trim();
    const environment       = ((formData.get('environment') as string) || '').trim();
    const hasVisualProfile  = !!(characterWardrobe || characterHeadwear || environment);
    // Modo creativo — a diferencia de arriba (que solo cambia ropa/entorno manteniendo la
    // MISMA pose/ángulo/acción), esto libera TAMBIÉN la escena/ángulo/acción para que la IA
    // proponga algo fresco por audiencia (ej. de calle urbana a pista de carreras) — lo
    // ÚNICO que se mantiene 100% fiel siempre es el producto protagonista. Por defecto
    // apagado (false) — algunas marcas necesitan conservar un ángulo/encuadre específico.
    const varyScene = ((formData.get('varyScene') as string) || '').trim() === 'true';

    const openaiKey = process.env.OPENAI_API_KEY || '';
    const geminiKey = process.env.GEMINI_API_KEY || '';
    if (!openaiKey && !geminiKey) return c.json({ error: 'Falta OPENAI_API_KEY y GEMINI_API_KEY en el backend' }, 500);

    const kvBuf = Buffer.from(await kvFile.arrayBuffer());
    const kvMime = kvFile.type || 'image/jpeg';

    // Formatos banner (skyscraper/billboard/half-page/MREC) exceden el rango de aspect
    // ratio/píxeles que soporta /v1/images/edits de GPT-image — para esos, el mismo
    // outpainting se hace con Gemini (generateContent con la imagen del KV + el mismo
    // prompt), que no tiene esa restricción de tamaño exacto. Se fuerza el recorte final
    // al tamaño EXACTO del formato después, porque Gemini no respeta un tamaño en px
    // pixel-perfecto — solo se acerca al aspect ratio pedido en el prompt.
    async function callGeminiRecreate(promptText: string, targetW: number, targetH: number, sourceBuf: Buffer, sourceMime: string): Promise<string> {
        if (!geminiKey) throw new Error('Falta GEMINI_API_KEY en el backend (requerida para formatos banner)');
        const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [
                    { inlineData: { mimeType: sourceMime, data: sourceBuf.toString('base64') } },
                    { text: promptText },
                ] }],
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
            }),
            signal: AbortSignal.timeout(120_000),
        });
        const data: any = await res.json();
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message || JSON.stringify(data?.error || {}).slice(0, 150)}`);
        const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
        if (!part) throw new Error('Gemini: respuesta sin imagen (posible bloqueo de moderación)');
        const rawBuf = Buffer.from(part.inlineData.data, 'base64');
        const cropped = await sharp(rawBuf).resize(targetW, targetH, { fit: 'cover' }).png().toBuffer();
        return cropped.toString('base64');
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    return stream(c, async (s) => {
        for (const formatId of formatIds) {
            const fmt = FORMATS[formatId];
            await s.write(`data: ${JSON.stringify({ type: 'start', formatId, platform: fmt.platform })}\n\n`);
            const heartbeat = setInterval(async () => {
                try { await s.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
            }, 5000);
            try {
                const size = gptImageSizeFor(fmt.family);
                const useGemini = !size; // formatos banner: GPT-image no los soporta, cae a Gemini
                if (useGemini && !geminiKey) {
                    await s.write(`data: ${JSON.stringify({ type: 'error', formatId, error: `GPT-image no soporta el formato "${fmt.family}" y falta GEMINI_API_KEY para el respaldo` })}\n\n`);
                    continue;
                }
                // Prompt "creativo" (reemplazo de copy + cambio de personaje/entorno) — se le
                // pide siempre a GPT-image, sea directo (formatos que soporta) o como paso 1
                // de un banner (ver más abajo). Parametrizado por tamaño/plataforma target
                // para poder reutilizarlo tanto en el formato final como en el proxy intermedio.
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
${varyScene ? `- MODO CREATIVO — ESCENA Y ÁNGULO LIBRES: para esta audiencia, proponé una escena, ángulo de cámara, pose y acción NUEVOS y frescos — NO repitas la composición/encuadre/entorno literal de la referencia. Pensá en qué situación real, distinta a la de la referencia, conectaría mejor con esta audiencia específica (otro lugar, otro momento del día, otra acción). Lo ÚNICO que se mantiene 100% fiel, sin excepción, es el PRODUCTO PROTAGONISTA (mismo tipo/modelo/color/detalles EXACTOS que en la referencia, perfectamente reconocible) y el sistema visual de marca (paleta de colores, franjas/patrones, calidad/mood de luz que lo conecten con esta marca). El personaje${characterWardrobe || characterHeadwear ? ` (${[characterWardrobe, characterHeadwear].filter(Boolean).join(', ')})` : ''}, su pose, el entorno${environment ? ` (ej. ${environment})` : ''}, el ángulo de cámara y la acción SÍ pueden reinventarse por completo respecto a la referencia.
  ⛔ PROHIBIDO ABSOLUTO: NO agregues logos, marcas, stickers ni nombres de NINGUNA empresa/plataforma real de terceros en el casco/gorra, la ropa, accesorios, vallas o cualquier parte de la escena. Toda la ropa/accesorios deben ser genéricos y sin marca, salvo los logos de ESTA marca ya autorizados arriba.` : hasVisualProfile ? `- CAMBIO DE PERSONAJE Y ENTORNO — esta pieza es para una audiencia distinta a la del KV original, así que el personaje y el fondo SÍ deben adaptarse (a diferencia del texto/logos, que no cambian):
${characterWardrobe ? `  Ropa del personaje: ${characterWardrobe}` : ''}
${characterHeadwear ? `  Casco/cabeza: ${characterHeadwear}` : ''}
${environment ? `  Entorno/fondo: ${environment}` : ''}
  El personaje sigue siendo el protagonista humano de la escena, en la MISMA acción/interacción general con el producto o servicio que se ve en la referencia (ej. si en la referencia usa/sostiene/interactúa con el producto de una forma particular, mantené esa misma forma de interacción) — solo cambian su vestuario y el escenario de fondo. El PRODUCTO PROTAGONISTA de la referencia (mismo tipo/modelo/color exacto, sea lo que sea — vehículo, dispositivo, empaque, etc.) y el sistema visual de marca (paleta de colores, franjas/patrones, calidad/mood de luz) se mantienen intactos — el entorno nuevo debe seguir sintiéndose de esta marca, no un estilo fotográfico distinto.
  ⛔ PROHIBIDO ABSOLUTO: NO agregues logos, marcas, stickers ni nombres de NINGUNA empresa/plataforma real de terceros (ej. apps de delivery, marcas de ropa, otras marcas competidoras) en el casco/gorra, la ropa, accesorios, vallas o cualquier parte de la escena — ni siquiera si la audiencia sugiere una actividad asociada a una plataforma conocida. Toda la ropa/accesorios deben ser genéricos y sin marca (lisos, sin logos, sin texto de terceros), salvo los logos de ESTA marca que ya están explícitamente autorizados arriba.` : `- La foto/escena (persona, producto, fondo, iluminación, franjas/diagonales de marca) es LA MISMA — extendé/rellená el fondo de forma natural y coherente con el estilo de la referencia para cubrir el nuevo lienzo, en vez de generar una escena distinta.`}
- Reacomodá tamaños/posiciones de texto, logos y foto para que la composición se vea profesional en el nuevo aspect ratio — todo debe quedar legible, nada cortado ni apretado.
- No agregues elementos que no estén en la referencia. No quites ninguno de los que sí están (salvo el texto reemplazado arriba y el personaje/entorno si aplica cambio de audiencia).

Devolvé SOLO la imagen final, sin texto adicional.`;
                };

                async function callOpenAIImageEdit(promptText: string, size: string, imageBuf: Buffer, imageMime: string): Promise<string> {
                    let res: any, data: any;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 4000));
                        const form = new FormData();
                        form.append('model', OPENAI_IMAGE_MODEL);
                        form.append('prompt', promptText);
                        form.append('size', size);
                        form.append('image[]', new Blob([new Uint8Array(imageBuf)], { type: imageMime }), 'kv.jpg');
                        res = await fetch('https://api.openai.com/v1/images/edits', {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${openaiKey}` },
                            body: form,
                            signal: AbortSignal.timeout(240_000),
                        });
                        data = await res.json() as any;
                        if (res.status !== 429 && res.status !== 503) break;
                        console.warn(`[recreate-formats] ${res.status} — retry ${attempt + 1}/3`);
                    }
                    if (!res.ok || data?.error) {
                        throw new Error(`OpenAI ${res.status}: ${data?.error?.message || JSON.stringify(data?.error || {}).slice(0, 150)}`);
                    }
                    const b64 = data?.data?.[0]?.b64_json;
                    if (!b64) throw new Error('OpenAI: respuesta sin imagen (posible bloqueo de moderación)');
                    return b64;
                }

                // Banner + cambio creativo (copy nuevo o cambio de personaje/entorno) NO se
                // resuelve acá — antes se hacían las 2 llamadas (GPT + Gemini) seguidas DENTRO
                // de esta misma solicitud, lo que casi duplicaba el tiempo total y en producción
                // (Render) superaba el timeout del proxy, dejando al usuario esperando sin
                // ningún error. Ahora ese caso se resuelve con 2 SOLICITUDES cortas separadas
                // desde el frontend: (1) este mismo endpoint con el formato proxy soportado
                // (GPT hace el trabajo creativo), (2) POST /resize-with-gemini con esa imagen
                // ya finalizada (Gemini solo la extiende al tamaño banner real).
                if (useGemini && (hasNewCopy || hasVisualProfile)) {
                    await s.write(`data: ${JSON.stringify({ type: 'error', formatId, error: 'Formato banner con copy/audiencia nueva requiere el flujo de 2 solicitudes (proxy + /resize-with-gemini) — no se resuelve en una sola llamada.' })}\n\n`);
                    continue;
                }

                let b64: string;
                if (!useGemini) {
                    // Formato estándar — GPT-image hace todo el trabajo directo, como siempre.
                    b64 = await callOpenAIImageEdit(buildCreativePrompt(fmt.width, fmt.height, fmt.platform), size!, kvBuf, kvMime);
                } else {
                    // Banner SIN cambio creativo — Gemini directo sobre el KV, como en la
                    // prueba 1 (ya validada excelente): solo extender/recomponer, cero contenido nuevo.
                    b64 = await callGeminiRecreate(buildCreativePrompt(fmt.width, fmt.height, fmt.platform), fmt.width, fmt.height, kvBuf, kvMime);
                }
                await s.write(`data: ${JSON.stringify({ type: 'result', formatId, platform: fmt.platform, width: fmt.width, height: fmt.height, imageBase64: b64, mimeType: 'image/png' })}\n\n`);
            } catch (err: any) {
                await s.write(`data: ${JSON.stringify({ type: 'error', formatId, error: err.message || 'Error' })}\n\n`);
            } finally {
                clearInterval(heartbeat);
            }
        }
        await s.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    });
});

// ─── POST /resize-with-gemini — paso 2 del flujo de banner con audiencia ──────────────
// Recibe una imagen YA FINALIZADA (la salida de /recreate-formats en el formato proxy,
// paso 1) y ÚNICAMENTE la extiende/recompone al aspect ratio extremo de un banner —
// nunca toca texto/logos/personaje. Solicitud corta y propia (una sola llamada a Gemini)
// para que ninguna conexión HTTP quede abierta esperando 2 llamadas de IA seguidas — eso
// era lo que superaba el timeout del proxy en producción (Render) y dejaba la pieza
// "cargando" para siempre sin ningún error.
dcoRoutes.post('/resize-with-gemini', async (c) => {
    const formData = await c.req.formData();
    const imageFile = formData.get('image') as File | null;
    if (!imageFile) return c.json({ error: 'image requerido' }, 400);
    const width = parseInt(String(formData.get('width') || '0'), 10);
    const height = parseInt(String(formData.get('height') || '0'), 10);
    if (!width || !height) return c.json({ error: 'width y height requeridos' }, 400);

    const geminiKey = process.env.GEMINI_API_KEY || '';
    if (!geminiKey) return c.json({ error: 'Falta GEMINI_API_KEY en el backend' }, 500);

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
        const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [
                    { inlineData: { mimeType: imgMime, data: imgBuf.toString('base64') } },
                    { text: prompt },
                ] }],
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
            }),
            signal: AbortSignal.timeout(90_000),
        });
        const data: any = await res.json();
        if (!res.ok) return c.json({ error: `Gemini ${res.status}: ${data?.error?.message || JSON.stringify(data?.error || {}).slice(0, 150)}` }, 500);
        const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
        if (!part) return c.json({ error: 'Gemini: respuesta sin imagen (posible bloqueo de moderación)' }, 500);
        const rawBuf = Buffer.from(part.inlineData.data, 'base64');
        const cropped = await sharp(rawBuf).resize(width, height, { fit: 'cover' }).png().toBuffer();
        return c.json({ imageBase64: cropped.toString('base64'), mimeType: 'image/png' });
    } catch (err: any) {
        return c.json({ error: err.message || 'Error' }, 500);
    }
});

// ─── POST /export-cuadro — genera un cuadro de materiales NUEVO (estructura exacta) ──
dcoRoutes.post('/export-cuadro', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const pieces: any[] = body.pieces || [];
    const meta = body.meta || {};
    if (!pieces.length) return c.json({ error: 'No hay piezas para exportar' }, 400);

    const wbx = new ExcelJS.Workbook();
    wbx.creator = 'MUSE DCO';
    wbx.created = new Date();
    const ws = wbx.addWorksheet(`${(meta.marca || 'MARCA').toUpperCase()} MATRICES`, { views: [{ state: 'frozen', ySplit: 1 }] });

    const RED_HEADER = 'E06C75', RED_AI = 'C0392B';
    // Columna A vacía (margen, idéntico al adjunto) + headers desde B
    ws.getColumn(1).width = 3;
    CUADRO_HEADERS.forEach((h, i) => {
        const col = ws.getColumn(i + 2);
        col.width = h === 'COPY' ? 52 : h === 'AUDIENCIAS REFERENCIA' || h === 'DRIVERS' ? 38 : h.length > 16 ? 24 : 16;
    });
    const headerRow = ws.getRow(1);
    headerRow.height = 34;
    const AI_COLS = new Set(['TONO', 'VARIANTE', 'OBSERVACIONES CREATIVAS']);
    CUADRO_HEADERS.forEach((h, i) => {
        const cell = headerRow.getCell(i + 2);
        cell.value = h;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (AI_COLS.has(h) ? RED_AI : RED_HEADER) } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });

    pieces.forEach((p, ri) => {
        const row = ws.getRow(ri + 2);
        const vals = [
            p.piezas ?? (ri + 1), p.mes || '', p.campana || p.campaña || '', p.territorio || 'NACIONAL',
            p.referencia || '', p.audiencia || '', p.audienciaRef || '', p.drivers || '',
            p.medio || 'META', p.formatoAnuncio || 'Link Ad', p.creativo || '', p.tamano || '1080x1080',
            p.formato || 'Feed Square 1:1', p.peso || '80KB', p.texto || '', p.objetivo || 'Awareness',
            p.geografia || 'NACIONAL', p.concepto || '', p.imagenVideo || 'Imagen', p.copyFull || '',
            p.fechaInicio || '', p.fechaFinal || '', p.fechaSalida || '', p.status || '', p.linkDrive || '',
            p.comentarios || (p.nuevaAudiencia ? 'Audiencia nueva sugerida por IA' : ''),
            p.tono || '', p.variante || '', p.observaciones || '',
        ];
        vals.forEach((v, i) => {
            const cell = row.getCell(i + 2);
            cell.value = v as any;
            cell.font = { size: 9, name: 'Calibri' };
            cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
            cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
        });
    });

    const out = await wbx.xlsx.writeBuffer();
    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', 'attachment; filename="cuadro_materiales_generado.xlsx"');
    return c.body(Buffer.from(out));
});

// ─── POST /export-brief — actualiza Excel con STATUS y FECHA SALIDA ───────────
dcoRoutes.post('/export-brief', async (c) => {
    const formData = await c.req.formData();
    const file     = formData.get('brief') as File | null;
    const rowsJson = formData.get('rows')  as string | null;
    if (!file || !rowsJson) return c.json({ error: 'Faltan parámetros' }, 400);

    const doneRowIndices: number[] = JSON.parse(rowsJson);
    const videoPromptsJson = formData.get('videoPrompts') as string | null;
    const videoPromptsMap: Record<number, string> = videoPromptsJson ? JSON.parse(videoPromptsJson) : {};
    const today = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const buf = Buffer.from(await file.arrayBuffer());
    const wb  = XLSX.read(buf, { type: 'buffer', cellStyles: true }); // preserve original styling
    const TARR_KW = ['SOFA', 'MATRICES', 'SOFA'];
    const tarrSh  = wb.SheetNames.find(n => TARR_KW.some(kw => n.toUpperCase().includes(kw))) || wb.SheetNames[0];
    const ws  = wb.Sheets[tarrSh];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Encuentra encabezado con STATUS
    let hdrIdx = -1;
    const colMap: Record<string, number> = {};
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const row = rows[i];
        if (row.some((c: any) => String(c).toUpperCase().includes('STATUS'))) {
            hdrIdx = i;
            row.forEach((cell: any, idx: number) => {
                const key = normalizeKey(String(cell || ''));
                if (key) colMap[key] = idx;
            });
            break;
        }
    }

    const fechaSalidaIdx = colMap['FECHASALIDA'];
    const statusIdx      = colMap['STATUS'];

    const range = ws['!ref']
        ? XLSX.utils.decode_range(ws['!ref'])
        : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };

    // Determine column for PROMPT VIDEO 15s (after last column or find existing)
    const promptVideoKey = normalizeKey('PROMPT VIDEO 15s');
    let promptVideoIdx = colMap[promptVideoKey];
    if (promptVideoIdx === undefined && hdrIdx >= 0) {
        // Add as new last column
        promptVideoIdx = range.e.c + 1;
        const hdrRef = XLSX.utils.encode_cell({ r: hdrIdx, c: promptVideoIdx });
        ws[hdrRef] = { v: 'PROMPT VIDEO 15s', t: 's' };
        range.e.c = promptVideoIdx;
    }

    for (const rowIdx of doneRowIndices) {
        if (fechaSalidaIdx !== undefined) {
            const ref = XLSX.utils.encode_cell({ r: rowIdx, c: fechaSalidaIdx });
            ws[ref] = { v: today, t: 's' };
            range.e.r = Math.max(range.e.r, rowIdx);
            range.e.c = Math.max(range.e.c, fechaSalidaIdx);
        }
        if (statusIdx !== undefined) {
            const ref = XLSX.utils.encode_cell({ r: rowIdx, c: statusIdx });
            ws[ref] = { v: 'PENDIENTE DE APROBACIÓN', t: 's' };
            range.e.r = Math.max(range.e.r, rowIdx);
            range.e.c = Math.max(range.e.c, statusIdx);
        }
        // Write video prompt if available for this row
        if (promptVideoIdx !== undefined && videoPromptsMap[rowIdx]) {
            const ref = XLSX.utils.encode_cell({ r: rowIdx, c: promptVideoIdx });
            ws[ref] = { v: videoPromptsMap[rowIdx], t: 's' };
            range.e.r = Math.max(range.e.r, rowIdx);
            range.e.c = Math.max(range.e.c, promptVideoIdx);
        }
    }

    ws['!ref'] = XLSX.utils.encode_range(range);
    const outBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true }); // preserve styling

    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', 'attachment; filename="cuadro_materiales_actualizado.xlsx"');
    return c.body(outBuf);
});

// ─── GIF animator: frames JPEG/PNG de Gemini → GIF animado ─────────────────────
async function buildAnimatedGif(
    frames: { data: string; mime: string }[],
    _width: number,
    _height: number
): Promise<string | null> {
    try {
        const GIFEncoder = (await import('gif-encoder-2')).default;
        const { PNG } = await import('pngjs');
        const jpeg = (await import('jpeg-js')).default;

        // Decode all frames first to get ACTUAL dimensions (Gemini may differ from fmt)
        const decoded: { data: Uint8Array; width: number; height: number }[] = [];
        for (const frame of frames) {
            const buf = Buffer.from(frame.data, 'base64');
            try {
                const isJpeg = frame.mime.includes('jpeg') || frame.mime.includes('jpg');
                if (isJpeg) {
                    const d = jpeg.decode(buf, { useTArray: true });
                    decoded.push({ data: d.data as Uint8Array, width: d.width, height: d.height });
                } else {
                    const png = PNG.sync.read(buf);
                    decoded.push({ data: new Uint8Array(png.data), width: png.width, height: png.height });
                }
            } catch {
                // skip unreadable frame
            }
        }

        if (decoded.length < 2) {
            console.warn('[DCO GIF] Not enough valid frames:', decoded.length);
            return null;
        }

        // Use ACTUAL dimensions from first decoded frame
        const actualWidth  = decoded[0].width;
        const actualHeight = decoded[0].height;
        console.log('[DCO GIF] Encoding', decoded.length, 'frames at', actualWidth + 'x' + actualHeight);

        const encoder = new GIFEncoder(actualWidth, actualHeight, 'neuquant', true);
        encoder.setDelay(500);
        encoder.setRepeat(0);
        encoder.setQuality(10);
        encoder.start();

        for (const f of decoded) {
            encoder.addFrame(f.data);
        }

        encoder.finish();
        const gifData = encoder.out.getData();
        if (!gifData || gifData.length < 100) return null;
        console.log('[DCO GIF] Done:', Math.round(gifData.length / 1024), 'KB');
        return Buffer.from(gifData).toString('base64');
    } catch (err: any) {
        console.warn('[DCO GIF] Build failed:', err.message);
        return null;
    }
}

// ─── Gemini Vision: analiza imagen generada → descripción estructurada ──────────
async function analyzeImageWithGemini(
    imageBase64: string,
    imageMime: string,
    productCategory: string,
    productBenefits: string[],
    geminiApiKey: string
): Promise<string | null> {
    if (!geminiApiKey) return null;
    try {
        const mime = imageMime.includes('png') ? 'image/png' : 'image/jpeg';
        const res = await fetch(`${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [
                    { inlineData: { mimeType: mime, data: imageBase64 } },
                    { text: `Eres un director creativo. Analiza esta imagen publicitaria generada con máximo detalle visual.
CONTEXTO — Categoría: ${productCategory || 'detectar'} | Features: ${productBenefits.join(', ') || 'detectar'}
Responde EXACTAMENTE con este formato (si hay múltiples personas, descríbelas TODAS en PERSONAJES):
PERSONAJES: [lista TODOS los visibles — para cada uno: género, edad estimada, outfit completo con colores exactos, expresión, postura, qué hace. Ej: "Hombre 1: masculino, 30–36 años, camiseta Colombia amarilla, puño en alto celebrando. Mujer 1: femenina, 28–34 años, camiseta azul Millonarios, boca abierta de emoción."]
AMBIENTE: [locación exacta, hora del día, temperatura de luz en K, paleta de colores dominante, elementos de fondo fijos]
PRODUCTO: [producto, posición en frame, features visibles, cómo interactúa con los personajes]
MARCA: [logo posición, colores de marca, tagline visible, elementos gráficos]
BENEFICIO_HÉROE: [el beneficio o feature más prominente y cinematográfico de esta imagen]
MOMENTO: [micro-momento emocional colectivo — qué pasa exactamente, qué sienten los personajes]` },
                ]}],
                generationConfig: { maxOutputTokens: 700 },
            }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return null;
        const data = await res.json() as any;
        const text = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text?.trim() || null;
        if (text) console.log('[DCO Vision/Gemini] OK:', text.slice(0, 80) + '...');
        return text;
    } catch (err: any) {
        console.warn('[DCO Vision/Gemini] Failed:', (err as Error).message);
        return null;
    }
}

// ─── Claude: escribe libreto 3 clips usando análisis visual de Gemini ────────
async function buildVideoPromptFromImage(
    imageBase64: string,
    imageMime: string,
    copy: { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string },
    fmtId: string,
    fmt: { width: number; height: number; family: string; platform: string },
    drivers: string,
    claudeApiKey: string,
    productCategory: string = '',
    productBenefits: string[] = [],
    geminiAnalysis: string | null = null
): Promise<string> {
    const { headline, body, cta, subhead, vitamina_chip } = copy;
    const ar = fmt.family === 'story' ? '9:16' : fmt.family === 'square' ? '1:1' : fmt.family === 'landscape' ? '16:9' : fmt.family === 'portrait' ? '4:5' : '1:1';
    const ctaLine = cta && !/(compra|llama|visita|descarga|regístrate|lleva)/i.test(cta) ? cta : '¿Listo para sentirlo?';
    const badge = vitamina_chip ? `Badge "${vitamina_chip}" aparece a los 4s` : 'sin badge';
    const bodyVO = (body || subhead || headline).slice(0, 140);

    const interactionMap = `MAPA DE INTERACCIÓN PRODUCTO — usa el más relevante en CLIP 2:
• TV + Magic Remote → plano detalle: mano con Magic Remote en el aire, gesto de control, TV responde; rostro iluminado por la pantalla
• TV + OLED/4K/imagen → cámara acercándose a píxeles de la pantalla, colores explotan, corte a rostro con asombro
• TV + fútbol/mundial/selección → gol en pantalla, persona salta del sofá, emoción pura e incontrolable
• TV + gaming/1ms → control en manos, pantalla reflejada en rostro, momento de victoria decisiva
• Nevera + InstaView → nudillo golpea suave la puerta de vidrio, luz interior se activa revelando alimentos organizados
• Nevera + Door-in-Door → mini-puerta interior se desliza, mano toma bebida sin abrir nevera entera
• Lavadora + TurboWash → dedo presiona botón, vórtice de agua arranca, temporizador corre veloz
• Lavadora + AI Direct Drive → plano detalle del tambor en silencio absoluto, tela delicada protegida
• Laptop → dedos en teclado con ritmo, pantalla con trabajo creativo real, rostro en estado de flujo
• Audio/Soundbar → visualización de ondas de sonido, ojos del personaje se cierran en éxtasis auditivo
• Aire/Purificador → partículas de aire limpio visibles, persona respira profundo y lento`;

    // Claude always receives the image directly — Gemini analysis is extra context when available
    const visualCtx = geminiAnalysis
        ? `ANÁLISIS VISUAL (Gemini Vision — úsalo como referencia pero CONFÍA en lo que ves en la imagen adjunta):
${geminiAnalysis}

INSTRUCCIÓN CRÍTICA: Tienes la imagen real adjunta. Si el análisis de arriba no coincide con lo que ves (e.g. describe 1 persona pero ves un grupo), USA LO QUE VES en la imagen. La imagen manda.`
        : `PRODUCTO: ${productCategory || 'detectar'} | FEATURES: ${productBenefits.join(', ') || 'detectar de imagen'}
INSTRUCCIÓN: Analiza la imagen adjunta directamente para extraer personajes, ambiente y contexto.`;

    const userPrompt = `${visualCtx}

COPY:
- Headline: "${headline}"
- Body VO: "${bodyVO}"
- Drivers: "${drivers || 'calidad de vida, aspiración, bienestar'}"
- CTA/cierre: "${ctaLine}"
- ${badge}

${interactionMap}

Write a PROFESSIONAL 30-SECOND TV COMMERCIAL PRODUCTION BRIEF — 3 clips of 10s forming ONE continuous ad with dramatic arc: INICIO → NUDO → DESENLACE. The story sells the product's key benefits to the Latin Colombian audience.

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
Shot 2 [3–7s]: [IN ENGLISH — EXACT character-product interaction from the interaction map; most cinematic selling moment; lens, blocking, emotion]
Shot 3 [7–10s]: [IN ENGLISH — reaction shot; genuine unscripted emotion, not performed]
VO (Spanish, professional — slightly more intimate, product benefits land naturally): "${bodyVO}"
SFX: [IN ENGLISH — specific sound of the product's hero benefit in action]
${badge}

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
3. VO cues embedded in Spanish inside quotes at each act: "${headline}" → "${bodyVO}" → "${ctaLine}", voice spec (Colombian professional announcer, gender from image).
4. Global specs at the end: ${ar}, 24fps, warm cinematic grade, same character/outfit/space across all acts, no morphing, no new characters, realistic anatomy.
[WRITE THE ACTUAL PROMPT HERE — not a description of it]

VOICE SPEC: Detect gender from the image → write exactly "Voz masculina colombiana, español neutro profesional" or "Voz femenina colombiana, español neutro profesional". Tone: authoritative yet warm, premium TV commercial cadence — natural pauses between product claims, microsilence before CTA. NEVER casual, NEVER TTS, NEVER generic.`;

    try {
        const client = new Anthropic({ apiKey: claudeApiKey });
        const ctrl = new AbortController();
        const t = setTimeout(() => {
            console.warn('[DCO Video/Claude] TIMEOUT 60s — aborting');
            ctrl.abort();
        }, 60_000);
        try {
            // ALWAYS send the image so Claude can verify directly what's in it.
            // Gemini analysis (if present) is included as context in userPrompt.
            const msgContent: any = [
                { type: 'image', source: { type: 'base64', media_type: (imageMime.includes('png') ? 'image/png' : 'image/jpeg') as any, data: imageBase64 } },
                { type: 'text', text: userPrompt },
            ];
            const resp = await client.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 3200,
                system: 'You are a senior creative director specializing in hyperrealistic TV commercials for the Colombian market. You write production briefs and Veo3 prompts so precise they execute perfectly in a single generation. You always detect the gender and group composition from the visual analysis and adjust accordingly. ALL characters must be adults 18+ — if the image shows minors, treat them as young adults 18–22.',
                messages: [{ role: 'user', content: msgContent }],
            }, { signal: ctrl.signal });
            clearTimeout(t);
            const text = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : '';
            if (text) console.log('[DCO Video/Claude] Brief OK:', text.slice(0, 120) + '...');
            else console.warn('[DCO Video/Claude] Response empty — content type:', resp.content[0]?.type, 'stop_reason:', resp.stop_reason);
            return text || '';
        } finally { clearTimeout(t); }
    } catch (err: any) {
        console.warn('[DCO Video/Claude] ERROR:', (err as Error).name, '—', (err as Error).message);
        return '';
    }
}

// ─── POST /generate — generación SSE (modo manual + modo brief) ───────────────
dcoRoutes.post('/generate', async (c) => {
    const formData = await c.req.formData();
    const kvFile   = formData.get('kvImage') as File | null;
    if (!kvFile) return c.json({ error: 'KV image requerido' }, 400);

    const tasksJson           = formData.get('tasks')               as string | null;
    const formatsStr          = ((formData.get('formats')           as string) || 'feed_square').trim();
    const profileId           = ((formData.get('brandProfile')      as string) || 'tarrito_rojo').trim();
    const customIdentityBlock = ((formData.get('customIdentityBlock') as string) || '').trim() || undefined;
    const productCategory     = ((formData.get('productCategory')     as string) || '').trim();
    // Proveedor de imagen — GPT-image es el default (validado manualmente contra Gemini,
    // mejor resultado); Gemini queda disponible como opt-in explícito para comparar
    // (arquitectura "un solo pintor" ya separa "quién pinta la foto" de QA/composición, así
    // que el proveedor es intercambiable sin tocar el resto del pipeline).
    const imageProvider: 'gemini' | 'gpt' = ((formData.get('imageProvider') as string) || 'gpt').trim() === 'gemini' ? 'gemini' : 'gpt';
    const productBenefitsRaw  = ((formData.get('productBenefits')     as string) || '').trim();
    const productBenefits: string[] = productBenefitsRaw ? JSON.parse(productBenefitsRaw).filter(Boolean) : [];
    let customQaRules: string[] = [];
    try { const raw = formData.get('customQaRules') as string | null; if (raw) customQaRules = JSON.parse(raw); } catch { /* ignore */ }
    const isTarrito           = profileId === 'tarrito_rojo';

    // Zonas marcadas a mano por el usuario sobre el KV (DCOView dibuja un recuadro por
    // elemento — headline/subhead/chip/body/cta = texto de copy; logo/brand_name/
    // conglomerate_logo/character = elementos graficos/de composicion — en % del ancho/
    // alto de la imagen). Si vienen, se le agrega al prompt una instruccion MANDATORIA
    // de posicion para esos elementos puntuales, en vez de dejar que la IA la adivine.
    // "benefit_1".."benefit_N" son dinamicas (una por bullet marcado, ver ZONE_LABELS
    // en DCOView.tsx) — el tipo queda como string en vez de una union fija.
    let manualZones: Record<string, { x: number; y: number; w: number; h: number }> = {};
    try { const raw = formData.get('manualZones') as string | null; if (raw) manualZones = JSON.parse(raw); } catch { /* ignore */ }
    const BENEFIT_ZONE_RE = /^benefit_(\d+)$/;
    // Elementos de copy (texto a renderizar) vs. elementos graficos (imagen de referencia
    // ya subida a posicionar) necesitan una frase distinta en el prompt.
    const TEXT_ZONE_LABEL: Record<string, string> = {
        headline: 'HEADLINE', subhead: 'SUBHEAD', vitamina_chip: 'CHIP/BADGE', body: 'BODY', cta: 'CTA',
        // brand_name (wordmark sin logo subido) pasa a ser zona de TEXTO compuesta por
        // código, igual que headline/subhead — antes era la única zona que Gemini seguía
        // dibujando libremente (sin límite de tamaño), causa confirmada del wordmark
        // gigante sin control ("BOXER" ocupando media pieza).
        brand_name: 'BRAND NAME/WORDMARK',
    };
    function textZoneLabel(key: string): string | null {
        if (TEXT_ZONE_LABEL[key]) return TEXT_ZONE_LABEL[key];
        const m = key.match(BENEFIT_ZONE_RE);
        return m ? `BENEFIT BULLET #${m[1]}` : null;
    }
    const GRAPHIC_ZONE_LABEL: Record<string, string> = {
        character: 'CHARACTER/PERSON (the reference character photo, if provided)',
    };
    // Texto real por zona — usado tanto para la instrucción "renderizá EXACTO esto" que
    // ahora se le da a Gemini (ver dentro de processTask) como para el overlay de
    // respaldo si el QA determina que Gemini no lo logró.
    function textForZoneKey(key: string, copy: any): string | undefined {
        if (key === 'headline')      return copy.headline;
        if (key === 'subhead')       return copy.subhead;
        if (key === 'vitamina_chip') return copy.vitamina_chip;
        if (key === 'cta')           return copy.cta;
        const m = key.match(BENEFIT_ZONE_RE);
        if (m) return copy.beneficios?.[parseInt(m[1], 10) - 1];
        return undefined;
    }
    // ── Layout de la capa de marca ─────────────────────────────────────────────
    // Toda pieza lleva SIEMPRE su texto compuesto por la capa determinística. Si el
    // usuario marcó una zona a mano, manda esa; si no, se usa un layout editorial por
    // defecto según la familia del formato — así la generación funciona igual de
    // consistente sin obligar a dibujar recuadros cada vez.
    const FAMILY_DEFAULT_ZONES: Record<string, Record<string, ZoneBox>> = {
        square:    { headline: { x: 6, y: 13, w: 56, h: 17 }, subhead: { x: 6, y: 31, w: 50, h: 9 },  chip: { x: 64, y: 15, w: 24, h: 6 },   cta: { x: 24, y: 88, w: 52, h: 7 } },
        story:     { headline: { x: 8, y: 15, w: 84, h: 13 }, subhead: { x: 8, y: 29, w: 74, h: 7 },  chip: { x: 8, y: 9, w: 26, h: 4.5 },   cta: { x: 20, y: 88, w: 60, h: 5.5 } },
        portrait:  { headline: { x: 6, y: 13, w: 60, h: 15 }, subhead: { x: 6, y: 29, w: 52, h: 8 },  chip: { x: 64, y: 15, w: 24, h: 5.5 }, cta: { x: 24, y: 88, w: 52, h: 6.5 } },
        landscape: { headline: { x: 5, y: 16, w: 48, h: 20 }, subhead: { x: 5, y: 38, w: 42, h: 10 }, chip: { x: 5, y: 8, w: 18, h: 7 },     cta: { x: 5, y: 84, w: 30, h: 9 } },
        micro:     { headline: { x: 4, y: 8, w: 60, h: 30 },  subhead: { x: 4, y: 42, w: 55, h: 16 }, chip: { x: 68, y: 8, w: 28, h: 14 },   cta: { x: 66, y: 60, w: 30, h: 24 } },
    };
    function benefitDefaultZones(family: string, count: number): ZoneBox[] {
        const base = family === 'story' ? { x: 8, y: 52, w: 56, h: 6, gap: 2 }
            : family === 'landscape'    ? { x: 5, y: 52, w: 38, h: 8.5, gap: 2.5 }
            :                             { x: 6, y: 47, w: 46, h: 7.5, gap: 2.2 };
        return Array.from({ length: count }, (_, i) => ({ x: base.x, y: base.y + i * (base.h + base.gap), w: base.w, h: base.h }));
    }
    // Sin logo-imagen subido, el wordmark ("BOXER") se compone como TEXTO por código en
    // vez de dejar que Gemini lo dibuje libre (esquina superior izquierda, más ancho que
    // un ícono de logo porque es una palabra, no un símbolo).
    const DEFAULT_BRAND_NAME_ZONE: ZoneBox = { x: 4, y: 4, w: 40, h: 10 };
    function resolveBrandTextZones(copy: any, family: string, brandNameText: string | undefined, hasLogoFile: boolean): BrandTextZone[] {
        const d = FAMILY_DEFAULT_ZONES[family] || FAMILY_DEFAULT_ZONES.square;
        const zones: BrandTextZone[] = [];
        if (copy.headline)      zones.push({ kind: 'headline', text: copy.headline,      ...(manualZones.headline      || d.headline) });
        if (copy.subhead)       zones.push({ kind: 'subhead',  text: copy.subhead,       ...(manualZones.subhead       || d.subhead) });
        if (copy.vitamina_chip) zones.push({ kind: 'chip',     text: copy.vitamina_chip, ...(manualZones.vitamina_chip || d.chip) });
        if (copy.cta)           zones.push({ kind: 'cta',      text: copy.cta,           ...(manualZones.cta           || d.cta) });
        let bens: string[] = Array.isArray(copy.beneficios) ? copy.beneficios.filter(Boolean) : [];
        // Flujos viejos traen solo `body` (a veces el join "a · b · c") — se reconstruye la lista.
        if (!bens.length && copy.body) bens = String(copy.body).split('·').map((s: string) => s.trim()).filter(Boolean).slice(0, 4);
        const defs = benefitDefaultZones(family, bens.length);
        bens.forEach((b, i) => zones.push({ kind: 'benefit', text: b, index: i, ...(manualZones[`benefit_${i + 1}`] || defs[i]) }));
        if (!hasLogoFile && brandNameText && brandNameText.trim()) {
            zones.push({ kind: 'brand_name', text: brandNameText.trim(), ...(manualZones.brand_name || DEFAULT_BRAND_NAME_ZONE) });
        }
        return zones;
    }
    // Marcas custom/aprendidas caen a 'generic' (NUNCA a Tarrito) → cero filtración.
    const profile             = BRAND_PROFILES[profileId] || BRAND_PROFILES['generic'];

    const kvBase64 = Buffer.from(await kvFile.arrayBuffer()).toString('base64');
    const kvMime   = kvFile.type || 'image/jpeg';
    const apiKey   = process.env.GEMINI_API_KEY || '';

    // Identidad de marca auto-extraída del KV subido — para cuando el usuario NO pasó por el
    // flujo explícito de "Aprender marca" (customIdentityBlock vacío) ni usa un perfil
    // built-in con su propio identityBlock a mano (Tarrito Rojo). Antes, ese caso (subir un
    // KV ad-hoc de una marca nueva, ej. Boxer/Grupo UMA) generaba con estilo 100% genérico,
    // sin relación real a los colores/tipografía/badges del KV. Se corre UNA vez por tanda
    // (no por pieza) y se reusa para todas las variantes — así "genera en masa" con la misma
    // identidad en vez de que cada pieza reinvente su propio estilo.
    let autoIdentityJson: any = null;
    if (!customIdentityBlock && !isTarrito && apiKey) {
        try {
            autoIdentityJson = await analyzeBrandIdentity(
                [{ inlineData: { data: kvBase64, mimeType: kvMime } }], 1, '', apiKey,
            );
            console.log('[DCO] Identidad auto-extraída del KV:', autoIdentityJson?.brandName || '(sin nombre)');
        } catch (e: any) {
            console.warn('[DCO] Fallo auto-extracción de identidad del KV (sigue sin ella):', e.message);
        }
    }

    // Color real del badge de beneficio, leído por píxeles directamente del KV en la zona
    // que el usuario marcó — no el hex "adivinado" por el modelo de visión (analyzeBrandIdentity
    // puede devolver un badge con un color mal alucinado, casi negro, que antes pasaba sin
    // ningún chequeo de plausibilidad). Se calcula UNA vez por tanda, igual que la identidad,
    // sobre la primera zona de beneficio marcada (asume el mismo color de badge en todos los
    // bullets — el caso normal en KVs reales).
    let sampledBenefitColor: string | null = null;
    const firstBenefitZoneEntry = Object.entries(manualZones).find(([k]) => BENEFIT_ZONE_RE.test(k));
    if (firstBenefitZoneEntry) {
        sampledBenefitColor = await sampleZoneDominantColor(kvBase64, firstBenefitZoneEntry[1]);
        if (sampledBenefitColor) console.log(`[DCO] Color de badge muestreado por píxeles del KV: ${sampledBenefitColor}`);
    }

    const productFileList = formData.getAll('productImage') as File[];
    // Max 2 product images to avoid OOM on Render 512MB — sequential to limit peak memory
    const productParts: { data: string; mime: string }[] = [];
    for (const f of productFileList.slice(0, 2)) {
        const buf = await f.arrayBuffer();
        const b64 = Buffer.from(buf).toString('base64');
        // Skip if image too large (> 800KB base64 ~ 600KB binary)
        if (b64.length > 800_000) { console.warn('[DCO] Product image too large, skipping:', f.name, b64.length); continue; }
        productParts.push({ data: b64, mime: f.type || 'image/jpeg' });
    }
    const hasProduct = productParts.length > 0;

    // Logo de marca (opcional) — imagen dedicada, separada del KV, para que el logo se
    // reproduzca fiel en vez de que la IA lo reinterprete a partir de la foto de escena.
    const logoFile = formData.get('logoImage') as File | null;
    let logoPart: { data: string; mime: string } | null = null;
    if (logoFile) {
        const buf = await logoFile.arrayBuffer();
        logoPart = { data: Buffer.from(buf).toString('base64'), mime: logoFile.type || 'image/png' };
    }
    const hasLogo = !!logoPart;

    // Logo del conglomerado (opcional) — mismo patrón que el logo de marca: imagen
    // dedicada aparte del KV para que se reproduzca fiel, no reinventado.
    const conglomerateLogoFile = formData.get('conglomerateLogoImage') as File | null;
    let conglomerateLogoPart: { data: string; mime: string } | null = null;
    if (conglomerateLogoFile) {
        const buf = await conglomerateLogoFile.arrayBuffer();
        conglomerateLogoPart = { data: Buffer.from(buf).toString('base64'), mime: conglomerateLogoFile.type || 'image/png' };
    }
    const hasConglomerateLogo = !!conglomerateLogoPart;

    // Badges/sellos adicionales (ej. lockup del fabricante "Preferida en 100 países",
    // fila de íconos de cumplimiento CBS/ABS/luces) — mismo patrón que logo/conglomerate_logo:
    // SIEMPRE compuestos determinísticamente sobre una zona marcada a mano (extra_logo_1,
    // extra_logo_2, ...), nunca dibujados por la IA. Sin posición por defecto — requieren
    // que el usuario marque su zona (no hay un lugar "obvio" único para un badge genérico).
    const extraLogoFiles = (formData.getAll('extraLogoImage') as File[]).slice(0, 4);
    const extraLogoParts: { data: string; mime: string }[] = [];
    for (const f of extraLogoFiles) {
        const buf = await f.arrayBuffer();
        extraLogoParts.push({ data: Buffer.from(buf).toString('base64'), mime: f.type || 'image/png' });
    }
    const EXTRA_LOGO_RE = /^extra_logo_(\d+)$/;
    const effectiveExtraLogoZones = extraLogoParts.map((_, i) => manualZones[`extra_logo_${i + 1}`]);

    // Los logos SIEMPRE se componen determinísticamente cuando hay un archivo subido —
    // nunca se le pide a Gemini que los dibuje (ver logoBlock/conglomerateLogoBlock en
    // buildPrompt). Si el usuario no marcó una zona a mano, se usa una posición por
    // defecto razonable en vez de dejarlo del todo a la suerte de la composición de Gemini.
    const DEFAULT_LOGO_ZONE              = { x: 76, y: 4, w: 20, h: 9 };  // esquina superior derecha
    const DEFAULT_CONGLOMERATE_LOGO_ZONE = { x: 4,  y: 4, w: 20, h: 9 };  // esquina superior izquierda
    // La cajita fija de arriba asume "logo chico en una esquina" para CUALQUIER marca —
    // pero analyzeBrandIdentity ya extrae logoPosition/logoSizePercent del KV real (ej.
    // BOXER: logo grande, protagonista, arriba a la izquierda). Antes ese dato se mandaba
    // solo como sugerencia de texto a Gemini y nunca se usaba para la zona real del
    // composite — se deriva acá una zona a medida de CADA marca en vez de una única
    // por defecto para todas.
    function deriveDefaultLogoZone(identity: any): { x: number; y: number; w: number; h: number } | null {
        if (!identity || typeof identity !== 'object') return null;
        const posMap: Record<string, { x: number; y: number }> = {
            'top-left': { x: 4, y: 4 }, 'top-right': { x: 76, y: 4 },
            'bottom-left': { x: 4, y: 84 }, 'bottom-right': { x: 76, y: 84 },
            'center': { x: 32, y: 40 },
            'inside-band-left': { x: 4, y: 84 }, 'inside-band-right': { x: 76, y: 84 }, 'inside-band-center': { x: 32, y: 84 },
        };
        const anchor = posMap[String(identity.logoPosition || '').toLowerCase().trim()];
        if (!anchor) return null; // sin dato util del KV — cae al default generico
        const sizePct = Number(identity.logoSizePercent);
        const w = Number.isFinite(sizePct) && sizePct > 0 ? Math.min(70, Math.max(10, sizePct)) : 20;
        return { x: anchor.x, y: anchor.y, w, h: w * 0.42 };
    }
    const identityForLogoDefault = customIdentityBlock
        ? (() => { try { return JSON.parse(customIdentityBlock); } catch { return null; } })()
        : autoIdentityJson;
    const smartLogoZone = deriveDefaultLogoZone(identityForLogoDefault);
    const effectiveLogoZone              = manualZones.logo              || (hasLogo              ? (smartLogoZone || DEFAULT_LOGO_ZONE) : undefined);
    const effectiveConglomerateLogoZone  = manualZones.conglomerate_logo || (hasConglomerateLogo   ? DEFAULT_CONGLOMERATE_LOGO_ZONE  : undefined);

    // Instrucción de posición para zonas NO-texto (logo/conglomerado siempre "dejar limpio,
    // se compone después"; brand_name/character siguen siendo dibujados por Gemini). Las
    // zonas de texto (headline/subhead/chip/cta/benefit_N) ya NO pasan por acá — Gemini
    // ahora recibe el texto real y una instrucción propia por tarea (ver processTask),
    // porque el usuario prefiere que la IA intente integrar el copy en el diseño real en
    // vez de blanquearlo y taparlo siempre con una caja genérica.
    const graphicZonesForInstruction: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const [key, z] of Object.entries(manualZones)) {
        if (textZoneLabel(key) === null && key !== 'logo' && key !== 'conglomerate_logo') graphicZonesForInstruction[key] = z;
    }
    if (effectiveLogoZone)             graphicZonesForInstruction.logo              = effectiveLogoZone;
    if (effectiveConglomerateLogoZone) graphicZonesForInstruction.conglomerate_logo = effectiveConglomerateLogoZone;

    const manualZoneInstruction = Object.entries(graphicZonesForInstruction)
        .map(([key, z]) => {
            const posSpec = `exactly ${z.x.toFixed(1)}% from left, ${z.y.toFixed(1)}% from top, spanning ${z.w.toFixed(1)}% width and ${z.h.toFixed(1)}% height of the frame`;
            const extraLogoMatch = key.match(EXTRA_LOGO_RE);
            if (key === 'logo' || key === 'conglomerate_logo' || extraLogoMatch) {
                const label = key === 'logo' ? 'BRAND LOGO' : key === 'conglomerate_logo' ? 'CONGLOMERATE/PARENT COMPANY LOGO' : `ADDITIONAL BRAND BADGE ${extraLogoMatch![1]} (e.g. manufacturer lockup, compliance/certification icons)`;
                return `- ${label} AREA: keep this area (${posSpec}) visually clean and empty — no text, no shape, no placeholder mark, no invented logo/badge. Do NOT draw anything here yourself. The real image will be composited on top after generation with pixel-perfect precision.`;
            }
            // "character" es un caso especial: a diferencia de un logo (que se puede escalar
            // a una caja exacta sin problema), forzar a la persona a encajar EXACTO en un
            // recuadro chico termina cortándole el cuerpo — pisando las reglas de anatomía/
            // no-crop de más abajo. Acá solo se ancla la posición aproximada (centro/base),
            // sin mandar a comprimir ni cortar el cuerpo para que quepa.
            if (key === 'character') {
                return `- CHARACTER/PERSON: position the character so they are anchored around ${z.x.toFixed(1)}%-${(z.x + z.w).toFixed(1)}% from left and ${z.y.toFixed(1)}%-${(z.y + z.h).toFixed(1)}% from top as their general placement in the frame. This is a user-specified ANCHOR AREA, not a hard crop box — the full body (head to feet) must STILL remain completely visible within the overall frame; expand beyond this area rather than cropping any body part. Anatomy/no-crop rules elsewhere in this prompt take priority over fitting exactly inside this box.`;
            }
            return `- ${GRAPHIC_ZONE_LABEL[key] || key.toUpperCase()}: place this element at ${posSpec}. This is a MANDATORY user-specified position — do NOT reposition, resize, or omit this element regardless of any other guidance elsewhere in this prompt.`;
        })
        .join('\n');

    // Personaje (opcional) — foto de referencia para consistencia entre generaciones.
    // Es el default GLOBAL para toda la tanda; cada tarea puede pisarlo con su propio
    // characterId (ej: una audiencia distinta con su propio personaje asignado en el
    // formulario de audiencias) — se resuelve por tarea dentro de processTask.
    const defaultCharacterId = ((formData.get('characterId') as string) || '').trim() || undefined;

    async function resolveCharacterForTask(taskCharacterId?: string) {
        const effectiveId = taskCharacterId || defaultCharacterId;
        const character = effectiveId ? await getCharacterPhotoBase64(effectiveId) : null;
        const characterIdentityInstruction = character
            ? `\n\n⚠️ CONSISTENCIA DE PERSONAJE: el protagonista humano de esta escena DEBE ser la misma persona que aparece en la foto de referencia adjunta (mismo rostro, tono de piel, tipo de cabello) — NO inventes una persona distinta. ${character.physicalNotes ? `Notas físicas: ${character.physicalNotes}.` : ''}`
            : '';
        return { character, characterIdentityInstruction };
    }

    type Task = {
        taskId: string;
        formatId: string;
        sceneDesc: string;
        // beneficios: lista de bullets cortos (uno por zona benefit_N marcada a mano);
        // body sigue existiendo como texto derivado (join) para no romper el resto del
        // pipeline (buildPrompt/buildCreativeSpec/QA/video prompt siguen esperando body).
        copy: { headline: string; subhead: string; vitamina_chip: string; body: string; cta: string; beneficios?: string[] };
        observaciones?: string;
        variante?: string;
        characterId?: string;
    };
    let tasks: Task[] = [];

    // Tono → mood modifier map
    const TONO_MODIFIERS: Record<string, string> = {
        aspiracional:  'inspirational, aspirational light, triumphant expression, golden hour glow',
        celebratorio:  'celebratory, joyful energy, vibrant colors, big smiles, festive atmosphere',
        empatico:      'warm and empathetic, soft natural light, genuine caring expression, intimate moment',
        urgente:       'dynamic, urgent energy, strong contrast, determined intense expression',
        motivacional:  'high energy, motivational, powerful body language, bold dynamic light',
        tranquilo:     'calm, peaceful, soft diffused light, relaxed natural expression',
        familiar:      'warm family feeling, soft golden light, genuine connection between people',
        profesional:   'clean, professional, confident expression, bright modern environment',
    };

    if (tasksJson) {
        // Modo brief / re-generación
        const briefTasks: {
            rowIndex?: number; audience?: string; audienciaRef?: string; drivers?: string;
            tono?: string; variante?: string; observaciones?: string;
            copyFull?: string; formatId: string;
            taskId?: string; explicitSceneDesc?: string; explicitCopy?: any;
            characterId?: string; beneficios?: string[];
        }[] = JSON.parse(tasksJson);
        tasks = briefTasks.map(t => {
            // Re-generación: escena y copy exactos, sin re-parsear
            if (t.explicitSceneDesc && t.explicitCopy) {
                return {
                    taskId:   t.taskId || `regen_${t.formatId}_${Date.now()}`,
                    formatId: t.formatId,
                    sceneDesc: t.explicitSceneDesc,
                    copy: t.explicitCopy,
                    observaciones: t.observaciones || '',
                    variante: t.variante || '',
                };
            }
            // Modo brief normal — escena construida desde audiencia + audienciaRef + drivers + tono
            const audLower = (t.audience || '').toLowerCase();
            const sceneEntry = Object.entries(profile.audienceScenes).find(([key]) => audLower.includes(key));
            const scenes = sceneEntry ? sceneEntry[1] : null;
            let sceneDesc: string;
            if (scenes && scenes.length > 0) {
                sceneDesc = scenes[Math.floor(Math.random() * scenes.length)];
            } else {
                // Build rich scene from audience + drivers data
                const who = t.audienciaRef || t.audience || 'a real person';
                const why = t.drivers || '';
                const what = why
                    ? `experiencing or benefiting from ${why}`
                    : 'in an authentic moment relevant to the brand';
                sceneDesc = `Real photograph of ${who}, ${what}. The person is the clear subject — large in frame, genuine expression, natural body language. Authentic real-world environment where this product belongs (home, outdoors, work, lifestyle). Cinematic natural light, shallow depth of field, editorial photography quality. Emotional and relatable.`;
            }
            // Apply tono modifier if provided
            if (t.tono) {
                const tonoKey = t.tono.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const modifier = TONO_MODIFIERS[tonoKey] || t.tono;
                sceneDesc = `${sceneDesc} Mood: ${modifier}.`;
            }
            const varianteSuffix = t.variante ? `_v${t.variante}` : '';
            // beneficios vienen directo del JSON (no del texto de copyFull, que no los
            // codifica) — si hay, pisan/completan lo que haya parseado parseCopyText.
            const parsedTaskCopy = parseCopyText(t.copyFull || '', isTarrito);
            if (Array.isArray(t.beneficios) && t.beneficios.length > 0) (parsedTaskCopy as any).beneficios = t.beneficios;
            return {
                taskId:       `row_${t.rowIndex}${varianteSuffix}`,
                formatId:     t.formatId || 'feed_square',
                sceneDesc,
                copy:         parsedTaskCopy,
                observaciones: t.observaciones || '',
                variante:     t.variante || '',
                audienceLabel: t.audience || '',
                audienciaRef:  t.audienciaRef || '',
                drivers:       t.drivers || '',
                characterId:  t.characterId || undefined,
            };
        });
    } else {
        // Modo manual: copy y escena del usuario
        const formats   = formatsStr.split(',').map(f => f.trim()).filter(f => f && FORMATS[f]);
        const sceneDesc = ((formData.get('sceneDesc') as string) || '').trim()
            || 'Authentic person matching the target audience, warm cinematic golden light, natural expression.';
        let beneficios: string[] = [];
        try { const raw = formData.get('beneficios') as string | null; if (raw) beneficios = JSON.parse(raw).filter(Boolean); } catch { /* ignore */ }
        const copy = {
            headline:      ((formData.get('headline') as string) || '').trim(),
            subhead:       ((formData.get('subhead')  as string) || '').trim(),
            vitamina_chip: ((formData.get('chip')     as string) || '').trim(),
            body:          ((formData.get('body')     as string) || '').trim(),
            beneficios,
            cta:           ((formData.get('cta')      as string) || '').trim(),
        };
        tasks = formats.map(fmtId => ({ taskId: fmtId, formatId: fmtId, sceneDesc, copy }));
    }

    if (tasks.length === 0) return c.json({ error: 'Al menos 1 tarea requerida' }, 400);

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const claudeApiKey = process.env.ANTHROPIC_API_KEY || '';

    return stream(c, async (s) => {
        // Concurrency pool: 2 simultaneous tasks (safe for Render 512MB)
        let taskIdx = 0;
        const processTask = async (task: any): Promise<void> => {
            const fmt = FORMATS[task.formatId] || FORMATS['feed_square'];
            await s.write(`data: ${JSON.stringify({ type: 'start', taskId: task.taskId, format: task.formatId, platform: fmt.platform, sceneDesc: task.sceneDesc, copy: task.copy })}\n\n`);

            const heartbeat = setInterval(async () => {
                try { await s.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
            }, 5000);

            try {
                const feedbackCtx = await getFeedbackContext(profileId, fmt.family);
                // Identidad efectiva: la guardada explícitamente (customIdentityBlock) tiene
                // prioridad; si no hay, se usa la auto-extraída del KV de esta tanda (ver arriba).
                const identityJson = customIdentityBlock
                    ? (() => { try { return JSON.parse(customIdentityBlock); } catch { return {}; } })()
                    : (autoIdentityJson || {});
                const hasRealIdentity = identityJson && Object.keys(identityJson).length > 0;
                const effectiveIdentityBlock = customIdentityBlock || (hasRealIdentity ? JSON.stringify(autoIdentityJson) : undefined);
                const identityWithFeedback = effectiveIdentityBlock ? effectiveIdentityBlock + feedbackCtx : (feedbackCtx || undefined);

                // Personaje de ESTA tarea (puede pisar el default global — ej: cada
                // audiencia del formulario con su propio personaje asignado).
                const { character, characterIdentityInstruction } = await resolveCharacterForTask(task.characterId);

                // ── ARQUITECTURA "UN SOLO PINTOR" ──────────────────────────────────────
                // Gemini genera SOLO la fotografía (personaje, producto, escenario, energía
                // gráfica de la marca — franjas, colores, motion). CERO texto, CERO logos:
                // todo eso lo pone después la capa de marca determinística
                // (compositeBrandLayer), idéntica pieza a pieza. Dos pintores a la vez (IA
                // escribiendo texto + capa componiendo encima) fue la causa raíz comprobada
                // del texto duplicado/fantasma — acá solo pinta uno.
                const copyForGemini = { ...task.copy, headline: '', subhead: '', vitamina_chip: '', body: '', cta: '' };

                // Zonas donde la capa va a componer texto — la foto debe dejarlas "tranquilas"
                // (sin cara del sujeto ni detalle clave del producto debajo).
                const renderZones = resolveBrandTextZones(task.copy, fmt.family, identityJson?.brandName, hasLogo);
                const cleanAreasList = renderZones
                    .map(z => `- ${z.x.toFixed(0)}%,${z.y.toFixed(0)}% → ${z.w.toFixed(0)}% wide × ${z.h.toFixed(0)}% tall`)
                    .join('\n');

                // Scene variety: unique scene per task based on audience + drivers + index
                const variantSceneDesc = buildSceneVariant(task.sceneDesc, task.audienciaRef || '', task.drivers || '', task.formatId, taskIdx - 1);
                const rawPrompt = buildPrompt(variantSceneDesc, copyForGemini, task.formatId, fmt, profileId, identityWithFeedback, task.observaciones, hasProduct, productCategory, productBenefits, task.audienciaRef || '', task.drivers || '', hasLogo, hasConglomerateLogo);

                // Regla absoluta AL FINAL del prompt (recencia gana): la identidad de marca de
                // arriba describe el AVISO FINAL — pero esta imagen es solo la fotografía base.
                const noTextRule = `

⛔⛔ PHOTOGRAPHY ONLY — ABSOLUTE FINAL RULE (overrides EVERYTHING above): this image must contain ZERO text of any kind — no words, letters, numbers, logos, wordmarks, badges, buttons, price tags, watermarks or typography of any size, not even blurred, partial, or in the background. Any typography/layout/badge guidance above describes the FINAL composed advertisement, NOT this image: all text and logos are added later by a separate pixel-perfect compositing system. Your job is a clean advertising PHOTOGRAPH: the scene, the person, the product, and the brand's background energy (colors, diagonal stripes, motion blur, light — graphic shapes WITHOUT any letters).
KEEP THESE AREAS VISUALLY CALM (text will be composited there afterward — do not place the subject's face or key product details inside them; simple background there is ideal):
${cleanAreasList || '- (none — keep the left third and the bottom strip calm)'}`;

                const agentPrompt = rawPrompt + characterIdentityInstruction
                    + (manualZoneInstruction ? `\n\n⚠️ USER-MARKED POSITIONS (override any zone/layout guidance above for these elements):\n${manualZoneInstruction}` : '')
                    + noTextRule;
                const agentChecklist: string[] = [];

                await s.write(`data: ${JSON.stringify({ type: 'agent1_done', taskId: task.taskId, checklistItems: 0, typoSpecItems: renderZones.length })}\n\n`);

                // ── Agent 2: Gemini Image Generator ─────────────────────────────────────
                // Los logos NUNCA se mandan como referencia de generación (ver logoBlock/
                // conglomerateLogoBlock) — Gemini no debe intentar dibujarlos, se componen
                // siempre después con el archivo real. Enviárselos igual solo lo tentaría a
                // "inspirarse" en ellos y redibujar su propia versión (la alucinación que
                // reportó el usuario).
                const callGemini = async (promptText: string): Promise<{ part: any; err: string | null }> => {
                    const parts: any[] = [{ inlineData: { mimeType: kvMime, data: kvBase64 } }];
                    for (const p of productParts) {
                        parts.push({ inlineData: { mimeType: p.mime, data: p.data } });
                    }
                    if (character) parts.push({ inlineData: { mimeType: character.mime, data: character.base64 } });
                    parts.push({ text: promptText });
                    let res: any, data: any;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 4000));
                        res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }),
                            signal: AbortSignal.timeout(120_000),
                        });
                        data = await res.json() as any;
                        if (res.status !== 503) break;
                        console.warn(`[Gemini] 503 — retry ${attempt+1}/3`);
                    }
                    if (!res.ok || data?.error) {
                        const errMsg = `Gemini ${res.status}: ${data?.error?.message || JSON.stringify(data?.error || {}).slice(0,150)}`;
                        console.error('[Gemini] Error:', errMsg);
                        return { part: null, err: errMsg };
                    }
                    const imgResult = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData) || null;
                    if (!imgResult) {
                        const reason = `No image — finishReason:${data?.candidates?.[0]?.finishReason || 'unknown'} promptFeedback:${JSON.stringify(data?.promptFeedback || {}).slice(0,100)}`;
                        console.error('[Gemini]', reason);
                        return { part: null, err: reason };
                    }
                    console.log(`[Agent2] Image generated — ${imgResult.inlineData.mimeType || 'image/jpeg'} ${imgResult.inlineData.data.length} bytes`);
                    return { part: imgResult, err: null };
                };

                // Mismo rol que callGemini (pinta SOLO la foto, cero texto/logo) pero con
                // GPT-image (/v1/images/edits) — devuelve la misma forma normalizada
                // { part: { inlineData: { data, mimeType } }, err } para que QA y el
                // compositor de marca no necesiten saber qué proveedor generó la foto.
                const callOpenAIImage = async (promptText: string): Promise<{ part: any; err: string | null }> => {
                    const openaiKey = process.env.OPENAI_API_KEY || '';
                    if (!openaiKey) return { part: null, err: 'OPENAI_API_KEY no configurada en el backend' };
                    const size = gptImageSizeFor(fmt.family);
                    if (!size) return { part: null, err: `GPT-image no soporta el formato "${fmt.family}" (excede el límite de aspect ratio 3:1 o el mínimo de píxeles) — usá Gemini para banners/skyscraper.` };
                    try {
                        const form = new FormData();
                        form.append('model', OPENAI_IMAGE_MODEL);
                        form.append('prompt', promptText);
                        form.append('size', size);
                        form.append('image[]', new Blob([Buffer.from(kvBase64, 'base64')], { type: kvMime }), 'kv.jpg');
                        for (const p of productParts) {
                            form.append('image[]', new Blob([Buffer.from(p.data, 'base64')], { type: p.mime }), 'product.jpg');
                        }
                        if (character) form.append('image[]', new Blob([Buffer.from(character.base64, 'base64')], { type: character.mime }), 'character.jpg');
                        let res: any, data: any;
                        for (let attempt = 0; attempt < 3; attempt++) {
                            if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 4000));
                            res = await fetch('https://api.openai.com/v1/images/edits', {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${openaiKey}` },
                                body: form,
                                // Medido en vivo: un solo image[] (KV) ya tarda ~90s; con KV + foto(s) de
                                // producto + personaje (el caso real del pipeline) supera los 120s que
                                // tenía antes, abortando el fetch a mitad de una generación válida.
                                signal: AbortSignal.timeout(240_000),
                            });
                            data = await res.json() as any;
                            if (res.status !== 429 && res.status !== 503) break;
                            console.warn(`[OpenAI] ${res.status} — retry ${attempt + 1}/3`);
                        }
                        if (!res.ok || data?.error) {
                            const errMsg = `OpenAI ${res.status}: ${data?.error?.message || JSON.stringify(data?.error || {}).slice(0, 150)}`;
                            console.error('[OpenAI] Error:', errMsg);
                            return { part: null, err: errMsg };
                        }
                        const b64 = data?.data?.[0]?.b64_json;
                        if (!b64) return { part: null, err: 'OpenAI: respuesta sin imagen (posible bloqueo de moderación)' };
                        console.log(`[Agent2/OpenAI] Image generated — ${b64.length} bytes b64`);
                        return { part: { inlineData: { data: b64, mimeType: 'image/png' } }, err: null };
                    } catch (e: any) {
                        return { part: null, err: `OpenAI fetch error: ${e.message}` };
                    }
                };

                const callImage = imageProvider === 'gpt' ? callOpenAIImage : callGemini;

                const geminiResult = await callImage(agentPrompt);
                let imgPart = geminiResult.part;
                let geminiErr = geminiResult.err;
                let qaAttempts = 0;
                let bestScore = 0;
                let bestImg = imgPart;

                // ── QA de la FOTOGRAFÍA — dos porteros, máx 3 intentos ────────────────
                // 1) Portero anti-texto (OCR local, determinístico, gratis): la foto debe venir
                //    sin NINGUNA letra — es la condición binaria que hace imposible el texto
                //    duplicado (el único texto del creativo final lo pone la capa de marca).
                // 2) Pase de modelo (Gemini, temperatura 0) solo para anatomía/consistencia de
                //    personaje — con copy vacío, ya no opina sobre texto.
                const EMPTY_COPY = { headline: '', subhead: '', vitamina_chip: '', body: '', cta: '' };
                if (imgPart && apiKey) {
                    let currentPrompt = agentPrompt;
                    for (let qaRound = 0; qaRound < 3; qaRound++) {
                        qaAttempts++;
                        const imgData  = imgPart.inlineData.data;
                        const imgMime  = imgPart.inlineData.mimeType || 'image/jpeg';

                        await s.write(`data: ${JSON.stringify({ type: 'qa_start', taskId: task.taskId, round: qaRound + 1 })}\n\n`);

                        // Portero 1: ¿Gemini desobedeció y escribió texto en la foto?
                        const noText = await checkImageHasNoText(Buffer.from(imgData, 'base64')).catch(() => null);
                        if (noText?.hasText) {
                            console.warn(`[dcoQa] round ${qaRound+1}: texto detectado en la foto (${noText.detectedWords.join(', ')}) — regenerando`);
                            await s.write(`data: ${JSON.stringify({ type: 'qa_score', taskId: task.taskId, attempt: qaRound + 1, score: 5, passed: false, errors: [`TEXT_IN_PHOTO: ${noText.detectedWords.slice(0, 6).join(', ')}`] })}\n\n`);
                            if (qaRound === 2) break;
                            const retryPrompt = [
                                `⚡ REJECTED — your previous image contained visible text/lettering ("${noText.detectedWords.slice(0, 6).join('", "')}"). This is FORBIDDEN. Regenerate the SAME scene as a pure photograph with ABSOLUTELY ZERO letters, words, numbers, logos or typography anywhere — remove signage, labels and any written marks. Graphic energy (stripes, colors, motion) stays, letters do not.`,
                                '',
                                '─── ORIGINAL BRIEF ───',
                                currentPrompt,
                            ].join('\n');
                            const retry = await callImage(retryPrompt);
                            if (retry.part) { imgPart = retry.part; currentPrompt = retryPrompt; continue; }
                            break;
                        }

                        // Portero 2: anatomía + personaje (único pase de modelo)
                        const verdict = await runQualityCheck({
                            imageBase64: imgData, imageMime: imgMime,
                            kvBase64, kvMime,
                            copy: EMPTY_COPY,
                            checklist: agentChecklist,
                            customQaRules,
                            // El color real de la marca (extraído/muestreado de ESTE KV) es más preciso
                            // que el color genérico del perfil builtin — para una marca custom/aprendida
                            // (BOXER, etc.) profile.color es solo el fallback 'generic', no el color real.
                            brandColorHex: (hasRealIdentity && (identityJson?.accentColor || identityJson?.primaryColor)) || sampledBenefitColor || profile.color,
                            characterPhoto: character ? { base64: character.base64, mime: character.mime, name: character.name } : undefined,
                            geminiApiKey: apiKey,
                        });

                        console.log(`[dcoQa] round ${qaRound+1} score=${verdict.score} passed=${verdict.passed} issues=${verdict.issues.length}`);
                        if (verdict.score > bestScore) { bestScore = verdict.score; bestImg = imgPart; }

                        await s.write(`data: ${JSON.stringify({ type: 'qa_score', taskId: task.taskId, attempt: qaRound + 1, score: verdict.score, passed: verdict.passed, errors: verdict.issues })}\n\n`);

                        if (verdict.passed || qaRound === 2) break;

                        await s.write(`data: ${JSON.stringify({ type: 'qa_retry', taskId: task.taskId, score: verdict.score, fixes: verdict.issues })}\n\n`);

                        const retryPrompt = [
                            `⚡ CORRECCIONES DEL QA (score anterior: ${verdict.score}/100):`,
                            verdict.correctionsForPrompt || verdict.issues.join(' | '),
                            '',
                            '─── BRIEF ORIGINAL ───',
                            currentPrompt,
                        ].join('\n');

                        const retry = await callImage(retryPrompt);
                        if (retry.part) { imgPart = retry.part; currentPrompt = retryPrompt; }
                        else break;
                    }
                    if (bestImg) imgPart = bestImg;
                    qaAttempts = Math.max(1, Math.min(qaAttempts, 3));
                    console.log(`[dcoQa] RESULTADO FINAL [${task.taskId}] score=${bestScore}/100 attempts=${qaAttempts}`);
                }

                // ── Capa de marca determinística — SIEMPRE ─────────────────────────────
                // Todo el texto (headline/subhead/chip/cta/beneficios) y los logos se componen
                // acá, con las fuentes profesionales embebidas y el estilo derivado de la
                // identidad (colores, contornos, barras inclinadas, pills). Idéntica pieza a
                // pieza: acá vive la consistencia de producción masiva.
                if (imgPart) {
                    const graphicOverlayZones: GraphicOverlayZone[] = [];
                    if (effectiveLogoZone && logoPart) graphicOverlayZones.push({ key: 'logo', imageBase64: logoPart.data, imageMime: logoPart.mime, ...effectiveLogoZone });
                    if (effectiveConglomerateLogoZone && conglomerateLogoPart) graphicOverlayZones.push({ key: 'conglomerate_logo', imageBase64: conglomerateLogoPart.data, imageMime: conglomerateLogoPart.mime, ...effectiveConglomerateLogoZone });
                    extraLogoParts.forEach((part, i) => {
                        const zone = effectiveExtraLogoZones[i];
                        if (zone && part) graphicOverlayZones.push({ key: `extra_logo_${i + 1}`, imageBase64: part.data, imageMime: part.mime, ...zone });
                    });

                    const brandStyle = deriveBrandLayerStyle(hasRealIdentity ? identityJson : { primaryColor: profile.color }, sampledBenefitColor);

                    if (renderZones.length > 0 || graphicOverlayZones.length > 0) {
                        const composited = await compositeBrandLayer(
                            imgPart.inlineData.data, imgPart.inlineData.mimeType || 'image/jpeg',
                            fmt.width, fmt.height, renderZones, graphicOverlayZones, brandStyle,
                        );
                        imgPart = { inlineData: { data: composited.base64, mimeType: composited.mime } };
                    }
                }

                if (imgPart) {
                    // Gemini Vision analiza la imagen generada
                    const t0 = Date.now();
                    console.log(`[DCO ${task.taskId}] ► Gemini Vision START`);
                    const geminiAnalysis = await analyzeImageWithGemini(imgPart.inlineData.data, imgPart.inlineData.mimeType || 'image/jpeg', productCategory, productBenefits, apiKey);
                    console.log(`[DCO ${task.taskId}] ► Gemini Vision ${geminiAnalysis ? 'OK' : 'FAIL/NULL'} — ${Date.now()-t0}ms`);

                    // Claude escribe el libreto de 3 clips con el análisis de Gemini
                    const t1 = Date.now();
                    if (!claudeApiKey) {
                        console.warn(`[DCO ${task.taskId}] ► Claude SKIP — no ANTHROPIC_API_KEY`);
                    } else {
                        console.log(`[DCO ${task.taskId}] ► Claude Sonnet START (geminiAnalysis=${geminiAnalysis ? 'present' : 'null'})`);
                    }
                    const videoPromptRaw = claudeApiKey
                        ? await buildVideoPromptFromImage(imgPart.inlineData.data, imgPart.inlineData.mimeType || 'image/jpeg', task.copy, task.formatId, { ...fmt, platform: fmt.platform }, task.drivers || '', claudeApiKey, productCategory, productBenefits, geminiAnalysis)
                        : '';
                    console.log(`[DCO ${task.taskId}] ► Claude Sonnet ${videoPromptRaw ? 'OK' : 'FAIL/EMPTY'} — ${Date.now()-t1}ms`);
                    if (!videoPromptRaw) console.warn(`[DCO ${task.taskId}] ► FALLING BACK to text-based buildVideoPrompt`);
                    // Fallback: si Claude falla → prompt desde texto (con contexto del sceneDesc)
                    const videoPrompt = videoPromptRaw || buildVideoPrompt(task.sceneDesc, task.copy, task.formatId, { ...fmt, platform: fmt.platform }, profileId, customIdentityBlock, hasProduct, task.audienceLabel || '', task.audienciaRef || '', task.drivers || '');

                    clearInterval(heartbeat);
                    await s.write(`data: ${JSON.stringify({ type: 'result', taskId: task.taskId, format: task.formatId, platform: fmt.platform, width: fmt.width, height: fmt.height, imageBase64: imgPart.inlineData.data, mimeType: imgPart.inlineData.mimeType || 'image/jpeg', qaAttempts, videoPrompt })}\n\n`);
                } else {
                    clearInterval(heartbeat);
                    await s.write(`data: ${JSON.stringify({ type: 'error', taskId: task.taskId, format: task.formatId, error: geminiErr || 'Sin imagen generada' })}\n\n`);
                }
            } catch (err: any) {
                console.error('[DCO] Error en task', task.taskId, err.message);
                clearInterval(heartbeat);
                await s.write(`data: ${JSON.stringify({ type: 'error', taskId: task.taskId, format: task.formatId, error: err.message || 'Error' })}\n\n`);
            }
        }; // end processTask
        const runWorker = async (): Promise<void> => {
            while (taskIdx < tasks.length) { await processTask(tasks[taskIdx++]); }
        };
        await Promise.all([runWorker(), runWorker()]); // 2 concurrent workers
        await s.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    });
});


// ─── POST /generate-gif — genera GIF animado on-demand ─────────────────────────
// 3 frames: Frame 1 = KV scene, Frame 2 = product close-up, Frame 3 = logo/CTA
dcoRoutes.post('/generate-gif', async (ctx) => {
    const body = await ctx.req.json() as {
        imageBase64: string;
        mimeType: string;
        formatId: string;
        width: number;
        height: number;
        headline?: string;
        cta?: string;
        logoBase64?: string;   // logo real subido — se compone determinísticamente en el frame de cierre
        logoMime?: string;
    };
    const apiKey = process.env.GEMINI_API_KEY || '';
    if (!apiKey) return ctx.json({ error: 'GEMINI_API_KEY not set' }, 500);

    const { imageBase64, mimeType, formatId, width, height } = body;
    const fmt = FORMATS[formatId] || { width, height, family: 'square' };
    const mime = mimeType.includes('png') ? 'image/png' : 'image/jpeg';

    // Frame 1 (imageBase64) ya viene de /generate — si esa pieza usó un personaje, ya
    // quedó verificado ahí. Frames 2/3 son a propósito sin personas (product shot y
    // logo), no hay "consistencia de personaje" que aplicar en este GIF de 3 frames.
    const makeFrame = async (prompt: string): Promise<{ data: string; mime: string } | null> => {
        try {
            const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [
                        { inlineData: { mimeType: mime, data: imageBase64 } },
                        { text: prompt },
                    ]}],
                    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
                }),
                signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) return null;
            const data = await res.json() as any;
            const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
            return part ? { data: part.inlineData.data, mime: part.inlineData.mimeType || mime } : null;
        } catch { return null; }
    };

    try {
        // Frame 2: clean product close-up extracted from the KV
        // Frame 3: brand identity closing frame — logo prominent, no copy text
        // Nota: frames 2 y 3 son a propósito "sin personajes" (product shot / logo) — el
        // personaje solo importa en el frame 1, que ya viene heredado y verificado de
        // /generate. No tiene sentido re-verificar "misma persona" en frames sin persona.
        // Ningún frame le pide a la IA que dibuje logos ni texto — misma regla que en
        // /generate: un modelo de difusión redibuja/disocia los logos entre frames (lo que
        // el usuario reportó como "disociar en los logos"). El logo real, si viene, se
        // compone determinísticamente sobre el frame de cierre — idéntico píxel a píxel.
        const productPrompt = `Extract and feature the main product from this advertising image. Create a clean close-up product shot: the product centered with professional studio lighting, slight background blur, brand advertising quality. Same product, no characters. ABSOLUTE RULE: zero text, zero letters, zero logos, zero badges anywhere in the image — remove any lettering visible on packaging/labels if needed by framing tighter. Photorealistic.`;
        const logoPrompt = `Closing background frame inspired by this advertising image. Clean elegant background using the exact dominant brand colors from this image — gradients, diagonal energy stripes or soft light allowed. Premium cinematic advertising finish. ABSOLUTE RULE: completely EMPTY of content — no logo, no text, no letters, no characters, no product. Just the branded background; the real logo will be composited on top separately.`;

        const [frame2, frame3raw] = await Promise.all([makeFrame(productPrompt), makeFrame(logoPrompt)]);

        // Componer el logo REAL (archivo subido) centrado en el frame de cierre.
        let frame3 = frame3raw;
        if (frame3 && body.logoBase64) {
            try {
                const composited = await compositeBrandLayer(
                    frame3.data, frame3.mime, fmt.width, fmt.height,
                    [],
                    [{ key: 'logo', imageBase64: body.logoBase64, imageMime: body.logoMime || 'image/png', x: 25, y: 32, w: 50, h: 36 }],
                    deriveBrandLayerStyle(null),
                );
                frame3 = { data: composited.base64, mime: composited.mime };
            } catch (e: any) { console.warn('[DCO GIF] No se pudo componer logo en frame de cierre:', e.message); }
        }

        const frames = [
            { data: imageBase64, mime },          // Frame 1: KV scene (ya trae la capa de marca compuesta)
            ...(frame2 ? [frame2] : []),           // Frame 2: product close-up
            ...(frame3 ? [frame3] : []),           // Frame 3: cierre de marca (logo real compuesto)
        ];

        if (frames.length < 2) return ctx.json({ error: 'Not enough frames generated' }, 500);

        const gif = await buildAnimatedGif(frames, fmt.width, fmt.height);
        if (!gif) return ctx.json({ error: 'GIF build failed' }, 500);

        console.log('[DCO GIF] On-demand:', frames.length, 'frames', Math.round(gif.length / 1024), 'KB');
        return ctx.json({ gifBase64: gif });
    } catch (err: any) {
        return ctx.json({ error: err.message }, 500);
    }
});

// ─── POST /feedback — guarda feedback de imagen generada ──────────────────────
// Crea la tabla dco_feedback si no existe, luego inserta el registro.
// --- Feedback learning ---
async function getFeedbackContext(profileId: string, formatFamily: string) {
    try {
        const { data } = await supabase
            .from('dco_feedback')
            .select('rating, comment, format_id')
            .eq('profile_id', profileId)
            .order('created_at', { ascending: false })
            .limit(40);
        if (!data || data.length === 0) return '';
        const bad  = data.filter(f => f.rating === 'bad'  && f.comment && f.comment.trim());
        const good = data.filter(f => f.rating === 'good' && f.comment && f.comment.trim());
        const FMAP = { vertical: ['story','portrait','halfpage'], square: ['feed_square','square'], horizontal: ['landscape','billboard'], micro: ['skyscraper','mrec'] };
        const ff = (FMAP as Record<string,string[]>)[formatFamily] || [];
        const badList  = (bad.filter(f => ff.includes(f.format_id)).length >= 2 ? bad.filter(f => ff.includes(f.format_id)) : bad).slice(0,5);
        const goodList = (good.filter(f => ff.includes(f.format_id)).length >= 2 ? good.filter(f => ff.includes(f.format_id)) : good).slice(0,3);
        if (!badList.length && !goodList.length) return '';
        const out = ['\nFEEDBACK DE USUARIOS (el sistema aprende):'];
        if (badList.length) { out.push('ERRORES A EVITAR:'); badList.forEach(f => out.push('  - ' + f.comment.trim())); }
        if (goodList.length) { out.push('LO QUE FUNCIONA BIEN:'); goodList.forEach(f => out.push('  + ' + f.comment.trim())); }
        return out.join('\n') + '\n';
    } catch { return ''; }
}
let feedbackTableReady = false;
async function ensureFeedbackTable() {
    // La tabla se crea con la migración backend/supabase-dco.sql.
    feedbackTableReady = true;
}

// ─── Carrusel / Historia — narrativa multi-slide con personaje consistente ────
dcoRoutes.get('/stories', async (c) => {
    const profileId = c.req.query('profileId') || undefined;
    const stories = await listStories(profileId);
    return c.json({ stories });
});

dcoRoutes.get('/stories/:id', async (c) => {
    const result = await getStory(c.req.param('id'));
    if (!result) return c.json({ error: 'No encontrada' }, 404);
    return c.json(result);
});

dcoRoutes.post('/generate-carousel', async (c) => {
    const formData = await c.req.formData();
    const kvFile = formData.get('kvImage') as File | null;
    if (!kvFile) return c.json({ error: 'KV image requerido' }, 400);

    const profileId = ((formData.get('brandProfile') as string) || 'generic').trim();
    const profile = BRAND_PROFILES[profileId] || BRAND_PROFILES['generic'];
    const characterId = ((formData.get('characterId') as string) || '').trim() || undefined;
    const narrative = ((formData.get('narrative') as string) || '').trim();
    const title = ((formData.get('title') as string) || narrative.slice(0, 60) || 'Historia sin título').trim();
    const format = (((formData.get('format') as string) || '1:1').trim()) as '1:1' | '4:5';
    // Por latencia (generación secuencial + verificación por slide), tope razonable — no los 10 que permite la plataforma.
    const slideCount = Math.max(3, Math.min(6, parseInt((formData.get('slideCount') as string) || '4', 10) || 4));

    if (!narrative) return c.json({ error: 'narrative es requerido' }, 400);
    const fmt = CAROUSEL_FORMATS[format] || CAROUSEL_FORMATS['1:1'];

    const kvBase64 = Buffer.from(await kvFile.arrayBuffer()).toString('base64');
    const kvMime = kvFile.type || 'image/jpeg';
    const apiKey = process.env.GEMINI_API_KEY || '';
    const claudeApiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) return c.json({ error: 'GEMINI_API_KEY not set' }, 500);
    if (!claudeApiKey) return c.json({ error: 'ANTHROPIC_API_KEY not set' }, 500);

    const character = characterId ? await getCharacterPhotoBase64(characterId) : null;

    const logoFile = formData.get('logoImage') as File | null;
    let logoPart: { data: string; mime: string } | null = null;
    if (logoFile) {
        const buf = await logoFile.arrayBuffer();
        logoPart = { data: Buffer.from(buf).toString('base64'), mime: logoFile.type || 'image/png' };
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    return stream(c, async (s) => {
        let storyId = '';
        try {
            const beats = await planStoryboard(narrative, slideCount, claudeApiKey);
            storyId = await createStory({ profileId, characterId, title, narrative, format, slideCount: beats.length });
            await s.write(`data: ${JSON.stringify({ type: 'story_start', storyId, beats })}\n\n`);

            const callGeminiSlide = async (parts: any[]): Promise<{ data: string; mime: string } | null> => {
                const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }),
                    signal: AbortSignal.timeout(120_000),
                });
                if (!res.ok) return null;
                const data: any = await res.json();
                const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
                return part ? { data: part.inlineData.data, mime: part.inlineData.mimeType || 'image/jpeg' } : null;
            };

            let previousSlide: { data: string; mime: string } | null = null;
            for (let i = 0; i < beats.length; i++) {
                const beat = beats[i];
                await s.write(`data: ${JSON.stringify({ type: 'slide_start', index: i })}\n\n`);

                const buildParts = (extraInstruction: string) => {
                    const parts: any[] = [{ inlineData: { mimeType: kvMime, data: kvBase64 } }];
                    if (logoPart) parts.push({ inlineData: { mimeType: logoPart.mime, data: logoPart.data } });
                    if (character) parts.push({ inlineData: { mimeType: character.mime, data: character.base64 } });
                    if (previousSlide) parts.push({ inlineData: { mimeType: previousSlide.mime, data: previousSlide.data } });
                    const promptText = `Advertising carousel slide ${i + 1}/${beats.length}. Brand identity: use the KV reference image for colors/typography/logo only.${logoPart ? ' A dedicated logo reference image is also provided — reproduce that EXACT logo pixel-faithfully, never redraw or reinterpret it.' : ''}${character ? ' The protagonist MUST be the exact same person as the character reference photo — same face, skin tone, hair.' : ''}${previousSlide ? ' Continue the SAME visual world, lighting, and character continuity as the previous slide image provided.' : ''}

SCENE: ${beat.sceneDesc}

TEXT TO RENDER (exactly, no more no less):
${beat.copy.headline ? `- Headline: "${beat.copy.headline}"` : ''}
${beat.copy.cta ? `- CTA: "${beat.copy.cta}"` : ''}

${extraInstruction}
Output size: ${fmt.width}x${fmt.height}px, aspect ratio ${format}.`;
                    parts.push({ text: promptText });
                    return parts;
                };

                let slide = await callGeminiSlide(buildParts(''));
                let bestSlide = slide;
                let bestScore = 0;
                if (slide) {
                    for (let round = 0; round < 2 && slide; round++) {
                        const verdict = await runQualityCheck({
                            imageBase64: slide.data, imageMime: slide.mime,
                            kvBase64, kvMime,
                            copy: { headline: beat.copy.headline, subhead: '', vitamina_chip: '', body: '', cta: beat.copy.cta },
                            checklist: [], customQaRules: [],
                            characterPhoto: character ? { base64: character.base64, mime: character.mime, name: character.name } : undefined,
                            geminiApiKey: apiKey,
                        });
                        if (verdict.score > bestScore) { bestScore = verdict.score; bestSlide = slide; }
                        await s.write(`data: ${JSON.stringify({ type: 'slide_qa', index: i, score: verdict.score, passed: verdict.passed, issues: verdict.issues })}\n\n`);
                        if (verdict.passed) break;
                        const retryParts = buildParts(`CORRECCIONES DEL INTENTO ANTERIOR: ${verdict.correctionsForPrompt || verdict.issues.join(' | ')}`);
                        const retry = await callGeminiSlide(retryParts);
                        if (!retry) break;
                        slide = retry;
                    }
                }

                if (!bestSlide) {
                    await s.write(`data: ${JSON.stringify({ type: 'slide_error', index: i, error: 'No se pudo generar este slide' })}\n\n`);
                    continue;
                }

                await saveSlide({
                    storyId, slideIndex: i, sceneDesc: beat.sceneDesc, copy: beat.copy,
                    imageBase64: bestSlide.data, imageMime: bestSlide.mime, qaScore: bestScore,
                    width: fmt.width, height: fmt.height,
                });
                previousSlide = bestSlide;
                await s.write(`data: ${JSON.stringify({ type: 'slide_done', index: i, imageBase64: bestSlide.data, mimeType: bestSlide.mime, score: bestScore })}\n\n`);
            }

            await s.write(`data: ${JSON.stringify({ type: 'done', storyId })}\n\n`);
        } catch (err: any) {
            console.error('[DCO Carousel] Error:', err.message);
            await s.write(`data: ${JSON.stringify({ type: 'error', storyId, error: err.message || 'Error' })}\n\n`);
        }
    });
});

// ─── POST /retouch — corrección quirúrgica sobre imagen ya generada ───────────
// Recibe la imagen original generada + una corrección del usuario.
// Gemini recibe: [imagen original, KV referencia] + prompt quirúrgico.
// Mantiene TODA la composición original — solo corrige el detalle indicado.
dcoRoutes.post('/retouch', async (c) => {
    const apiKey = process.env.GEMINI_API_KEY || '';
    if (!apiKey) return c.json({ error: 'GEMINI_API_KEY not configured' }, 500);

    const formData = await c.req.formData();

    const originalImageBase64 = (formData.get('originalImageBase64') as string || '').trim();
    const originalMime        = (formData.get('originalMime')        as string || 'image/jpeg').trim();
    const correction          = (formData.get('correction')          as string || '').trim();
    const formatId            = (formData.get('formatId')            as string || 'feed_square').trim();
    const kvFile              = formData.get('kvImage') as File | null;

    if (!kvFile)               return c.json({ error: 'kvImage requerido' }, 400);
    if (!originalImageBase64)  return c.json({ error: 'originalImageBase64 requerido' }, 400);
    if (!correction)           return c.json({ error: 'correction requerido' }, 400);

    const kvBase64 = Buffer.from(await kvFile.arrayBuffer()).toString('base64');
    const kvMime   = kvFile.type || 'image/jpeg';
    const fmt      = FORMATS[formatId] || FORMATS['feed_square'];

    const surgicalPrompt = `You are performing a SURGICAL CORRECTION on an existing advertisement (first image provided).

CRITICAL PRESERVATION RULE — keep EVERY visual element exactly as it is:
• Scene, people, expressions, poses, lighting, color grade, composition
• Brand band position, size, color (#E30613), and all copy inside it
• Product jar placement, bottle silhouette overlay, FMC seal position
• All visible text: headline, subhead, body, CTA, pill badge — unchanged

Make ONLY this specific targeted fix — change ABSOLUTELY NOTHING else:
${correction}

Reference the second image (KV) only to confirm correct brand colors/style for the fix.
Output the corrected ad at exactly ${fmt.width}×${fmt.height}px.`;

    try {
        const parts = [
            { inlineData: { mimeType: originalMime, data: originalImageBase64 } },
            { inlineData: { mimeType: kvMime,       data: kvBase64 } },
            { text: surgicalPrompt },
        ];

        const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
            }),
            signal: AbortSignal.timeout(120_000),
        });

        const data = await res.json() as any;
        const imgPart = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
        if (!imgPart) return c.json({ error: 'Sin imagen generada' }, 500);

        return c.json({
            imageBase64: imgPart.inlineData.data,
            mimeType:    imgPart.inlineData.mimeType || 'image/jpeg',
            width:       fmt.width,
            height:      fmt.height,
        });
    } catch (err: any) {
        return c.json({ error: err.message || 'Error generando corrección' }, 500);
    }
});

dcoRoutes.post('/feedback', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, string>;
    const { profileId, formatId, audience, sceneDesc, headline, rating, comment, userEmail, chosenVersion } = body;
    if (!rating) return c.json({ error: 'rating requerido' }, 400);

    await ensureFeedbackTable();

    const { error } = await supabase.from('dco_feedback').insert({
        profile_id:      profileId      || '',
        format_id:       formatId       || '',
        audience:        audience       || '',
        scene_desc:      sceneDesc      || '',
        headline:        headline       || '',
        rating:          rating,
        comment:         comment        || '',
        user_email:      userEmail      || '',
        chosen_version:  chosenVersion  || null,
    });

    if (error) {
        console.error('[DCO] feedback error:', error.message);
        return c.json({ error: error.message }, 500);
    }
    return c.json({ ok: true });
});

