// gif-encoder-2 ships no type declarations. Minimal ambient shape for the
// subset used by routes/dco/gif.ts.
declare module 'gif-encoder-2' {
    export default class GIFEncoder {
        constructor(width: number, height: number, algorithm?: string, useOptimizer?: boolean);
        setDelay(ms: number): void;
        setRepeat(repeat: number): void;
        setQuality(quality: number): void;
        start(): void;
        addFrame(data: Uint8Array | Buffer): void;
        finish(): void;
        out: { getData(): Buffer };
    }
}
