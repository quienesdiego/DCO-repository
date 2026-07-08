// ─── DCO Studio characters — reference photo for consistency across generations ─
// No external facial recognition: "same person" verification happens inside the
// single QA pass in services/qa.ts (see CHARACTER_MATCH in runQualityCheck).
import sharp from 'sharp';
import type { StorageProvider, DcoRepository, CharacterRecord } from '../adapters/types.js';

const CHARACTERS_BUCKET = 'dco-characters';

// Resizes the reference photo to a reasonable width for prompt/reference use (it
// doesn't need to be full-res — your vision provider receives it as just another
// image in the context array, same as the reference/KV image) before uploading it.
async function resizeAndUploadReferencePhoto(
    storage: StorageProvider, name: string, base64: string,
): Promise<{ url: string; path: string } | null> {
    try {
        const inputBuffer = Buffer.from(base64, 'base64');
        const resized = await sharp(inputBuffer)
            .resize({ width: 768, withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();

        const path = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.jpg`;
        const stored = await storage.upload({ bucket: CHARACTERS_BUCKET, path, data: resized, contentType: 'image/jpeg' });
        return { url: stored.url, path: stored.path };
    } catch (err: any) {
        console.error('[characters] Error processing photo:', err.message);
        return null;
    }
}

export async function listCharacters(repository: DcoRepository, profileId?: string): Promise<CharacterRecord[]> {
    return repository.characters.list(profileId);
}

export async function createCharacter(
    providers: { storage: StorageProvider; repository: DcoRepository },
    params: { name: string; profileId?: string | null; photoBase64: string; physicalNotes?: string; createdBy?: string },
): Promise<{ character?: CharacterRecord; error?: string }> {
    const uploaded = await resizeAndUploadReferencePhoto(providers.storage, params.name, params.photoBase64);
    if (!uploaded) return { error: 'Could not process/upload the reference photo' };

    try {
        const character = await providers.repository.characters.create({
            name: params.name.trim(),
            profileId: params.profileId || undefined,
            referencePhotoUrl: uploaded.url,
            referencePhotoPath: uploaded.path,
            physicalNotes: params.physicalNotes || '',
            createdBy: params.createdBy || '',
        });
        return { character };
    } catch (err: any) {
        return { error: err.message };
    }
}

export async function deleteCharacter(
    providers: { storage: StorageProvider; repository: DcoRepository },
    id: string,
): Promise<{ ok: boolean; error?: string }> {
    const existing = await providers.repository.characters.get(id);
    try {
        await providers.repository.characters.delete(id);
    } catch (err: any) {
        return { ok: false, error: err.message };
    }
    if (existing?.referencePhotoPath) {
        await providers.storage.remove({ bucket: CHARACTERS_BUCKET, path: existing.referencePhotoPath }).catch(() => {});
    }
    return { ok: true };
}

// Fetches the photo already as base64, ready to drop into your vision provider's
// image array — same pattern as the reference/product images in routes/dco.ts.
export async function getCharacterPhotoBase64(
    repository: DcoRepository, id: string,
): Promise<{ base64: string; mime: string; name: string; physicalNotes: string } | null> {
    const character = await repository.characters.get(id);
    if (!character) return null;
    try {
        const res = await fetch(character.referencePhotoUrl);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return { base64: buf.toString('base64'), mime: 'image/jpeg', name: character.name, physicalNotes: character.physicalNotes || '' };
    } catch (err: any) {
        console.error('[characters] Error downloading reference photo:', err.message);
        return null;
    }
}
