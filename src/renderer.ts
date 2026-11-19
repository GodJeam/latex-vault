import { execFile, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import { accessSync, constants as fsConstants, promises as fsp, statSync } from "fs";
import { cpus, tmpdir } from "os";
import { join } from "path";
import type { LatexSettings } from "./settings";

export interface RendererHost {
  settings: LatexSettings;
  t: (text: string) => string;
}

export interface RenderOptions {
  signal?: AbortSignal;
}

export interface RendererOptions {
  cacheDir?: string;
  maxConcurrency?: number;
  maxMemoEntries?: number;
}

interface EngineBuild {
  label: string;
  build: (dir: string) => Promise<void>;
}

interface InFlightEntry {
  promise: Promise<string>;
  controller: AbortController;
  refs: number;
}

const DEFAULT_MAX_MEMO_ENTRIES = 200;
const CACHE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const STALE_BUILD_DIR_AGE_MS = 3600 * 1000;
const EXEC_TIMEOUT_MS = 120_000;
const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const LEGACY_HASH_DIR_RE = /^[0-9a-f]{32}$/;

// Environments that produce a picture on their own and must NOT be nested in
// another tikzpicture.
const PICTURE_ENVS = new Set([
  "tikzpicture",
  "tikzcd",
  "forest",
  "circuitikz",
  "quantikz",
  "karnaugh-map",
  "bytefield",
]);

// TikZ / pgfplots inner environments that require a surrounding tikzpicture.
const TIKZ_INNER_ENVS = new Set([
  "scope",
  "axis",
  "semilogxaxis",
  "semilogyaxis",
  "loglogaxis",
  "polaraxis",
  "groupplot",
  "ternaryaxis",
  "smithchart",
]);

// Bare TikZ drawing commands (block without any environment).
const TIKZ_CMD =
  /^\\(draw|node|path|fill|filldraw|shade|shadedraw|coordinate|foreach|matrix|pic|clip|graph|useasboundingbox|tikzset)\b/;

// Packages loaded automatically when their environments/commands appear.
const AUTO_PACKAGES: [RegExp, string][] = [
  [/\\begin\{tikzcd\}/, "tikz-cd"],
  [/\\begin\{forest\}/, "forest"],
  [/\\begin\{circuitikz\}/, "circuitikz"],
  [/\\begin\{quantikz\}/, "quantikz"],
  [/\\begin\{karnaugh-map\}/, "karnaugh-map"],
  [/\\begin\{bytefield\}/, "bytefield"],
  [/\\begin\{[pbBvV]?Nice(Matrix|Array|Tabular)\}/, "nicematrix"],
  [/\\begin\{blockarray\}/, "blkarray"],
  [/\\begin\{lstlisting\}|\\lstinline/, "listings"],
  [/\\begin\{minted\}|\\mintinline/, "minted"],
  [/\\begin\{tcolorbox\}/, "tcolorbox"],
  [/\\(dv|pdv|bra|ket|braket)\b/, "physics"],
  [/\\(mathclap|coloneqq|xrightarrow|prescript|DeclarePairedDelimiter)\b/, "mathtools"],
  [/\\cancel(to)?\b/, "cancel"],
  [/\\(SI|si|num|unit|qty|qtyrange|numrange|ang)\s*[\[{]/, "siunitx"],
];

// pgfplots libraries required by specific plot environments.
const PGFPLOTS_LIBS: [RegExp, string][] = [
  [/\\begin\{groupplot\}/, "groupplots"],
  [/\\begin\{polaraxis\}/, "polar"],
  [/\\begin\{ternaryaxis\}/, "ternary"],
  [/\\begin\{smithchart\}/, "smithchart"],
];

const PREAMBLE_LINE_RE =
  /^\s*(%.*|\\(usepackage|RequirePackage|usetikzlibrary|usepgfplotslibrary|usepgflibrary|pgfplotsset|tikzset|ctikzset|newcommand|renewcommand|providecommand|NewDocumentCommand|DeclareMathOperator|DeclarePairedDelimiter|def|let|definecolor|colorlet|lstset|lstdefinestyle|lstdefinelanguage|setminted|usemintedstyle|tcbuselibrary|tcbset|forestset|sisetup|NiceMatrixOptions|algrenewcommand|algnewcommand|algdef|newtheorem|tikzcdset|usetkzobj|tkzSetUpPoint)\b.*)?$/;

const SVG_IGNORED_CONTAINERS_RE =
  /<(clipPath|mask|title|desc|metadata)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SVG_EL_RE =
  /<(path|rect|circle|ellipse|line|polyline|polygon|text|image)\b[^>]*>/gi;
const ATTR_STROKE_RE = /(?:^|\s)stroke=["']([^"']*)["']/i;
const ATTR_FILL_RE = /(?:^|\s)fill=["']([^"']*)["']/i;
const ATTR_STROKE_OP_RE = /(?:^|\s)stroke-opacity=["']([^"']*)["']/i;
const ATTR_FILL_OP_RE = /(?:^|\s)fill-opacity=["']([^"']*)["']/i;
const ATTR_OP_RE = /(?:^|\s)opacity=["']([^"']*)["']/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeAbortError(): Error {
  const err = new Error("LaTeX rendering aborted.");
  err.name = "AbortError";
  return err;
}

/** Strip an unescaped `%` TeX comment from a single line. */
export function stripLineComment(line: string): string {
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      escaped = !escaped;
    } else if (ch === "%" && !escaped) {
      return line.slice(0, i);
    } else {
      escaped = false;
    }
  }
  return line;
}

export function stripTexComments(src: string): string {
  return src.split("\n").map(stripLineComment).join("\n");
}

function countUnescapedBraces(line: string): number {
  const clean = stripLineComment(line);
  let delta = 0;
  let escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "\\") {
      escaped = !escaped;
    } else if (!escaped && ch === "{") {
      delta++;
    } else if (!escaped && ch === "}") {
      delta--;
    } else {
      escaped = false;
    }
  }
  return delta;
}

// Leading lines made of preamble-only commands (packages, libraries, macro
// definitions, comments) become the preamble; the rest is the body.
export function splitPreamble(src: string): { preamble: string; body: string } {
  const lines = src.split("\n");
  let i = 0;
  let depth = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (depth === 0 && !PREAMBLE_LINE_RE.test(line)) break;
    // Keep multi-line definitions (unbalanced braces) in the preamble while
    // ignoring comments and escaped braces (\{ and \}).
    depth += countUnescapedBraces(line);
    if (depth < 0) depth = 0;
    i++;
  }
  return {
    preamble: lines.slice(0, i).join("\n").trim(),
    body: lines.slice(i).join("\n").trim(),
  };
}

export function buildTexSource(code: string, extraPreamble: string): string {
  const src = code.replace(/\r\n/g, "\n").trim();
  if (!src) throw new Error("The LaTeX block is empty.");

  const srcNoComments = stripTexComments(src);

  if (/\\documentclass\s*[\[{]/.test(srcNoComments)) {
    return src;
  }

  // A block that already provides a document environment must not be wrapped
  // again: only prepend the missing class/packages.
  if (/\\begin\{document\}/.test(srcNoComments)) {
    const head = ["\\documentclass[border=5pt]{standalone}"];
    if (!/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\btikz\b[^}]*\}/.test(srcNoComments)) {
      head.push("\\usepackage{tikz}");
    }
    const extraDoc = extraPreamble.trim();
    if (extraDoc) head.push(extraDoc);
    return head.join("\n") + "\n" + src;
  }

  const { preamble, body: rawBody } = splitPreamble(src);
  if (!rawBody) throw new Error("The LaTeX block has no document body.");

  let body = rawBody;
  let picture = true;
  let float = false;

  // Floats (algorithm, figure, table) cannot float in a standalone page:
  // force the [H] placement and enable the class "float" option.
  const floatMatch = body.match(/^\\begin\{(algorithm|figure|table)\}(\[[^\]]*\])?/);
  if (floatMatch) {
    float = true;
    body = `\\begin{${floatMatch[1]}}[H]` + body.slice(floatMatch[0].length);
  }

  const envMatch = body.match(/^\\begin\{([\w*-]+)\}/);
  if (envMatch) {
    const env = envMatch[1];
    if (TIKZ_INNER_ENVS.has(env)) {
      // TikZ scopes and pgfplots axes must live inside a tikzpicture
      body = "\\begin{tikzpicture}\n" + body + "\n\\end{tikzpicture}";
    } else if (!PICTURE_ENVS.has(env)) {
      // matrices, algorithms, listings, align, ...: typeset as text
      picture = false;
    }
  } else if (/^\\tikz\s*[{\[]/.test(body)) {
    // inline \tikz command: leave as is
  } else if (TIKZ_CMD.test(body)) {
    body = "\\begin{tikzpicture}\n" + body + "\n\\end{tikzpicture}";
  } else {
    // plain math/text such as \[ ... \] or $...$
    picture = false;
  }

  const userPreNoComments = stripTexComments(preamble + "\n" + extraPreamble);
  const has = (pkg: string) =>
    new RegExp(
      `\\\\(?:usepackage|RequirePackage)(?:\\[[^\\]]*\\])?\\{[^}]*\\b${escapeRegExp(pkg)}\\b[^}]*\\}`
    ).test(userPreNoComments);

  const classOpts = ["border=5pt"];
  if (!picture) classOpts.push("varwidth");
  if (float) classOpts.push("float");
  const parts = [`\\documentclass[${classOpts.join(",")}]{standalone}`];
  const add = (pkg: string, opts = "") => {
    if (!has(pkg)) parts.push(`\\usepackage${opts}{${pkg}}`);
  };
  add("amsmath");
  add("amssymb");
  add("tikz");
  if (float) {
    if (/^\\begin\{algorithm\}/.test(body)) {
      // algorithm2e provides its own float; otherwise use algorithm + algpseudocode
      if (!has("algorithm2e")) add("algorithm");
    } else {
      add("float"); // [H] for figure/table
    }
  }
  // Avoid loading algpseudocode when the user explicitly chose the older
  // algorithmic or algorithmicx packages, which define conflicting commands.
  if (
    /\\begin\{algorithmic\}/.test(srcNoComments) &&
    !has("algorithmic") &&
    !has("algorithmicx")
  ) {
    add("algpseudocode");
  }
  for (const [re, pkg] of AUTO_PACKAGES) {
    if (re.test(srcNoComments)) add(pkg);
  }
  const needsPgfplots =
    /(\\begin\{(?:\w*axis|groupplot|smithchart)\}|\\addplot)/.test(srcNoComments);
  if (needsPgfplots) {
    if (!has("pgfplots")) {
      parts.push("\\usepackage{pgfplots}", "\\pgfplotsset{compat=1.18}");
    }
    for (const [re, lib] of PGFPLOTS_LIBS) {
      if (
        re.test(srcNoComments) &&
        !new RegExp(`\\\\usepgfplotslibrary\\{[^}]*\\b${escapeRegExp(lib)}\\b[^}]*\\}`).test(
          userPreNoComments
        )
      ) {
        parts.push(`\\usepgfplotslibrary{${lib}}`);
      }
    }
  }
  const extra = extraPreamble.trim();
  if (extra) parts.push(extra);
  if (preamble) parts.push(preamble);
  parts.push("\\begin{document}", body, "\\end{document}");
  return parts.join("\n");
}

export function cleanSvg(svg: string): string {
  return svg
    .replace(/^\s*<\?xml[^>]*\?>\s*/, "")
    .replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/, "")
    .trim();
}

function isZeroOpacity(val: string | undefined): boolean {
  if (val === undefined) return false;
  const n = Number.parseFloat(val);
  return Number.isFinite(n) && n === 0;
}

// An SVG is "blank" when every drawing element is invisible (stroke-opacity
// or fill-opacity equal to 0, or no visible stroke/fill at all). Used to
// detect broken dvisvgm output and fall back to the next engine.
export function isBlankSvg(svg: string): boolean {
  const scannable = svg.replace(SVG_IGNORED_CONTAINERS_RE, "");
  for (const m of scannable.matchAll(SVG_EL_RE)) {
    const tag = m[0];
    const tagName = m[1].toLowerCase();
    const op = ATTR_OP_RE.exec(tag)?.[1];
    if (isZeroOpacity(op)) continue;
    if (tagName === "image") return false;

    const stroke = ATTR_STROKE_RE.exec(tag)?.[1];
    const fill = ATTR_FILL_RE.exec(tag)?.[1];
    const strokeOp = ATTR_STROKE_OP_RE.exec(tag)?.[1];
    const fillOp = ATTR_FILL_OP_RE.exec(tag)?.[1];
    const strokeVisible =
      stroke !== undefined && stroke !== "" && stroke !== "none" && !isZeroOpacity(strokeOp);
    // A path without a fill attribute is filled black by default (this is how
    // dvisvgm emits text glyphs with --no-fonts), so it counts as visible.
    const fillVisible = fill !== "" && fill !== "none" && !isZeroOpacity(fillOp);
    if (strokeVisible || fillVisible) {
      return false;
    }
  }
  return true;
}

/**
 * Build CLI arguments for latex/pdflatex. `--disable-write18`, `--enable-write18`,
 * and `--enable-installer` are MiKTeX-specific; TeX Live (even on Windows)
 * rejects `--enable-installer`.
 */
export function buildLatexArgs(options: {
  shellEscape: boolean;
  isMiktex: boolean;
}): string[] {
  const args = ["--interaction=nonstopmode", "--halt-on-error"];
  if (options.shellEscape) args.push("--shell-escape");
  if (options.isMiktex) {
    args.push(
      options.shellEscape ? "--enable-write18" : "--disable-write18",
      "--enable-installer"
    );
  }
  args.push("main.tex");
  return args;
}

/**
 * Resolve a configured `latexBin` setting for the requested `"pdf"` or `"dvi"`
 * engine. When the user points `latexBin` to `pdflatex` (or `latex`), look for
 * its sibling binary (`latex` or `pdflatex`) for the other engine instead of
 * invoking the wrong engine and failing on missing output files.
 */
export function resolveConfiguredLatexBin(
  cfg: string,
  engine: "pdf" | "dvi",
  fileExists: (p: string) => boolean,
  findInPath: (name: string) => string | null,
  withExe: (bin: string) => string
): string {
  const sepIdx = Math.max(cfg.lastIndexOf("/"), cfg.lastIndexOf("\\"));
  const hasDir = sepIdx >= 0;
  const dir = hasDir ? cfg.slice(0, sepIdx) : "";
  const sep = hasDir ? cfg[sepIdx] : "";
  const base = hasDir ? cfg.slice(sepIdx + 1) : cfg;
  const dotIdx = base.lastIndexOf(".");
  const ext = dotIdx > 0 ? base.slice(dotIdx) : "";
  const stem = (dotIdx > 0 ? base.slice(0, dotIdx) : base).toLowerCase();

  const targetStem = engine === "pdf" ? "pdflatex" : "latex";
  if (stem === "pdflatex" || stem === "latex") {
    if (stem === targetStem) return withExe(cfg);
    if (hasDir) {
      const sibling = `${dir}${sep}${targetStem}${ext}`;
      return fileExists(sibling) ? sibling : "";
    }
    return findInPath(targetStem) ?? "";
  }

  return withExe(cfg);
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== "win32") {
      accessSync(p, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function getFallbackTexDirs(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") {
    return ["/Library/TeX/texbin", "/usr/texbin", "/opt/homebrew/bin", "/usr/local/bin"];
  }
  if (platform === "win32") {
    const dirs: string[] = [];
    if (process.env.LOCALAPPDATA) {
      dirs.push(join(process.env.LOCALAPPDATA, "Programs", "MiKTeX", "miktex", "bin", "x64"));
    }
    dirs.push(
      "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
      "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin"
    );
    return dirs;
  }
  return ["/usr/local/bin", "/usr/bin"];
}

export class LatexRenderer {
  private plugin: RendererHost;
  private cacheDir: string;
  private maxConcurrency: number;
  private maxMemoEntries: number;
  private inFlight = new Map<string, InFlightEntry>();
  // Bounded LRU in-memory copy of already rendered SVGs: avoids re-reading disk
  // when the editor recomputes decorations on keystrokes.
  private memo = new Map<string, string>();
  private binCache = new Map<string, string | null>();
  private miktexCache = new Map<string, boolean>();
  private activeProcs = new Set<ChildProcess>();
  private running = 0;
  private waitQueue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    cleanup: () => void;
  }> = [];
  private disposed = false;

  constructor(plugin: RendererHost, options?: RendererOptions) {
    this.plugin = plugin;
    this.cacheDir = options?.cacheDir ?? join(tmpdir(), "latex-vault-render");
    const defaultConcurrency = Math.min(
      4,
      Math.max(1, Math.floor((cpus().length || 2) / 2))
    );
    this.maxConcurrency = Math.max(1, options?.maxConcurrency ?? defaultConcurrency);
    this.maxMemoEntries = Math.max(1, options?.maxMemoEntries ?? DEFAULT_MAX_MEMO_ENTRIES);
  }

  private computeHash(tex: string, s: LatexSettings): string {
    return createHash("sha256")
      .update(`${s.engine}\0${s.shellEscape ? "1" : "0"}\0${tex}`)
      .digest("hex")
      .slice(0, 32);
  }

  private memoGet(hash: string): string | null {
    const value = this.memo.get(hash);
    if (value === undefined) return null;
    // Refresh recency for LRU eviction.
    this.memo.delete(hash);
    this.memo.set(hash, value);
    return value;
  }

  private memoSet(hash: string, svg: string): void {
    if (this.memo.has(hash)) {
      this.memo.delete(hash);
    }
    this.memo.set(hash, svg);
    while (this.memo.size > this.maxMemoEntries) {
      const oldest = this.memo.keys().next().value;
      if (oldest === undefined) break;
      this.memo.delete(oldest);
    }
  }

  invalidateBinCache(): void {
    this.binCache.clear();
    this.miktexCache.clear();
  }

  // Synchronous in-memory cache lookup so Live Preview widgets can render
  // immediately without flashing a loading state.
  getCached(code: string): string | null {
    try {
      const s = this.plugin.settings;
      const tex = buildTexSource(code, s.extraPreamble);
      return this.memoGet(this.computeHash(tex, s));
    } catch {
      return null;
    }
  }

  async render(code: string, options?: RenderOptions): Promise<string> {
    if (this.disposed) throw makeAbortError();
    const signal = options?.signal;
    if (signal?.aborted) throw makeAbortError();

    const s = this.plugin.settings;
    const tex = buildTexSource(code, s.extraPreamble);
    const hash = this.computeHash(tex, s);
    const svgFile = join(this.cacheDir, `${hash}.svg`);

    const memoized = this.memoGet(hash);
    if (memoized !== null) return memoized;

    const cached = await this.readCache(svgFile);
    if (signal?.aborted) throw makeAbortError();
    if (cached !== null) {
      this.memoSet(hash, cached);
      return cached;
    }

    let entry = this.inFlight.get(hash);
    if (!entry) {
      const controller = new AbortController();
      const promise = this.doRender(tex, svgFile, s, controller.signal)
        .then((svg) => {
          this.memoSet(hash, svg);
          return svg;
        })
        .finally(() => {
          this.inFlight.delete(hash);
        });
      entry = { promise, controller, refs: 0 };
      this.inFlight.set(hash, entry);
    }

    entry.refs++;
    const currentEntry = entry;
    return this.awaitWithAbort(currentEntry, signal);
  }

  private awaitWithAbort(entry: InFlightEntry, signal?: AbortSignal): Promise<string> {
    if (!signal) {
      return entry.promise.finally(() => {
        entry.refs = Math.max(0, entry.refs - 1);
      });
    }
    if (signal.aborted) {
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0) entry.controller.abort();
      return Promise.reject(makeAbortError());
    }
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        entry.refs = Math.max(0, entry.refs - 1);
        if (entry.refs === 0) entry.controller.abort();
        reject(makeAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (svg) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          entry.refs = Math.max(0, entry.refs - 1);
          resolve(svg);
        },
        (err) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          entry.refs = Math.max(0, entry.refs - 1);
          reject(err);
        }
      );
    });
  }

  private acquireSlot(signal?: AbortSignal): Promise<void> {
    if (this.disposed || signal?.aborted) {
      return Promise.reject(makeAbortError());
    }
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const item = {
        resolve: () => {
          item.cleanup();
          resolve();
        },
        reject: (err: Error) => {
          item.cleanup();
          reject(err);
        },
        cleanup: () => {
          if (signal) signal.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = () => {
        const idx = this.waitQueue.indexOf(item);
        if (idx >= 0) this.waitQueue.splice(idx, 1);
        item.reject(makeAbortError());
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.waitQueue.push(item);
    });
  }

  private releaseSlot(): void {
    while (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) {
        next.resolve();
        return;
      }
    }
    this.running = Math.max(0, this.running - 1);
  }

  // Read a cached SVG asynchronously so the UI thread is not blocked. A stale
  // blank SVG (broken dvisvgm output) is discarded so it gets re-rendered.
  private async readCache(svgFile: string): Promise<string | null> {
    let cached: string;
    try {
      cached = await fsp.readFile(svgFile, "utf8");
    } catch {
      return null;
    }
    if (isBlankSvg(cached)) {
      await fsp.rm(svgFile, { force: true }).catch(() => {});
      return null;
    }
    // Refresh mtime on hit so active diagrams do not expire as stale.
    const now = new Date();
    void fsp.utimes(svgFile, now, now).catch(() => {});
    return cleanSvg(cached);
  }

  private async doRender(
    tex: string,
    cacheSvgFile: string,
    s: LatexSettings,
    signal: AbortSignal
  ): Promise<string> {
    await this.acquireSlot(signal);
    let buildDir: string | null = null;
    try {
      if (signal.aborted) throw makeAbortError();

      const latexPdf = this.resolveLatex("pdf");
      const latexDvi = this.resolveLatex("dvi");
      const dvisvgm = this.resolveDvisvgm();

      const engines: EngineBuild[] = [];
      if (s.engine !== "dvi" && latexPdf && dvisvgm) {
        engines.push({
          label: "pdflatex + dvisvgm",
          build: async (d) => {
            const args = await this.latexArgs(latexPdf);
            await this.run(latexPdf, args, d, signal);
            await this.run(
              dvisvgm,
              ["--pdf", "--no-fonts=1", "--precision=2", "main.pdf"],
              d,
              signal
            );
          },
        });
      }
      if (s.engine !== "pdf" && latexDvi && dvisvgm) {
        engines.push({
          label: "latex + dvisvgm",
          build: async (d) => {
            const args = await this.latexArgs(latexDvi);
            await this.run(latexDvi, args, d, signal);
            await this.run(
              dvisvgm,
              ["--no-fonts=1", "--precision=2", "main.dvi"],
              d,
              signal
            );
          },
        });
      }

      if (engines.length === 0) {
        const missing: string[] = [];
        if (!latexPdf && !latexDvi) missing.push("latex/pdflatex");
        if (!dvisvgm) missing.push("dvisvgm");
        throw new Error(
          `Binary ${missing.join(" and ")} not found. Check the TeX installation or set the paths in the plugin settings.`
        );
      }

      await fsp.mkdir(this.cacheDir, { recursive: true });
      buildDir = await fsp.mkdtemp(join(this.cacheDir, ".build-"));
      await fsp.writeFile(join(buildDir, "main.tex"), tex, "utf8");
      const outSvgFile = join(buildDir, "main.svg");

      const errors: string[] = [];
      for (const engine of engines) {
        if (signal.aborted) throw makeAbortError();
        try {
          await engine.build(buildDir);
          let svg: string;
          try {
            svg = await fsp.readFile(outSvgFile, "utf8");
          } catch {
            throw new Error(`dvisvgm did not produce any SVG (engine ${engine.label})`);
          }
          if (isBlankSvg(svg)) {
            // dvisvgm (e.g. MiKTeX 3.4.3) can emit every stroke with
            // stroke-opacity='0' when converting some pgfplots PDFs: the file
            // looks valid but nothing is visible. Treat it as a failure and let
            // the next engine (DVI) try instead.
            throw new Error(
              `dvisvgm produced an empty SVG (all strokes/fills are transparent, engine ${engine.label})`
            );
          }
          const cleaned = cleanSvg(svg);
          await this.writeCacheAtomic(cacheSvgFile, cleaned);
          return cleaned;
        } catch (e) {
          if (signal.aborted || (e instanceof Error && e.name === "AbortError")) {
            throw makeAbortError();
          }
          errors.push(e instanceof Error ? e.message : String(e));
          for (const f of ["main.pdf", "main.dvi", "main.svg"]) {
            await fsp.rm(join(buildDir, f), { force: true }).catch(() => {});
          }
        }
      }

      throw new Error(await this.buildErrorMessage(errors, buildDir));
    } finally {
      if (buildDir) {
        await fsp.rm(buildDir, { recursive: true, force: true }).catch(() => {});
      }
      this.releaseSlot();
    }
  }

  private async writeCacheAtomic(targetFile: string, content: string): Promise<void> {
    const tmpFile = `${targetFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.writeFile(tmpFile, content, "utf8");
      await fsp.rename(tmpFile, targetFile);
    } catch {
      await fsp.rm(tmpFile, { force: true }).catch(() => {});
    }
  }

  private async isMiktexBinary(bin: string): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const cached = this.miktexCache.get(bin);
    if (cached !== undefined) return cached;
    if (/miktex/i.test(bin)) {
      this.miktexCache.set(bin, true);
      return true;
    }
    const detected = await new Promise<boolean>((resolve) => {
      const isJs = process.platform === "win32" && /\.(m?js|cjs)$/i.test(bin);
      const spawnBin = isJs ? process.execPath : bin;
      const spawnArgs = isJs ? [bin, "--version"] : ["--version"];
      execFile(
        spawnBin,
        spawnArgs,
        { windowsHide: true, timeout: 5000, env: process.env },
        (_err, stdout, stderr) => {
          resolve(/miktex/i.test(`${stdout ?? ""}\n${stderr ?? ""}`));
        }
      );
    });
    this.miktexCache.set(bin, detected);
    return detected;
  }

  private async latexArgs(bin: string): Promise<string[]> {
    const isMiktex = await this.isMiktexBinary(bin);
    return buildLatexArgs({
      shellEscape: this.plugin.settings.shellEscape,
      isMiktex,
    });
  }

  /** Abort all in-flight renders and terminate any running TeX child processes. */
  destroy(): void {
    this.disposed = true;
    for (const entry of this.inFlight.values()) {
      entry.controller.abort();
    }
    this.inFlight.clear();
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift();
      waiter?.reject(makeAbortError());
    }
    for (const proc of [...this.activeProcs]) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
    this.activeProcs.clear();
  }

  // Wait for in-flight renders before deleting the cache, so a build that is
  // writing into the cache directory cannot fail with a missing-directory error.
  async clearCache(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()].map((e) => e.promise));
    }
    this.memo.clear();
    try {
      await fsp.rm(this.cacheDir, { recursive: true, force: true });
      await fsp.mkdir(this.cacheDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  // Opportunistic async cleanup: drop cached SVGs older than 14 days, prune
  // legacy/stale build directories, and cap total cache size at 256 MB.
  async cleanupCache(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.cacheDir);
    } catch {
      return;
    }
    const now = Date.now();
    const files: { path: string; mtime: number; size: number }[] = [];
    for (const name of names) {
      const p = join(this.cacheDir, name);
      try {
        const st = await fsp.lstat(p);
        if (st.isDirectory()) {
          // Clean up pre-0.4.1 hash directories and crashed build dirs.
          const isStaleBuild =
            name.startsWith(".build-") && now - st.mtimeMs > STALE_BUILD_DIR_AGE_MS;
          if (LEGACY_HASH_DIR_RE.test(name) || isStaleBuild) {
            await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
          }
          continue;
        }
        if (st.isFile() && name.endsWith(".svg")) {
          if (now - st.mtimeMs > CACHE_MAX_AGE_MS) {
            await fsp.rm(p, { force: true }).catch(() => {});
          } else {
            files.push({ path: p, mtime: st.mtimeMs, size: st.size });
          }
        }
      } catch {
        // ignore
      }
    }

    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total > CACHE_MAX_BYTES) {
      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files) {
        if (total <= CACHE_MAX_BYTES) break;
        try {
          await fsp.rm(f.path, { force: true });
          total -= f.size;
        } catch {
          // ignore
        }
      }
    }
  }

  private async buildErrorMessage(errors: string[], dir: string): Promise<string> {
    const logFile = join(dir, "main.log");
    let tail = "";
    try {
      const rawLog = await fsp.readFile(logFile, "utf8");
      const lines = rawLog.split(/\r?\n/);
      const errs = lines.filter((l) =>
        /^!|^l\.\d+|error|Error|Undefined control sequence|File .* not found|cannot|runaway/i.test(
          l
        )
      );
      tail = (errs.length ? errs : lines).slice(-25).join("\n");
    } catch {
      // main.log may not exist if binary failed to launch
    }
    const detail = errors.length
      ? errors.map((e, i) => `${this.plugin.t("Attempt")} ${i + 1}: ${e}`).join("\n\n")
      : "";
    return detail + (tail ? `\n\n--- LaTeX log ---\n${tail}` : "");
  }

  private resolveLatex(engine: "pdf" | "dvi"): string {
    const cfg = this.plugin.settings.latexBin.trim();
    if (cfg) {
      return resolveConfiguredLatexBin(
        cfg,
        engine,
        isExecutableFile,
        (name) => this.findInPathCached(name),
        (bin) => this.withExe(bin)
      );
    }
    return this.findInPathCached(engine === "pdf" ? "pdflatex" : "latex") ?? "";
  }

  private resolveDvisvgm(): string {
    const cfg = this.plugin.settings.dvisvgmBin.trim();
    if (cfg) return this.withExe(cfg);
    return this.findInPathCached("dvisvgm") ?? "";
  }

  private withExe(bin: string): string {
    if (process.platform !== "win32") return bin;
    const lower = bin.toLowerCase();
    if (
      lower.endsWith(".exe") ||
      lower.endsWith(".cmd") ||
      lower.endsWith(".bat") ||
      bin.includes("\\") ||
      bin.includes("/")
    ) {
      return bin;
    }
    return bin + ".exe";
  }

  // Cached PATH lookup: the PATH does not change while the plugin is loaded, so
  // there is no need to scan every directory on each render.
  private findInPathCached(name: string): string | null {
    const cached = this.binCache.get(name);
    if (cached !== undefined) return cached;
    const found = this.findInPath(name);
    this.binCache.set(name, found);
    return found;
  }

  private findInPath(name: string): string | null {
    const isWin = process.platform === "win32";
    const exts = isWin ? [".exe", ".cmd", ".bat"] : [""];
    const pathDirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
    const dirs = Array.from(new Set([...pathDirs, ...getFallbackTexDirs()]));
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = join(dir, name + ext);
        if (isExecutableFile(p)) return p;
      }
    }
    return null;
  }

  private run(
    bin: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(makeAbortError());
    const lower = bin.toLowerCase();
    const isJsOnWin = process.platform === "win32" && /\.(m?js|cjs)$/i.test(bin);
    const spawnBin = isJsOnWin ? process.execPath : bin;
    const spawnArgs = isJsOnWin ? [bin, ...args] : args;
    // .cmd/.bat cannot be launched by execFile on Windows without a shell.
    const shell =
      !isJsOnWin &&
      process.platform === "win32" &&
      (lower.endsWith(".cmd") || lower.endsWith(".bat"));
    return new Promise((resolve, reject) => {
      const child = execFile(
        spawnBin,
        spawnArgs,
        {
          cwd,
          windowsHide: true,
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: EXEC_MAX_BUFFER_BYTES,
          env: process.env,
          shell,
          signal,
        },
        (error, stdout, stderr) => {
          this.activeProcs.delete(child);
          if (error) {
            const e = error as NodeJS.ErrnoException & {
              killed?: boolean;
              signal?: string | null;
            };
            if (signal?.aborted || e.name === "AbortError") {
              reject(makeAbortError());
            } else if (e.code === "ENOENT") {
              reject(new Error(`Executable not found: ${bin}`));
            } else if (e.killed && e.signal) {
              reject(
                new Error(
                  `Compilation timed out after ${Math.round(EXEC_TIMEOUT_MS / 1000)}s (${bin})`
                )
              );
            } else if (typeof e.code === "number") {
              reject(
                new Error(
                  `Error (exit code ${e.code}) from ${bin}: ${(stderr || "").trim() || stdout.trim()}`
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
      this.activeProcs.add(child);
    });
  }
}
