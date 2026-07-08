/**
 * Default Supabase adapter — implements both StorageProvider (Storage buckets)
 * and DcoRepository (Postgres tables, see ../../db/schema.sql) using the
 * service-role key (bypasses RLS; this backend is the only trusted writer).
 *
 * Swap this out for your own Postgres/S3/Mongo/whatever by implementing
 * StorageProvider and DcoRepository from ../types.js — the engine and routes
 * never import @supabase/supabase-js directly.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
    StorageProvider, DcoRepository, BrandProfileRecord, CharacterRecord,
    StoryRecord, StorySlideRecord, FeedbackRecord,
} from '../types.js';

export function createSupabaseClient(opts: { url: string; serviceKey: string }): SupabaseClient {
    return createClient(opts.url, opts.serviceKey, { auth: { persistSession: false } });
}

export function createSupabaseStorage(client: SupabaseClient): StorageProvider {
    return {
        id: 'supabase-storage',
        async upload({ bucket, path, data, contentType }) {
            const { error } = await client.storage.from(bucket).upload(path, data, { contentType, upsert: true });
            if (error) throw new Error(error.message);
            const { data: pub } = client.storage.from(bucket).getPublicUrl(path);
            return { url: pub.publicUrl, path };
        },
        async remove({ bucket, path }) {
            await client.storage.from(bucket).remove([path]);
        },
    };
}

function profileFromRow(row: any): BrandProfileRecord {
    return {
        id: row.id,
        name: row.name,
        color: row.color,
        emoji: row.emoji,
        identityPrompt: row.identity_prompt || '',
        analysisSummary: row.analysis_summary || {},
        qaRules: row.qa_rules || [],
        copyIdentity: row.copy_identity || {},
        kvCount: row.kv_count || 0,
        createdBy: row.created_by || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function characterFromRow(row: any): CharacterRecord {
    return {
        id: row.id,
        name: row.name,
        profileId: row.profile_id || undefined,
        referencePhotoUrl: row.reference_photo_url,
        referencePhotoPath: row.reference_photo_path,
        physicalNotes: row.physical_notes || '',
        createdBy: row.created_by || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function storyFromRow(row: any): StoryRecord {
    return {
        id: row.id,
        profileId: row.profile_id || undefined,
        characterId: row.character_id || undefined,
        title: row.title,
        narrative: row.narrative,
        platform: row.platform,
        format: row.format,
        slideCount: row.slide_count,
        createdBy: row.created_by || undefined,
        createdAt: row.created_at,
    };
}

function slideFromRow(row: any): StorySlideRecord {
    return {
        id: row.id,
        storyId: row.story_id,
        slideIndex: row.slide_index,
        sceneDesc: row.scene_desc,
        copy: row.copy || {},
        imageUrl: row.image_url || '',
        imagePath: row.image_path || '',
        qaScore: row.qa_score ?? 0,
        width: row.width,
        height: row.height,
        createdAt: row.created_at,
    };
}

export function createSupabaseRepository(client: SupabaseClient): DcoRepository {
    return {
        brandProfiles: {
            async list() {
                const { data, error } = await client.from('dco_brand_profiles').select('*').order('created_at', { ascending: false });
                if (error) throw new Error(error.message);
                return (data || []).map(profileFromRow);
            },
            async get(id) {
                const { data, error } = await client.from('dco_brand_profiles').select('*').eq('id', id).maybeSingle();
                if (error) throw new Error(error.message);
                return data ? profileFromRow(data) : null;
            },
            async save(profile) {
                const { data, error } = await client.from('dco_brand_profiles').insert({
                    name: profile.name,
                    color: profile.color,
                    emoji: profile.emoji,
                    identity_prompt: profile.identityPrompt,
                    analysis_summary: profile.analysisSummary,
                    qa_rules: profile.qaRules,
                    copy_identity: profile.copyIdentity,
                    kv_count: profile.kvCount,
                    created_by: profile.createdBy || '',
                }).select('*').single();
                if (error) throw new Error(error.message);
                return profileFromRow(data);
            },
            async delete(id) {
                const { error } = await client.from('dco_brand_profiles').delete().eq('id', id);
                if (error) throw new Error(error.message);
            },
        },
        characters: {
            async list(profileId) {
                let query = client.from('dco_characters').select('*').order('created_at', { ascending: false });
                if (profileId) query = query.or(`profile_id.eq.${profileId},profile_id.is.null`);
                const { data, error } = await query;
                if (error) throw new Error(error.message);
                return (data || []).map(characterFromRow);
            },
            async get(id) {
                const { data, error } = await client.from('dco_characters').select('*').eq('id', id).maybeSingle();
                if (error) throw new Error(error.message);
                return data ? characterFromRow(data) : null;
            },
            async create(character) {
                const { data, error } = await client.from('dco_characters').insert({
                    name: character.name,
                    profile_id: character.profileId || null,
                    reference_photo_url: character.referencePhotoUrl,
                    reference_photo_path: character.referencePhotoPath,
                    physical_notes: character.physicalNotes || '',
                    created_by: character.createdBy || '',
                }).select('*').single();
                if (error) throw new Error(error.message);
                return characterFromRow(data);
            },
            async delete(id) {
                const { error } = await client.from('dco_characters').delete().eq('id', id);
                if (error) throw new Error(error.message);
            },
        },
        stories: {
            async list(profileId) {
                let query = client.from('dco_stories').select('*').order('created_at', { ascending: false });
                if (profileId) query = query.eq('profile_id', profileId);
                const { data, error } = await query;
                if (error) throw new Error(error.message);
                return (data || []).map(storyFromRow);
            },
            async get(id) {
                const { data: story, error } = await client.from('dco_stories').select('*').eq('id', id).maybeSingle();
                if (error) throw new Error(error.message);
                if (!story) return null;
                const { data: slides, error: slidesError } = await client
                    .from('dco_story_slides').select('*').eq('story_id', id).order('slide_index', { ascending: true });
                if (slidesError) throw new Error(slidesError.message);
                return { ...storyFromRow(story), slides: (slides || []).map(slideFromRow) };
            },
            async create(story) {
                const { data, error } = await client.from('dco_stories').insert({
                    profile_id: story.profileId || null,
                    character_id: story.characterId || null,
                    title: story.title,
                    narrative: story.narrative,
                    platform: story.platform,
                    format: story.format,
                    slide_count: story.slideCount,
                    created_by: story.createdBy || '',
                }).select('*').single();
                if (error) throw new Error(error.message);
                return storyFromRow(data);
            },
            async saveSlide(slide) {
                const { data, error } = await client.from('dco_story_slides').upsert({
                    story_id: slide.storyId,
                    slide_index: slide.slideIndex,
                    scene_desc: slide.sceneDesc,
                    copy: slide.copy,
                    image_url: slide.imageUrl || null,
                    image_path: slide.imagePath || null,
                    qa_score: slide.qaScore,
                    width: slide.width,
                    height: slide.height,
                }, { onConflict: 'story_id,slide_index' }).select('*').single();
                if (error) throw new Error(error.message);
                return slideFromRow(data);
            },
        },
        feedback: {
            async add(entry: FeedbackRecord) {
                const { error } = await client.from('dco_feedback').insert({
                    profile_id: entry.profileId,
                    format_id: entry.formatId,
                    audience: entry.audience,
                    scene_desc: entry.sceneDesc || '',
                    headline: entry.headline,
                    rating: entry.rating,
                    comment: entry.comment || '',
                    user_email: entry.userEmail || '',
                });
                if (error) throw new Error(error.message);
            },
            async contextFor({ profileId, formatFamily }) {
                const { data, error } = await client
                    .from('dco_feedback')
                    .select('rating, headline, scene_desc, comment')
                    .eq('profile_id', profileId)
                    .eq('format_id', formatFamily)
                    .order('created_at', { ascending: false })
                    .limit(20);
                if (error || !data?.length) return '';
                const good = data.filter(r => r.rating === 'good');
                const bad = data.filter(r => r.rating === 'bad');
                const lines: string[] = [];
                if (good.length) lines.push(`What has worked before: ${good.slice(0, 5).map(r => r.headline).filter(Boolean).join(' | ')}`);
                if (bad.length) lines.push(`Mistakes to avoid: ${bad.slice(0, 5).map(r => r.comment || r.headline).filter(Boolean).join(' | ')}`);
                return lines.join('\n');
            },
        },
    };
}
