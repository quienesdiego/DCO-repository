// ─── Personajes del DCO — foto de referencia para consistencia entre generaciones ─
// Sin reconocimiento facial externo: la verificación de "misma persona" corre
// dentro del pase único de dcoQa.ts (ver character_match en runQualityCheck).
import sharp from 'sharp';
import { supabase } from './supabase.js';

const CHARACTERS_BUCKET = 'dco-characters';

export interface DcoCharacter {
    id: string;
    name: string;
    profileId: string | null;
    referencePhotoUrl: string;
    physicalNotes: string;
    createdAt: string;
}

function rowToCharacter(row: any): DcoCharacter {
    return {
        id: row.id,
        name: row.name,
        profileId: row.profile_id,
        referencePhotoUrl: row.reference_photo_url,
        physicalNotes: row.physical_notes || '',
        createdAt: row.created_at,
    };
}

// Redimensiona la foto de referencia a un ancho razonable para prompt/referencia
// (no necesita ser full-res — Gemini la recibe como una imagen más del array de
// contexto, igual que el KV) antes de subirla.
async function resizeAndUploadReferencePhoto(name: string, base64: string): Promise<{ url: string; path: string } | null> {
    try {
        const inputBuffer = Buffer.from(base64, 'base64');
        const resized = await sharp(inputBuffer)
            .resize({ width: 768, withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();

        const path = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.jpg`;
        const { error } = await supabase.storage
            .from(CHARACTERS_BUCKET)
            .upload(path, resized, { contentType: 'image/jpeg', upsert: true });

        if (error) {
            console.error('[DcoCharacters] Error subiendo foto de referencia:', error.message);
            return null;
        }

        const { data } = supabase.storage.from(CHARACTERS_BUCKET).getPublicUrl(path);
        return { url: data.publicUrl, path };
    } catch (err: any) {
        console.error('[DcoCharacters] Error procesando foto:', err.message);
        return null;
    }
}

export async function listCharacters(profileId?: string): Promise<DcoCharacter[]> {
    let query = supabase.from('dco_characters').select('*').order('created_at', { ascending: false });
    if (profileId) query = query.or(`profile_id.eq.${profileId},profile_id.is.null`);
    const { data, error } = await query;
    if (error) { console.error('[DcoCharacters] list error:', error.message); return []; }
    return (data || []).map(rowToCharacter);
}

export async function createCharacter(params: {
    name: string; profileId?: string | null; photoBase64: string; physicalNotes?: string; createdBy?: string;
}): Promise<{ character?: DcoCharacter; error?: string }> {
    const uploaded = await resizeAndUploadReferencePhoto(params.name, params.photoBase64);
    if (!uploaded) return { error: 'No se pudo procesar/subir la foto de referencia' };

    const { data, error } = await supabase.from('dco_characters').insert({
        name: params.name.trim(),
        profile_id: params.profileId || null,
        reference_photo_url: uploaded.url,
        reference_photo_path: uploaded.path,
        physical_notes: params.physicalNotes || '',
        created_by: params.createdBy || '',
    }).select('*').single();

    if (error) return { error: error.message };
    return { character: rowToCharacter(data) };
}

export async function deleteCharacter(id: string): Promise<{ ok: boolean; error?: string }> {
    const { data: existing } = await supabase.from('dco_characters').select('reference_photo_path').eq('id', id).single();
    const { error } = await supabase.from('dco_characters').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    if (existing?.reference_photo_path) {
        await supabase.storage.from(CHARACTERS_BUCKET).remove([existing.reference_photo_path]);
    }
    return { ok: true };
}

// Trae la foto ya en base64 lista para meter al array de `parts` de Gemini —
// mismo patrón que el KV/producto en dco.ts.
export async function getCharacterPhotoBase64(id: string): Promise<{ base64: string; mime: string; name: string; physicalNotes: string } | null> {
    const { data, error } = await supabase.from('dco_characters').select('reference_photo_url, name, physical_notes').eq('id', id).single();
    if (error || !data) return null;
    try {
        const res = await fetch(data.reference_photo_url);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return { base64: buf.toString('base64'), mime: 'image/jpeg', name: data.name, physicalNotes: data.physical_notes || '' };
    } catch (err: any) {
        console.error('[DcoCharacters] Error descargando foto de referencia:', err.message);
        return null;
    }
}
