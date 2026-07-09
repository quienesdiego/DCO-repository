// ─── Historias / Carrusel — narrativa multi-slide con personaje consistente ───
// Un personaje + una idea de historia → Claude arma el guion (una sola pasada,
// JSON estricto), cada slide se genera encadenando la anterior como referencia
// visual, listo para exportar en el formato exacto de carrusel de Meta.
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';

const STORIES_BUCKET = 'dco-stories';

export interface StoryBeat {
    sceneDesc: string;
    copy: { headline: string; cta: string };
}

function extractJSON(text: string): string | null {
    const mdBlock = text.match(/```(?:json)?\s*(\{[\s\S]+?\}|\[[\s\S]+?\])\s*```/);
    if (mdBlock) { try { JSON.parse(mdBlock[1]); return mdBlock[1]; } catch {} }
    const raw = text.match(/\[[\s\S]+\]/) || text.match(/\{[\s\S]+\}/);
    if (raw) { try { JSON.parse(raw[0]); return raw[0]; } catch {} }
    return null;
}

// ─── Claude: descompone la narrativa en N escenas ordenadas (una sola pasada) ─
export async function planStoryboard(narrative: string, slideCount: number, claudeApiKey: string): Promise<StoryBeat[]> {
    const client = new Anthropic({ apiKey: claudeApiKey });
    const prompt = `Sos un director creativo armando el guion de un carrusel publicitario de ${slideCount} slides para redes sociales.

HISTORIA A CONTAR:
${narrative}

Descomponé esta historia en EXACTAMENTE ${slideCount} escenas, en orden, que juntas cuenten una historia coherente de principio a fin (inicio → desarrollo → cierre/CTA). Cada escena es UN slide del carrusel.

Devolvé SOLO JSON válido, un array de ${slideCount} objetos, sin markdown:
[
  { "sceneDesc": "descripción visual detallada de la escena, en inglés, para un generador de imágenes — quién aparece, dónde, qué está pasando, mood", "copy": { "headline": "titular corto para este slide", "cta": "call to action corto, o string vacío si este slide no lleva CTA" } }
]

El último slide SIEMPRE debe tener un CTA claro. Los slides intermedios pueden tener cta vacío si no aplica.`;

    const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = extractJSON(text);
    if (!jsonMatch) throw new Error('No se pudo generar el guion del carrusel (parse fail)');
    const beats = JSON.parse(jsonMatch);
    if (!Array.isArray(beats) || beats.length === 0) throw new Error('Guion vacío');
    return beats.slice(0, slideCount).map((b: any) => ({
        sceneDesc: String(b.sceneDesc || ''),
        copy: { headline: String(b.copy?.headline || ''), cta: String(b.copy?.cta || '') },
    }));
}

// ─── Persistencia ──────────────────────────────────────────────────────────

async function uploadSlideImage(storyId: string, slideIndex: number, base64: string, mime: string): Promise<{ url: string; path: string } | null> {
    try {
        const buf = Buffer.from(base64, 'base64');
        const resized = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
        const path = `${storyId}/slide-${slideIndex}.jpg`;
        const { error } = await supabase.storage.from(STORIES_BUCKET).upload(path, resized, { contentType: 'image/jpeg', upsert: true });
        if (error) { console.error('[DcoStories] Error subiendo slide:', error.message); return null; }
        const { data } = supabase.storage.from(STORIES_BUCKET).getPublicUrl(path);
        return { url: data.publicUrl, path };
    } catch (err: any) {
        console.error('[DcoStories] Error procesando slide:', err.message);
        return null;
    }
}

export async function createStory(params: {
    profileId?: string; characterId?: string; title: string; narrative: string;
    platform?: string; format: string; slideCount: number; createdBy?: string;
}): Promise<string> {
    const { data, error } = await supabase.from('dco_stories').insert({
        profile_id: params.profileId || null,
        character_id: params.characterId || null,
        title: params.title,
        narrative: params.narrative,
        platform: params.platform || 'meta_carousel',
        format: params.format,
        slide_count: params.slideCount,
        created_by: params.createdBy || '',
    }).select('id').single();
    if (error || !data) throw new Error(error?.message || 'No se pudo crear la historia');
    return data.id;
}

export async function saveSlide(params: {
    storyId: string; slideIndex: number; sceneDesc: string; copy: { headline: string; cta: string };
    imageBase64: string; imageMime: string; qaScore: number; width: number; height: number;
}): Promise<void> {
    const uploaded = await uploadSlideImage(params.storyId, params.slideIndex, params.imageBase64, params.imageMime);
    await supabase.from('dco_story_slides').upsert({
        story_id: params.storyId,
        slide_index: params.slideIndex,
        scene_desc: params.sceneDesc,
        copy: params.copy,
        image_url: uploaded?.url || null,
        image_path: uploaded?.path || null,
        qa_score: params.qaScore,
        width: params.width,
        height: params.height,
    }, { onConflict: 'story_id,slide_index' });
}

export async function listStories(profileId?: string): Promise<any[]> {
    let query = supabase.from('dco_stories').select('*, dco_story_slides(count)').order('created_at', { ascending: false });
    if (profileId) query = query.eq('profile_id', profileId);
    const { data, error } = await query;
    if (error) { console.error('[DcoStories] list error:', error.message); return []; }
    return data || [];
}

export async function getStory(id: string): Promise<{ story: any; slides: any[] } | null> {
    const { data: story, error } = await supabase.from('dco_stories').select('*').eq('id', id).single();
    if (error || !story) return null;
    const { data: slides } = await supabase.from('dco_story_slides').select('*').eq('story_id', id).order('slide_index', { ascending: true });
    return { story, slides: slides || [] };
}
