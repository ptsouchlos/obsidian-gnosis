//! A row of mutually exclusive buttons, for a choice between a few named
//! presets. Obsidian has no native one; this is a radio group drawn as
//! buttons, so it is keyboard-reachable and announced as a choice.

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
}

export interface Segmented<T extends string> {
    el: HTMLElement;
    setValue(value: T): void;
    setDisabled(disabled: boolean): void;
}

export function segmented<T extends string>(
    parent: HTMLElement,
    label: string,
    options: readonly SegmentedOption<T>[],
    value: T,
    onChange: (value: T) => void,
): Segmented<T> {
    const el = parent.createDiv({ cls: "gnosis-segmented", attr: { role: "radiogroup", "aria-label": label } });
    let current = value;
    const buttons = options.map((option) => {
        const button = el.createEl("button", { text: option.label, attr: { role: "radio", type: "button" } });
        button.addEventListener("click", () => {
            if (option.value !== current) {
                select(option.value);
                onChange(option.value);
            }
        });
        return button;
    });

    function select(next: T): void {
        current = next;
        options.forEach((option, i) => {
            const on = option.value === next;
            buttons[i].toggleClass("is-selected", on);
            buttons[i].setAttribute("aria-checked", String(on));
            // One tab stop for the group, as a radio group has.
            buttons[i].tabIndex = on ? 0 : -1;
        });
    }

    // Arrow keys move the choice, as they do in any radio group.
    el.addEventListener("keydown", (evt) => {
        const step = evt.key === "ArrowRight" || evt.key === "ArrowDown" ? 1 : evt.key === "ArrowLeft" || evt.key === "ArrowUp" ? -1 : 0;
        if (step === 0 || el.hasClass("is-disabled")) {
            return;
        }
        evt.preventDefault();
        const at = options.findIndex((o) => o.value === current);
        const next = options[(at + step + options.length) % options.length];
        select(next.value);
        buttons[options.indexOf(next)].focus();
        onChange(next.value);
    });

    select(value);
    return {
        el,
        setValue: select,
        setDisabled(disabled: boolean) {
            el.toggleClass("is-disabled", disabled);
            for (const button of buttons) {
                button.disabled = disabled;
            }
        },
    };
}
