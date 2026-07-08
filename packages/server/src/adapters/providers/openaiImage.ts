/**
 * Default OpenAI image adapter — implements ImageProvider via the
 * /v1/images/edits REST endpoint (plain fetch, no SDK dependency).
 *
 * Useful as the `imageAlt` provider alongside Gemini (see providers/gemini.ts),
 * since the two engines have different aspect-ratio/size constraints — the
 * engine picks whichever provider fits the requested format.
 */
import type { ImageProvider, GeneratedImage } from '../types.js';

export function createOpenAIImageProvider(opts: { apiKey: string; model?: string }): ImageProvider {
    const model = opts.model || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

    return {
        id: `openai:${model}`,
        async generate({ prompt, references, targetWidth, targetHeight }): Promise<GeneratedImage> {
            const form = new FormData();
            form.set('model', model);
            form.set('prompt', prompt);
            form.set('size', pickSize(targetWidth, targetHeight));
            for (const [i, ref] of references.entries()) {
                const bytes = Buffer.from(ref.base64, 'base64');
                form.append('image[]', new Blob([bytes], { type: ref.mimeType }), `ref-${i}.${extFor(ref.mimeType)}`);
            }
            const res = await fetch('https://api.openai.com/v1/images/edits', {
                method: 'POST',
                headers: { Authorization: `Bearer ${opts.apiKey}` },
                body: form,
                signal: AbortSignal.timeout(120_000),
            });
            const data: any = await res.json();
            if (!res.ok) throw new Error(data?.error?.message || `OpenAI images/edits ${res.status}`);
            const b64 = data?.data?.[0]?.b64_json;
            if (!b64) throw new Error('OpenAI did not return image data');
            return { base64: b64, mimeType: 'image/png', width: targetWidth, height: targetHeight };
        },
    };
}

// gpt-image-1 only accepts a small set of fixed sizes; snap the requested
// aspect ratio to the closest supported one.
function pickSize(width: number, height: number): '1024x1024' | '1536x1024' | '1024x1536' {
    const ratio = width / height;
    if (ratio > 1.15) return '1536x1024';
    if (ratio < 0.87) return '1024x1536';
    return '1024x1024';
}

function extFor(mime: string): string {
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    return 'jpg';
}
