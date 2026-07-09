-- ============================================================================
-- MUSE · DCO — Esquema Supabase (identidad 100% por marca, sin hardcode)
-- Ejecutar UNA sola vez en:  Supabase → SQL Editor → New query → Run
-- No depende de la función exec_sql (que no existe por defecto).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ────────────────────────────────────────────────────────────────────────────
-- 1) PERFILES DE MARCA — identidad visual + QA + copy, TODO por marca (data, no código)
--    Aquí vive lo que aprende `analyze-brand` desde los KVs de cada marca.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists dco_brand_profiles (
    id               uuid primary key default gen_random_uuid(),
    name             text not null,
    color            text default '#6b7280',
    emoji            text default '🏷️',
    identity_prompt  text not null,                 -- dirección creativa visual (image gen)
    analysis_summary jsonb default '{}'::jsonb,      -- salida completa de analyze-brand
    qa_rules         jsonb default '[]'::jsonb,      -- reglas QA PROPIAS de la marca (de-hardcode del QA)
    copy_identity    jsonb default '{}'::jsonb,      -- tono, fórmula, palabras +/- , audiencias (de-hardcode del copy)
    kv_count         integer default 0,
    created_by       text default '',
    created_at       timestamptz default now(),
    updated_at       timestamptz default now()
);
create index if not exists idx_dco_profiles_created on dco_brand_profiles (created_at desc);

-- Si la tabla ya existía sin estas columnas, las agrega sin perder datos:
alter table dco_brand_profiles add column if not exists qa_rules      jsonb default '[]'::jsonb;
alter table dco_brand_profiles add column if not exists copy_identity jsonb default '{}'::jsonb;
alter table dco_brand_profiles add column if not exists updated_at    timestamptz default now();

-- ────────────────────────────────────────────────────────────────────────────
-- 2) FEEDBACK — calificación de piezas generadas (mejora continua)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists dco_feedback (
    id          bigserial primary key,
    created_at  timestamptz default now(),
    profile_id  text,
    format_id   text,
    audience    text,
    scene_desc  text,
    headline    text,
    rating      text,          -- 'good' | 'bad'
    comment     text,
    user_email  text
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) LOTES DE COPYS — cada cuadro de materiales generado por el motor de copys
--    Guarda la identidad de copy inferida + las filas generadas (reutilizable).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists dco_copy_batches (
    id          uuid primary key default gen_random_uuid(),
    profile_id  text,                          -- id de marca (uuid de dco_brand_profiles o built-in)
    brand_name  text,
    identity    jsonb default '{}'::jsonb,      -- identidad de copy inferida del cuadro base
    pieces      jsonb default '[]'::jsonb,      -- filas del cuadro generado (DCO-compatibles)
    source_file text,
    created_by  text default '',
    created_at  timestamptz default now()
);
create index if not exists idx_dco_batches_profile on dco_copy_batches (profile_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) PERSONAJES — foto de referencia para consistencia entre generaciones.
--    Sin face_embedding: la verificación de "misma persona" corre dentro del
--    mismo pase único de Gemini que ya hace el QA (ver dcoQa.ts) — no depende
--    de ninguna API externa de reconocimiento facial.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists dco_characters (
    id                   uuid primary key default gen_random_uuid(),
    name                 text not null,
    profile_id           text,                  -- id de marca opcional (uuid o built-in) — null = disponible para todas
    reference_photo_url  text not null,
    reference_photo_path text not null,         -- path dentro del bucket, para poder borrarla
    physical_notes       text default '',        -- notas opcionales para reforzar la instrucción de identidad
    created_by           text default '',
    created_at           timestamptz default now(),
    updated_at           timestamptz default now()
);
create index if not exists idx_dco_characters_profile on dco_characters (profile_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 5) HISTORIAS / CARRUSEL — narrativa multi-slide con un personaje consistente,
--    lista para exportar en el formato exacto de carrusel de Meta/Instagram.
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
-- RLS: el backend usa SUPABASE_SERVICE_ROLE_KEY, que IGNORA RLS (bypass total).
-- Por eso NO activamos RLS aquí (evita bloqueos accidentales). Si algún día
-- expones estas tablas al cliente con la anon key, activa RLS y agrega políticas.
-- ────────────────────────────────────────────────────────────────────────────
