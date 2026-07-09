/**
 * Registro de las fuentes embebidas (backend/fonts) vía fontconfig — para que la capa
 * de marca del DCO (dcoOverlay) renderice con tipografías display profesionales (Anton,
 * Archivo Black, Barlow Condensed…) en vez de la fuente genérica del sistema.
 *
 * CRÍTICO — orden de carga: este módulo NO importa sharp y debe ejecutarse ANTES de
 * que cualquier módulo cargue sharp por primera vez (por eso es el primer import de
 * server.ts y de dcoOverlay.ts). La librería nativa de sharp (libvips/fontconfig)
 * captura FONTCONFIG_PATH cuando su DLL se carga: si sharp ya se importó, setear la
 * variable después no tiene efecto y todo cae a la fuente por defecto — verificado
 * en Windows local, mismo riesgo en el contenedor de Render.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

function findFontsDir(): string | null {
    // dist/services → ../../fonts (deploy) | src/services → ../../fonts (dev)
    const candidates = [
        path.resolve(__dirname_, '..', '..', 'fonts'),
        path.resolve(process.cwd(), 'fonts'),
        path.resolve(process.cwd(), 'backend', 'fonts'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'Anton-Regular.ttf'))) return c;
    }
    return null;
}

try {
    const fontsDir = findFontsDir();
    if (!fontsDir) {
        console.warn('[fontSetup] backend/fonts no encontrado — se usarán fuentes del sistema');
    } else {
        const cacheDir = path.join(os.tmpdir(), 'muse-fontconfig-cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const confDir = path.join(os.tmpdir(), 'muse-fontconfig');
        fs.mkdirSync(confDir, { recursive: true });
        const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir.replace(/&/g, '&amp;')}</dir>
  <cachedir>${cacheDir.replace(/&/g, '&amp;')}</cachedir>
</fontconfig>`;
        fs.writeFileSync(path.join(confDir, 'fonts.conf'), conf);
        process.env.FONTCONFIG_PATH = confDir;
        console.log('[fontSetup] Fuentes de marca registradas:', fontsDir);
    }
} catch (e: any) {
    console.warn('[fontSetup] No se pudo registrar fontconfig:', e.message);
}

export {};
