//! The related map's layout: the radius states the score, and the angle
//! states which notes are alike.

import assert from "node:assert/strict";
import test from "node:test";

import { mapLayout, mdsAngles, similarity } from "../src/related/layout.js";

const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const angleGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

test("notes alike to each other are placed together, and unlike ones apart", () => {
    // Two clusters, {0, 2} and {1, 3}: alike within, unlike across.
    // Interleaved, so placing notes around the circle in list order — angles
    // that mean nothing — would put each cluster's members opposite.
    const pairs = [
        [null, 0.2, 0.95, 0.25],
        [0.2, null, 0.22, 0.9],
        [0.95, 0.22, null, 0.2],
        [0.25, 0.9, 0.2, null],
    ];
    const angles = mdsAngles(similarity(pairs));
    assert.ok(angleGap(angles[0]!, angles[2]!) < angleGap(angles[0]!, angles[1]!), `${angles}`);
    assert.ok(angleGap(angles[1]!, angles[3]!) < angleGap(angles[2]!, angles[3]!), `${angles}`);

    // With every note at the same score, distance on the map is angle alone.
    const points = mapLayout([0.8, 0.8, 0.8, 0.8], pairs)!;
    assert.ok(gap(points[0]!, points[2]!) < gap(points[0]!, points[1]!));
    assert.ok(gap(points[1]!, points[3]!) < gap(points[2]!, points[3]!));
});

test("distance from the center is the score: the most related note is nearest", () => {
    const pairs = [
        [null, 0.5, 0.5],
        [0.5, null, 0.5],
        [0.5, 0.5, null],
    ];
    const points = mapLayout([0.9, 0.7, 0.8], pairs)!;
    const radius = points.map((p) => Math.hypot(p.x, p.y));
    assert.ok(radius[0]! < radius[2]! && radius[2]! < radius[1]!, `${radius}`);
    for (const r of radius) {
        assert.ok(r > 0 && r <= 1, `${r} is off the disc`);
    }
});

test("a pair gnosis scored one way only is taken from that way; one it never scored counts as far", () => {
    const sim = similarity([
        [null, 0.8, null],
        [null, null, 0.4],
        [null, 0.6, null],
    ]);
    assert.equal(sim[0]![1], 0.8, "only one direction scored");
    assert.equal(sim[1]![2], 0.5, "both directions, averaged");
    assert.equal(sim[0]![2], 0.4, "neither: the least alike pair seen");
    assert.equal(sim[1]![1], 1);
});

test("dots never sit on top of each other, and keep their score as their radius", () => {
    // Four identical notes at one score would all land on one spot.
    const pairs = [
        [null, 1, 1, 1],
        [1, null, 1, 1],
        [1, 1, null, 1],
        [1, 1, 1, null],
    ];
    const points = mapLayout([0.7, 0.7, 0.7, 0.7], pairs)!;
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            assert.ok(gap(points[i]!, points[j]!) > 0.1, `${i} and ${j} overlap`);
        }
    }
    const radius = points.map((p) => Math.hypot(p.x, p.y));
    assert.ok(Math.max(...radius) - Math.min(...radius) < 1e-9, `${radius}`);
});

test("pair scores that are not for these notes draw no map at all", () => {
    assert.equal(mapLayout([0.9, 0.8], [[null]]), null);
    assert.equal(mapLayout([0.9, 0.8], [[null, 0.5], [0.5]]), null);
    assert.deepEqual(mapLayout([], []), []);
    assert.equal(mapLayout([0.9], [[null]])!.length, 1);
});
