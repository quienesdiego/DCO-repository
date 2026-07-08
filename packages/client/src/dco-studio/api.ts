import type { DCOStudioProps } from './types';

/** Header de autenticación configurable — reemplaza el `X-Muse-Key` fijo del original.
 *  Si el host no pasa `apiKeyHeader`, no se agrega ningún header extra: la
 *  autenticación queda completamente a cargo de cómo el host monte este componente
 *  (proxy autenticado, cookie de sesión, etc). */
export function authHeaders(props: Pick<DCOStudioProps, 'apiKeyHeader'>, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (props.apiKeyHeader) headers[props.apiKeyHeader.name] = props.apiKeyHeader.value;
    return headers;
}

/** Base URL del backend, sin fallback de producción de ningún cliente — en desarrollo
 *  cae a localhost. */
export function resolveApiBase(apiBaseUrl: string): string {
    return (apiBaseUrl || 'http://localhost:3001').trim();
}
