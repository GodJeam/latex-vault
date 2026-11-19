import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { editorLivePreviewField, sanitizeHTMLToDom } from "obsidian";
import type LatexVaultPlugin from "./main";
import type { RenderOptions } from "./renderer";
import { isClosingFence, isLatexOpeningFence, parseOpeningFence } from "./languages";

export interface LatexBlock {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  code: string;
}

// Delay live recompilation while the user is actively typing inside an expanded
// code block, avoiding a process storm on every keystroke.
export const LIVE_EDIT_DEBOUNCE_MS = 450;

// The whole document is scanned for fences; cache the result per document
// snapshot so selection updates do not rescan it on every keystroke.
const blockCache = new WeakMap<object, LatexBlock[]>();

const MAX_BLOCK_LINES = 5000;

export function findLatexBlocks(state: EditorState): LatexBlock[] {
  const cached = blockCache.get(state.doc);
  if (cached) return cached;
  const blocks: LatexBlock[] = [];
  const doc = state.doc;

  let activeFence: { char: "`" | "~"; len: number; isLatex: boolean; fromLine: number } | null =
    null;

  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;

    if (!activeFence) {
      const open = parseOpeningFence(text);
      if (open) {
        activeFence = {
          char: open.char,
          len: open.len,
          isLatex: open.isLatex,
          fromLine: n,
        };
      }
      continue;
    }

    if (isClosingFence(text, activeFence.char, activeFence.len)) {
      if (activeFence.isLatex && n - activeFence.fromLine <= MAX_BLOCK_LINES) {
        const from = doc.line(activeFence.fromLine).from;
        const to = doc.line(n).to;
        const codeLines: string[] = [];
        for (let x = activeFence.fromLine + 1; x < n; x++) {
          codeLines.push(doc.line(x).text);
        }
        const code = codeLines.join("\n").trim();
        if (code) {
          blocks.push({ from, to, fromLine: activeFence.fromLine, toLine: n, code });
        }
      }
      activeFence = null;
    }
  }

  blockCache.set(state.doc, blocks);
  return blocks;
}

export const expandEffect = StateEffect.define<number>();
export const collapseEffect = StateEffect.define<number>();
export const recalcEffect = StateEffect.define<null>();

function isLivePreview(state: EditorState): boolean {
  // Default to true when the Obsidian field is absent (e.g. unit tests).
  return state.field(editorLivePreviewField, false) ?? true;
}

export class LatexPreviewWidget extends WidgetType {
  private destroyed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;

  constructor(
    readonly code: string,
    private renderFn: (code: string, options?: RenderOptions) => Promise<string>,
    private getCachedFn: (code: string) => string | null,
    private t: (s: string) => string,
    readonly language: string,
    readonly expanded: boolean,
    readonly configVersion: number,
    private debounceMs = LIVE_EDIT_DEBOUNCE_MS
  ) {
    super();
  }

  eq(other: LatexPreviewWidget): boolean {
    return (
      other.code === this.code &&
      other.expanded === this.expanded &&
      other.language === this.language &&
      other.configVersion === this.configVersion
    );
  }

  updateDOM(dom: HTMLElement, _view: EditorView, prev: this): boolean {
    if (
      prev.code !== this.code ||
      prev.configVersion !== this.configVersion ||
      dom.dataset.ready !== "1"
    ) {
      return false;
    }
    dom.dataset.expanded = this.expanded ? "1" : "0";
    const btn = dom.querySelector<HTMLButtonElement>(".latex-source-toggle");
    if (btn) {
      btn.textContent = this.expanded
        ? this.t("Hide LaTeX code")
        : this.t("Show LaTeX code");
    }
    const errTitle = dom.querySelector<HTMLElement>(".latex-error-title");
    if (errTitle) {
      errTitle.textContent = this.t("LaTeX rendering error");
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "latex-live";
    wrap.dataset.expanded = this.expanded ? "1" : "0";

    const appendToggle = () => {
      wrap.dataset.ready = "1";
      // Toggle that reveals/hides the REAL code lines in the editor (editable).
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "latex-source-toggle";
      btn.textContent =
        wrap.dataset.expanded === "1"
          ? this.t("Hide LaTeX code")
          : this.t("Show LaTeX code");
      btn.addEventListener("click", () => {
        const currentView = EditorView.findFromDOM(wrap) ?? view;
        let pos: number;
        try {
          pos = currentView.posAtDOM(wrap);
        } catch {
          return;
        }
        const block = findLatexBlocks(currentView.state).find(
          (b) => pos >= b.from && pos <= b.to
        );
        if (!block) return;
        const isExpanded = wrap.dataset.expanded === "1";
        if (isExpanded) {
          const sel = currentView.state.selection.main;
          const insideBlock = sel.from >= block.from && sel.to <= block.to;
          currentView.dispatch({
            effects: collapseEffect.of(block.from),
            ...(insideBlock ? { selection: { anchor: block.from } } : {}),
          });
        } else {
          currentView.dispatch({
            effects: expandEffect.of(block.from),
          });
        }
      });
      wrap.appendChild(btn);
    };

    const showSvg = (svg: string) => {
      wrap.replaceChildren();
      const fig = document.createElement("div");
      fig.className = "latex-figure";
      fig.appendChild(sanitizeHTMLToDom(svg));
      wrap.appendChild(fig);
      appendToggle();
    };

    const cached = this.getCachedFn(this.code);
    if (cached !== null) {
      showSvg(cached);
      return wrap;
    }

    const status = document.createElement("div");
    status.className = "latex-status latex-loading";
    status.textContent = this.t("Rendering LaTeX...");
    wrap.appendChild(status);

    const startRender = () => {
      if (this.destroyed) return;
      const controller = new AbortController();
      this.abortController = controller;
      this.renderFn(this.code, { signal: controller.signal })
        .then((svg) => {
          if (this.destroyed || controller.signal.aborted) return;
          showSvg(svg);
        })
        .catch((err) => {
          if (
            this.destroyed ||
            controller.signal.aborted ||
            (err instanceof Error && err.name === "AbortError")
          ) {
            return;
          }
          wrap.replaceChildren();
          const errBox = document.createElement("div");
          errBox.className = "latex-error";
          const title = document.createElement("div");
          title.className = "latex-error-title";
          title.textContent = this.t("LaTeX rendering error");
          errBox.appendChild(title);
          const pre = document.createElement("pre");
          pre.className = "latex-error-msg";
          pre.textContent = err instanceof Error ? err.message : String(err);
          errBox.appendChild(pre);
          wrap.appendChild(errBox);
          appendToggle();
        });
    };

    if (this.expanded && this.debounceMs > 0) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        startRender();
      }, this.debounceMs);
    } else {
      startRender();
    }

    return wrap;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function computeDecorations(
  state: EditorState,
  plugin: LatexVaultPlugin,
  expanded: Set<number>
) {
  if (!plugin.settings.enabled || !plugin.settings.livePreview || !isLivePreview(state)) {
    return Decoration.none;
  }
  const builder = new RangeSetBuilder<Decoration>();
  const render = (code: string, options?: RenderOptions) =>
    plugin.renderer.render(code, options);
  const getCached = (code: string) => plugin.renderer.getCached(code);
  const t = (s: string) => plugin.t(s);
  const lang = plugin.settings.language;
  const configVersion = plugin.renderConfigVersion ?? 0;
  try {
    for (const block of findLatexBlocks(state)) {
      const isExpanded = expanded.has(block.from);
      const widget = new LatexPreviewWidget(
        block.code,
        render,
        getCached,
        t,
        lang,
        isExpanded,
        configVersion
      );
      if (!isExpanded) {
        // Atomic block replacement avoids invisible cursor traps inside hidden lines.
        builder.add(
          block.from,
          block.to,
          Decoration.replace({
            widget,
            block: true,
          })
        );
      } else {
        builder.add(
          block.to,
          block.to,
          Decoration.widget({
            widget,
            block: true,
            side: 1,
          })
        );
      }
    }
  } catch (e) {
    console.error("latex-vault: error building LaTeX decorations:", e);
  }
  return builder.finish();
}

export function livePreviewExtension(plugin: LatexVaultPlugin) {
  return StateField.define<{ deco: DecorationSet; expanded: Set<number> }>({
    create(state: EditorState) {
      return { deco: computeDecorations(state, plugin, new Set()), expanded: new Set() };
    },
    update(value, tr) {
      const modeChanged = isLivePreview(tr.state) !== isLivePreview(tr.startState);
      const relevant =
        tr.docChanged ||
        modeChanged ||
        tr.effects.some(
          (e) => e.is(expandEffect) || e.is(collapseEffect) || e.is(recalcEffect)
        );
      if (!relevant) return value;

      const expanded = new Set<number>();
      for (const pos of value.expanded) {
        const mapped = tr.changes.mapPos(pos, 1);
        if (
          mapped <= tr.state.doc.length &&
          isLatexOpeningFence(tr.state.doc.lineAt(mapped).text)
        ) {
          expanded.add(mapped);
        }
      }
      for (const e of tr.effects) {
        if (e.is(expandEffect)) expanded.add(e.value);
        else if (e.is(collapseEffect)) expanded.delete(e.value);
      }
      return { deco: computeDecorations(tr.state, plugin, expanded), expanded };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
}
