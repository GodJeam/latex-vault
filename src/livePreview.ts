import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import type LatexVaultPlugin from "./main";
import type { TranslationKey } from "./i18n";
import type { RenderOptions } from "./renderer";
import { isClosingFence, isLatexOpeningFence, parseOpeningFence } from "./languages";
import { createLoadingStatus, renderErrorElement, renderSvgElement } from "./ui";

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

interface WidgetMountState {
  destroyed: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
}

export class LatexPreviewWidget extends WidgetType {
  // CodeMirror 6 can unmount a widget (destroy) and later remount the exact
  // same WidgetType instance (toDOM) as it leaves and re-enters the viewport,
  // or mount it in multiple views simultaneously. Track lifecycle per DOM node.
  private mounts = new WeakMap<HTMLElement, WidgetMountState>();

  constructor(
    readonly code: string,
    private renderFn: (code: string, options?: RenderOptions) => Promise<string>,
    private getCachedFn: (code: string) => string | null,
    private t: (s: TranslationKey) => string,
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

    const mount: WidgetMountState = {
      destroyed: false,
      debounceTimer: null,
      abortController: null,
    };
    this.mounts.set(wrap, mount);

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
      wrap.replaceChildren(renderSvgElement(svg));
      appendToggle();
    };

    const cached = this.getCachedFn(this.code);
    if (cached !== null) {
      showSvg(cached);
      return wrap;
    }

    wrap.appendChild(createLoadingStatus(this.t("Rendering LaTeX...")));

    const startRender = () => {
      if (mount.destroyed) return;
      // Only abort in-flight compilation on unmount when editing an expanded
      // block; collapsed blocks scrolled temporarily out of the viewport can
      // finish into cache so scrolling back displays them immediately.
      const controller = this.expanded ? new AbortController() : null;
      mount.abortController = controller;
      this.renderFn(this.code, controller ? { signal: controller.signal } : undefined)
        .then((svg) => {
          if (mount.destroyed || controller?.signal.aborted) return;
          showSvg(svg);
        })
        .catch((err) => {
          if (
            mount.destroyed ||
            controller?.signal.aborted ||
            (err instanceof Error && err.name === "AbortError")
          ) {
            return;
          }
          wrap.replaceChildren(renderErrorElement(this.t("LaTeX rendering error"), err));
          appendToggle();
        });
    };

    if (this.expanded && this.debounceMs > 0) {
      mount.debounceTimer = setTimeout(() => {
        mount.debounceTimer = null;
        startRender();
      }, this.debounceMs);
    } else {
      startRender();
    }

    return wrap;
  }

  destroy(dom: HTMLElement): void {
    const mount = this.mounts.get(dom);
    if (!mount) return;
    mount.destroyed = true;
    if (mount.debounceTimer !== null) {
      clearTimeout(mount.debounceTimer);
      mount.debounceTimer = null;
    }
    if (mount.abortController) {
      mount.abortController.abort();
      mount.abortController = null;
    }
    this.mounts.delete(dom);
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
  const t = (s: TranslationKey) => plugin.t(s);
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
