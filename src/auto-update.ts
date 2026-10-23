//! When to update the index without being asked: once edits have settled.
//!
//! Every edit to a note restarts a quiet period. When it ends, the update
//! runs once, however many edits came before it. An edit during an update
//! does not cancel it: it restarts the quiet period, and the next update picks
//! the edit up. Whether an update is worth running at all is the plugin's
//! call (`GnosisPlugin.autoUpdate`); this only decides when to ask.

/** How long notes must go unedited before an update. */
export const QUIET_MS = 2 * 60_000;

export interface Clock {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

const realClock: Clock = {
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: (handle) => window.clearTimeout(handle as number),
};

export class AutoUpdater {
    private timer: unknown = null;
    private running = false;
    /** Set when the quiet period ended mid-update, so another follows it. */
    private again = false;

    constructor(
        private readonly update: () => Promise<void>,
        private readonly quietMs = QUIET_MS,
        private readonly clock: Clock = realClock,
    ) {}

    /** A note changed: wait for the quiet period, from now. */
    poke(delayMs = this.quietMs): void {
        if (this.timer !== null) {
            this.clock.clear(this.timer);
        }
        this.timer = this.clock.set(() => {
            this.timer = null;
            void this.fire();
        }, delayMs);
    }

    stop(): void {
        if (this.timer !== null) {
            this.clock.clear(this.timer);
            this.timer = null;
        }
    }

    private async fire(): Promise<void> {
        if (this.running) {
            this.again = true;
            return;
        }
        this.running = true;
        try {
            await this.update();
        } finally {
            this.running = false;
            if (this.again) {
                this.again = false;
                this.poke();
            }
        }
    }
}
