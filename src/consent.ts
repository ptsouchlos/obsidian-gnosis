//! Asking before downloading anything.
//!
//! Semantic search is the first thing in this plugin that touches the
//! network, so the prompt says exactly what will be fetched, from where and how
//! large it is — and that nothing goes the other way.

import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type { QueryModel } from "./models.js";

/** What the prompt lists, one line per download. */
export interface Download {
    what: string;
    from: string;
    bytes: number;
}

/** The downloads semantic search needs for `model`. */
export function downloadsFor(
    modelId: string,
    model: QueryModel,
    runtime: { url: string; bytes: number },
): Download[] {
    return [
        {
            what: `${modelId} (${model.repo}, revision ${model.revision.slice(0, 7)})`,
            from: "huggingface.co",
            bytes: model.downloadBytes,
        },
        {
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
    const total = downloads.reduce((sum, d) => sum + d.bytes, 0);
    return [
        `Semantic search runs the model your index was built with, here, on this device. ` +
            `Turning it on downloads, once (${megabytes(total)} in all):`,
        ...downloads.map((d) => `• ${d.what} — ${megabytes(d.bytes)} from ${d.from}`),
        "Both are cached, so nothing is downloaded again. Your notes and your queries never " +
            "leave this device: nothing is uploaded, and the model runs locally.",
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
        this.titleEl.setText("Download the model for semantic search?");
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
