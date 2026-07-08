// ─── Helpers de color para el acento de marca configurable ─────────────────
// El original tenía el rojo de MUSE (#E30613) repetido como literal en decenas de
// `style={{...}}` a lo largo del archivo. Acá se centraliza en una sola función que
// deriva variantes (más clara/oscura, e con transparencia) de un único color base
// configurable vía `props.brandColor`, para que el resto del componente nunca
// hardcodee un color de marca ajeno.

/** Aclara (percent > 0) u oscurece (percent < 0) un color hex. percent en [-100, 100]. */
export function shadeColor(hex: string, percent: number): string {
    const clean = hex.replace('#', '');
    const num = parseInt(clean.length === 3
        ? clean.split('').map(c => c + c).join('')
        : clean, 16);
    if (Number.isNaN(num)) return hex;
    const amt = Math.round(2.55 * percent);
    let r = (num >> 16) + amt;
    let g = ((num >> 8) & 0x00ff) + amt;
    let b = (num & 0x0000ff) + amt;
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    return `#${(0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1)}`;
}

/** Convierte un color hex a rgba(...) con la transparencia dada — reemplaza los
 *  literales `rgba(227,6,19,0.06)` etc. del original, ahora derivados del acento. */
export function hexToRgba(hex: string, alpha: number): string {
    const clean = hex.replace('#', '');
    const num = parseInt(clean.length === 3
        ? clean.split('').map(c => c + c).join('')
        : clean, 16);
    if (Number.isNaN(num)) return hex;
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
