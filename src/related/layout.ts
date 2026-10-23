//! Where the related-notes map puts each note.
//!
//! Two things are encoded, and both are measured, never decorative:
//!
//! - **Distance from the center is the note's own `related` score**, scaled
//!   between the lowest and highest shown, so a tight band of scores still
//!   spreads out. Closer is more related.
//! - **The angle places notes that are alike near each other.** It comes from
//!   gnosis's pair scores between the results (`Index.similarities`), laid out
//!   with classical multidimensional scaling; only the direction of each point
//!   is kept, since the radius is already the score.
//!
//! Without pair scores there is no layout: dots at arbitrary angles would look
//! like structure that is not there.

/** A note's place on the map, in a unit disc around the open note. */
export interface MapPoint {
    x: number;
    y: number;
}

/** Inner and outer radius, as fractions of the disc, so no dot sits on the center or the edge. */
const MIN_RADIUS = 0.3;
const MAX_RADIUS = 0.92;
/** The smallest gap kept between two dots, as a fraction of the disc's radius. */
const MIN_GAP = 0.2;

/**
 * Lay out `scores.length` related notes.
 *
 * `scores[i]` is note `i`'s `related` score from the open note. `pairs[i][j]`
 * is gnosis's score for note `j` when asked from note `i`, `null` on the
 * diagonal and for a pair gnosis would never relate. Returns null when the
 * pair scores do not describe these notes.
 */
export function mapLayout(scores: number[], pairs: (number | null)[][]): MapPoint[] | null {
    const n = scores.length;
    if (pairs.length !== n || pairs.some((row) => row.length !== n)) {
        return null;
    }
    if (n === 0) {
        return [];
    }
    const angles = mdsAngles(similarity(pairs));
    const radii = radiiFor(scores);
    return separate(
        angles.map((angle, i) => ({ x: radii[i] * Math.cos(angle), y: radii[i] * Math.sin(angle) })),
    );
}

/**
 * One symmetric similarity per pair. Gnosis's two directions can differ (a
 * note of only embeds compares from them but is never a candidate), so they
 * are averaged; a pair with no score either way counts as the least alike
 * pair seen, which is "far" without inventing a number below the data.
 */
export function similarity(pairs: (number | null)[][]): number[][] {
    const known = pairs.flat().filter((s): s is number => s !== null);
    const floor = known.length === 0 ? 0 : Math.min(...known);
    return pairs.map((row, i) =>
        row.map((_, j) => {
            if (i === j) {
                return 1;
            }
            const both = [pairs[i][j], pairs[j][i]].filter((s): s is number => s !== null && s !== undefined);
            return both.length === 0 ? floor : both.reduce((a, b) => a + b, 0) / both.length;
        }),
    );
}

/**
 * Each note's direction from the center, by classical MDS over distances
 * `1 - similarity`: double-center the squared distances, take the top two
 * eigenvectors by power iteration (n ≤ 50, so this is trivial), and keep each
 * point's angle.
 */
export function mdsAngles(sim: number[][]): number[] {
    const n = sim.length;
    if (n === 1) {
        return [-Math.PI / 2];
    }
    const d2 = sim.map((row) => row.map((s) => (1 - s) ** 2));
    const rowMean = d2.map((row) => row.reduce((a, b) => a + b, 0) / n);
    const mean = rowMean.reduce((a, b) => a + b, 0) / n;
    const b = d2.map((row, i) => row.map((v, j) => -0.5 * (v - rowMean[i] - rowMean[j] + mean)));

    const first = topEigenvector(b, []);
    const second = topEigenvector(b, [first]);
    return first.vector.map((x, i) => {
        const px = x * Math.sqrt(Math.max(first.value, 0));
        const py = second.vector[i] * Math.sqrt(Math.max(second.value, 0));
        // A point at the centroid has no direction of its own; spread such
        // points evenly rather than stacking them all at angle zero.
        return Math.hypot(px, py) < 1e-9 ? (2 * Math.PI * i) / n : Math.atan2(py, px);
    });
}

interface Eigen {
    value: number;
    vector: number[];
}

/** The dominant eigenvector of symmetric `m`, orthogonal to `found`. */
function topEigenvector(m: number[][], found: Eigen[]): Eigen {
    const n = m.length;
    // A fixed, uneven start: deterministic, and unlikely to be orthogonal to
    // the answer the way a constant vector is (B's rows sum to zero).
    let v = Array.from({ length: n }, (_, i) => Math.sin(i + 1) + 0.1 * (i + 1));
    let value = 0;
    for (let iter = 0; iter < 200; iter++) {
        for (const f of found) {
            const dotted = dot(v, f.vector);
            v = v.map((x, i) => x - dotted * f.vector[i]);
        }
        const next = m.map((row) => dot(row, v));
        const norm = Math.hypot(...next);
        if (norm < 1e-12) {
            return { value: 0, vector: new Array<number>(n).fill(0) };
        }
        const unit = next.map((x) => x / norm);
        value = dot(unit, m.map((row) => dot(row, unit)));
        const moved = Math.hypot(...unit.map((x, i) => x - v[i]));
        v = unit;
        if (moved < 1e-10) {
            break;
        }
    }
    return { value, vector: v };
}

function dot(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

/** Highest score nearest the center, scaled across the scores shown. */
function radiiFor(scores: number[]): number[] {
    const hi = Math.max(...scores);
    const lo = Math.min(...scores);
    const mid = (MIN_RADIUS + MAX_RADIUS) / 2;
    return scores.map((s) => (hi - lo < 1e-9 ? mid : MIN_RADIUS + ((hi - s) / (hi - lo)) * (MAX_RADIUS - MIN_RADIUS)));
}

/**
 * Nudge overlapping dots apart along their circle, so two notes at nearly the
 * same score and direction stay two dots. Radius is never changed: it is the
 * score, and the score is the one thing the map must state exactly.
 */
function separate(points: MapPoint[]): MapPoint[] {
    const polar = points.map((p) => ({ r: Math.hypot(p.x, p.y), a: Math.atan2(p.y, p.x) }));
    for (let pass = 0; pass < 50; pass++) {
        let moved = false;
        for (let i = 0; i < polar.length; i++) {
            for (let j = i + 1; j < polar.length; j++) {
                const p = polar[i];
                const q = polar[j];
                const gap = Math.hypot(p.r * Math.cos(p.a) - q.r * Math.cos(q.a), p.r * Math.sin(p.a) - q.r * Math.sin(q.a));
                if (gap >= MIN_GAP) {
                    continue;
                }
                // Turn each away from the other by half the shortfall, as an angle at their radius.
                const apart = Math.sign(wrap(q.a - p.a)) || 1;
                const step = (MIN_GAP - gap) / 2 / Math.max((p.r + q.r) / 2, 1e-6);
                p.a -= apart * step;
                q.a += apart * step;
                moved = true;
            }
        }
        if (!moved) {
            break;
        }
    }
    return polar.map(({ r, a }) => ({ x: r * Math.cos(a), y: r * Math.sin(a) }));
}

/** An angle difference brought into (-π, π]. */
function wrap(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
}
