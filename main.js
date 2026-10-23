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
  default: () => LatexVaultPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/renderer.ts
var import_child_process = require("child_process");
var import_crypto = require("crypto");
var import_fs = require("fs");
var import_os = require("os");
var import_path = require("path");
var _LatexRenderer = class _LatexRenderer {
  constructor(plugin) {
    __publicField(this, "plugin");
    __publicField(this, "cacheDir");
    __publicField(this, "inFlight", /* @__PURE__ */ new Map());
    // In-memory copy of already rendered SVGs: avoids re-reading the disk (and
    // re-rendering) when the editor recomputes decorations on every keystroke.
    __publicField(this, "memo", /* @__PURE__ */ new Map());
    __publicField(this, "binCache", /* @__PURE__ */ new Map());
    this.plugin = plugin;
    this.cacheDir = (0, import_path.join)((0, import_os.tmpdir)(), "latex-vault-render");
    (0, import_fs.mkdirSync)(this.cacheDir, { recursive: true });
  }
  async render(code) {
    const s = this.plugin.settings;
    const tex = this.buildTexSource(code, s.extraPreamble);
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
    if (s.engine !== "dvi" && latexPdf && dvisvgm) {
      engines.push({
        label: "pdflatex + dvisvgm",
        build: async (d) => {
          await this.run(latexPdf, this.latexArgs(), d);
          await this.run(dvisvgm, ["--pdf", "--no-fonts=1", "--precision=2", "main.pdf"], d);
        }
      });
    }
    if (s.engine !== "pdf" && latexDvi && dvisvgm) {
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
    const shell = this.plugin.settings.shellEscape;
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
    if (!src) throw new Error("The LaTeX block is empty.");
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
    let float = false;
    const floatMatch = body.match(/^\\begin\{(algorithm|figure|table)\}(\[[^\]]*\])?/);
    if (floatMatch) {
      float = true;
      body = `\\begin{${floatMatch[1]}}[H]` + body.slice(floatMatch[0].length);
    }
    const envMatch = body.match(/^\\begin\{([\w*-]+)\}/);
    if (envMatch) {
      const env = envMatch[1];
      if (_LatexRenderer.AXIS_ENVS.has(env)) {
        body = "\\begin{tikzpicture}\n" + body + "\n\\end{tikzpicture}";
      } else if (!_LatexRenderer.PICTURE_ENVS.has(env)) {
        picture = false;
      }
    } else if (/^\\tikz\s*[{\[]/.test(body)) {
    } else if (_LatexRenderer.TIKZ_CMD.test(body)) {
      body = "\\begin{tikzpicture}\n" + body + "\n\\end{tikzpicture}";
    } else {
      picture = false;
    }
    const userPre = preamble + "\n" + extraPreamble;
    const has = (pkg) => new RegExp(`\\\\(?:usepackage|RequirePackage)(?:\\[[^\\]]*\\])?\\{[^}]*\\b${pkg}\\b[^}]*\\}`).test(userPre);
    const classOpts = ["border=5pt"];
    if (!picture) classOpts.push("varwidth");
    if (float) classOpts.push("float");
    const parts = [`\\documentclass[${classOpts.join(",")}]{standalone}`];
    const add = (pkg, opts = "") => {
      if (!has(pkg)) parts.push(`\\usepackage${opts}{${pkg}}`);
    };
    add("amsmath");
    add("amssymb");
    add("tikz");
    if (float) {
      if (/^\\begin\{algorithm\}/.test(body)) {
        if (!has("algorithm2e")) add("algorithm");
      } else {
        add("float");
      }
    }
    for (const [re, pkg] of _LatexRenderer.AUTO_PACKAGES) {
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
    const cfg = this.plugin.settings.latexBin.trim();
    if (cfg) return this.withExe(cfg);
    return (_a = this.findInPathCached(engine === "pdf" ? "pdflatex" : "latex")) != null ? _a : "";
  }
  resolveDvisvgm() {
    var _a;
    const cfg = this.plugin.settings.dvisvgmBin.trim();
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
__publicField(_LatexRenderer, "PICTURE_ENVS", /* @__PURE__ */ new Set([
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
__publicField(_LatexRenderer, "AXIS_ENVS", /* @__PURE__ */ new Set([
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
__publicField(_LatexRenderer, "TIKZ_CMD", /^\\(draw|node|path|fill|filldraw|shade|shadedraw|coordinate|foreach|matrix|pic|clip|graph|useasboundingbox|begin\{scope\}|tikzset)\b/);
// Packages loaded automatically when their environments/commands appear.
__publicField(_LatexRenderer, "AUTO_PACKAGES", [
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
var LatexRenderer = _LatexRenderer;

// src/livePreview.ts
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var import_obsidian = require("obsidian");

// src/languages.ts
var LANGUAGES = ["latex-vault", "tikz", "tikzcd", "pgfplots"];
var LANGUAGE_SELECTOR = LANGUAGES.map((l) => `pre > code.language-${l}`).join(", ");
var FENCE_RE = new RegExp("^```(" + LANGUAGES.join("|") + ")(\\s|$)", "i");

// src/livePreview.ts
var CLOSING_FENCE = /^```\s*$/;
var blockCache = /* @__PURE__ */ new WeakMap();
function findLatexBlocks(state) {
  const cached = blockCache.get(state.doc);
  if (cached) return cached;
  const blocks = [];
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
var expandEffect = import_state.StateEffect.define();
var collapseEffect = import_state.StateEffect.define();
var recalcEffect = import_state.StateEffect.define();
var LatexPreviewWidget = class extends import_view.WidgetType {
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
    wrap.className = "latex-live";
    const status = document.createElement("div");
    status.className = "latex-status";
    status.textContent = this.t("Rendering LaTeX...");
    wrap.appendChild(status);
    const finish = () => {
      const btn = document.createElement("button");
      btn.className = "latex-source-toggle";
      btn.textContent = this.expanded ? this.t("Hide LaTeX code") : this.t("Show LaTeX code");
      btn.addEventListener("click", () => {
        const view = import_view.EditorView.findFromDOM(wrap);
        if (!view) return;
        view.dispatch({
          effects: this.expanded ? collapseEffect.of(this.from) : expandEffect.of(this.from)
        });
      });
      wrap.appendChild(btn);
    };
    this.renderFn(this.code).then((svg) => {
      if (this.destroyed) return;
      wrap.replaceChildren();
      const fig = document.createElement("div");
      fig.className = "latex-figure";
      fig.appendChild((0, import_obsidian.sanitizeHTMLToDom)(svg));
      wrap.appendChild(fig);
      finish();
    }).catch((err) => {
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
  destroy() {
    this.destroyed = true;
  }
  ignoreEvent() {
    return true;
  }
};
function computeDecorations(state, plugin, expanded) {
  if (!plugin.settings.enabled || !plugin.settings.livePreview) return import_view.Decoration.none;
  const builder = new import_state.RangeSetBuilder();
  const render = (code) => plugin.renderer.render(code);
  try {
    for (const block of findLatexBlocks(state)) {
      if (!expanded.has(block.from)) {
        for (let k = block.fromLine; k <= block.toLine; k++) {
          const pos = state.doc.line(k).from;
          builder.add(pos, pos, import_view.Decoration.line({ class: "latex-code-hidden" }));
        }
      }
      builder.add(
        block.to,
        block.to,
        import_view.Decoration.widget({
          widget: new LatexPreviewWidget(block.code, render, plugin.t, block.from, expanded.has(block.from)),
          block: true,
          side: 1
        })
      );
    }
  } catch (e) {
    console.error("latex-vault: error building LaTeX decorations:", e);
  }
  return builder.finish();
}
function livePreviewExtension(plugin) {
  const field = import_state.StateField.define({
    create(state) {
      return { deco: computeDecorations(state, plugin, /* @__PURE__ */ new Set()), expanded: /* @__PURE__ */ new Set() };
    },
    update(value, tr) {
      const relevant = tr.docChanged || tr.effects.some((e) => e.is(expandEffect) || e.is(collapseEffect) || e.is(recalcEffect));
      if (!relevant) return value;
      const expanded = /* @__PURE__ */ new Set();
      for (const pos of value.expanded) expanded.add(tr.changes.mapPos(pos, -1));
      for (const e of tr.effects) {
        if (e.is(expandEffect)) expanded.add(e.value);
        else if (e.is(collapseEffect)) expanded.delete(e.value);
      }
      return { deco: computeDecorations(tr.state, plugin, expanded), expanded };
    },
    provide: (f) => import_view.EditorView.decorations.from(f, (v) => v.deco)
  });
  return [
    field,
    import_view.EditorView.updateListener.of((update) => {
      if (update.viewportChanged) {
        update.view.dispatch({ effects: recalcEffect.of(null) });
      }
    })
  ];
}

// src/settings.ts
var import_obsidian2 = require("obsidian");
var DEFAULT_SETTINGS = {
  language: "en",
  enabled: true,
  engine: "auto",
  latexBin: "",
  dvisvgmBin: "",
  extraPreamble: "",
  livePreview: true,
  shellEscape: false
};
var LatexSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    __publicField(this, "plugin");
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const t = (s) => this.plugin.t(s);
    containerEl.empty();
    containerEl.createEl("h2", { text: t("LaTeX rendering") });
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
    new import_obsidian2.Setting(containerEl).setName(t("Render LaTeX code blocks with local TeX")).setDesc(t(
      "Renders ```latex-vault blocks (and the legacy ```tikz, ```tikzcd, ```pgfplots) using the TeX installed on the system (MiKTeX/TeX Live). Any installed package works: TikZ, pgfplots, matrices, algorithms, code listings, math. Rendering happens before the TikZJax plugin, so it takes precedence."
    )).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
        this.plugin.settings.enabled = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Live preview in Edit mode")).setDesc(t(
      "Show the image also in Edit mode, below the code block. The preview updates automatically when the code changes."
    )).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.livePreview).onChange(async (value) => {
        this.plugin.settings.livePreview = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Rendering engine")).setDesc(t(
      "auto tries pdflatex+dvisvgm and falls back to latex+dvisvgm. 'pdf' is more compatible with modern packages, 'dvi' is more traditional."
    )).addDropdown(
      (dd) => dd.addOption("auto", t("Auto (recommended)")).addOption("pdf", t("pdflatex + dvisvgm (PDF)")).addOption("dvi", t("latex + dvisvgm (DVI)")).setValue(this.plugin.settings.engine).onChange(async (value) => {
        this.plugin.settings.engine = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("latex/pdflatex binary path")).setDesc(t("Leave empty for automatic lookup in the PATH (recommended). Use a full path only if needed.")).addText(
      (text) => text.setPlaceholder("(auto)").setValue(this.plugin.settings.latexBin).onChange(async (value) => {
        this.plugin.settings.latexBin = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("dvisvgm binary path")).setDesc(t("Leave empty for automatic lookup in the PATH (recommended).")).addText(
      (text) => text.setPlaceholder("(auto)").setValue(this.plugin.settings.dvisvgmBin).onChange(async (value) => {
        this.plugin.settings.dvisvgmBin = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Extra preamble")).setDesc(t(
      "Lines to add to the preamble of every rendering. Useful to load frequently used libraries, e.g. \\usepackage{pgfplots} or \\usetikzlibrary{positioning, arrows.meta}."
    )).addTextArea(
      (text) => text.setPlaceholder("\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}").setValue(this.plugin.settings.extraPreamble).onChange(async (value) => {
        this.plugin.settings.extraPreamble = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Enable shell-escape")).setDesc(t(
      "Required by packages that run external programs, such as minted (needs Pygments). Security risk: code blocks can execute commands on your system. Enable only for trusted vaults."
    )).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.shellEscape).onChange(async (value) => {
        this.plugin.settings.shellEscape = value;
        await this.plugin.saveSettings();
        await this.plugin.renderer.clearCache();
      })
    );
    new import_obsidian2.Setting(containerEl).setName(t("Test LaTeX rendering")).setDesc(t("Runs a test diagram with pgfplots, circuitikz and libraries to verify the configuration.")).addButton(
      (btn) => btn.setButtonText(t("Test")).onClick(async () => {
        btn.setDisabled(true);
        btn.setButtonText(t("Rendering..."));
        try {
          await this.plugin.renderer.render(
            "\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}\n\\usepackage[siunitx]{circuitikz}\n\\usetikzlibrary{positioning, arrows.meta}\n\\begin{tikzpicture}\n\\draw (0,0) to[R=1k] (3,0);\n\\node[draw, right=1cm of {(3,0)}] (b) {OK};\n\\draw[-{Stealth}] (3,0) -- (b);\n\\end{tikzpicture}"
          );
          new import_obsidian2.Notice(t("LaTeX rendering succeeded: the TeX configuration works."));
        } catch (e) {
          new import_obsidian2.Notice(`${t("LaTeX rendering error:")} ${e.message}`);
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
          await this.plugin.renderer.clearCache();
          new import_obsidian2.Notice(t("LaTeX cache cleared."));
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
  "LaTeX rendering": "Rendering LaTeX",
  "Render LaTeX code blocks with local TeX": "Render dei blocchi LaTeX con TeX locale",
  "Renders ```latex-vault blocks (and the legacy ```tikz, ```tikzcd, ```pgfplots) using the TeX installed on the system (MiKTeX/TeX Live). Any installed package works: TikZ, pgfplots, matrices, algorithms, code listings, math. Rendering happens before the TikZJax plugin, so it takes precedence.": "Rende i blocchi ```latex-vault (e i vecchi ```tikz, ```tikzcd, ```pgfplots) con il TeX installato sul sistema (MiKTeX/TeX Live). Funziona qualsiasi pacchetto installato: TikZ, pgfplots, matrici, algoritmi, codice, matematica. Il rendering avviene prima del plugin TikZJax, quindi ha la precedenza.",
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
  "Test LaTeX rendering": "Testa rendering LaTeX",
  "Runs a test diagram with pgfplots, circuitikz and libraries to verify the configuration.": "Esegue un diagramma di prova con pgfplots, circuitikz e librerie per verificare la configurazione.",
  "Test": "Test",
  "Rendering...": "Rendering in corso...",
  "LaTeX rendering succeeded: the TeX configuration works.": "Rendering LaTeX riuscito: la configurazione TeX funziona.",
  "LaTeX rendering error:": "Errore rendering LaTeX:",
  "Clear rendering cache": "Svuota cache rendering",
  "Deletes the already compiled SVGs (useful after preamble changes or to free space).": "Elimina gli SVG gi\xE0 compilati (utile dopo modifiche al preambolo o per liberare spazio).",
  "Clear": "Svuota",
  "LaTeX cache cleared.": "Cache LaTeX svuotata.",
  "Rendering LaTeX with local TeX...": "Rendering LaTeX con TeX locale\u2026",
  "Show LaTeX code": "Mostra codice LaTeX",
  "Hide LaTeX code": "Nascondi codice LaTeX",
  "LaTeX rendering error": "Errore di rendering LaTeX",
  "Rendering LaTeX...": "Rendering LaTeX\u2026",
  "Attempt": "Tentativo"
};
function translate(lang, text) {
  var _a;
  if (lang === "it") return (_a = IT[text]) != null ? _a : text;
  return text;
}

// src/main.ts
var LatexVaultPlugin = class extends import_obsidian3.Plugin {
  constructor() {
    super(...arguments);
    __publicField(this, "settings");
    __publicField(this, "renderer");
  }
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrateSettings(await this.loadLegacyAwareData()));
    this.renderer = new LatexRenderer(this);
    this.renderer.cleanupCache();
    this.registerEditorExtension(livePreviewExtension(this));
    this.registerMarkdownPostProcessor(
      async (el) => {
        if (!this.settings.enabled) return;
        try {
          const candidates = Array.from(
            el.querySelectorAll(LANGUAGE_SELECTOR)
          );
          for (const codeEl of candidates) {
            try {
              const pre = codeEl.parentElement;
              if (!pre) continue;
              const code = codeEl.innerText;
              const container = this.buildContainer(code);
              pre.replaceWith(container);
              await this.fillContainer(container, code);
            } catch (e) {
              console.error("latex-vault: error in the LaTeX post-processor:", e);
            }
          }
        } catch (e) {
          console.error("latex-vault: error in the LaTeX post-processor:", e);
        }
      },
      -1e3
    );
    this.addSettingTab(new LatexSettingTab(this.app, this));
  }
  // Settings of the plugin, falling back to the data of the old "tikz-vault"
  // plugin id so that renaming the plugin does not lose the configuration.
  async loadLegacyAwareData() {
    const data = await this.loadData();
    if (data) return data;
    const legacy = `${this.app.vault.configDir}/plugins/tikz-vault/data.json`;
    try {
      if (await this.app.vault.adapter.exists(legacy)) {
        return JSON.parse(await this.app.vault.adapter.read(legacy));
      }
    } catch (e) {
      console.error("latex-vault: cannot read legacy tikz-vault settings:", e);
    }
    return null;
  }
  // Translate a UI string according to the selected language.
  t(text) {
    var _a, _b;
    return translate((_b = (_a = this.settings) == null ? void 0 : _a.language) != null ? _b : "en", text);
  }
  buildContainer(code) {
    const container = document.createElement("div");
    container.className = "latex-result";
    container.dataset.latexCode = code;
    const status = container.createEl("div", { cls: "latex-status" });
    status.setText(this.t("Rendering LaTeX with local TeX..."));
    status.addClass("latex-loading");
    return container;
  }
  async fillContainer(container, code) {
    const status = container.querySelector(".latex-status");
    try {
      const svg = await this.renderer.render(code);
      status == null ? void 0 : status.remove();
      const figure = container.createEl("div", { cls: "latex-figure" });
      figure.appendChild((0, import_obsidian3.sanitizeHTMLToDom)(svg));
    } catch (e) {
      status == null ? void 0 : status.remove();
      const errBox = container.createEl("div", { cls: "latex-error" });
      errBox.createEl("div", {
        text: this.t("LaTeX rendering error"),
        cls: "latex-error-title"
      });
      errBox.createEl("pre", {
        text: e instanceof Error ? e.message : String(e),
        cls: "latex-error-msg"
      });
    }
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
function migrateSettings(data) {
  if (!data) return {};
  const out = { ...data };
  const keys = {
    tikzEnabled: "enabled",
    tikzEngine: "engine",
    tikzLatexBin: "latexBin",
    tikzDvisvgmBin: "dvisvgmBin",
    tikzExtraPreamble: "extraPreamble",
    tikzLivePreview: "livePreview",
    tikzShellEscape: "shellEscape"
  };
  for (const [oldKey, newKey] of Object.entries(keys)) {
    if (oldKey in out) {
      if (!(newKey in out)) out[newKey] = out[oldKey];
      delete out[oldKey];
    }
  }
  return out;
}
