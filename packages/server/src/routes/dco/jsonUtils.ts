// ─── Robust JSON extraction from LLM text output ──────────────────────────────
// Handles markdown code fences, leading/trailing prose, and truncated JSON
// (best-effort brace-matching repair) — shared by every route that parses a
// text/vision provider's response as JSON.

/** Extracts the first valid JSON object substring from free-form text, or null. */
export function extractJSON(text: string | null | undefined): string | null {
    if (!text) return null;
    // 1. ```json ... ``` fenced block
    const mdBlock = text.match(/```(?:json)?\s*(\{[\s\S]+?\})\s*```/);
    if (mdBlock) { try { JSON.parse(mdBlock[1]); return mdBlock[1]; } catch { /* fall through */ } }
    // 2. Largest { ... } block
    const raw = text.match(/\{[\s\S]+\}/);
    if (raw) { try { JSON.parse(raw[0]); return raw[0]; } catch { /* fall through */ } }
    // 3. Brace-match from the first '{' to repair truncated output
    const start = text.indexOf('{');
    if (start !== -1) {
        let depth = 0, end = -1;
        for (let i = start; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end !== -1) { try { JSON.parse(text.slice(start, end + 1)); return text.slice(start, end + 1); } catch { /* give up */ } }
    }
    return null;
}

/** Same as extractJSON but for a top-level JSON array. */
export function extractJSONArray(text: string | null | undefined): string | null {
    if (!text) return null;
    const mdBlock = text.match(/```(?:json)?\s*(\[[\s\S]+?\])\s*```/);
    if (mdBlock) { try { JSON.parse(mdBlock[1]); return mdBlock[1]; } catch { /* fall through */ } }
    const raw = text.match(/\[[\s\S]+\]/);
    if (raw) { try { JSON.parse(raw[0]); return raw[0]; } catch { /* fall through */ } }
    return null;
}

/** Strips ```json fences and extracts the first {...} block — used for text-provider replies. */
export function parseJsonLoose(text: string): any {
    let t = (text || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
    return JSON.parse(t);
}
