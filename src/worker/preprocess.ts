//! CLIP's image preprocessing, as the gnosis CLI does it.
//!
//! The CLI's vectors come from fastembed, whose CLIP pipeline is not the one
//! the model's `preprocessor_config.json` describes and transformers.js
//! applies: it resizes to 224x224 *exactly* — squashing the picture rather
//! than scaling its short side and cropping — with a Catmull-Rom filter,
//! drops the alpha channel without compositing it, and normalizes. A vector
//! made the other way is the same image seen differently, and measured
//! against the CLI's own it scored 0.69 for a 16:9 photo and ~0.93 for a 4:3
//! flag, where this scores above 0.999.
//!
//! The resize is `image::imageops::resize` from the Rust `image` crate, which
//! fastembed calls: a separable filter whose support widens with the
//! downscale ratio (so it averages rather than skips), a vertical pass then a
//! horizontal one, each rounded to a byte. Pure functions over pixel arrays,
//! so the same code runs in the worker and under node in the tests.

export const CLIP_SIZE = 224;

/** OpenAI CLIP's channel statistics, from the model's own config. */
const MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
const STD = [0.26862954, 0.26130258, 0.27577711] as const;

/** The Catmull-Rom cubic: `image`'s `bc_cubic_spline` at B = 0, C = 0.5. */
function catmullRom(x: number): number {
    const a = Math.abs(x);
    if (a < 1) {
        return (9 * a * a * a - 15 * a * a + 6) / 6;
    }
    if (a < 2) {
        return (-3 * a * a * a + 15 * a * a - 24 * a + 12) / 6;
    }
    return 0;
}

/** The source samples each output sample averages, and their normalized weights. */
function weights(inSize: number, outSize: number): { first: number; weights: Float32Array }[] {
    const ratio = inSize / outSize;
    // Widened when shrinking, so every source pixel counts.
    const scale = Math.max(ratio, 1);
    const support = 2 * scale;
    const out: { first: number; weights: Float32Array }[] = [];
    for (let o = 0; o < outSize; o++) {
        const center = (o + 0.5) * ratio;
        const left = Math.min(Math.max(Math.floor(center - support), 0), inSize - 1);
        const right = Math.min(Math.max(Math.ceil(center + support), left + 1), inSize);
        const at = center - 0.5;
        const w = new Float32Array(right - left);
        let sum = 0;
        for (let i = left; i < right; i++) {
            const weight = catmullRom((i - at) / scale);
            w[i - left] = weight;
            sum += weight;
        }
        if (sum !== 0) {
            for (let i = 0; i < w.length; i++) {
                w[i]! /= sum;
            }
        }
        out.push({ first: left, weights: w });
    }
    return out;
}

/** `rgb` is `width * height * 3` bytes, row by row; the result is the same layout at the new size. */
export function resizeExact(
    rgb: Uint8Array,
    width: number,
    height: number,
    newWidth: number,
    newHeight: number,
): Uint8Array {
    const byte = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
    // Vertical first, as `image` does, to a byte image of the new height.
    const rows = weights(height, newHeight);
    const tall = new Uint8Array(width * newHeight * 3);
    for (let y = 0; y < newHeight; y++) {
        const { first, weights: w } = rows[y]!;
        for (let x = 0; x < width; x++) {
            for (let c = 0; c < 3; c++) {
                let t = 0;
                for (let i = 0; i < w.length; i++) {
                    t += rgb[((first + i) * width + x) * 3 + c]! * w[i]!;
                }
                tall[(y * width + x) * 3 + c] = byte(t);
            }
        }
    }
    const columns = weights(width, newWidth);
    const out = new Uint8Array(newWidth * newHeight * 3);
    for (let y = 0; y < newHeight; y++) {
        for (let x = 0; x < newWidth; x++) {
            const { first, weights: w } = columns[x]!;
            for (let c = 0; c < 3; c++) {
                let t = 0;
                for (let i = 0; i < w.length; i++) {
                    t += tall[(y * width + first + i) * 3 + c]! * w[i]!;
                }
                out[(y * newWidth + x) * 3 + c] = byte(t);
            }
        }
    }
    return out;
}

/**
 * The model's input for one image: `3 * 224 * 224` floats, channel first,
 * from `rgba` pixels row by row. Alpha is dropped as the CLI drops it.
 */
export function clipPixels(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Float32Array {
    if (width < 1 || height < 1 || rgba.length < width * height * 4) {
        throw new Error(`an image of ${width}x${height} needs ${width * height * 4} bytes, got ${rgba.length}`);
    }
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < width * height; i++) {
        rgb[j++] = rgba[i * 4]!;
        rgb[j++] = rgba[i * 4 + 1]!;
        rgb[j++] = rgba[i * 4 + 2]!;
    }
    const small = resizeExact(rgb, width, height, CLIP_SIZE, CLIP_SIZE);
    const plane = CLIP_SIZE * CLIP_SIZE;
    const out = new Float32Array(3 * plane);
    for (let p = 0; p < plane; p++) {
        for (let c = 0; c < 3; c++) {
            out[c * plane + p] = (small[p * 3 + c]! / 255 - MEAN[c]!) / STD[c]!;
        }
    }
    return out;
}
