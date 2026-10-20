//! Asking before downloading anything.
//!
//! Semantic search and building an index are the only things in this plugin
//! that touch the network, so the prompt says exactly what will be fetched,
//! from where and how large it is — and that nothing goes the other way.

import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type { QueryModel } from "./models.js";

/** What the prompt lists, one line per download. */
export interface Download {
    what: string;
    from: string;
    bytes: number;
    /** Set on the engine that runs the model on the graphics card. */
    gpu?: boolean;
    /**
     * Agreed to now but downloaded only when something needs it — the vision
     * tower, on the first index build with images — so it is named, and left
     * out of what is downloaded straight away.
     */
    later?: boolean;
}

/** The downloads semantic search needs for `model`, on `device`. */
export function downloadsFor(
    modelId: string,
    model: QueryModel,
    runtime: { url: string; bytes: number },
    device: "wasm" | "webgpu" = "wasm",
): Download[] {
    return [
        {
            what: `${modelId} (${model.repo}, revision ${model.revision.slice(0, 7)})`,
            from: "huggingface.co",
            bytes: model.downloadBytes,
        },
        device === "webgpu"
            ? {
                  what: "ONNX Runtime's WebGPU engine, which runs the model on your graphics card, checked against a pinned hash",
                  from: new URL(runtime.url).host,
                  bytes: runtime.bytes,
                  gpu: true,
              }
            : {
                  what: "ONNX Runtime's WebAssembly engine, checked against a pinned hash",
                  from: new URL(runtime.url).host,
                  bytes: runtime.bytes,
              },
    ];
}

export function megabytes(bytes: number): string {
    return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/** The prompt's text, separate from the modal so it can be tested. */
export function consentLines(downloads: Download[]): string[] {
    const now = downloads.filter((d) => !d.later);
    const later = downloads.filter((d) => d.later);
    const total = now.reduce((sum, d) => sum + d.bytes, 0);
    return [
        `Gnosis embeds your notes and your queries with this model, here, on this device. ` +
            `Using it downloads, once (${megabytes(total)} in all):`,
        ...now.map((d) => `• ${d.what} — ${megabytes(d.bytes)} from ${d.from}`),
        ...(later.length === 0
            ? []
            : [
                  "Also covered by agreeing, downloaded only when you first build an index with images:",
                  ...later.map((d) => `• ${d.what} — ${megabytes(d.bytes)} from ${d.from}`),
              ]),
        "Both are cached, so nothing is downloaded again. Your notes and your queries never " +
            "leave this device: nothing is uploaded, and the model runs locally.",
        ...(downloads.some((d) => d.gpu)
            ? [
                  "Your graphics card indexes about 100 times faster than the CPU. To use the CPU " +
                      "instead, set Compute to CPU in Gnosis's settings.",
              ]
            : []),
    ];
}

/** Resolves true if the reader agreed, false if they declined or closed it. */
export class ConsentModal extends Modal {
    private agreed = false;

    constructor(
        app: App,
        private readonly downloads: Download[],
        private readonly decide: (agreed: boolean) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.titleEl.setText("Download the embedding model?");
        for (const line of consentLines(this.downloads)) {
            this.contentEl.createEl("p", { text: line });
        }
        new Setting(this.contentEl)
            .addButton((button) =>
                button
                    .setButtonText("Download and enable")
                    .setCta()
                    .onClick(() => {
                        this.agreed = true;
                        this.close();
                    }),
            )
            .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
    }

    override onClose(): void {
        this.contentEl.empty();
        this.decide(this.agreed);
    }
}

export function askConsent(app: App, downloads: Download[]): Promise<boolean> {
    return new Promise((resolve) => new ConsentModal(app, downloads, resolve).open());
}

/** A yes/no question with its consequences spelled out. */
class ConfirmModal extends Modal {
    private agreed = false;

    constructor(
        app: App,
        private readonly title: string,
        private readonly lines: string[],
        private readonly confirmText: string,
        private readonly decide: (agreed: boolean) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.titleEl.setText(this.title);
        for (const line of this.lines) {
            this.contentEl.createEl("p", { text: line });
        }
        new Setting(this.contentEl)
            .addButton((button) =>
                button
                    .setButtonText(this.confirmText)
                    .setWarning()
                    .onClick(() => {
                        this.agreed = true;
                        this.close();
                    }),
            )
            .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
    }

    override onClose(): void {
        this.contentEl.empty();
        this.decide(this.agreed);
    }
}

export function confirm(app: App, title: string, lines: string[], confirmText: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, title, lines, confirmText, resolve).open());
}
