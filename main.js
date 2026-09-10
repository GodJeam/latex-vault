var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => TikzVaultPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian2 = require("obsidian");

// src/tikzRenderer.ts
var import_child_process = require("child_process");
var import_crypto = require("crypto");
var import_fs = require("fs");
var import_os = require("os");
var import_path = require("path");
var TikzRenderer = class {
  constructor(plugin) {
    __publicField(this, "plugin");
    __publicField(this, "cacheDir");
    __publicField(this, "inFlight", /* @__PURE__ */ new Map());
    this.plugin = plugin;
    this.cacheDir = (0, import_path.join)((0, import_os.tmpdir)(), "tikz-vault-render");
    (0, import_fs.mkdirSync)(this.cacheDir, { recursive: true });
  }
  async render(code) {
    const s = this.plugin.settings;
    const tex = this.buildTexSource(code, s.tikzExtraPreamble);
    const hash = (0, import_crypto.createHash)("sha256").update(tex).digest("hex").slice(0, 32);
    const dir = (0, import_path.join)(this.cacheDir, hash);
    const svgFile = (0, import_path.join)(dir, "main.svg");
    if ((0, import_fs.existsSync)(svgFile)) {
      const cached = (0, import_fs.readFileSync)(svgFile, "utf8");
      if (!this.isBlankSvg(cached)) return cached;
      try {
        (0, import_fs.rmSync)(svgFile, { force: true });
      } catch (e) {
      }
    }
    const existing = this.inFlight.get(hash);
    if (existing) return existing;
    const promise = this.doRender(tex, dir, svgFile, s).finally(() => {
      this.inFlight.delete(hash);
    });
    this.inFlight.set(hash, promise);
    return promise;
  }
  async doRender(tex, dir, svgFile, s) {
    (0, import_fs.mkdirSync)(dir, { recursive: true });
    (0, import_fs.writeFileSync)((0, import_path.join)(dir, "main.tex"), tex, "utf8");
    const latexPdf = this.resolveLatex("pdf");
    const latexDvi = this.resolveLatex("dvi");
    const dvisvgm = this.resolveDvisvgm();
    const engines = [];
    if (s.tikzEngine !== "dvi" && latexPdf && dvisvgm) {
      engines.push({
        label: "pdflatex + dvisvgm",
        build: async (d) => {
          await this.run(
            latexPdf,
            ["--interaction=nonstopmode", "--halt-on-error", "--disable-write18", "--enable-installer", "main.tex"],
            d
          );
          await this.run(dvisvgm, ["--pdf", "--no-fonts", "--precision=2", "main.pdf"], d);
        }
      });
    }
    if (s.tikzEngine !== "pdf" && latexDvi && dvisvgm) {
      engines.push({
        label: "latex + dvisvgm",
        build: async (d) => {
          await this.run(
            latexDvi,
            ["--interaction=nonstopmode", "--halt-on-error", "--disable-write18", "--enable-installer", "main.tex"],
            d
          );
          await this.run(dvisvgm, ["--no-fonts", "--precision=2", "main.dvi"], d);
        }
      });
    }
    if (engines.length === 0) {
      const missing = [];
      if (!latexPdf && !latexDvi) missing.push("latex/pdflatex");
      if (!dvisvgm) missing.push("dvisvgm");
      throw new Error(
        `Binary ${missing.join(" and ")} not found. Check the TeX installation or set the paths in the plugin settings.`
      );
    }
    const errors = [];
    for (const engine of engines) {
      try {
        await engine.build(dir);
        if (!(0, import_fs.existsSync)(svgFile)) {
          throw new Error(`dvisvgm did not produce any SVG (engine ${engine.label})`);
        }
        const svg = (0, import_fs.readFileSync)(svgFile, "utf8");
        if (this.isBlankSvg(svg)) {
          throw new Error(
            `dvisvgm produced an empty SVG (all strokes/fills are transparent) \u2014 engine ${engine.label}`
          );
        }
        return this.cleanSvg(svg);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        for (const f of ["main.pdf", "main.dvi"]) {
          try {
            (0, import_fs.rmSync)((0, import_path.join)(dir, f), { force: true });
          } catch (e2) {
          }
        }
      }
    }
    throw new Error(this.buildErrorMessage(errors, dir));
  }
  clearCache() {
    try {
      (0, import_fs.rmSync)(this.cacheDir, { recursive: true, force: true });
      (0, import_fs.mkdirSync)(this.cacheDir, { recursive: true });
    } catch (e) {
    }
  }
  buildTexSource(code, extraPreamble) {
    const src = code.replace(/\r\n/g, "\n").trim();
    if (!src) throw new Error("The TikZ block is empty.");
    if (/\\documentclass\s*\{/.test(src)) {
      return src;
    }
    const envMatch = src.match(/\\begin\{(\w+)\}/);
    let preamble = "";
    let body = src;
    if (envMatch && envMatch.index !== void 0) {
      preamble = src.slice(0, envMatch.index).trim();
      body = src.slice(envMatch.index).trim();
      const env = envMatch[1];
      if (env !== "tikzpicture" && env !== "tikzcd") {
        body = "\\begin{tikzpicture}\n" + body + "\n\\end{tikzpicture}";
      }
    } else if (!/\\tikz\s*[{\[]/.test(src)) {
      body = "\\begin{tikzpicture}\n" + src + "\n\\end{tikzpicture}";
    }
    const parts = ["\\documentclass[border=5pt]{standalone}", "\\usepackage{tikz}"];
    if (/\\begin\{tikzcd\}/.test(src)) parts.push("\\usepackage{tikz-cd}");
    if (/(\\begin\{axis\}|\\addplot)/.test(src)) {
      parts.push("\\usepackage{pgfplots}", "\\pgfplotsset{compat=1.18}");
    }
    if (/\\begin\{forest\}/.test(src)) parts.push("\\usepackage{forest}");
    const extra = extraPreamble.trim();
    if (extra) parts.push(extra);
    if (preamble) parts.push(preamble);
    parts.push("\\begin{document}", body, "\\end{document}");
    return parts.join("\n");
  }
  cleanSvg(svg) {
    return svg.replace(/^\s*<\?xml[^>]*\?>\s*/, "").replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
  }
  // An SVG is "blank" when every drawing element is invisible (stroke-opacity
  // or fill-opacity equal to 0, or no visible stroke/fill at all). Used to
  // detect broken dvisvgm output and fall back to the next engine.
  isBlankSvg(svg) {
    var _a, _b, _c, _d;
    const elRe = /<(path|rect|circle|ellipse|line|polyline|polygon|text)\b[^>]*>/gi;
    let visible = false;
    let m;
    while ((m = elRe.exec(svg)) !== null) {
      const tag = m[0];
      const stroke = (_a = /stroke='([^']*)'/.exec(tag)) == null ? void 0 : _a[1];
      const fill = (_b = /fill='([^']*)'/.exec(tag)) == null ? void 0 : _b[1];
      const strokeOp = (_c = /stroke-opacity='([^']*)'/.exec(tag)) == null ? void 0 : _c[1];
      const fillOp = (_d = /fill-opacity='([^']*)'/.exec(tag)) == null ? void 0 : _d[1];
      const strokeVisible = stroke !== void 0 && stroke !== "" && stroke !== "none" && strokeOp !== "0";
      const fillVisible = fill !== void 0 && fill !== "" && fill !== "none" && fillOp !== "0";
      if (strokeVisible || fillVisible) {
        visible = true;
        break;
      }
    }
    return !visible;
  }
  buildErrorMessage(errors, dir) {
    const logFile = (0, import_path.join)(dir, "main.log");
    let tail = "";
    if ((0, import_fs.existsSync)(logFile)) {
      const lines = (0, import_fs.readFileSync)(logFile, "utf8").split(/\r?\n/);
      const errs = lines.filter(
        (l) => /^!|^l\.\d+|error|Error|Undefined control sequence|File .* not found|cannot|runaway/i.test(l)
      );
      tail = (errs.length ? errs : lines).slice(-25).join("\n");
    }
    const detail = errors.length ? errors.map((e, i) => `Tentativo ${i + 1}: ${e}`).join("\n\n") : "";
    return detail + (tail ? `

--- LaTeX log ---
${tail}` : "");
  }
  resolveLatex(engine) {
    var _a;
    const cfg = this.plugin.settings.tikzLatexBin.trim();
    if (cfg) return this.withExe(cfg);
    return (_a = this.findInPath(engine === "pdf" ? "pdflatex" : "latex")) != null ? _a : "";
  }
  resolveDvisvgm() {
    var _a;
    const cfg = this.plugin.settings.tikzDvisvgmBin.trim();
    if (cfg) return this.withExe(cfg);
    return (_a = this.findInPath("dvisvgm")) != null ? _a : "";
  }
  withExe(bin) {
    if (process.platform !== "win32") return bin;
    if (bin.toLowerCase().endsWith(".exe") || bin.includes("\\") || bin.includes("/")) return bin;
    return bin + ".exe";
  }
  findInPath(name) {
    var _a;
    const isWin = process.platform === "win32";
    const exts = isWin ? [".exe", ".cmd", ".bat"] : [""];
    const dirs = ((_a = process.env.PATH) != null ? _a : "").split(isWin ? ";" : ":").filter(Boolean);
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = (0, import_path.join)(dir, name + ext);
        if ((0, import_fs.existsSync)(p)) return p;
      }
    }
    return null;
  }
  run(bin, args, cwd) {
    return new Promise((resolve, reject) => {
      (0, import_child_process.execFile)(
        bin,
        args,
        { cwd, windowsHide: true, timeout: 12e4, env: process.env },
        (error, _stdout, stderr) => {
          if (error) {
            const e = error;
            if (e.code === "ENOENT") {
              reject(new Error(`Executable not found: ${bin}`));
            } else if (typeof e.code === "number") {
              reject(
                new Error(
                  `Error (exit code ${e.code}) from ${bin}: ${(stderr || "").trim() || _stdout.trim()}`
                )
              );
            } else {
              reject(new Error(`${bin}: ${e.message}`));
            }
          } else {
            resolve();
          }
        }
      );
    });
  }
};

// src/tikzPreview.ts
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var TIKZ_LANG = /^```(tikz|tikzcd|pgfplots)(\s|$)/i;
var CLOSING_FENCE = /^```\s*$/;
function findTikzBlocks(state) {
  const blocks = [];
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
      if (k - n > 5e3) break;
    }
    if (closeLine) {
      const from = doc.line(n).from;
      const to = doc.line(closeLine).to;
      const codeLines = [];
      for (let x = n + 1; x < closeLine; x++) {
        codeLines.push(doc.line(x).text);
      }
      const code = codeLines.join("\n").trim();
      if (code) blocks.push({ from, to, fromLine: n, toLine: closeLine, code });
      n = closeLine;
    }
  }
  return blocks;
}
var tikzExpandEffect = import_state.StateEffect.define();
var tikzCollapseEffect = import_state.StateEffect.define();
var tikzRecalcEffect = import_state.StateEffect.define();
var TikzPreviewWidget = class extends import_view.WidgetType {
  constructor(code, renderFn, t, from, expanded) {
    super();
    this.code = code;
    this.renderFn = renderFn;
    this.t = t;
    this.from = from;
    this.expanded = expanded;
    __publicField(this, "destroyed", false);
  }
  eq(other) {
    return other.code === this.code && other.from === this.from && other.expanded === this.expanded;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "tikz-live";
    const status = document.createElement("div");
    status.className = "tikz-status";
    status.textContent = this.t("Rendering TikZ...");
    wrap.appendChild(status);
    const finish = () => {
      const btn = document.createElement("button");
      btn.className = "tikz-source-toggle";
      btn.textContent = this.expanded ? this.t("Hide TikZ code") : this.t("Show TikZ code");
      btn.addEventListener("click", () => {
        const view = import_view.EditorView.findFromDOM(wrap);
        if (!view) return;
        view.dispatch({
          effects: this.expanded ? tikzCollapseEffect.of(this.from) : tikzExpandEffect.of(this.from)
        });
      });
      wrap.appendChild(btn);
    };
    this.renderFn(this.code).then((svg) => {
      if (this.destroyed) return;
      wrap.replaceChildren();
      const fig = document.createElement("div");
      fig.className = "tikz-figure";
      fig.innerHTML = svg;
      wrap.appendChild(fig);
      finish();
    }).catch((err) => {
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
  destroy() {
    this.destroyed = true;
  }
  ignoreEvent() {
    return true;
  }
};
function computeDecorations(state, plugin, expanded) {
  if (!plugin.settings.tikzEnabled || !plugin.settings.tikzLivePreview) return import_view.Decoration.none;
  const builder = new import_state.RangeSetBuilder();
  const render = (code) => plugin.tikzRenderer.render(code);
  try {
    for (const block of findTikzBlocks(state)) {
      if (!expanded.has(block.from)) {
        for (let k = block.fromLine; k <= block.toLine; k++) {
          const pos = state.doc.line(k).from;
          builder.add(pos, pos, import_view.Decoration.line({ class: "tikz-code-hidden" }));
        }
      }
      builder.add(
        block.to,
        block.to,
        import_view.Decoration.widget({
          widget: new TikzPreviewWidget(block.code, render, plugin.t, block.from, expanded.has(block.from)),
          block: true,
          side: 1
        })
      );
    }
  } catch (e) {
    console.error("tikz-vault: error building TikZ decorations:", e);
  }
  return builder.finish();
}
function tikzPreviewExtension(plugin) {
  const field = import_state.StateField.define({
    create(state) {
      return { deco: computeDecorations(state, plugin, /* @__PURE__ */ new Set()), expanded: /* @__PURE__ */ new Set() };
    },
    update(value, tr) {
      const relevant = tr.docChanged || tr.effects.some((e) => e.is(tikzExpandEffect) || e.is(tikzCollapseEffect) || e.is(tikzRecalcEffect));
      if (!relevant) return value;
      const expanded = /* @__PURE__ */ new Set();
      for (const pos of value.expanded) expanded.add(tr.changes.mapPos(pos, -1));
      for (const e of tr.effects) {
        if (e.is(tikzExpandEffect)) expanded.add(e.value);
        else if (e.is(tikzCollapseEffect)) expanded.delete(e.value);
      }
      return { deco: computeDecorations(tr.state, plugin, expanded), expanded };
    },
    provide: (f) => import_view.EditorView.decorations.from(f, (v) => v.deco)
  });
  return [
    field,
    import_view.EditorView.updateListener.of((update) => {
      if (update.viewportChanged) {
        update.view.dispatch({ effects: tikzRecalcEffect.of(null) });
      }
    })
  ];
}

// src/settings.ts
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  language: "en",
  tikzEnabled: true,
  tikzEngine: "auto",
  tikzLatexBin: "",
  tikzDvisvgmBin: "",
  tikzExtraPreamble: "",
  tikzLivePreview: true
};
var TikzSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    __publicField(this, "plugin");
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const t = (s) => this.plugin.t(s);
    containerEl.empty();
    containerEl.createEl("h2", { text: t("Rendering TikZ") });
    new import_obsidian.Setting(containerEl).setName(t("Language")).setDesc(t(
      "Interface language. English is the default. Some command names update after reloading Obsidian."
    )).addDropdown(
      (dd) => dd.addOption("en", t("English")).addOption("it", t("Italian")).setValue(this.plugin.settings.language).onChange(async (value) => {
        this.plugin.settings.language = value;
        await this.plugin.saveSettings();
        new import_obsidian.Notice(t("Language changed. Reload Obsidian to apply it everywhere."));
        this.display();
      })
    );
    new import_obsidian.Setting(containerEl).setName(t("Render TikZ code blocks with local TeX")).setDesc(t(
      "Renders ```tikz blocks in your notes using the TeX installed on the system (MiKTeX/TeX Live). Supports ALL external libraries (pgfplots, circuitikz, tikz-cd, forest, etc.) that TikZJax cannot load. Rendering happens before the TikZJax plugin, so it takes precedence."
    )).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.tikzEnabled).onChange(async (value) => {
        this.plugin.settings.tikzEnabled = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName(t("Live preview in Edit mode")).setDesc(t(
      "Show the image also in Edit mode, below the code block. The preview updates automatically when the code changes."
    )).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.tikzLivePreview).onChange(async (value) => {
        this.plugin.settings.tikzLivePreview = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName(t("Rendering engine")).setDesc(t(
      "auto tries pdflatex+dvisvgm and falls back to latex+dvisvgm. 'pdf' is more compatible with modern packages, 'dvi' is more traditional."
    )).addDropdown(
      (dd) => dd.addOption("auto", t("Auto (recommended)")).addOption("pdf", t("pdflatex + dvisvgm (PDF)")).addOption("dvi", t("latex + dvisvgm (DVI)")).setValue(this.plugin.settings.tikzEngine).onChange(async (value) => {
        this.plugin.settings.tikzEngine = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName(t("latex/pdflatex binary path")).setDesc(t("Leave empty for automatic lookup in the PATH (recommended). Use a full path only if needed.")).addText(
      (text) => text.setPlaceholder("(auto)").setValue(this.plugin.settings.tikzLatexBin).onChange(async (value) => {
        this.plugin.settings.tikzLatexBin = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName(t("dvisvgm binary path")).setDesc(t("Leave empty for automatic lookup in the PATH (recommended).")).addText(
      (text) => text.setPlaceholder("(auto)").setValue(this.plugin.settings.tikzDvisvgmBin).onChange(async (value) => {
        this.plugin.settings.tikzDvisvgmBin = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName(t("Extra preamble")).setDesc(t(
      "Lines to add to the preamble of every rendering. Useful to load frequently used libraries, e.g. \\usepackage{pgfplots} or \\usetikzlibrary{positioning, arrows.meta}."
    )).addTextArea(
      (text) => text.setPlaceholder("\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}").setValue(this.plugin.settings.tikzExtraPreamble).onChange(async (value) => {
        this.plugin.settings.tikzExtraPreamble = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName(t("Test TikZ rendering")).setDesc(t("Runs a test diagram with pgfplots, circuitikz and libraries to verify the configuration.")).addButton(
      (btn) => btn.setButtonText(t("Test")).onClick(async () => {
        btn.setDisabled(true);
        btn.setButtonText(t("Rendering..."));
        try {
          await this.plugin.tikzRenderer.render(
            "\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}\n\\usepackage[siunitx]{circuitikz}\n\\usetikzlibrary{positioning, arrows.meta}\n\\begin{tikzpicture}\n\\draw (0,0) to[R=1k] (3,0);\n\\node[draw, right=1cm of {(3,0)}] (b) {OK};\n\\draw[-{Stealth}] (3,0) -- (b);\n\\end{tikzpicture}"
          );
          new import_obsidian.Notice(t("TikZ rendering succeeded: the TeX configuration works."));
        } catch (e) {
          new import_obsidian.Notice(`${t("TikZ rendering error:")} ${e.message}`);
        } finally {
          btn.setDisabled(false);
          btn.setButtonText(t("Test"));
        }
      })
    );
    new import_obsidian.Setting(containerEl).setName(t("Clear rendering cache")).setDesc(t("Deletes the already compiled SVGs (useful after preamble changes or to free space).")).addButton(
      (btn) => btn.setButtonText(t("Clear")).onClick(() => {
        this.plugin.tikzRenderer.clearCache();
        new import_obsidian.Notice(t("TikZ cache cleared."));
      })
    );
  }
};

// src/i18n.ts
var IT = {
  "Language": "Lingua",
  "Interface language. English is the default. Some command names update after reloading Obsidian.": "Lingua dell'interfaccia. L'inglese \xE8 il default. Alcuni nomi dei comandi si aggiornano dopo il ricaricamento di Obsidian.",
  "Language changed. Reload Obsidian to apply it everywhere.": "Lingua cambiata. Ricarica Obsidian per applicarla ovunque.",
  "English": "Inglese",
  "Italian": "Italiano",
  "Rendering TikZ": "Rendering TikZ",
  "Render TikZ code blocks with local TeX": "Render dei blocchi TikZ con TeX locale",
  "Renders ```tikz blocks in your notes using the TeX installed on the system (MiKTeX/TeX Live). Supports ALL external libraries (pgfplots, circuitikz, tikz-cd, forest, etc.) that TikZJax cannot load. Rendering happens before the TikZJax plugin, so it takes precedence.": "Rende i blocchi ```tikz delle note con il TeX installato sul sistema (MiKTeX/TeX Live). Supporta TUTTE le librerie esterne (pgfplots, circuitikz, tikz-cd, forest, ecc.) che TikZJax non pu\xF2 caricare. Il rendering avviene prima del plugin TikZJax, quindi ha la precedenza.",
  "Live preview in Edit mode": "Anteprima in modifica (live preview)",
  "Show the image also in Edit mode, below the code block. The preview updates automatically when the code changes.": "Mostra l'immagine anche in modalit\xE0 modifica, sotto il blocco di codice. L'anteprima viene aggiornata automaticamente quando il codice cambia.",
  "Rendering engine": "Motore di rendering",
  "auto tries pdflatex+dvisvgm and falls back to latex+dvisvgm. 'pdf' is more compatible with modern packages, 'dvi' is more traditional.": "auto prova pdflatex+dvisvgm e ripiega su latex+dvisvgm. 'pdf' \xE8 pi\xF9 compatibile con i pacchetti moderni, 'dvi' \xE8 pi\xF9 tradizionale.",
  "Auto (recommended)": "Auto (consigliato)",
  "pdflatex + dvisvgm (PDF)": "pdflatex + dvisvgm (PDF)",
  "latex + dvisvgm (DVI)": "latex + dvisvgm (DVI)",
  "latex/pdflatex binary path": "Percorso binario latex/pdflatex",
  "Leave empty for automatic lookup in the PATH (recommended). Use a full path only if needed.": "Lascia vuoto per la ricerca automatica nel PATH (consigliato). Usa il percorso completo solo se serve.",
  "dvisvgm binary path": "Percorso binario dvisvgm",
  "Leave empty for automatic lookup in the PATH (recommended).": "Lascia vuoto per la ricerca automatica nel PATH (consigliato).",
  "Extra preamble": "Preambolo aggiuntivo",
  "Lines to add to the preamble of every rendering. Useful to load frequently used libraries, e.g. \\usepackage{pgfplots} or \\usetikzlibrary{positioning, arrows.meta}.": "Linee da aggiungere al preambolo di ogni rendering. Utile per caricare librerie usate di frequente, es. \\usepackage{pgfplots} oppure \\usetikzlibrary{positioning, arrows.meta}.",
  "Test TikZ rendering": "Testa rendering TikZ",
  "Runs a test diagram with pgfplots, circuitikz and libraries to verify the configuration.": "Esegue un diagramma di prova con pgfplots, circuitikz e librerie per verificare la configurazione.",
  "Test": "Test",
  "Rendering...": "Rendering in corso...",
  "TikZ rendering succeeded: the TeX configuration works.": "Rendering TikZ riuscito: la configurazione TeX funziona.",
  "TikZ rendering error:": "Errore rendering TikZ:",
  "Clear rendering cache": "Svuota cache rendering",
  "Deletes the already compiled SVGs (useful after preamble changes or to free space).": "Elimina gli SVG gi\xE0 compilati (utile dopo modifiche al preambolo o per liberare spazio).",
  "Clear": "Svuota",
  "TikZ cache cleared.": "Cache TikZ svuotata.",
  "Rendering TikZ with local TeX...": "Rendering TikZ con TeX locale\u2026",
  "Show TikZ code": "Mostra codice TikZ",
  "Hide TikZ code": "Nascondi codice TikZ",
  "TikZ rendering error": "Errore di rendering TikZ",
  "Rendering TikZ...": "Rendering TikZ\u2026"
};
function translate(lang, text) {
  var _a;
  if (lang === "it") return (_a = IT[text]) != null ? _a : text;
  return text;
}

// src/main.ts
var TikzVaultPlugin = class extends import_obsidian2.Plugin {
  constructor() {
    super(...arguments);
    __publicField(this, "settings");
    __publicField(this, "tikzRenderer");
  }
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.tikzRenderer = new TikzRenderer(this);
    this.registerEditorExtension(tikzPreviewExtension(this));
    this.registerMarkdownPostProcessor(
      async (el) => {
        if (!this.settings.tikzEnabled) return;
        try {
          const candidates = Array.from(
            el.querySelectorAll(
              "pre > code.language-tikz, pre > code.language-tikzcd, pre > code.language-pgfplots"
            )
          );
          for (const codeEl of candidates) {
            try {
              const pre = codeEl.parentElement;
              if (!pre) continue;
              const code = codeEl.innerText;
              const container = this.buildTikzContainer(code);
              pre.replaceWith(container);
              await this.fillTikzContainer(container, code);
            } catch (e) {
              console.error("tikz-vault: error in the TikZ post-processor:", e);
            }
          }
        } catch (e) {
          console.error("tikz-vault: error in the TikZ post-processor:", e);
        }
      },
      -1e3
    );
    this.addSettingTab(new TikzSettingTab(this.app, this));
  }
  // Translate a UI string according to the selected language.
  t(text) {
    var _a, _b;
    return translate((_b = (_a = this.settings) == null ? void 0 : _a.language) != null ? _b : "en", text);
  }
  onunload() {
  }
  buildTikzContainer(code) {
    const container = document.createElement("div");
    container.className = "tikz-result";
    container.dataset.tikzCode = code;
    const status = container.createEl("div", { cls: "tikz-status" });
    status.setText(this.t("Rendering TikZ with local TeX..."));
    status.addClass("tikz-loading");
    return container;
  }
  async fillTikzContainer(container, code) {
    const status = container.querySelector(".tikz-status");
    try {
      const svg = await this.tikzRenderer.render(code);
      status == null ? void 0 : status.remove();
      const figure = container.createEl("div", { cls: "tikz-figure" });
      figure.innerHTML = svg;
    } catch (e) {
      status == null ? void 0 : status.remove();
      const errBox = container.createEl("div", { cls: "tikz-error" });
      errBox.createEl("div", {
        text: this.t("TikZ rendering error"),
        cls: "tikz-error-title"
      });
      errBox.createEl("pre", {
        text: e instanceof Error ? e.message : String(e),
        cls: "tikz-error-msg"
      });
    }
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
