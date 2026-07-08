// ─── Standard advertising format catalog ──────────────────────────────────────
// These sizes are industry-standard ad unit dimensions (Meta feed/story, IAB
// display banners, generic landscape) — not tied to any specific brand, so they
// port unchanged from the source system.

export interface FormatSpec {
    width: number;
    height: number;
    family: string;
    platform: string;
}

export const FORMATS: Record<string, FormatSpec> = {
    feed_portrait:     { width: 1080, height: 1350, family: 'portrait',   platform: 'Meta Feed Portrait 4:5' },
    feed_square:       { width: 1080, height: 1080, family: 'square',     platform: 'Meta Feed Square 1:1' },
    story_vertical:    { width: 1080, height: 1920, family: 'story',      platform: 'Stories / Reels 9:16' },
    banner_billboard:  { width: 970,  height: 250,  family: 'billboard',  platform: 'Display 970×250' },
    banner_skyscraper: { width: 160,  height: 600,  family: 'skyscraper', platform: 'Display 160×600' },
    banner_halfpage:   { width: 300,  height: 600,  family: 'halfpage',   platform: 'Display 300×600' },
    banner_mrec:       { width: 300,  height: 250,  family: 'mrec',       platform: 'Display 300×250' },
    feed_landscape:    { width: 1200, height: 628,  family: 'landscape',  platform: 'Landscape 1200×628' },
};

// Meta/Instagram carousel: 2-10 cards, same aspect ratio across the whole set.
export const CAROUSEL_FORMATS: Record<string, { width: number; height: number }> = {
    '1:1': { width: 1080, height: 1080 },
    '4:5': { width: 1080, height: 1350 },
};

// dimensions string ("1080x1080") → format id, used by the Excel brief parser.
const DIM_TO_FORMAT: Record<string, string> = {
    '1080x1080': 'feed_square',      '1080x1350': 'feed_portrait',   '1080x1920': 'story_vertical',
    '970x250':   'banner_billboard', '160x600':   'banner_skyscraper', '300x600': 'banner_halfpage',
    '300x250':   'banner_mrec',      '1200x628':  'feed_landscape',  '1200x630': 'feed_landscape',
};

export function dimToFormatId(dim: string): string | null {
    const norm = dim.toLowerCase().replace(/\s+/g, '').replace(/[×*]/g, 'x');
    return DIM_TO_FORMAT[norm] || null;
}

/** Uppercases + strips everything but letters/digits — used to match Excel header cells. */
export function normalizeKey(str: string): string {
    return String(str).toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ0-9]/g, '');
}

// Note: the source system had a `gptImageSizeFor()` helper here mapping format
// families to OpenAI's fixed image-edit sizes, and branched routes/dco.ts
// around it (banners needed a 2-request Gemini fallback because raw GPT-image
// calls couldn't hit that aspect ratio). Concrete ImageProvider adapters now
// own that size negotiation internally (see adapters/providers/openaiImage.ts
// pickSize()) — routes only ever call `provider.generate({ targetWidth,
// targetHeight, ... })` and let the adapter decide how to satisfy it.
