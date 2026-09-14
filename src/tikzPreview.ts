import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { sanitizeHTMLToDom } from "obsidian";
import type TikzVaultPlugin from "./main";

const TIKZ_LANG = /^```(tikz|tikzcd|pgfplots)(\s|$)/i;
const CLOSING_FENCE = /^```\s*$/;

interface TikzBlock {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  code: string;
}

// The whole document is scanned for fences; cache the result per document
// snapshot so selection/viewport updates do not rescan it on every keystroke.
const blockCache = new WeakMap<object, TikzBlock[]>();

function findTikzBlocks(state: EditorState): TikzBlock[] {
  const cached = blockCache.get(state.doc);
  if (cached) return cached;
  const blocks: TikzBlock[] = [];
  const doc = state.doc;

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (!TIKZ_LANG.test(line.text.trim())) continue;

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

const tikzExpandEffect = StateEffect.define<number>();
const tikzCollapseEffect = StateEffect.define<number>();
const tikzRecalcEffect = StateEffect.define<null>();

class TikzPreviewWidget extends WidgetType {
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

  eq(other: TikzPreviewWidget): boolean {
    return (
      other.code === this.code &&
      other.from === this.from &&
      other.expanded === this.expanded
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "tikz-live";

    const status = document.createElement("div");
    status.className = "tikz-status";
    status.textContent = this.t("Rendering TikZ...");
    wrap.appendChild(status);

    const finish = () => {
      // Toggle that reveals/hides the REAL code lines in the editor (editable).
      const btn = document.createElement("button");
      btn.className = "tikz-source-toggle";
      btn.textContent = this.expanded ? this.t("Hide TikZ code") : this.t("Show TikZ code");
      btn.addEventListener("click", () => {
        const view = EditorView.findFromDOM(wrap);
        if (!view) return;
        view.dispatch({
          effects: this.expanded ? tikzCollapseEffect.of(this.from) : tikzExpandEffect.of(this.from),
        });
      });
      wrap.appendChild(btn);
    };

    this.renderFn(this.code)
      .then((svg) => {
        if (this.destroyed) return;
        wrap.replaceChildren();
        const fig = document.createElement("div");
        fig.className = "tikz-figure";
        fig.appendChild(sanitizeHTMLToDom(svg));
        wrap.appendChild(fig);
        finish();
      })
      .catch((err) => {
        if (this.destroyed) return;
        wrap.replaceChildren();
        const errBox = document.createElement("div");
        errBox.className = "tikz-error";
        const title = document.createElement("div");
        title.className = "tikz-error-title";
        title.textContent = this.t("TikZ rendering error");
        errBox.appendChild(title);
        const pre = document.createElement("pre");
        pre.className = "tikz-error-msg";
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

function computeDecorations(state: EditorState, plugin: TikzVaultPlugin, expanded: Set<number>) {
  if (!plugin.settings.tikzEnabled || !plugin.settings.tikzLivePreview) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const render = (code: string) => plugin.tikzRenderer.render(code);
  try {
    for (const block of findTikzBlocks(state)) {
      // Hide the code fence lines unless the user expanded the block.
      if (!expanded.has(block.from)) {
        for (let k = block.fromLine; k <= block.toLine; k++) {
          const pos = state.doc.line(k).from;
          builder.add(pos, pos, Decoration.line({ class: "tikz-code-hidden" }));
        }
      }
      builder.add(
        block.to,
        block.to,
        Decoration.widget({
          widget: new TikzPreviewWidget(block.code, render, plugin.t, block.from, expanded.has(block.from)),
          block: true,
          side: 1,
        })
      );
    }
  } catch (e) {
    console.error("tikz-vault: error building TikZ decorations:", e);
  }
  return builder.finish();
}

export function tikzPreviewExtension(plugin: TikzVaultPlugin) {
  const field = StateField.define<{ deco: DecorationSet; expanded: Set<number> }>({
    create(state: EditorState) {
      return { deco: computeDecorations(state, plugin, new Set()), expanded: new Set() };
    },
    update(value, tr) {
      const relevant =
        tr.docChanged ||
        tr.effects.some((e) => e.is(tikzExpandEffect) || e.is(tikzCollapseEffect) || e.is(tikzRecalcEffect));
      if (!relevant) return value;
      const expanded = new Set<number>();
      for (const pos of value.expanded) expanded.add(tr.changes.mapPos(pos, -1));
      for (const e of tr.effects) {
        if (e.is(tikzExpandEffect)) expanded.add(e.value);
        else if (e.is(tikzCollapseEffect)) expanded.delete(e.value);
      }
      return { deco: computeDecorations(tr.state, plugin, expanded), expanded };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  return [
    field,
    EditorView.updateListener.of((update) => {
      if (update.viewportChanged) {
        update.view.dispatch({ effects: tikzRecalcEffect.of(null) });
      }
    }),
  ];
}