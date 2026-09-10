import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type TikzVaultPlugin from "./main";
import type { TikzSettings } from "./settings";

export type TikzEngine = "auto" | "pdf" | "dvi";

interface EngineBuild {
  label: string;
  build: (dir: string) => Promise<void>;
}

export class TikzRenderer {
  private plugin: TikzVaultPlugin;
  private cacheDir: string;
  private inFlight = new Map<string, Promise<string>>();

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

    if (existsSync(svgFile)) {
      const cached = readFileSync(svgFile, "utf8");
      // A stale blank SVG (broken dvisvgm output) must not be served: re-render.
      if (!this.isBlankSvg(cached)) return cached;
      try {
        rmSync(svgFile, { force: true });
      } catch {
        // ignore
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

  private async doRender(
    tex: string,
    dir: string,
    svgFile: string,
    s: TikzSettings
  ): Promise<string> {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.tex"), tex, "utf8");

    const latexPdf = this.resolveLatex("pdf");
    const latexDvi = this.resolveLatex("dvi");
    const dvisvgm = this.resolveDvisvgm();

    const engines: EngineBuild[] = [];
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
        },
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
        if (!existsSync(svgFile)) {
          throw new Error(`dvisvgm did not produce any SVG (engine ${engine.label})`);
        }
        const svg = readFileSync(svgFile, "utf8");
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
            rmSync(join(dir, f), { force: true });
          } catch {
            // ignore
          }
        }
      }
    }

    throw new Error(this.buildErrorMessage(errors, dir));
  }

  clearCache(): void {
    try {
      rmSync(this.cacheDir, { recursive: true, force: true });
      mkdirSync(this.cacheDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  private buildTexSource(code: string, extraPreamble: string): string {
    const src = code.replace(/\r\n/g, "\n").trim();
    if (!src) throw new Error("The TikZ block is empty.");

    if (/\\documentclass\s*\{/.test(src)) {
      return src;
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
      .replace(/^\s*<!--[\s\S]*?-->\s*/, "")
      .trim();
  }

  // An SVG is "blank" when every drawing element is invisible (stroke-opacity
  // or fill-opacity equal to 0, or no visible stroke/fill at all). Used to
  // detect broken dvisvgm output and fall back to the next engine.
  private isBlankSvg(svg: string): boolean {
    const elRe = /<(path|rect|circle|ellipse|line|polyline|polygon|text)\b[^>]*>/gi;
    let visible = false;
    let m: RegExpExecArray | null;
    while ((m = elRe.exec(svg)) !== null) {
      const tag = m[0];
      const stroke = /stroke='([^']*)'/.exec(tag)?.[1];
      const fill = /fill='([^']*)'/.exec(tag)?.[1];
      const strokeOp = /stroke-opacity='([^']*)'/.exec(tag)?.[1];
      const fillOp = /fill-opacity='([^']*)'/.exec(tag)?.[1];
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
      ? errors.map((e, i) => `Tentativo ${i + 1}: ${e}`).join("\n\n")
      : "";
    return detail + (tail ? `\n\n--- LaTeX log ---\n${tail}` : "");
  }

  private resolveLatex(engine: "pdf" | "dvi"): string {
    const cfg = this.plugin.settings.tikzLatexBin.trim();
    if (cfg) return this.withExe(cfg);
    return this.findInPath(engine === "pdf" ? "pdflatex" : "latex") ?? "";
  }

  private resolveDvisvgm(): string {
    const cfg = this.plugin.settings.tikzDvisvgmBin.trim();
    if (cfg) return this.withExe(cfg);
    return this.findInPath("dvisvgm") ?? "";
  }

  private withExe(bin: string): string {
    if (process.platform !== "win32") return bin;
    if (bin.toLowerCase().endsWith(".exe") || bin.includes("\\") || bin.includes("/")) return bin;
    return bin + ".exe";
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
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { cwd, windowsHide: true, timeout: 120000, env: process.env },
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