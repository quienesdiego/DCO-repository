/**
 * Registers the bundled display fonts (packages/server/fonts) via fontconfig so the
 * deterministic brand layer (services/overlay.ts) renders real display typefaces
 * (Anton, Archivo Black, Barlow Condensed…) instead of the system's default font.
 *
 * CRITICAL load order: this module must NOT import sharp, and must run BEFORE any
 * module imports sharp for the first time (that's why it's the first import in
 * src/index.ts and in services/overlay.ts). Sharp's native binding (libvips/fontconfig)
 * reads FONTCONFIG_PATH once, at load time — setting the env var afterwards has no
 * effect and everything silently falls back to the system default font.
 *
 * Bring your own fonts: set DCO_FONTS_DIR to point at a folder with your own .ttf
 * files, then update services/overlay.ts's font map to reference their file names.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

function findFontsDir(): string | null {
    const candidates = [
        process.env.DCO_FONTS_DIR,
        path.resolve(__dirname_, '..', '..', 'fonts'), // dist/services or src/services -> ../../fonts
        path.resolve(process.cwd(), 'fonts'),
        path.resolve(process.cwd(), 'packages', 'server', 'fonts'),
    ].filter(Boolean) as string[];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'Anton-Regular.ttf'))) return c;
    }
    return null;
}

try {
    const fontsDir = findFontsDir();
    if (!fontsDir) {
        console.warn('[fontSetup] fonts dir not found — falling back to system fonts');
    } else {
        const cacheDir = path.join(os.tmpdir(), 'dco-fontconfig-cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const confDir = path.join(os.tmpdir(), 'dco-fontconfig');
        fs.mkdirSync(confDir, { recursive: true });
        const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir.replace(/&/g, '&amp;')}</dir>
  <cachedir>${cacheDir.replace(/&/g, '&amp;')}</cachedir>
</fontconfig>`;
        fs.writeFileSync(path.join(confDir, 'fonts.conf'), conf);
        process.env.FONTCONFIG_PATH = confDir;
        console.log('[fontSetup] Brand fonts registered:', fontsDir);
    }
} catch (e: any) {
    console.warn('[fontSetup] Could not register fontconfig:', e.message);
}

export {};
