// ─── Utilidades compartidas de streaming SSE ───────────────────────────────
// El backend DCO expone varios endpoints como streams SSE simplificados: no son
// EventSource reales (no hay reconexión automática ni `Last-Event-ID`), son
// respuestas `fetch` de cuerpo largo donde cada evento es una línea `data: {...}\n`.
// Este patrón se repite igual en generate(), generate-carousel, recreate-formats y
// regenerateInFormat en el DCOView original — acá se extrae una sola vez.

/** Lee un `Response` como stream SSE simplificado (líneas `data: {...}`) y llama a
 *  `onEvent` por cada evento parseado. Igual que el original: JSON.parse con
 *  try/catch silencioso (una línea corrupta/parcial no debe tumbar el stream). */
export async function consumeSSE(res: Response, onEvent: (ev: any) => void): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
                onEvent(JSON.parse(line.slice(6)));
            } catch { /* ignore — línea corrupta/parcial */ }
        }
    }
}

/** fetch con 1 reintento ante cold start del backend (502/503 → espera 8s → reintenta
 *  una vez) — mismo criterio que el original para el backend en un tier gratuito/
 *  económico que puede estar dormido. `init` se pasa tal cual a ambos intentos (el
 *  `body` debe ser un tipo re-enviable, ej. FormData ya construido). */
export async function fetchWithColdStartRetry(input: string, init: RequestInit, onRetrying?: () => void): Promise<Response> {
    let res = await fetch(input, init);
    if (res.status === 502 || res.status === 503) {
        onRetrying?.();
        await new Promise(r => setTimeout(r, 8000));
        res = await fetch(input, init);
    }
    return res;
}

/** Extrae `{ error }` del cuerpo JSON de una respuesta no-OK, con fallback a
 *  `HTTP <status>` si el cuerpo no es JSON parseable — patrón repetido en todo el
 *  original para mensajes de error consistentes. */
export async function extractErrorDetail(res: Response): Promise<string> {
    let errDetail = `HTTP ${res.status}`;
    try {
        const j = await res.json();
        errDetail = j.error || errDetail;
    } catch { /* ignore */ }
    return errDetail;
}
