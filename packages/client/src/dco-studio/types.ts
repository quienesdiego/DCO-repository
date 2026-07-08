// ─── Tipos compartidos del módulo DCO Studio ───────────────────────────────
// Porteado 1:1 desde el DCOView.tsx original, sin cambios de forma salvo el
// renombre de `vitamina_chip` → `chip` (ver CopyData.chip más abajo), que se
// propagó a todo el sistema (frontend + backend).

export type GenStatus = 'idle' | 'generating' | 'done' | 'error';

export interface BriefRow {
    rowIndex: number;
    audience: string;
    audienciaRef: string;
    drivers: string;
    tono: string;
    variante: string;
    observaciones: string;
    copyPreview: string;
    copyFull: string;
    dimensions: string;
    formatId: string;
    formatLabel: string;
    platform: string;
    campaña: string;
    characterId?: string;
    beneficios?: string[];
    // Perfil visual de audiencia (vestuario/accesorios/entorno) — solo presente cuando la
    // fila viene del modo Automático/audiencias con IA; alimenta /recreate-formats para
    // cambiar personaje/entorno, no aplica al flujo tradicional de Excel.
    wardrobe?: string;
    headwear?: string;
    environment?: string;
    varyScene?: boolean;
}

export interface ProfileEntry {
    id: string;
    name: string;
    emoji: string;
    color: string;
    type: 'builtin' | 'saved';
    kvCount?: number;
    identityPrompt?: string;
    productCategory?: string;
    productBenefits?: string[];
}

export interface CopyData {
    headline: string; subhead: string; chip: string; body: string; cta: string;
    // Beneficios como lista de bullets cortos — "body" queda como texto derivado
    // (join de los bullets) para no romper nada que ya lea copyData.body.
    beneficios?: string[];
}

export interface FormatResult {
    taskId: string;
    format: string;
    label: string;
    audience?: string;
    copyPreview?: string;
    platform: string;
    width: number;
    height: number;
    imageBase64: string;
    mimeType: string;
    status: 'waiting' | 'generating' | 'qa_check' | 'done' | 'error';
    error?: string;
    feedback?: 'good' | 'bad' | null;
    feedbackComment?: string;
    feedbackSent?: boolean;
    sceneDesc?: string;
    copyData?: CopyData;
    qaAttempts?: number;
    videoPrompt?: string;
    gifBase64?: string;
    qaResult?: { score: number; passed: boolean; issues: string[] } | null;
}

// Marcado manual de zonas sobre el KV — en vez de dejar que la IA adivine dónde va
// cada elemento de copy, el usuario dibuja la caja directamente sobre la imagen de
// referencia y esa posición exacta (en % del ancho/alto) se manda al backend para que
// la respete en vez de inventar una zona propia.
// NOTA: "body"/Beneficios no es una zona fija — son N zonas "benefit_1".."benefit_N"
// (una por cada bullet corto), porque un KV real trae 1, 3, o la cantidad que sea de
// beneficios como bullets separados, no un párrafo único.
export type FixedZoneLabel = 'headline' | 'subhead' | 'chip' | 'cta'
    | 'logo' | 'brand_name' | 'conglomerate_logo' | 'character';
export type ZoneLabel = FixedZoneLabel | string; // string cubre "benefit_1", "benefit_2", ...

export interface ManualZone { x: number; y: number; w: number; h: number; }

export type RecreateCopy = { headline: string; subhead: string; beneficios: string[]; cta: string };

// ─── Props públicas del componente ─────────────────────────────────────────
export interface DCOStudioProps {
    /** Base URL del backend DCO (ej. "https://api.tuapp.com"). Sin fallback de
     *  producción ajeno — si no se pasa, cae a localhost para desarrollo local. */
    apiBaseUrl: string;
    /** Header extra de autenticación que el host quiera inyectar en cada request
     *  (ej. { name: 'X-API-Key', value: '...' }). Si se omite, no se agrega ningún
     *  header extra — la autenticación queda 100% a cargo del host. */
    apiKeyHeader?: { name: string; value: string };
    /** Color de marca de la HERRAMIENTA (no de la marca del cliente final) — se usa
     *  en header, botones y bordes activos. Default: azul neutro. */
    brandColor?: string;
    /** Email del usuario logueado, provisto por el host — se manda en /feedback y
     *  /save-profile. Si se omite, esos payloads viajan con userEmail/createdBy vacío. */
    currentUserEmail?: string;
    /** Reservado para que el host persista/sincronice el email del usuario si lo
     *  necesita (ej. tras un flujo de login embebido). El componente no lo invoca
     *  internamente — no hay ningún flujo de captura de usuario en el DCO original. */
    onPersistUser?: (email: string) => void;
}
