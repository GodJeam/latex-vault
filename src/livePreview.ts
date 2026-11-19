import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { editorLivePreviewField, sanitizeHTMLToDom } from "obsidian";
import type LatexVaultPlugin from "./main";
import { FENCE_RE } from "./languages";

const CLOSING_FENCE = /^```\s*$/;

export interface LatexBlock {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  code: string;
}

// The whole document is scanned for fences; cache the result per document
// snapshot so selection updates do not rescan it on every keystroke.
const blockCache = new WeakMap<object, LatexBlock[]>();

export function findLatexBlocks(state: EditorState): LatexBlock[] {
  const cached = blockCache.get(state.doc);
  if (cached) return cached;
  const blocks: LatexBlock[] = [];
  const doc = state.doc;

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (!FENCE_RE.test(line.text.trim())) continue;

    let closeLine = 0;
    for (let k = n + 1; k <= doc.lines; k++) {
      const l = doc.line(k);
      if (CLOSING_FENCE.test(l.text.trim())) {
        closeLine = k;
        break;
      }
      if (k - n > 5000) break;
    }

    if (closeLine) {
      const from = doc.line(n).from;
      const to = doc.line(closeLine).to;
      const codeLines: string[] = [];
      for (let x = n + 1; x < closeLine; x++) {
        codeLines.push(doc.line(x).text);
      }
      const code = codeLines.join("\n").trim();
      if (code) blocks.push({ from, to, fromLine: n, toLine: closeLine, code });
      n = closeLine;
    }
  }

  blockCache.set(state.doc, blocks);
  return blocks;
}

const expandEffect = StateEffect.define<number>();
const collapseEffect = StateEffect.define<number>();
export const recalcEffect = StateEffect.define<null>();

function isLivePreview(state: EditorState): boolean {
  // Default to true when the Obsidian field is absent (e.g. unit tests).
  return state.field(editorLivePreviewField, false) ?? true;
}

class LatexPreviewWidget extends WidgetType {
  private destroyed = false;

  constructor(
    readonly code: string,
    private renderFn: (code: string) => Promise<string>,
    private getCachedFn: (code: string) => string | null,
    private t: (s: string) => string,
    readonly language: string,
    readonly expanded: boolean
  ) {
    super();
  }

  eq(other: LatexPreviewWidget): boolean {
    return (
      other.code === this.code &&
      other.expanded === this.expanded &&
      other.language === this.language
    );
  }

  updateDOM(dom: HTMLElement, _view: EditorView, prev: this): boolean {
    if (prev.code !== this.code || dom.dataset.ready !== "1") return false;
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
        currentView.dispatch({
          effects: isExpanded
            ? collapseEffect.of(block.from)
            : expandEffect.of(block.from),
        });
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

    this.renderFn(this.code)
      .then((svg) => {
        if (this.destroyed) return;
        showSvg(svg);
      })
      .catch((err) => {
        if (this.destroyed) return;
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

    return wrap;
  }

  destroy(): void {
    this.destroyed = true;
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
  const render = (code: string) => plugin.renderer.render(code);
  const getCached = (code: string) => plugin.renderer.getCached(code);
  const t = (s: string) => plugin.t(s);
  const lang = plugin.settings.language;
  try {
    for (const block of findLatexBlocks(state)) {
      const isExpanded = expanded.has(block.from);
      // Hide the code fence lines unless the user expanded the block.
      if (!isExpanded) {
        for (let k = block.fromLine; k <= block.toLine; k++) {
          const pos = state.doc.line(k).from;
          builder.add(pos, pos, Decoration.line({ class: "latex-code-hidden" }));
        }
      }
      builder.add(
        block.to,
        block.to,
        Decoration.widget({
          widget: new LatexPreviewWidget(block.code, render, getCached, t, lang, isExpanded),
          block: true,
          side: 1,
        })
      );
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
          FENCE_RE.test(tr.state.doc.lineAt(mapped).text.trim())
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
