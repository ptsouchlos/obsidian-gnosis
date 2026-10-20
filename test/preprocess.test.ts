//! CLIP's image preprocessing, the parts that can be checked without a model.
//! That it reproduces the CLI's vectors is `test/image-parity.test.ts`'s job.

import assert from "node:assert/strict";
import test from "node:test";

import { CLIP_SIZE, clipPixels, resizeExact } from "../src/worker/preprocess.js";

/** `width * height` RGBA pixels, all one color. */
function solid(width: number, height: number, [r, g, b]: [number, number, number], alpha = 255): Uint8Array {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        rgba.set([r, g, b, alpha], i * 4);
    }
    return rgba;
}

test("a resize to the same size changes nothing", () => {
    const rgb = Uint8Array.from({ length: 5 * 4 * 3 }, (_, i) => (i * 37) % 256);
    assert.deepEqual(resizeExact(rgb, 5, 4, 5, 4), rgb);
});

test("resizing a flat color, up or down, keeps it", () => {
    const rgb = new Uint8Array(30 * 20 * 3).fill(200);
    for (const [w, h] of [
        [224, 224],
        [7, 3],
        [100, 9],
    ] as const) {
        assert.ok(resizeExact(rgb, 30, 20, w, h).every((v) => v === 200), `${w}x${h}`);
    }
});

test("a picture is squashed to the square, not cropped to it", () => {
    // Left half black, right half white, twice as wide as tall: a crop would
    // keep a stripe of one color, a squash keeps both halves.
    const width = 40;
    const height = 20;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = width / 2; x < width; x++) {
            rgb.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
        }
    }
    const out = resizeExact(rgb, width, height, 8, 8);
    assert.equal(out[0], 0, "the left edge is black");
    assert.equal(out[(7 * 8 + 7) * 3], 255, "the right edge is white");
});

test("the model's input is channel first, normalized, and alpha is ignored", () => {
    const white = clipPixels(solid(3, 5, [255, 255, 255], 0), 3, 5);
    assert.equal(white.length, 3 * CLIP_SIZE * CLIP_SIZE);
    const plane = CLIP_SIZE * CLIP_SIZE;
    const mean = [0.48145466, 0.4578275, 0.40821073];
    const std = [0.26862954, 0.26130258, 0.27577711];
    for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(white[c * plane]! - (1 - mean[c]!) / std[c]!) < 1e-5, `channel ${c}`);
        assert.ok(Math.abs(white[(c + 1) * plane - 1]! - (1 - mean[c]!) / std[c]!) < 1e-5);
    }
});

test("pixels that do not fill the stated size are refused", () => {
    assert.throws(() => clipPixels(new Uint8Array(10), 4, 4), /needs 64 bytes, got 10/);
    assert.throws(() => clipPixels(new Uint8Array(0), 0, 0), /needs 0 bytes/);
});
