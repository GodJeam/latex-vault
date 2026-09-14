import { execFile } from "child_process";
import { createHash } from "crypto";
import { promises as fsp, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type TikzVaultPlugin from "./main";
import type { TikzSettings } from "./settings";

interface EngineBuild {
  label: string;
  build: (dir: string) => Promise<void>;
}

export class TikzRenderer {
  private plugin: TikzVaultPlugin;
  private cacheDir: string;
  private inFlight = new Map<string, Promise<string>>();
  // In-memory copy of already rendered SVGs: avoids re-reading the disk (and
  // re-rendering) when the editor recomputes decorations on every keystroke.
  private memo = new Map<string, string>();
  private binCache = new Map<string, string | null>();

  constructor(plugin: TikzVaultPlugin) {
    this.plugin = plugin;
    this.cacheDir = join(tmpdir(), "tikz-vault-render");
    mkdirSync(this.cacheDir, { recursive: true });
  }

  async render(code: string): Promise<string> {
    const s = this.plugin.settings;
    const tex = this.buildTexSource(code, s.tikzExtraPreamble);
    const hash = createHash("sha256").update(tex).digest("hex").slice(0, 32);
    const dir = join(this.cacheDir, hash);
    const svgFile = join(dir, "main.svg");

    const memoized = this.memo.get(hash);
    if (memoized) return memoized;

    const cached = await this.readCache(svgFile);
    if (cached !== null) {
      this.memo.set(hash, cached);
      return cached;
    }

    const existing = this.inFlight.get(hash);
    if (existing) return existing;

    const promise = this.doRender(tex, dir, svgFile, s)
      .then((svg) => {
        this.memo.set(hash, svg);
        return svg;
      })
      .finally(() => {
        this.inFlight.delete(hash);
      });
    this.inFlight.set(hash, promise);
    return promise;
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
    if (this.isBlankSvg(cached)) {
      try {
        await fsp.rm(svgFile, { force: true });
      } catch {
        // ignore
      }
      return null;
    }
    return this.cleanSvg(cached);
  }

  private async doRender(
    tex: string,
    dir: string,
    svgFile: string,
    s: TikzSettings
  ): Promise<string> {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, "main.tex"), tex, "utf8");

    const latexPdf = this.resolveLatex("pdf");
    const latexDvi = this.resolveLatex("dvi");
    const dvisvgm = this.resolveDvisvgm();

    const engines: EngineBuild[] = [];
    if (s.tikzEngine !== "dvi" && latexPdf && dvisvgm) {
      engines.push({
        label: "pdflatex + dvisvgm",
        build: async (d) => {
          await this.run(latexPdf, this.latexArgs(), d);
          await this.run(dvisvgm, ["--pdf", "--no-fonts", "--precision=2", "main.pdf"], d);
        },
      });
    }
    if (s.tikzEngine !== "pdf" && latexDvi && dvisvgm) {
      engines.push({
        label: "latex + dvisvgm",
        build: async (d) => {
          await this.run(latexDvi, this.latexArgs(), d);
          await this.run(dvisvgm, ["--no-fonts", "--precision=2", "main.dvi"], d);
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

    const errors: string[] = [];
    for (const engine of engines) {
      try {
        await engine.build(dir);
        let svg: string;
        try {
          svg = await fsp.readFile(svgFile, "utf8");
        } catch {
          throw new Error(`dvisvgm did not produce any SVG (engine ${engine.label})`);
        }
        if (this.isBlankSvg(svg)) {
          // dvisvgm (e.g. MiKTeX 3.4.3) can emit every stroke with
          // stroke-opacity='0' when converting some pgfplots PDFs: the file
          // looks valid but nothing is visible. Treat it as a failure and let
          // the next engine (DVI) try instead.
          throw new Error(
            `dvisvgm produced an empty SVG (all strokes/fills are transparent) — engine ${engine.label}`
          );
        }
        return this.cleanSvg(svg);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        for (const f of ["main.pdf", "main.dvi"]) {
          try {
            await fsp.rm(join(dir, f), { force: true });
          } catch {
            // ignore
          }
        }
      }
    }

    throw new Error(this.buildErrorMessage(errors, dir));
  }

  // LaTeX arguments. `--disable-write18` and `--enable-installer` are MiKTeX
  // specific: TeX Live does not accept them, so they are only added on Windows
  // (where MiKTeX is the common distribution).
  private latexArgs(): string[] {
    const args = ["--interaction=nonstopmode", "--halt-on-error"];
    if (process.platform === "win32") args.push("--disable-write18", "--enable-installer");
    args.push("main.tex");
    return args;
  }

  // Wait for in-flight renders before deleting the cache, so a build that is
  // writing into a cache directory cannot fail with a missing-directory error.
  async clearCache(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
    this.memo.clear();
    try {
      rmSync(this.cacheDir, { recursive: true, force: true });
      mkdirSync(this.cacheDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  // Opportunistic cleanup: drop cached renders older than 14 days and, if the
  // cache exceeds 256 MB, remove the oldest directories first.
  cleanupCache(): void {
    const maxAgeMs = 14 * 24 * 3600 * 1000;
    const maxBytes = 256 * 1024 * 1024;
    let names: string[];
    try {
      names = readdirSync(this.cacheDir);
    } catch {
      return;
    }
    const now = Date.now();
    const dirs: { path: string; mtime: number; size: number }[] = [];
    for (const name of names) {
      const p = join(this.cacheDir, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) dirs.push({ path: p, mtime: st.mtimeMs, size: this.dirSize(p) });
      } catch {
        // ignore
      }
    }
    let total = 0;
    for (const d of dirs) {
      if (now - d.mtime > maxAgeMs) {
        try {
          rmSync(d.path, { recursive: true, force: true });
        } catch {
          // ignore
        }
      } else {
        total += d.size;
      }
    }
    if (total > maxBytes) {
      const remaining = dirs
        .filter((d) => existsSync(d.path))
        .sort((a, b) => a.mtime - b.mtime);
      for (const d of remaining) {
        if (total <= maxBytes) break;
        try {
          rmSync(d.path, { recursive: true, force: true });
          total -= d.size;
        } catch {
          // ignore
        }
      }
    }
  }

  private dirSize(dir: string): number {
    let total = 0;
    try {
      for (const name of readdirSync(dir)) {
        try {
          total += statSync(join(dir, name)).size;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return total;
  }

  private buildTexSource(code: string, extraPreamble: string): string {
    const src = code.replace(/\r\n/g, "\n").trim();
    if (!src) throw new Error("The TikZ block is empty.");

    if (/\\documentclass\s*\{/.test(src)) {
      return src;
    }

    // A block that already provides a document environment must not be wrapped
    // again: only prepend the missing class/packages.
    if (/\\begin\{document\}/.test(src)) {
      const head = ["\\documentclass[border=5pt]{standalone}"];
      if (!/\\usepackage(?:\[[^\]]*\])?\{tikz\}/.test(src)) head.push("\\usepackage{tikz}");
      const extraDoc = extraPreamble.trim();
      if (extraDoc) head.push(extraDoc);
      return head.join("\n") + "\n" + src;
    }

    const envMatch = src.match(/\\begin\{(\w+)\}/);
    let preamble = "";
    let body = src;
    if (envMatch && envMatch.index !== undefined) {
      preamble = src.slice(0, envMatch.index).trim();
      body = src.slice(envMatch.index).trim();
      const env = envMatch[1];
      if (env !== "tikzpicture" && env !== "tikzcd") {
        // environments like "axis": wrap them in a tikzpicture
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

  private cleanSvg(svg: string): string {
    return svg
      .replace(/^\s*<\?xml[^>]*\?>\s*/, "")
      .replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/, "")
      .trim();
  }

  // An SVG is "blank" when every drawing element is invisible (stroke-opacity
  // or fill-opacity equal to 0, or no visible stroke/fill at all). Used to
  // detect broken dvisvgm output and fall back to the next engine.
  private isBlankSvg(svg: string): boolean {
    const elRe = /<(path|rect|circle|ellipse|line|polyline|polygon|text)\b[^>]*>/gi;
    let visible = false;
    let m: RegExpExecArray | null;
    // dvisvgm normally emits single-quoted attributes, but accept double
    // quotes too so a valid SVG is never mistaken for a blank one.
    const attr = (tag: string, name: string): string | undefined =>
      new RegExp(`${name}=["']([^"']*)["']`).exec(tag)?.[1];
    while ((m = elRe.exec(svg)) !== null) {
      const tag = m[0];
      const stroke = attr(tag, "stroke");
      const fill = attr(tag, "fill");
      const strokeOp = attr(tag, "stroke-opacity");
      const fillOp = attr(tag, "fill-opacity");
      const strokeVisible = stroke !== undefined && stroke !== "" && stroke !== "none" && strokeOp !== "0";
      const fillVisible = fill !== undefined && fill !== "" && fill !== "none" && fillOp !== "0";
      if (strokeVisible || fillVisible) {
        visible = true;
        break;
      }
    }
    return !visible;
  }

  private buildErrorMessage(errors: string[], dir: string): string {
    const logFile = join(dir, "main.log");
    let tail = "";
    if (existsSync(logFile)) {
      const lines = readFileSync(logFile, "utf8").split(/\r?\n/);
      const errs = lines.filter(
        (l) =>
          /^!|^l\.\d+|error|Error|Undefined control sequence|File .* not found|cannot|runaway/i.test(l)
      );
      tail = (errs.length ? errs : lines).slice(-25).join("\n");
    }
    const detail = errors.length
      ? errors.map((e, i) => `${this.plugin.t("Attempt")} ${i + 1}: ${e}`).join("\n\n")
      : "";
    return detail + (tail ? `\n\n--- LaTeX log ---\n${tail}` : "");
  }

  private resolveLatex(engine: "pdf" | "dvi"): string {
    const cfg = this.plugin.settings.tikzLatexBin.trim();
    if (cfg) return this.withExe(cfg);
    return this.findInPathCached(engine === "pdf" ? "pdflatex" : "latex") ?? "";
  }

  private resolveDvisvgm(): string {
    const cfg = this.plugin.settings.tikzDvisvgmBin.trim();
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
    const dirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = join(dir, name + ext);
        if (existsSync(p)) return p;
      }
    }
    return null;
  }

  private run(bin: string, args: string[], cwd: string): Promise<void> {
    const lower = bin.toLowerCase();
    // .cmd/.bat cannot be launched by execFile on Windows without a shell.
    const shell = process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { cwd, windowsHide: true, timeout: 120000, env: process.env, shell },
        (error, _stdout, stderr) => {
          if (error) {
            const e = error as NodeJS.ErrnoException;
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
}