# Integration guide

DCO Studio is designed to be dropped into an existing product, using whatever
AI providers, database, and auth your platform already has. This doc covers
the two integration surfaces: the server (adapters) and the client (props).

## 1. Server: bring your own providers

`packages/server/src/index.ts` builds one `DcoProviders` object and passes it
to `createDcoRoutes(providers)`. Nothing in `routes/` or `services/` imports a
vendor SDK directly — they only depend on the interfaces in
`adapters/types.ts`. To integrate with your own stack, implement whichever
interfaces you need to replace and swap them in `buildProviders()`:

```ts
// packages/server/src/index.ts
const providers: DcoProviders = {
  image: myImageProvider,       // ImageProvider
  imageAlt: myBackupImageProvider, // optional
  text: myLLMProvider,          // TextProvider — copywriting/reasoning
  vision: myVisionProvider,     // TextProvider — multimodal QA + brand analysis
  storage: myStorageProvider,   // StorageProvider
  repository: myRepository,     // DcoRepository
};
app.route('/api/dco', createDcoRoutes(providers));
```

### ImageProvider — swap the image engine

```ts
export interface ImageProvider {
  readonly id: string;
  generate(input: {
    prompt: string;
    references: { base64: string; mimeType: string }[];
    targetWidth: number;
    targetHeight: number;
  }): Promise<{ base64: string; mimeType: string; width?: number; height?: number }>;
}
```
Implement this against Vertex AI, Bedrock (Titan/Nova), Azure OpenAI, Replicate,
Midjourney's API, or your own fine-tuned model. `references` always includes
the brand's reference creative first, then any product photos/character photo.

### TextProvider — swap the LLM(s)

```ts
export interface TextProvider {
  readonly id: string;
  complete(input: {
    system?: string; prompt: string; images?: { base64: string; mimeType: string }[];
    maxTokens?: number; temperature?: number; jsonMode?: boolean;
  }): Promise<string>;
}
```
Used for both `text` (copywriting/parsing/storyboards — doesn't need to see
images) and `vision` (QA verdicts + brand-identity extraction — always passes
images). You can point both at the same provider instance if your model of
choice is strong at both. `jsonMode: true` means the caller expects the
returned string to `JSON.parse()` cleanly — implement that however your
provider supports structured output (a `response_format` param, a system
instruction, whatever fits).

### StorageProvider / DcoRepository — swap persistence

Implement these against your own Postgres/Mongo/DynamoDB + S3/GCS/Blob
Storage. The default Supabase implementation
(`adapters/providers/supabase.ts`) is a reference you can read start to
finish — every method is a thin, direct mapping.

If your app already has a "brands" or "clients" table, the cleanest
integration is usually to implement `DcoRepository.brandProfiles` as a view
over your existing table (map your columns to `BrandProfileRecord`) rather
than adopting `dco_brand_profiles` verbatim.

## 2. Client: bring your own host app

`packages/client/src/DCOStudio.tsx` is a single React component you mount
inside your existing app shell. It takes no environment variables directly —
everything comes in as props, so the same build works across environments/tenants:

```tsx
<DCOStudio
  apiBaseUrl="https://your-dco-server.example.com"
  apiKeyHeader={{ name: 'X-Api-Key', value: yourApiKey }}
  brandColor="#111827"               // your product's accent color, not the ad brand's
  currentUserEmail={session.user.email}
/>
```

It has no dependency on any router, state manager, or design system beyond
`lucide-react` for icons — drop it into a route, a modal, a tab, wherever.

## 3. Auth

The server ships a minimal shared-secret gate (`DCO_API_SECRET` env var →
`X-Api-Key` header) in `index.ts`. Replace the Hono middleware there with
whatever your platform already uses (JWT, session cookie, mTLS) — it's a
single `app.use('*', ...)` block, not threaded through the rest of the code.

## 4. Fonts and brand voice

- Swap the embedded display fonts (`packages/server/fonts/*.ttf`) for your
  own via `DCO_FONTS_DIR`, and update the font-family map in
  `services/overlay.ts` (`pickFont`, `DEFAULT_STYLE`) to reference them.
- `QA_ISSUE_TRANSLATIONS` in the client (error-code → human string) is a
  single object literal — extend it for other languages or new QA codes.
