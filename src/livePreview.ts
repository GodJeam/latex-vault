import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { sanitizeHTMLToDom } from "obsidian";
import type LatexVaultPlugin from "./main";
import { FENCE_RE } from "./languages";

const CLOSING_FENCE = /^```\s*$/;

interface LatexBlock {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  code: string;
}

// The whole document is scanned for fences; cache the result per document
// snapshot so selection/viewport updates do not rescan it on every keystroke.
const blockCache = new WeakMap<object, LatexBlock[]>();

function findLatexBlocks(state: EditorState): LatexBlock[] {
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
const recalcEffect = StateEffect.define<null>();

class LatexPreviewWidget extends WidgetType {
  private destroyed = false;

  constructor(
    readonly code: string,
    private renderFn: (code: string) => Promise<string>,
    private t: (s: string) => string,
    private from: number,
    private expanded: boolean
  ) {
    super();
  }

  eq(other: LatexPreviewWidget): boolean {
    return (
      other.code === this.code &&
      other.from === this.from &&
      other.expanded === this.expanded
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "latex-live";

    const status = document.createElement("div");
    status.className = "latex-status";
    status.textContent = this.t("Rendering LaTeX...");
    wrap.appendChild(status);

    const finish = () => {
      // Toggle that reveals/hides the REAL code lines in the editor (editable).
      const btn = document.createElement("button");
      btn.className = "latex-source-toggle";
      btn.textContent = this.expanded ? this.t("Hide LaTeX code") : this.t("Show LaTeX code");
      btn.addEventListener("click", () => {
        const view = EditorView.findFromDOM(wrap);
        if (!view) return;
        view.dispatch({
          effects: this.expanded ? collapseEffect.of(this.from) : expandEffect.of(this.from),
        });
      });
      wrap.appendChild(btn);
    };

    this.renderFn(this.code)
      .then((svg) => {
        if (this.destroyed) return;
        wrap.replaceChildren();
        const fig = document.createElement("div");
        fig.className = "latex-figure";
        fig.appendChild(sanitizeHTMLToDom(svg));
        wrap.appendChild(fig);
        finish();
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
        finish();
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

function computeDecorations(state: EditorState, plugin: LatexVaultPlugin, expanded: Set<number>) {
  if (!plugin.settings.enabled || !plugin.settings.livePreview) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const render = (code: string) => plugin.renderer.render(code);
  try {
    for (const block of findLatexBlocks(state)) {
      // Hide the code fence lines unless the user expanded the block.
      if (!expanded.has(block.from)) {
        for (let k = block.fromLine; k <= block.toLine; k++) {
          const pos = state.doc.line(k).from;
          builder.add(pos, pos, Decoration.line({ class: "latex-code-hidden" }));
        }
      }
      builder.add(
        block.to,
        block.to,
        Decoration.widget({
          widget: new LatexPreviewWidget(block.code, render, plugin.t, block.from, expanded.has(block.from)),
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
  const field = StateField.define<{ deco: DecorationSet; expanded: Set<number> }>({
    create(state: EditorState) {
      return { deco: computeDecorations(state, plugin, new Set()), expanded: new Set() };
    },
    update(value, tr) {
      const relevant =
        tr.docChanged ||
        tr.effects.some((e) => e.is(expandEffect) || e.is(collapseEffect) || e.is(recalcEffect));
      if (!relevant) return value;
      const expanded = new Set<number>();
      for (const pos of value.expanded) expanded.add(tr.changes.mapPos(pos, -1));
      for (const e of tr.effects) {
        if (e.is(expandEffect)) expanded.add(e.value);
        else if (e.is(collapseEffect)) expanded.delete(e.value);
      }
      return { deco: computeDecorations(tr.state, plugin, expanded), expanded };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  return [
    field,
    EditorView.updateListener.of((update) => {
      if (update.viewportChanged) {
        update.view.dispatch({ effects: recalcEffect.of(null) });
      }
    }),
  ];
}