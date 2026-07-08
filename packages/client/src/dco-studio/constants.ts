// ─── Constantes compartidas del módulo DCO Studio ──────────────────────────

export const FORMATS = [
    { id: 'feed_square',       label: 'Cuadrado',            dims: '1080×1080', platform: 'Instagram / Facebook' },
    { id: 'feed_portrait',     label: 'Vertical (4:5)',      dims: '1080×1350', platform: 'Instagram / Facebook' },
    { id: 'story_vertical',    label: 'Pantalla completa',   dims: '1080×1920', platform: 'Stories / Reels / TikTok' },
    { id: 'banner_billboard',  label: 'Banner ancho',        dims: '970×250',   platform: 'Sitios web' },
    { id: 'banner_skyscraper', label: 'Banner vertical',     dims: '160×600',   platform: 'Sitios web' },
    { id: 'banner_halfpage',   label: 'Banner mediano',      dims: '300×600',   platform: 'Sitios web' },
    { id: 'banner_mrec',       label: 'Banner rectangular',  dims: '300×250',   platform: 'Sitios web' },
    { id: 'feed_landscape',    label: 'Horizontal',          dims: '1200×628',  platform: 'LinkedIn' },
];

export const KV_FORMAT_OPTIONS = [
    { value: 'square',   label: 'Cuadrado' },
    { value: 'portrait', label: 'Vertical 4:5' },
    { value: 'vertical', label: 'Story/Reels' },
    { value: 'banner',   label: 'Banner' },
    { value: 'general',  label: 'Sin especificar' },
];

// Formatos que GPT-image NO soporta (excede su límite de aspect ratio 3:1 y su mínimo
// de píxeles totales) — se filtran solos si están seleccionados al cambiar a GPT.
export const GPT_UNSUPPORTED_FORMATS = ['banner_billboard', 'banner_skyscraper', 'banner_halfpage', 'banner_mrec'];

// Formato "proxy" soportado que se usa como paso intermedio cuando un banner necesita
// cambio creativo (copy/audiencia nueva) en /recreate-formats — ver recreateOneFormat
// en DCOStudio.tsx para el detalle del flujo en 2 pasos.
export const PROXY_FORMAT_FOR_BANNER: Record<string, string> = {
    banner_billboard:  'feed_landscape',
    banner_skyscraper: 'story_vertical',
    banner_halfpage:   'story_vertical',
    banner_mrec:       'feed_square',
};

export const RECREATE_FORMAT_OPTIONS = FORMATS.map(f => f.id);

// Traduce los códigos internos de QA a una frase corta legible — sin esto, el usuario
// final solo vería algo como "STYLE_FIDELITY: 4/10" en un tooltip, sin contexto de qué
// significa. Hace match por prefijo porque el código real trae detalle después del ":".
//
// Este diccionario es deliberadamente simple y reemplazable: para agregar un nuevo
// código de QA, o para traducir a otro idioma, basta con agregar/editar una entrada acá
// — no hay ninguna otra dependencia oculta en el resto del componente.
export const QA_ISSUE_TRANSLATIONS: [RegExp, string][] = [
    [/^TEXT_IN_PHOTO/i,        'La IA escribió texto en la foto (no debería) — se está regenerando.'],
    [/^LAYOUT_LABEL_LEAK/i,    'Apareció una etiqueta interna como texto visible en la imagen.'],
    [/^EXTRA_LIMBS/i,          'El personaje salió con más brazos o piernas de la cuenta.'],
    [/^FINGER_DEFORMITY/i,     'Las manos/dedos salieron mal formados.'],
    [/^FACE_ANOMALY/i,         'La cara salió con una asimetría o duplicación rara.'],
    [/^FLOATING_LIMB/i,        'Alguna parte del cuerpo quedó flotando, sin conectar.'],
    [/^CHARACTER_MATCH/i,      'El protagonista no se parece a la foto de referencia del personaje.'],
    [/^STYLE_FIDELITY/i,       'La escena no se siente lo suficiente de tu marca (colores/energía gráfica débiles).'],
    [/^CREATIVE_FRESHNESS/i,   'La escena quedó demasiado parecida al KV — se pidió más variación.'],
    [/^QA_MODEL_ERROR/i,       'No se pudo verificar automáticamente (falla de red) — se entregó sin bloquear.'],
];

export function translateQaIssue(issue: string): string {
    const match = QA_ISSUE_TRANSLATIONS.find(([re]) => re.test(issue));
    return match ? match[1] : issue;
}
