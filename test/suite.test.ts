import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EditorState } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import {
  LatexRenderer,
  buildLatexArgs,
  buildTexSource,
  cleanSvg,
  ensurePrivateTempDir,
  isBlankSvg,
  resolveConfiguredLatexBin,
  resolveSpawnCommand,
  restrictFilePermissions,
  scopeSvgIds,
  splitPreamble,
  stripLineComment,
  stripTexComments,
  type RendererHost,
} from "../src/renderer";
import { DEFAULT_SETTINGS, type LatexSettings } from "../src/settings";
import { migrateSettings } from "../src/main";
import { findLatexBlocks, livePreviewExtension } from "../src/livePreview";
import { IT_TRANSLATIONS, translate, type TranslationKey } from "../src/i18n";

const MOCK_TEX_BIN = resolve(process.cwd(), "test", "mock-tex.mjs");

function createMockHost(overrides?: Partial<LatexSettings>): RendererHost {
  const settings: LatexSettings = {
    ...DEFAULT_SETTINGS,
    latexBin: MOCK_TEX_BIN,
    dvisvgmBin: MOCK_TEX_BIN,
    ...overrides,
  };
  return {
    settings,
    t: (text: TranslationKey) => translate(settings.language, text),
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "latex-vault-unit-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- TeX comment & preamble helpers ---

test("stripLineComment respects escaped percent signs and line breaks", () => {
  assert.equal(stripLineComment("% full line comment"), "");
  assert.equal(stripLineComment("50\\% real % trailing comment"), "50\\% real ");
  assert.equal(stripLineComment("a \\\\% comment after linebreak"), "a \\\\");
  assert.equal(stripLineComment("a \\\\\\% literal percent"), "a \\\\\\% literal percent");
  assert.equal(stripTexComments("\\draw (0,0); % ok\n% skipped\n\\node {};"), "\\draw (0,0); \n\n\\node {};");
});

test("splitPreamble handles multi-line definitions, comments with braces, and escaped braces", () => {
  const src = [
    "% comment with an unmatched {",
    "\\usepackage{xcolor}",
    "\\newcommand{\\set}[1]{%",
    "  \\{#1\\}",
    "}",
    "\\begin{tikzpicture}",
    "\\draw (0,0) circle (1);",
    "\\end{tikzpicture}",
  ].join("\n");
  const { preamble, body } = splitPreamble(src);
  assert.ok(preamble.includes("\\usepackage{xcolor}"));
  assert.ok(preamble.includes("\\newcommand{\\set}[1]{%"));
  assert.ok(body.startsWith("\\begin{tikzpicture}"));
  assert.ok(body.endsWith("\\end{tikzpicture}"));
});

// --- buildTexSource ---

test("buildTexSource rejects empty and preamble-only blocks", () => {
  assert.throws(() => buildTexSource("   \n  ", ""), /empty/i);
  assert.throws(() => buildTexSource("% only comment\n\\usepackage{xcolor}", ""), /no document body/i);
});

test("buildTexSource leaves full documents verbatim and ignores commented documentclass", () => {
  const full = "\\documentclass{article}\n\\begin{document}Hi\\end{document}";
  assert.equal(buildTexSource(full, "\\usepackage{xcolor}"), full);

  const commented = "% \\documentclass{article}\n\\draw (0,0) -- (1,1);";
  const built = buildTexSource(commented, "");
  assert.ok(built.includes("\\documentclass[border=5pt]{standalone}"));
  assert.ok(built.includes("\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}"));
});

test("buildTexSource wraps document-only blocks without double document environment", () => {
  const src = "\\begin{document}\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n\\end{document}";
  const built = buildTexSource(src, "\\usetikzlibrary{arrows.meta}");
  assert.ok(built.startsWith("\\documentclass[border=5pt]{standalone}\n\\usepackage{tikz}\n\\usetikzlibrary{arrows.meta}\n"));
  assert.equal((built.match(/\\begin\{document\}/g) ?? []).length, 1);
});

test("buildTexSource wraps scope and pgfplots axes inside tikzpicture and auto-loads libraries", () => {
  const scopeTex = buildTexSource("\\begin{scope}[shift={(1,0)}]\n\\draw (0,0)--(1,1);\n\\end{scope}", "");
  assert.ok(scopeTex.includes("\\begin{tikzpicture}\n\\begin{scope}[shift={(1,0)}]"));

  const groupTex = buildTexSource("\\begin{groupplot}\n\\nextgroupplot\n\\end{groupplot}", "");
  assert.ok(groupTex.includes("\\usepackage{pgfplots}"));
  assert.ok(groupTex.includes("\\usepgfplotslibrary{groupplots}"));
  assert.ok(groupTex.includes("\\begin{tikzpicture}\n\\begin{groupplot}"));

  const smithTex = buildTexSource("\\begin{smithchart}\n\\end{smithchart}", "");
  assert.ok(smithTex.includes("\\usepackage{pgfplots}"));
  assert.ok(smithTex.includes("\\usepgfplotslibrary{smithchart}"));
});

test("buildTexSource does not double-wrap self-contained picture environments", () => {
  for (const env of ["tikzpicture", "tikzcd", "forest", "circuitikz", "quantikz", "karnaugh-map", "bytefield"]) {
    const tex = buildTexSource(`\\begin{${env}}\ncontent\n\\end{${env}}`, "");
    assert.ok(!tex.includes(`\\begin{tikzpicture}\n\\begin{${env}}`), `${env} must not be wrapped`);
    assert.ok(!tex.includes("varwidth"), `${env} should stay picture mode`);
  }
});

test("buildTexSource handles floats, non-picture math, siunitx v3, algorithmic conflicts, and comments", () => {
  const algoTex = buildTexSource("\\begin{algorithm}[htbp]\n\\begin{algorithmic}\n\\State $x$\n\\end{algorithmic}\n\\end{algorithm}", "");
  assert.ok(algoTex.includes("\\documentclass[border=5pt,varwidth,float]{standalone}"));
  assert.ok(algoTex.includes("\\begin{algorithm}[H]"));
  assert.ok(algoTex.includes("\\usepackage{algorithm}"));
  assert.ok(algoTex.includes("\\usepackage{algpseudocode}"));

  // Explicit algorithmic package must not also load conflicting algpseudocode
  const legacyAlgo = buildTexSource(
    "\\usepackage{algorithmic}\n\\begin{algorithmic}\n\\STATE $x$\n\\end{algorithmic}",
    ""
  );
  assert.ok(!legacyAlgo.includes("\\usepackage{algpseudocode}"));

  // siunitx v3 \qty and bracket options \num[...]
  const siTex = buildTexSource("$\\qty{5}{\\meter}$ and $\\num[round-mode=places]{1.234}$", "");
  assert.ok(siTex.includes("\\usepackage{siunitx}"));
  assert.ok(siTex.includes("varwidth"));

  // Commented-out minted must NOT auto-load minted
  const commentedMinted = buildTexSource("% \\begin{minted}{py}\n$a+b$", "");
  assert.ok(!commentedMinted.includes("\\usepackage{minted}"));
});

// --- SVG helpers ---

test("isBlankSvg ignores clipPath paths, detects transparent strokes, and accepts visible elements", () => {
  const blankWithClip =
    "<svg><defs><clipPath id='c0'><path d='M0 0H10V10Z'/></clipPath></defs>" +
    "<path stroke='#000' stroke-opacity='0' fill='none' d='M0 0L5 5'/></svg>";
  assert.equal(isBlankSvg(blankWithClip), true);

  const blankZeroFloat = "<svg><path stroke='#000' stroke-opacity='0.0' fill='none' d='M0 0'/></svg>";
  assert.equal(isBlankSvg(blankZeroFloat), true);

  const blankOverallOpacity = "<svg><rect width='10' height='10' fill='#000' opacity='0'/></svg>";
  assert.equal(isBlankSvg(blankOverallOpacity), true);

  const visibleGlyphPath = "<svg><defs><path id='g0' d='M0 0L5 5'/></defs></svg>";
  assert.equal(isBlankSvg(visibleGlyphPath), false);

  const visibleImage = "<svg><image href='data:image/png;base64,AAAA' width='10' height='10'/></svg>";
  assert.equal(isBlankSvg(visibleImage), false);
});

test("cleanSvg strips XML declaration and leading comments", () => {
  const raw = "  <?xml version='1.0'?>\n<!-- generated -->\n<!-- second -->\n<svg></svg>  ";
  assert.equal(cleanSvg(raw), "<svg></svg>");
});

// --- CLI args & binary resolution ---

test("buildLatexArgs separates TeX Live from MiKTeX flags", () => {
  assert.deepEqual(buildLatexArgs({ shellEscape: false, isMiktex: false }), [
    "--interaction=nonstopmode",
    "--halt-on-error",
    "main.tex",
  ]);
  assert.deepEqual(buildLatexArgs({ shellEscape: true, isMiktex: false }), [
    "--interaction=nonstopmode",
    "--halt-on-error",
    "--shell-escape",
    "main.tex",
  ]);
  assert.deepEqual(buildLatexArgs({ shellEscape: false, isMiktex: true }), [
    "--interaction=nonstopmode",
    "--halt-on-error",
    "--disable-write18",
    "--enable-installer",
    "main.tex",
  ]);
  assert.deepEqual(buildLatexArgs({ shellEscape: true, isMiktex: true }), [
    "--interaction=nonstopmode",
    "--halt-on-error",
    "--shell-escape",
    "--enable-write18",
    "--enable-installer",
    "main.tex",
  ]);
});

test("resolveConfiguredLatexBin locates sibling pdf/dvi binaries on POSIX and Windows", () => {
  const identity = (b: string) => b;
  const posixFiles = new Set(["/Library/TeX/texbin/pdflatex", "/Library/TeX/texbin/latex"]);
  assert.equal(
    resolveConfiguredLatexBin(
      "/Library/TeX/texbin/pdflatex",
      "dvi",
      (p) => posixFiles.has(p),
      () => null,
      identity
    ),
    "/Library/TeX/texbin/latex"
  );
  // When sibling does not exist, returns "" instead of misrunning pdflatex
  assert.equal(
    resolveConfiguredLatexBin(
      "/Library/TeX/texbin/pdflatex",
      "dvi",
      () => false,
      () => null,
      identity
    ),
    ""
  );

  const winFiles = new Set([
    "C:\\MiKTeX\\miktex\\bin\\x64\\latex.exe",
    "C:\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe",
  ]);
  assert.equal(
    resolveConfiguredLatexBin(
      "C:\\MiKTeX\\miktex\\bin\\x64\\latex.exe",
      "pdf",
      (p) => winFiles.has(p),
      () => null,
      identity
    ),
    "C:\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe"
  );

  // Custom wrapper scripts work for both engines
  assert.equal(
    resolveConfiguredLatexBin(MOCK_TEX_BIN, "dvi", () => true, () => null, identity),
    MOCK_TEX_BIN
  );
});

// --- Settings migration ---

test("migrateSettings maps legacy pre-0.4 tikz* keys without overwriting new keys", () => {
  const { settings, changed } = migrateSettings({
    tikzEnabled: false,
    tikzEngine: "dvi",
    engine: "pdf",
    tikzShellEscape: true,
  });
  assert.equal(changed, true);
  assert.equal(settings.enabled, false);
  assert.equal(settings.engine, "pdf");
  assert.equal(settings.shellEscape, true);
  assert.equal("tikzEnabled" in settings, false);

  const noop = migrateSettings({ enabled: true, engine: "auto" });
  assert.equal(noop.changed, false);
});

// --- CodeMirror block discovery & Live Preview state ---

test("findLatexBlocks finds supported fences and skips empty blocks", () => {
  const doc = [
    "# Title",
    "```latex-vault",
    "\\draw (0,0) circle (1);",
    "```",
    "```tikz",
    "   ",
    "```",
    "```pgfplots",
    "\\begin{axis}\\end{axis}",
    "```",
  ].join("\n");
  const state = EditorState.create({ doc });
  const blocks = findLatexBlocks(state);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].code, "\\draw (0,0) circle (1);");
  assert.equal(blocks[1].code, "\\begin{axis}\\end{axis}");
});

test("livePreviewExtension respects editorLivePreviewField (Source Mode)", () => {
  const doc = "```latex-vault\n\\draw (0,0) circle (1);\n```";
  const host = createMockHost();
  const fakePlugin = {
    settings: host.settings,
    renderer: new LatexRenderer(host),
    t: host.t,
  } as unknown as Parameters<typeof livePreviewExtension>[0];

  const liveField = livePreviewExtension(fakePlugin);
  const lpState = EditorState.create({
    doc,
    extensions: [editorLivePreviewField.init(() => true), liveField],
  });
  assert.ok(lpState.field(liveField).deco.size > 0);

  const srcState = EditorState.create({
    doc,
    extensions: [editorLivePreviewField.init(() => false), liveField],
  });
  assert.equal(srcState.field(liveField).deco.size, 0);
});

// --- i18n parity ---

test("every UI translation key used in src/ has an Italian entry and no stale keys exist", () => {
  const files = ["src/main.ts", "src/settings.ts", "src/renderer.ts", "src/livePreview.ts"];
  const used = new Set<string>();
  for (const f of files) {
    const content = readFileSync(resolve(process.cwd(), f), "utf8");
    for (const m of content.matchAll(/\bt\(\s*\n?\s*"((?:[^"\\]|\\.)+)"\s*\n?\s*\)/g)) {
      used.add(JSON.parse(`"${m[1]}"`) as string);
    }
  }
  assert.ok(used.size > 0);
  for (const key of used) {
    assert.ok(key in IT_TRANSLATIONS, `Missing Italian translation for: ${key}`);
  }
  for (const key of Object.keys(IT_TRANSLATIONS)) {
    assert.ok(used.has(key), `Unused Italian translation key: ${key}`);
  }
});

// --- End-to-end LatexRenderer tests with mock-tex.mjs ---

test("LatexRenderer renders SVG, caches SVG-only on disk, and hits memo synchronously", async () => {
  await withTempDir(async (cacheDir) => {
    const host = createMockHost();
    const renderer = new LatexRenderer(host, { cacheDir, maxMemoEntries: 2 });
    const code = "\\draw (0,0) circle (1);";

    assert.equal(renderer.getCached(code), null);
    const svg = await renderer.render(code);
    assert.ok(svg.startsWith("<svg "));
    assert.ok(svg.includes("data-engine='pdf'"));
    assert.equal(renderer.getCached(code), svg);

    // Only a single <hash>.svg file must remain on disk (no leftover .build-* dirs)
    const entries = await readdir(cacheDir);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].endsWith(".svg"));

    // Switching engine changes cache key and triggers a new DVI render
    host.settings.engine = "dvi";
    assert.equal(renderer.getCached(code), null);
    const dviSvg = await renderer.render(code);
    assert.ok(dviSvg.includes("data-engine='dvi'"));

    // LRU eviction with maxMemoEntries = 2
    await renderer.render("\\draw (0,0) -- (2,2);");
    assert.equal((await readdir(cacheDir)).length, 3);
    // Original PDF entry was evicted from memo when 3rd distinct render finished
    host.settings.engine = "pdf";
    assert.equal(renderer.getCached(code), null);
    renderer.destroy();
  });
});

test("LatexRenderer falls back from blank PDF SVG (with clipPath) to DVI", async () => {
  await withTempDir(async (cacheDir) => {
    const host = createMockHost({ engine: "auto" });
    const renderer = new LatexRenderer(host, { cacheDir });
    const svg = await renderer.render("% MOCK_BLANK_PDF\n\\draw (0,0) -- (1,1);");
    assert.ok(svg.includes("data-engine='dvi'"));
    renderer.destroy();
  });
});

test("LatexRenderer limits concurrent compilations via semaphore", async () => {
  await withTempDir(async (cacheDir) => {
    const traceFile = join(cacheDir, "trace.jsonl");
    const prevTrace = process.env.MOCK_TRACE_FILE;
    process.env.MOCK_TRACE_FILE = traceFile;
    try {
      const host = createMockHost({ engine: "pdf" });
      const renderer = new LatexRenderer(host, { cacheDir, maxConcurrency: 2 });
      await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          renderer.render(`% MOCK_DELAY_MS=80\n\\draw (0,0) -- (${n},1);`)
        )
      );
      const events = readFileSync(traceFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { tool: string; event?: string });
      let active = 0;
      let peak = 0;
      for (const ev of events) {
        if (ev.tool === "latex" && ev.event === "start") {
          active++;
          if (active > peak) peak = active;
        } else if (ev.tool === "latex" && (ev.event === "end" || ev.event === "fail")) {
          active--;
        }
      }
      assert.ok(peak <= 2, `Expected peak concurrency <= 2, got ${peak}`);
      renderer.destroy();
    } finally {
      if (prevTrace === undefined) delete process.env.MOCK_TRACE_FILE;
      else process.env.MOCK_TRACE_FILE = prevTrace;
    }
  });
});

test("LatexRenderer refcounted AbortSignal does not cancel shared callers and destroy aborts active work", async () => {
  await withTempDir(async (cacheDir) => {
    const host = createMockHost({ engine: "pdf" });
    const renderer = new LatexRenderer(host, { cacheDir });
    const code = "% MOCK_DELAY_MS=150\n\\draw (0,0) -- (3,3);";

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = renderer.render(code, { signal: ac1.signal });
    const p2 = renderer.render(code, { signal: ac2.signal });

    // Aborting caller 1 must not abort caller 2
    ac1.abort();
    await assert.rejects(p1, { name: "AbortError" });
    const svg = await p2;
    assert.ok(svg.startsWith("<svg "));

    // destroy() must reject active render
    const p3 = renderer.render("% MOCK_DELAY_MS=500\n\\draw (0,0) -- (4,4);");
    setTimeout(() => renderer.destroy(), 30);
    await assert.rejects(p3, { name: "AbortError" });
  });
});

test("LatexRenderer.cleanupCache prunes legacy hash dirs, stale build dirs, and expired SVGs", async () => {
  await withTempDir(async (cacheDir) => {
    const oldDate = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    const legacyDir = join(cacheDir, "0123456789abcdef0123456789abcdef");
    const staleBuild = join(cacheDir, ".build-crashed");
    const expiredSvg = join(cacheDir, "expired.svg");
    const freshSvg = join(cacheDir, "fresh.svg");

    await mkdir(legacyDir, { recursive: true });
    await mkdir(staleBuild, { recursive: true });
    await writeFile(expiredSvg, "<svg><path d='M0 0'/></svg>", "utf8");
    await writeFile(freshSvg, "<svg><path d='M0 0'/></svg>", "utf8");
    await utimes(staleBuild, oldDate, oldDate);
    await utimes(expiredSvg, oldDate, oldDate);

    const renderer = new LatexRenderer(createMockHost(), { cacheDir });
    await renderer.cleanupCache();

    const remaining = await readdir(cacheDir);
    assert.deepEqual(remaining, ["fresh.svg"]);
    renderer.destroy();
  });
});

// --- Security & 0.4.2 regression tests ---

test("scopeSvgIds prefixes defined IDs and references without touching data-id or external URLs", () => {
  const svg =
    `<svg><defs><path id='g0-65' data-id='g0-65' d='M0 0'/><clipPath id="clip0"><path d='M0 0'/></clipPath></defs>` +
    `<g id='page1' clip-path='url(#clip0)' style='mask:url("#clip0")'>` +
    `<use xlink:href='#g0-65'/><use href="#g0-65"/><a href="https://example.com#g0-65"/><use href="#unknown"/>` +
    `</g></svg>`;
  const scoped = scopeSvgIds(svg, "lv-12345678-");
  assert.ok(scoped.includes("id='lv-12345678-g0-65'"));
  assert.ok(scoped.includes("data-id='g0-65'"));
  assert.ok(scoped.includes('id="lv-12345678-clip0"'));
  assert.ok(scoped.includes("id='lv-12345678-page1'"));
  assert.ok(scoped.includes("xlink:href='#lv-12345678-g0-65'"));
  assert.ok(scoped.includes('href="#lv-12345678-g0-65"'));
  assert.ok(scoped.includes("url(#lv-12345678-clip0)"));
  assert.ok(scoped.includes('url("#lv-12345678-clip0")'));
  assert.ok(scoped.includes('href="https://example.com#g0-65"'));
  assert.ok(scoped.includes('href="#unknown"'));
  // Idempotent when applied a second time with the same prefix
  assert.equal(scopeSvgIds(scoped, "lv-12345678-"), scoped);
});

test("LatexRenderer assigns distinct scoped SVG IDs to different diagrams", async () => {
  await withTempDir(async (cacheDir) => {
    const renderer = new LatexRenderer(createMockHost(), { cacheDir });
    const svg1 = await renderer.render("\\draw (0,0) circle (1);");
    const svg2 = await renderer.render("\\draw (0,0) circle (2);");
    const id1 = svg1.match(/\sid='([^']+)'/)?.[1];
    const id2 = svg2.match(/\sid='([^']+)'/)?.[1];
    assert.ok(id1 && id1.startsWith("lv-"));
    assert.ok(id2 && id2.startsWith("lv-"));
    assert.notEqual(id1, id2);
    renderer.destroy();
  });
});

test("ensurePrivateTempDir enforces owner-only permissions and rejects symlinks", async () => {
  await withTempDir(async (root) => {
    const privateDir = join(root, "cache");
    await ensurePrivateTempDir(privateDir);
    if (process.platform !== "win32") {
      const st = await stat(privateDir);
      assert.equal(st.mode & 0o777, 0o700);
    }

    const filePath = join(privateDir, "sample.svg");
    await writeFile(filePath, "<svg/>", "utf8");
    await restrictFilePermissions(filePath);
    if (process.platform !== "win32") {
      const fst = await stat(filePath);
      assert.equal(fst.mode & 0o777, 0o600);
    }

    if (process.platform !== "win32") {
      const target = join(root, "real-dir");
      const link = join(root, "symlink-cache");
      await mkdir(target, { recursive: true });
      await symlink(target, link);
      await assert.rejects(() => ensurePrivateTempDir(link), /Unsafe cache directory/);
    }
  });
});

test("resolveSpawnCommand blocks .cmd/.bat on Windows and wraps JS scripts with node", () => {
  assert.throws(
    () => resolveSpawnCommand("C:\\MiKTeX\\pdflatex.cmd", ["main.tex"], "win32"),
    /cannot be run safely/i
  );
  assert.throws(
    () => resolveSpawnCommand("C:\\MiKTeX\\dvisvgm.bat", ["main.pdf"], "win32"),
    /cannot be run safely/i
  );
  const winJs = resolveSpawnCommand("C:\\repo\\test\\mock-tex.mjs", ["--version"], "win32");
  assert.equal(winJs.command, process.execPath);
  assert.deepEqual(winJs.args, ["C:\\repo\\test\\mock-tex.mjs", "--version"]);

  const winExe = resolveSpawnCommand("C:\\MiKTeX\\pdflatex.exe", ["main.tex"], "win32");
  assert.equal(winExe.command, "C:\\MiKTeX\\pdflatex.exe");
  assert.deepEqual(winExe.args, ["main.tex"]);

  const linuxBin = resolveSpawnCommand("/usr/bin/pdflatex", ["main.tex"], "linux");
  assert.equal(linuxBin.command, "/usr/bin/pdflatex");
});

test("migrateSettings rejects invalid types, unknown keys, and null bytes in binary paths", () => {
  const { settings, changed } = migrateSettings({
    language: "de",
    engine: "xelatex",
    enabled: "yes",
    livePreview: 1,
    shellEscape: "true",
    latexBin: "/usr/bin/pdflatex\0evil",
    dvisvgmBin: "  /usr/bin/dvisvgm  ",
    extraPreamble: 42,
    unexpectedKey: "drop-me",
  });
  assert.equal(changed, true);
  assert.equal(settings.language, DEFAULT_SETTINGS.language);
  assert.equal(settings.engine, DEFAULT_SETTINGS.engine);
  assert.equal(settings.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(settings.livePreview, DEFAULT_SETTINGS.livePreview);
  assert.equal(settings.shellEscape, DEFAULT_SETTINGS.shellEscape);
  assert.equal(settings.latexBin, "");
  assert.equal(settings.dvisvgmBin, "/usr/bin/dvisvgm");
  assert.equal(settings.extraPreamble, "");
  assert.equal("unexpectedKey" in settings, false);

  const fromArray = migrateSettings(["corrupted"]);
  assert.equal(fromArray.changed, true);
  assert.deepEqual(fromArray.settings, DEFAULT_SETTINGS);
});

test("findLatexBlocks ignores nested fences and supports 4-backtick and tilde fences", () => {
  const doc = [
    "````markdown",
    "```latex-vault",
    "\\draw (0,0) -- (1,1);",
    "```",
    "````",
    "~~~markdown",
    "```tikz",
    "\\draw (0,0) circle (1);",
    "```",
    "~~~",
    "Inline ```latex-vault``` not a fence",
    "~~~latex-vault",
    "\\draw (0,0) -- (2,2);",
    "~~~",
    "````tikz",
    "\\draw (0,0) circle (3);",
    "````",
  ].join("\n");
  const state = EditorState.create({ doc });
  const blocks = findLatexBlocks(state);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].code, "\\draw (0,0) -- (2,2);");
  assert.equal(blocks[1].code, "\\draw (0,0) circle (3);");
});

test("LatexRenderer.testRender bypasses disk and memory cache and detects broken binaries", async () => {
  await withTempDir(async (cacheDir) => {
    const host = createMockHost();
    const renderer = new LatexRenderer(host, { cacheDir });
    const code = "\\draw (0,0) -- (1,0);";

    // Populate normal cache first
    await renderer.render(code);
    assert.ok(renderer.getCached(code) !== null);

    // testRender succeeds and reports the engine label
    const res = await renderer.testRender(code);
    assert.equal(res.engine, "pdflatex + dvisvgm");
    assert.ok(res.svg.startsWith("<svg "));

    // Breaking latexBin must fail testRender even though the code is cached
    host.settings.latexBin = join(cacheDir, "nonexistent-pdflatex");
    await assert.rejects(() => renderer.testRender(code));
    renderer.destroy();
  });
});
