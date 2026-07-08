-- ============================================================================
-- DCO Studio — Supabase/Postgres schema (default DcoRepository implementation)
-- Run once in: Supabase → SQL Editor → New query → Run.
-- Brand identity lives 100% in data (dco_brand_profiles), never hardcoded —
-- that's what makes the engine reusable across brands/clients out of the box.
--
-- Using a different store? Implement the DcoRepository/StorageProvider
-- interfaces in packages/server/src/adapters/types.ts against your own
-- database instead — this file is only needed if you use the bundled
-- Supabase adapter (adapters/providers/supabase.ts).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ────────────────────────────────────────────────────────────────────────────
-- 1) BRAND PROFILES — visual identity + QA rules + copy voice, all per-brand
--    (data, not code). This is what POST /analyze-brand learns from a batch
--    of a brand's reference creatives.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists dco_brand_profiles (
    id               uuid primary key default gen_random_uuid(),
    name             text not null,
    color            text default '#6b7280',
    emoji            text default '🏷️',
    identity_prompt  text not null,                 -- visual creative direction (image gen)
    analysis_summary jsonb default '{}'::jsonb,      -- full output of /analyze-brand
    qa_rules         jsonb default '[]'::jsonb,      -- brand-specific QA rules
    copy_identity    jsonb default '{}'::jsonb,      -- tone, formula, do/don't words, audiences
    kv_count         integer default 0,
    created_by       text default '',
    created_at       timestamptz default now(),
    updated_at       timestamptz default now()
);
create index if not exists idx_dco_profiles_created on dco_brand_profiles (created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) FEEDBACK — 👍/👎 on generated pieces, replayed as context in future
--    generations for the same brand/format family (continuous improvement).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists dco_feedback (
    id             bigserial primary key,
    created_at     timestamptz default now(),
    profile_id     text,
    format_id      text,
    audience       text,
    scene_desc     text,
    headline       text,
    rating         text,          -- 'good' | 'bad'
    comment        text,
    user_email     text,
    chosen_version text            -- optional: which of N candidate versions was chosen
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) COPY BATCHES — optional: persisted output of the copywriting engine
--    (generate-copies / generate-copies-from-audiences), if you want to let
--    users revisit a previous batch instead of regenerating it. Not required
--    by the default DcoRepository interface; wire it up if you need it.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists dco_copy_batches (
    id          uuid primary key default gen_random_uuid(),
    profile_id  text,
    brand_name  text,
    identity    jsonb default '{}'::jsonb,
    pieces      jsonb default '[]'::jsonb,
    source_file text,
    created_by  text default '',
    created_at  timestamptz default now()
);
create index if not exists idx_dco_batches_profile on dco_copy_batches (profile_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) CHARACTERS — reference photo for consistency across generations. No
--    face-embedding column: "same person" verification runs inside the single
--    QA model pass (see services/qa.ts), not an external face-recognition API.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists dco_characters (
    id                   uuid primary key default gen_random_uuid(),
    name                 text not null,
    profile_id           text,                  -- optional brand id — null = available to all brands
    reference_photo_url  text not null,
    reference_photo_path text not null,         -- path within the bucket, so it can be deleted
    physical_notes       text default '',
    created_by           text default '',
    created_at           timestamptz default now(),
    updated_at           timestamptz default now()
);
create index if not exists idx_dco_characters_profile on dco_characters (profile_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 5) STORIES / CAROUSEL — multi-slide narrative with a consistent character,
--    ready to export in Meta/Instagram's exact carousel format.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists dco_stories (
    id            uuid primary key default gen_random_uuid(),
    profile_id    text,
    character_id  uuid references dco_characters(id) on delete set null,
    title         text not null,
    narrative     text not null,
    platform      text default 'meta_carousel',
    format        text default '1:1',              -- '1:1' | '4:5'
    slide_count   integer not null,
    created_by    text default '',
    created_at    timestamptz default now()
);
create index if not exists idx_dco_stories_profile on dco_stories (profile_id, created_at desc);

create table if not exists dco_story_slides (
    id              uuid primary key default gen_random_uuid(),
    story_id        uuid not null references dco_stories(id) on delete cascade,
    slide_index     integer not null,
    scene_desc      text,
    copy            jsonb default '{}'::jsonb,
    image_url       text,
    image_path      text,
    qa_score        numeric,
    width           integer,
    height          integer,
    created_at      timestamptz default now(),
    unique(story_id, slide_index)
);
create index if not exists idx_dco_story_slides_story on dco_story_slides (story_id, slide_index);

-- ────────────────────────────────────────────────────────────────────────────
-- Storage buckets used by the default StorageProvider (adapters/providers/supabase.ts).
-- Public read so generated URLs can be embedded directly in the frontend/export files.
-- ────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('dco-characters', 'dco-characters', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('dco-stories', 'dco-stories', true)
on conflict (id) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- RLS: the backend uses the Supabase SERVICE ROLE key, which bypasses RLS
-- entirely — RLS is intentionally left off here to avoid accidental lockouts.
-- If you ever expose these tables to a client using the anon key, enable RLS
-- and add explicit policies first.
-- ────────────────────────────────────────────────────────────────────────────
