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
var import_obsidian3 = require("obsidian");

// src/tikzRenderer.ts
var import_child_process = require("child_process");
var import_crypto = require("crypto");
var import_fs = require("fs");
var import_os = require("os");
var import_path = require("path");
var _TikzRenderer = class _TikzRenderer {
  constructor(plugin) {
    __publicField(this, "plugin");
    __publicField(this, "cacheDir");
    __publicField(this, "inFlight", /* @__PURE__ */ new Map());
    // In-memory copy of already rendered SVGs: avoids re-reading the disk (and
    // re-rendering) when the editor recomputes decorations on every keystroke.
    __publicField(this, "memo", /* @__PURE__ */ new Map());
    __publicField(this, "binCache", /* @__PURE__ */ new Map());
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
    const memoized = this.memo.get(hash);
    if (memoized) return memoized;
    const cached = await this.readCache(svgFile);
    if (cached !== null) {
      this.memo.set(hash, cached);
      return cached;
    }
    const existing = this.inFlight.get(hash);
    if (existing) return existing;
    const promise = this.doRender(tex, dir, svgFile, s).then((svg) => {
      this.memo.set(hash, svg);
      return svg;
    }).finally(() => {
      this.inFlight.delete(hash);
    });
    this.inFlight.set(hash, promise);
    return promise;
  }
  // Read a cached SVG asynchronously so the UI thread is not blocked. A stale
  // blank SVG (broken dvisvgm output) is discarded so it gets re-rendered.
  async readCache(svgFile) {
    let cached;
    try {
      cached = await import_fs.promises.readFile(svgFile, "utf8");
    } catch (e) {
      return null;
    }
    if (this.isBlankSvg(cached)) {
      try {
        await import_fs.promises.rm(svgFile, { force: true });
      } catch (e) {
      }
      return null;
    }
    return this.cleanSvg(cached);
  }
  async doRender(tex, dir, svgFile, s) {
    await import_fs.promises.mkdir(dir, { recursive: true });
    await import_fs.promises.writeFile((0, import_path.join)(dir, "main.tex"), tex, "utf8");
    const latexPdf = this.resolveLatex("pdf");
    const latexDvi = this.resolveLatex("dvi");
    const dvisvgm = this.resolveDvisvgm();
    const engines = [];
    if (s.tikzEngine !== "dvi" && latexPdf && dvisvgm) {
      engines.push({
        label: "pdflatex + dvisvgm",
        build: async (d) => {
          await this.run(latexPdf, this.latexArgs(), d);
          await this.run(dvisvgm, ["--pdf", "--no-fonts=1", "--precision=2", "main.pdf"], d);
        }
      });
    }
    if (s.tikzEngine !== "pdf" && latexDvi && dvisvgm) {
      engines.push({
        label: "latex + dvisvgm",
        build: async (d) => {
          await this.run(latexDvi, this.latexArgs(), d);
          await this.run(dvisvgm, ["--no-fonts=1", "--precision=2", "main.dvi"], d);
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
        let svg;
        try {
          svg = await import_fs.promises.readFile(svgFile, "utf8");
        } catch (e) {
          throw new Error(`dvisvgm did not produce any SVG (engine ${engine.label})`);
        }
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
            await import_fs.promises.rm((0, import_path.join)(dir, f), { force: true });
          } catch (e2) {
          }
        }
      }
    }
    throw new Error(this.buildErrorMessage(errors, dir));
  }
  // LaTeX arguments. `--disable-write18` and `--enable-installer` are MiKTeX
  // specific: TeX Live does not accept them, so they are only added on Windows
  // (where MiKTeX is the common distribution).
  latexArgs() {
    const args = ["--interaction=nonstopmode", "--halt-on-error"];
    const shell = this.plugin.settings.tikzShellEscape;
    if (shell) args.push("--shell-escape");
    if (process.platform === "win32") {
      args.push(shell ? "--enable-write18" : "--disable-write18", "--enable-installer");
    }
    args.push("main.tex");
    return args;
  }
  // Wait for in-flight renders before deleting the cache, so a build that is
  // writing into a cache directory cannot fail with a missing-directory error.
  async clearCache() {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
    this.memo.clear();
    try {
      (0, import_fs.rmSync)(this.cacheDir, { recursive: true, force: true });
      (0, import_fs.mkdirSync)(this.cacheDir, { recursive: true });
    } catch (e) {
    }
  }
  // Opportunistic cleanup: drop cached renders older than 14 days and, if the
  // cache exceeds 256 MB, remove the oldest directories first.
  cleanupCache() {
    const maxAgeMs = 14 * 24 * 3600 * 1e3;
    const maxBytes = 256 * 1024 * 1024;
    let names;
    try {
      names = (0, import_fs.readdirSync)(this.cacheDir);
    } catch (e) {
      return;
    }
    const now = Date.now();
    const dirs = [];
    for (const name of names) {
      const p = (0, import_path.join)(this.cacheDir, name);
      try {
        const st = (0, import_fs.statSync)(p);
        if (st.isDirectory()) dirs.push({ path: p, mtime: st.mtimeMs, size: this.dirSize(p) });
      } catch (e) {
      }
    }
    let total = 0;
    for (const d of dirs) {
      if (now - d.mtime > maxAgeMs) {
        try {
          (0, import_fs.rmSync)(d.path, { recursive: true, force: true });
        } catch (e) {
        }
      } else {
        total += d.size;
      }
    }
    if (total > maxBytes) {
      const remaining = dirs.filter((d) => (0, import_fs.existsSync)(d.path)).sort((a, b) => a.mtime - b.mtime);
      for (const d of remaining) {
        if (total <= maxBytes) break;
        try {
          (0, import_fs.rmSync)(d.path, { recursive: true, force: true });
          total -= d.size;
        } catch (e) {
        }
      }
    }
  }
  dirSize(dir) {
    let total = 0;
    try {
      for (const name of (0, import_fs.readdirSync)(dir)) {
        try {
          total += (0, import_fs.statSync)((0, import_path.join)(dir, name)).size;
        } catch (e) {
        }
      }
    } catch (e) {
    }
    return total;
  }
  buildTexSource(code, extraPreamble) {
    const src = code.replace(/\r\n/g, "\n").trim();
    if (!src) throw new Error("The TikZ block is empty.");
    if (/\\documentclass\s*[\[{]/.test(src)) {
      return src;
    }
    if (/\\begin\{document\}/.test(src)) {
      const head = ["\\documentclass[border=5pt]{standalone}"];
      if (!/\\usepackage(?:\[[^\]]*\])?\{[^}]*\btikz\b[^}]*\}/.test(src)) head.push("\\usepackage{tikz}");
      const extraDoc = extraPreamble.trim();
      if (extraDoc) head.push(extraDoc);
      return head.join("\n") + "\n" + src;
    }
    const { preamble, body: rawBody } = this.splitPreamble(src);
    let body = rawBody;
    let picture = true;
    const envMatch = body.match(/^\\begin\{([\w*-]+)\}/);
    if (envMatch) {
      const env = envMatch[1];
      if (_TikzRenderer.AXIS_ENVS.has(env)) {
        body = "\\begin{tikzpicture}\n" + body + "\n\\end{tikzpicture}";
      } else if (!_TikzRenderer.PICTURE_ENVS.has(env)) {
        picture = false;
      }
    } else if (/^\\tikz\s*[{\[]/.test(body)) {
    } else if (_TikzRenderer.TIKZ_CMD.test(body)) {
      body = "\\begin{tikzpicture}\n" + body + "\n\\end{tikzpicture}";
    } else {
      picture = false;
    }
    const userPre = preamble + "\n" + extraPreamble;
    const has = (pkg) => new RegExp(`\\\\(?:usepackage|RequirePackage)(?:\\[[^\\]]*\\])?\\{[^}]*\\b${pkg}\\b[^}]*\\}`).test(userPre);
    const parts = [
      picture ? "\\documentclass[border=5pt]{standalone}" : "\\documentclass[border=5pt,varwidth]{standalone}"
    ];
    const add = (pkg, opts = "") => {
      if (!has(pkg)) parts.push(`\\usepackage${opts}{${pkg}}`);
    };
    add("amsmath");
    add("amssymb");
    add("tikz");
    for (const [re, pkg] of _TikzRenderer.AUTO_PACKAGES) {
      if (re.test(src)) add(pkg);
    }
    if (/(\\begin\{\w*axis\}|\\addplot)/.test(src) && !has("pgfplots")) {
      parts.push("\\usepackage{pgfplots}", "\\pgfplotsset{compat=1.18}");
    }
    const extra = extraPreamble.trim();
    if (extra) parts.push(extra);
    if (preamble) parts.push(preamble);
    parts.push("\\begin{document}", body, "\\end{document}");
    return parts.join("\n");
  }
  // Leading lines made of preamble-only commands (packages, libraries, macro
  // definitions, comments) become the preamble; the rest is the body.
  splitPreamble(src) {
    const lines = src.split("\n");
    const pre = /^\s*(%.*|\\(usepackage|RequirePackage|usetikzlibrary|usepgfplotslibrary|usepgflibrary|pgfplotsset|tikzset|ctikzset|newcommand|renewcommand|providecommand|NewDocumentCommand|DeclareMathOperator|DeclarePairedDelimiter|def|let|definecolor|colorlet|lstset|lstdefinestyle|lstdefinelanguage|setminted|usemintedstyle|tcbuselibrary|tcbset|forestset|sisetup|NiceMatrixOptions|algrenewcommand|algnewcommand|algdef|newtheorem|tikzcdset|usetkzobj|tkzSetUpPoint)\b.*)?$/;
    let i = 0;
    let depth = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (depth === 0 && !pre.test(line)) break;
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth < 0) depth = 0;
      i++;
    }
    return { preamble: lines.slice(0, i).join("\n").trim(), body: lines.slice(i).join("\n").trim() };
  }
  cleanSvg(svg) {
    return svg.replace(/^\s*<\?xml[^>]*\?>\s*/, "").replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/, "").trim();
  }
  // An SVG is "blank" when every drawing element is invisible (stroke-opacity
  // or fill-opacity equal to 0, or no visible stroke/fill at all). Used to
  // detect broken dvisvgm output and fall back to the next engine.
  isBlankSvg(svg) {
    const elRe = /<(path|rect|circle|ellipse|line|polyline|polygon|text)\b[^>]*>/gi;
    let visible = false;
    let m;
    const attr = (tag, name) => {
      var _a;
      return (_a = new RegExp(`${name}=["']([^"']*)["']`).exec(tag)) == null ? void 0 : _a[1];
    };
    while ((m = elRe.exec(svg)) !== null) {
      const tag = m[0];
      const stroke = attr(tag, "stroke");
      const fill = attr(tag, "fill");
      const strokeOp = attr(tag, "stroke-opacity");
      const fillOp = attr(tag, "fill-opacity");
      const strokeVisible = stroke !== void 0 && stroke !== "" && stroke !== "none" && strokeOp !== "0";
      const fillVisible = fill !== "" && fill !== "none" && fillOp !== "0";
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
    const detail = errors.length ? errors.map((e, i) => `${this.plugin.t("Attempt")} ${i + 1}: ${e}`).join("\n\n") : "";
    return detail + (tail ? `

--- LaTeX log ---
${tail}` : "");
  }
  resolveLatex(engine) {
    var _a;
    const cfg = this.plugin.settings.tikzLatexBin.trim();
    if (cfg) return this.withExe(cfg);
    return (_a = this.findInPathCached(engine === "pdf" ? "pdflatex" : "latex")) != null ? _a : "";
  }
  resolveDvisvgm() {
    var _a;
    const cfg = this.plugin.settings.tikzDvisvgmBin.trim();
    if (cfg) return this.withExe(cfg);
    return (_a = this.findInPathCached("dvisvgm")) != null ? _a : "";
  }
  withExe(bin) {
    if (process.platform !== "win32") return bin;
    const lower = bin.toLowerCase();
    if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat") || bin.includes("\\") || bin.includes("/")) {
      return bin;
    }
    return bin + ".exe";
  }
  // Cached PATH lookup: the PATH does not change while the plugin is loaded, so
  // there is no need to scan every directory on each render.
  findInPathCached(name) {
    const cached = this.binCache.get(name);
    if (cached !== void 0) return cached;
    const found = this.findInPath(name);
    this.binCache.set(name, found);
    return found;
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
    const lower = bin.toLowerCase();
    const shell = process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
    return new Promise((resolve, reject) => {
      (0, import_child_process.execFile)(
        bin,
        args,
        { cwd, windowsHide: true, timeout: 12e4, env: process.env, shell },
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
// Environments that produce a picture on their own and must NOT be nested in
// another tikzpicture.
__publicField(_TikzRenderer, "PICTURE_ENVS", /* @__PURE__ */ new Set([
  "tikzpicture",
  "tikzcd",
  "forest",
  "circuitikz",
  "quantikz",
  "karnaugh-map",
  "bytefield",
  "scope"
]));
// pgfplots environments that need a surrounding tikzpicture.
__publicField(_TikzRenderer, "AXIS_ENVS", /* @__PURE__ */ new Set([
  "axis",
  "semilogxaxis",
  "semilogyaxis",
  "loglogaxis",
  "polaraxis",
  "groupplot",
  "ternaryaxis",
  "smithchart"
]));
// Bare TikZ drawing commands (block without any environment).
__publicField(_TikzRenderer, "TIKZ_CMD", /^\\(draw|node|path|fill|filldraw|shade|shadedraw|coordinate|foreach|matrix|pic|clip|graph|useasboundingbox|begin\{scope\}|tikzset)\b/);
// Packages loaded automatically when their environments/commands appear.
__publicField(_TikzRenderer, "AUTO_PACKAGES", [
  [/\\begin\{tikzcd\}/, "tikz-cd"],
  [/\\begin\{forest\}/, "forest"],
  [/\\begin\{circuitikz\}/, "circuitikz"],
  [/\\begin\{quantikz\}/, "quantikz"],
  [/\\begin\{karnaugh-map\}/, "karnaugh-map"],
  [/\\begin\{bytefield\}/, "bytefield"],
  [/\\begin\{[pbBvV]?Nice(Matrix|Array|Tabular)\}/, "nicematrix"],
  [/\\begin\{blockarray\}/, "blkarray"],
  [/\\begin\{algorithmic\}/, "algpseudocode"],
  [/\\begin\{lstlisting\}|\\lstinline/, "listings"],
  [/\\begin\{minted\}|\\mintinline/, "minted"],
  [/\\begin\{tcolorbox\}/, "tcolorbox"],
  [/\\(dv|pdv|bra|ket|braket)\b/, "physics"],
  [/\\(mathclap|coloneqq|xrightarrow|prescript|DeclarePairedDelimiter)\b/, "mathtools"],
  [/\\cancel(to)?\b/, "cancel"],
  [/\\(SI|si|num|unit)\{/, "siunitx"]
]);
var TikzRenderer = _TikzRenderer;

// src/tikzPreview.ts
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var import_obsidian = require("obsidian");
var TIKZ_LANG = /^```(tikz|tikzcd|pgfplots)(\s|$)/i;
var CLOSING_FENCE = /^```\s*$/;
var blockCache = /* @__PURE__ */ new WeakMap();
function findTikzBlocks(state) {
  const cached = blockCache.get(state.doc);
  if (cached) return cached;
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
  blockCache.set(state.doc, blocks);
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
      fig.appendChild((0, import_obsidian.sanitizeHTMLToDom)(svg));
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
var import_obsidian2 = require("obsidian");
var DEFAULT_SETTINGS = {
  language: "en",
  tikzEnabled: true,
  tikzEngine: "auto",
  tikzLatexBin: "",
  tikzDvisvgmBin: "",
  tikzExtraPreamble: "",
  tikzLivePreview: true,
  tikzShellEscape: false
};
var TikzSettingTab = class extends import_obsidian2.PluginSettingTab {
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
    new import_obsidian2.Setting(containerEl).setName(t("Language")).setDesc(t(
      "Interface language. English is the default. Some command names update after reloading Obsidian."
    )).addDropdown(
      (dd) => dd.addOption("en", t("English")).addOption("it", t("Italian")).setValue(this.plugin.settings.language).onChange(async (value) => {
        this.plugin.settings.language = value;
        await this.plugin.saveSettings();
        new import_obsidian2.Notice(t("Language changed. Reload Obsidian to apply it everywhere."));
        this.display();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Render TikZ code blocks with local TeX")).setDesc(t(
      "Renders ```tikz blocks in your notes using the TeX installed on the system (MiKTeX/TeX Live). Supports ALL external libraries (pgfplots, circuitikz, tikz-cd, forest, etc.) that TikZJax cannot load. Rendering happens before the TikZJax plugin, so it takes precedence."
    )).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.tikzEnabled).onChange(async (value) => {
        this.plugin.settings.tikzEnabled = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Live preview in Edit mode")).setDesc(t(
      "Show the image also in Edit mode, below the code block. The preview updates automatically when the code changes."
    )).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.tikzLivePreview).onChange(async (value) => {
        this.plugin.settings.tikzLivePreview = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Rendering engine")).setDesc(t(
      "auto tries pdflatex+dvisvgm and falls back to latex+dvisvgm. 'pdf' is more compatible with modern packages, 'dvi' is more traditional."
    )).addDropdown(
      (dd) => dd.addOption("auto", t("Auto (recommended)")).addOption("pdf", t("pdflatex + dvisvgm (PDF)")).addOption("dvi", t("latex + dvisvgm (DVI)")).setValue(this.plugin.settings.tikzEngine).onChange(async (value) => {
        this.plugin.settings.tikzEngine = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("latex/pdflatex binary path")).setDesc(t("Leave empty for automatic lookup in the PATH (recommended). Use a full path only if needed.")).addText(
      (text) => text.setPlaceholder("(auto)").setValue(this.plugin.settings.tikzLatexBin).onChange(async (value) => {
        this.plugin.settings.tikzLatexBin = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("dvisvgm binary path")).setDesc(t("Leave empty for automatic lookup in the PATH (recommended).")).addText(
      (text) => text.setPlaceholder("(auto)").setValue(this.plugin.settings.tikzDvisvgmBin).onChange(async (value) => {
        this.plugin.settings.tikzDvisvgmBin = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Extra preamble")).setDesc(t(
      "Lines to add to the preamble of every rendering. Useful to load frequently used libraries, e.g. \\usepackage{pgfplots} or \\usetikzlibrary{positioning, arrows.meta}."
    )).addTextArea(
      (text) => text.setPlaceholder("\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}").setValue(this.plugin.settings.tikzExtraPreamble).onChange(async (value) => {
        this.plugin.settings.tikzExtraPreamble = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Enable shell-escape")).setDesc(t(
      "Required by packages that run external programs, such as minted (needs Pygments). Security risk: code blocks can execute commands on your system. Enable only for trusted vaults."
    )).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.tikzShellEscape).onChange(async (value) => {
        this.plugin.settings.tikzShellEscape = value;
        await this.plugin.saveSettings();
        await this.plugin.tikzRenderer.clearCache();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Test TikZ rendering")).setDesc(t("Runs a test diagram with pgfplots, circuitikz and libraries to verify the configuration.")).addButton(
      (btn) => btn.setButtonText(t("Test")).onClick(async () => {
        btn.setDisabled(true);
        btn.setButtonText(t("Rendering..."));
        try {
          await this.plugin.tikzRenderer.render(
            "\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}\n\\usepackage[siunitx]{circuitikz}\n\\usetikzlibrary{positioning, arrows.meta}\n\\begin{tikzpicture}\n\\draw (0,0) to[R=1k] (3,0);\n\\node[draw, right=1cm of {(3,0)}] (b) {OK};\n\\draw[-{Stealth}] (3,0) -- (b);\n\\end{tikzpicture}"
          );
          new import_obsidian2.Notice(t("TikZ rendering succeeded: the TeX configuration works."));
        } catch (e) {
          new import_obsidian2.Notice(`${t("TikZ rendering error:")} ${e.message}`);
        } finally {
          btn.setDisabled(false);
          btn.setButtonText(t("Test"));
        }
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Clear rendering cache")).setDesc(t("Deletes the already compiled SVGs (useful after preamble changes or to free space).")).addButton(
      (btn) => btn.setButtonText(t("Clear")).onClick(async () => {
        btn.setDisabled(true);
        try {
          await this.plugin.tikzRenderer.clearCache();
          new import_obsidian2.Notice(t("TikZ cache cleared."));
        } finally {
          btn.setDisabled(false);
        }
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
  "Enable shell-escape": "Abilita shell-escape",
  "Required by packages that run external programs, such as minted (needs Pygments). Security risk: code blocks can execute commands on your system. Enable only for trusted vaults.": "Necessario per pacchetti che eseguono programmi esterni, come minted (richiede Pygments). Rischio di sicurezza: i blocchi di codice possono eseguire comandi sul sistema. Abilitalo solo per vault fidati.",
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
  "Rendering TikZ...": "Rendering TikZ\u2026",
  "Attempt": "Tentativo"
};
function translate(lang, text) {
  var _a;
  if (lang === "it") return (_a = IT[text]) != null ? _a : text;
  return text;
}

// src/main.ts
var TikzVaultPlugin = class extends import_obsidian3.Plugin {
  constructor() {
    super(...arguments);
    __publicField(this, "settings");
    __publicField(this, "tikzRenderer");
  }
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.tikzRenderer = new TikzRenderer(this);
    this.tikzRenderer.cleanupCache();
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
      figure.appendChild((0, import_obsidian3.sanitizeHTMLToDom)(svg));
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
