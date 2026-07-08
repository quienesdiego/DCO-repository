// ─── Stories / Carousel — multi-slide narrative with a consistent character ───
// A character + a story idea → your text provider writes the beat sheet (a single
// pass, strict JSON), each slide is generated chaining the previous one as visual
// reference, ready to export in Meta's exact carousel format.
import sharp from 'sharp';
import type { TextProvider, StorageProvider, DcoRepository, StoryRecord, StorySlideRecord } from '../adapters/types.js';

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

// ─── Breaks the narrative into N ordered scenes (a single pass) ────────────────
export async function planStoryboard(text: TextProvider, narrative: string, slideCount: number): Promise<StoryBeat[]> {
    const prompt = `You are a creative director writing the script for a ${slideCount}-slide social media ad carousel.

STORY TO TELL:
${narrative}

Break this story into EXACTLY ${slideCount} scenes, in order, that together tell one coherent story from start to finish (opening → development → close/CTA). Each scene is ONE carousel slide.

Return ONLY valid JSON, an array of ${slideCount} objects, no markdown:
[
  { "sceneDesc": "detailed visual description of the scene, in English, for an image generator — who's in it, where, what's happening, mood", "copy": { "headline": "short headline for this slide", "cta": "short call to action, or an empty string if this slide has no CTA" } }
]

The last slide must ALWAYS have a clear CTA. Middle slides can leave cta empty if it doesn't apply.`;

    const responseText = await text.complete({ prompt, maxTokens: 2048 });
    const jsonMatch = extractJSON(responseText);
    if (!jsonMatch) throw new Error('Could not generate the carousel script (parse failed)');
    const beats = JSON.parse(jsonMatch);
    if (!Array.isArray(beats) || beats.length === 0) throw new Error('Empty script');
    return beats.slice(0, slideCount).map((b: any) => ({
        sceneDesc: String(b.sceneDesc || ''),
        copy: { headline: String(b.copy?.headline || ''), cta: String(b.copy?.cta || '') },
    }));
}

// ─── Persistence ────────────────────────────────────────────────────────────

async function uploadSlideImage(
    storage: StorageProvider, storyId: string, slideIndex: number, base64: string,
): Promise<{ url: string; path: string } | null> {
    try {
        const buf = Buffer.from(base64, 'base64');
        const resized = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
        const path = `${storyId}/slide-${slideIndex}.jpg`;
        const stored = await storage.upload({ bucket: STORIES_BUCKET, path, data: resized, contentType: 'image/jpeg' });
        return { url: stored.url, path: stored.path };
    } catch (err: any) {
        console.error('[stories] Error processing slide:', err.message);
        return null;
    }
}

export async function createStory(
    repository: DcoRepository,
    params: {
        profileId?: string; characterId?: string; title: string; narrative: string;
        platform?: string; format: '1:1' | '4:5'; slideCount: number; createdBy?: string;
    },
): Promise<StoryRecord> {
    return repository.stories.create({
        profileId: params.profileId,
        characterId: params.characterId,
        title: params.title,
        narrative: params.narrative,
        platform: params.platform || 'meta_carousel',
        format: params.format,
        slideCount: params.slideCount,
        createdBy: params.createdBy || '',
    });
}

export async function saveSlide(
    providers: { storage: StorageProvider; repository: DcoRepository },
    params: {
        storyId: string; slideIndex: number; sceneDesc: string; copy: { headline: string; cta: string };
        imageBase64: string; imageMime: string; qaScore: number; width: number; height: number;
    },
): Promise<StorySlideRecord> {
    const uploaded = await uploadSlideImage(providers.storage, params.storyId, params.slideIndex, params.imageBase64);
    return providers.repository.stories.saveSlide({
        storyId: params.storyId,
        slideIndex: params.slideIndex,
        sceneDesc: params.sceneDesc,
        copy: params.copy,
        imageUrl: uploaded?.url || '',
        imagePath: uploaded?.path || '',
        qaScore: params.qaScore,
        width: params.width,
        height: params.height,
    });
}

export async function listStories(repository: DcoRepository, profileId?: string): Promise<StoryRecord[]> {
    return repository.stories.list(profileId);
}

export async function getStory(repository: DcoRepository, id: string): Promise<(StoryRecord & { slides: StorySlideRecord[] }) | null> {
    return repository.stories.get(id);
}
