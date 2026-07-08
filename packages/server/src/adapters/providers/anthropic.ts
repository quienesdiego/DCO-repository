/**
 * Default Anthropic (Claude) adapter — implements TextProvider for
 * copywriting, brief parsing, and storyboard generation.
 *
 * Requires the `@anthropic-ai/sdk` package (see package.json).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { TextProvider, ImagePart } from '../types.js';

export function createAnthropicTextProvider(opts: { apiKey: string; model?: string }): TextProvider {
    const model = opts.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
    const client = new Anthropic({ apiKey: opts.apiKey });

    return {
        id: `anthropic:${model}`,
        async complete({ system, prompt, images, maxTokens, temperature, jsonMode }): Promise<string> {
            const content: any[] = [
                ...(images || []).map((img: ImagePart) => ({
                    type: 'image',
                    source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
                })),
                { type: 'text', text: jsonMode ? `${prompt}\n\nRespond with ONLY valid JSON, no markdown fences.` : prompt },
            ];
            const response = await client.messages.create({
                model,
                max_tokens: maxTokens ?? 4096,
                temperature: temperature,
                system,
                messages: [{ role: 'user', content }],
            });
            const block = response.content.find(b => b.type === 'text');
            return block && block.type === 'text' ? block.text : '';
        },
    };
}
