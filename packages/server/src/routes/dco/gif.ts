// ─── GIF animator: JPEG/PNG frames → animated GIF ─────────────────────────────
// Pure post-processing, no AI/brand-specific content — ported unchanged.
export async function buildAnimatedGif(frames: { data: string; mime: string }[]): Promise<string | null> {
    try {
        const GIFEncoder = (await import('gif-encoder-2')).default;
        const { PNG } = await import('pngjs');
        const jpeg = (await import('jpeg-js')).default;

        const decoded: { data: Uint8Array; width: number; height: number }[] = [];
        for (const frame of frames) {
            const buf = Buffer.from(frame.data, 'base64');
            try {
                const isJpeg = frame.mime.includes('jpeg') || frame.mime.includes('jpg');
                if (isJpeg) {
                    const d = jpeg.decode(buf, { useTArray: true });
                    decoded.push({ data: d.data as Uint8Array, width: d.width, height: d.height });
                } else {
                    const png = PNG.sync.read(buf);
                    decoded.push({ data: new Uint8Array(png.data), width: png.width, height: png.height });
                }
            } catch {
                // skip unreadable frame
            }
        }

        if (decoded.length < 2) {
            console.warn('[dco] GIF: not enough valid frames:', decoded.length);
            return null;
        }

        const actualWidth = decoded[0].width;
        const actualHeight = decoded[0].height;

        const encoder = new GIFEncoder(actualWidth, actualHeight, 'neuquant', true);
        encoder.setDelay(500);
        encoder.setRepeat(0);
        encoder.setQuality(10);
        encoder.start();

        for (const f of decoded) encoder.addFrame(f.data);

        encoder.finish();
        const gifData = encoder.out.getData();
        if (!gifData || gifData.length < 100) return null;
        return Buffer.from(gifData).toString('base64');
    } catch (err: any) {
        console.warn('[dco] GIF build failed:', err.message);
        return null;
    }
}
