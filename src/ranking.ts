//! The ranking presets the settings offer, and the numbers behind them.
//!
//! A preset, not a slider: each one names a value that was measured, so a
//! reader choosing one is choosing a known trade-off rather than an untested
//! number. The measurements are recorded in the workspace's
//! `docs/gnosis/plugin-settings-redesign.md` (step 3); change a value here
//! only with a new measurement there.

export type Strategy = "balanced" | "keyword";
export type TitleBonus = "off" | "default";
export type Recency = "off" | "on";

/** `dense_weight`: how much of the fused score comes from meaning. */
export const DENSE_WEIGHT: Readonly<Record<Strategy, number>> = {
    // gnosis's own default, and the only value that improved both BEIR sets.
    balanced: 0.9,
    // Keeps meaning in the blend, at little cost on topical queries (scifact
    // 0.722 -> 0.712; nfcorpus even gains, 0.346 -> 0.352), and gains where exact words
    // decide: a real vault's body-phrase lookups 0.82 -> 0.94, Swahili with an
    // English model 0.42 -> 0.57. Not 0.0: that drops meaning entirely, which
    // turning semantic search off already does.
    keyword: 0.3,
};

/** `title_boost`: the bounded bonus for a note whose title carries the query. */
export const TITLE_BOOST: Readonly<Record<TitleBonus, number>> = {
    off: 0,
    // gnosis's own default: exact-title lookups 0.70 -> 0.81 on kepano, for
    // about 0.003-0.006 on topical queries. A "High" of 0.2 was measured and
    // left out: +0.02 on one vault, nothing on another, -0.012 on scifact.
    default: 0.1,
};

/**
 * `recency_weight` and `recency_half_life_days`: a bonus for a recently written
 * note, halving every year, for notes that carry a frontmatter `created` date.
 */
export const RECENCY: Readonly<Record<Recency, { weight: number; halfLifeDays: number }>> = {
    off: { weight: 0, halfLifeDays: 365 },
    // Measured on gnosis's `data/recency_vault` (see the workspace's
    // `docs/gnosis/recency-bonus.md`): "what was I reading about X" queries,
    // nDCG@10 0.56 -> 0.92, at 0.04 on reference lookups where the old note is the
    // answer. A synthetic vault, so a starting value rather than a tuned one.
    on: { weight: 0.1, halfLifeDays: 365 },
};

/** The fields of gnosis's `SearchConfig` the presets set. */
interface SearchConfig {
    dense_weight: number;
    title_boost: number;
    recency_weight: number;
    recency_half_life_days: number;
    now_unix?: number;
}

/**
 * The index's configuration with the reader's presets applied.
 *
 * Everything else — BM25's parameters, whether the lexical channel runs —
 * stays as gnosis set it.
 */
export function withPresets<T extends SearchConfig>(
    base: T,
    strategy: Strategy,
    titleBonus: TitleBonus,
    recency: Recency,
    nowMs: number,
): T {
    return {
        ...base,
        dense_weight: DENSE_WEIGHT[strategy],
        title_boost: TITLE_BOOST[titleBonus],
        recency_weight: RECENCY[recency].weight,
        recency_half_life_days: RECENCY[recency].halfLifeDays,
        // The query client has no clock; ages are measured from here.
        now_unix: Math.floor(nowMs / 1000),
    };
}
