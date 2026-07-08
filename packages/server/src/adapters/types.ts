/**
 * DCO Studio — Adapter contracts.
 *
 * Everything the engine needs from the outside world (image generation,
 * text/LLM generation, vision QA, and persistence/storage) is expressed as
 * an interface here. The engine (services/, routes/) never imports a
 * concrete provider SDK directly — it only depends on these types.
 *
 * To integrate DCO Studio with your own stack:
 *   1. Implement whichever interfaces below you need (or reuse the default
 *      providers in adapters/providers/ and just supply API keys via env).
 *   2. Wire your implementations in src/index.ts when constructing the
 *      DcoEngine.
 *
 * You are not required to use Gemini/OpenAI/Anthropic/Supabase — swap any
 * of them for your own provider (Bedrock, Vertex, Azure OpenAI, Postgres+S3,
 * your internal CMS, etc.) as long as your implementation satisfies the
 * interface.
 */

export interface GeneratedImage {
  base64: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface ImagePart {
  base64: string;
  mimeType: string;
}

/** Generates or edits a photograph from a text prompt + reference images. */
export interface ImageProvider {
  readonly id: string;
  generate(input: {
    prompt: string;
    references: ImagePart[];
    targetWidth: number;
    targetHeight: number;
  }): Promise<GeneratedImage>;
}

/** General-purpose text/reasoning LLM (copywriting, brief parsing, storyboards). */
export interface TextProvider {
  readonly id: string;
  complete(input: {
    system?: string;
    prompt: string;
    images?: ImagePart[];
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
  }): Promise<string>;
}

export interface StoredFile {
  url: string;
  path: string;
}

/** Binary storage (character photos, story slides, exported files). */
export interface StorageProvider {
  readonly id: string;
  upload(input: {
    bucket: string;
    path: string;
    data: Buffer;
    contentType: string;
  }): Promise<StoredFile>;
  remove(input: { bucket: string; path: string }): Promise<void>;
}

/**
 * Minimal persistence contract. The default Supabase/Postgres adapter maps
 * these 1:1 to tables (see db/schema.sql); a custom adapter can back this
 * with any store (Mongo, DynamoDB, your app's existing DB) as long as it
 * keeps the same shape.
 */
export interface DcoRepository {
  brandProfiles: {
    list(): Promise<BrandProfileRecord[]>;
    get(id: string): Promise<BrandProfileRecord | null>;
    save(profile: Omit<BrandProfileRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<BrandProfileRecord>;
    delete(id: string): Promise<void>;
  };
  characters: {
    list(profileId?: string): Promise<CharacterRecord[]>;
    get(id: string): Promise<CharacterRecord | null>;
    create(character: Omit<CharacterRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<CharacterRecord>;
    delete(id: string): Promise<void>;
  };
  stories: {
    list(profileId?: string): Promise<StoryRecord[]>;
    get(id: string): Promise<(StoryRecord & { slides: StorySlideRecord[] }) | null>;
    create(story: Omit<StoryRecord, 'id' | 'createdAt'>): Promise<StoryRecord>;
    saveSlide(slide: Omit<StorySlideRecord, 'id' | 'createdAt'>): Promise<StorySlideRecord>;
  };
  feedback: {
    add(entry: FeedbackRecord): Promise<void>;
    contextFor(input: { profileId: string; formatFamily: string }): Promise<string>;
  };
}

export interface BrandProfileRecord {
  id: string;
  name: string;
  color: string;
  emoji: string;
  identityPrompt: string;
  analysisSummary: Record<string, unknown>;
  qaRules: string[];
  copyIdentity: Record<string, unknown>;
  kvCount: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterRecord {
  id: string;
  name: string;
  profileId?: string;
  referencePhotoUrl: string;
  referencePhotoPath: string;
  physicalNotes?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoryRecord {
  id: string;
  profileId?: string;
  characterId?: string;
  title: string;
  narrative: string;
  platform: string;
  format: '1:1' | '4:5';
  slideCount: number;
  createdBy?: string;
  createdAt: string;
}

export interface StorySlideRecord {
  id: string;
  storyId: string;
  slideIndex: number;
  sceneDesc: string;
  copy: Record<string, string>;
  imageUrl: string;
  imagePath: string;
  qaScore: number;
  width: number;
  height: number;
  createdAt: string;
}

export interface FeedbackRecord {
  profileId: string;
  formatId: string;
  audience: string;
  sceneDesc?: string;
  headline: string;
  rating: 'good' | 'bad';
  comment?: string;
  userEmail?: string;
}

/**
 * Everything the engine needs, bundled. Build one of these in your app entrypoint
 * and pass it into createDcoRoutes(providers).
 *
 * `text` and `vision` are both TextProvider — split into two slots because in
 * practice you'll often want a different model for each job (e.g. Claude for
 * copywriting/reasoning, Gemini for multimodal QA/brand-identity extraction,
 * since it needs to look at images and return strict JSON cheaply). Nothing
 * stops you from pointing both at the same provider instance.
 */
export interface DcoProviders {
  /** Paints the base photograph. Never receives real copy — see docs/ARCHITECTURE.md. */
  image: ImageProvider;
  /** Optional second image provider selectable per-request (e.g. a cheaper/faster option). */
  imageAlt?: ImageProvider;
  /** General reasoning/copywriting LLM (brief parsing, copy generation, storyboards). */
  text: TextProvider;
  /** Multimodal LLM used for QA verdicts and brand-identity extraction from images. */
  vision: TextProvider;
  storage: StorageProvider;
  repository: DcoRepository;
}
