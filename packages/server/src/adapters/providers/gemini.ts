/**
 * Default Google Gemini adapter — implements both ImageProvider (image
 * generation/editing) and TextProvider (multimodal reasoning/JSON, used for
 * QA verdicts and brand-identity extraction) via plain REST calls (no SDK
 * dependency, so upgrading the API surface doesn't require a version bump here).
 *
 * Swap this out for Vertex AI, Bedrock, Azure OpenAI, or any other provider by
 * implementing the same two interfaces from ../types.js — nothing else in the
 * engine needs to change.
 */
import type { ImageProvider, TextProvider, ImagePart, GeneratedImage } from '../types.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function callGemini(apiKey: string, model: string, body: unknown, timeoutMs: number): Promise<any> {
    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Gemini ${model} ${res.status}`);
    return data;
}

/**
 * Image generation/editing provider. Model defaults to a Gemini image-preview
 * model — override via the `model` argument or GEMINI_IMAGE_MODEL env var.
 * Retries automatically on 429/503 (rate limit / overloaded), linear backoff.
 */
export function createGeminiImageProvider(opts: { apiKey: string; model?: string; maxRetries?: number }): ImageProvider {
    const model = opts.model || process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
    const maxRetries = opts.maxRetries ?? 3;

    return {
        id: `gemini:${model}`,
        async generate({ prompt, references, targetWidth, targetHeight }): Promise<GeneratedImage> {
            const parts: any[] = [
                ...references.map(r => ({ inlineData: { mimeType: r.mimeType, data: r.base64 } })),
                { text: prompt },
            ];
            let lastErr: any;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const data = await callGemini(opts.apiKey, model, {
                        contents: [{ parts }],
                        generationConfig: { responseModalities: ['IMAGE'] },
                    }, 120_000);
                    const imgPart = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
                    if (!imgPart) throw new Error('Gemini did not return an image');
                    return {
                        base64: imgPart.inlineData.data,
                        mimeType: imgPart.inlineData.mimeType || 'image/png',
                        width: targetWidth,
                        height: targetHeight,
                    };
                } catch (err: any) {
                    lastErr = err;
                    const retryable = /429|503|overloaded|rate.?limit/i.test(String(err.message));
                    if (!retryable || attempt === maxRetries) break;
                    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                }
            }
            throw lastErr;
        },
    };
}

/**
 * Multimodal text/JSON provider — used for QA verdicts and brand-identity
 * extraction (anything that needs to look at images and reason in text/JSON).
 * Model defaults to gemini-2.5-pro; override via `model` or GEMINI_TEXT_MODEL.
 */
export function createGeminiTextProvider(opts: { apiKey: string; model?: string }): TextProvider {
    const model = opts.model || process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-pro';

    return {
        id: `gemini:${model}`,
        async complete({ system, prompt, images, maxTokens, temperature, jsonMode }): Promise<string> {
            const imageParts: any[] = (images || []).map((img: ImagePart) => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } }));
            const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
            const data = await callGemini(opts.apiKey, model, {
                contents: [{ parts: [...imageParts, { text: fullPrompt }] }],
                generationConfig: {
                    temperature: temperature ?? 0,
                    ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
                    // gemini-2.5-pro spends "thinking" tokens before the visible JSON — a low
                    // maxOutputTokens can eat the whole budget on thinking and leave no output.
                    maxOutputTokens: maxTokens ?? 8192,
                },
            }, 45_000);
            return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        },
    };
}
