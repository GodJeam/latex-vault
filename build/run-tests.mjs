import esbuild from "esbuild";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { builtinModules as builtins } from "node:module";

const tmp = mkdtempSync(join(tmpdir(), "latex-vault-test-"));
const outfile = join(tmp, "suite.test.cjs");

try {
  await esbuild.build({
    entryPoints: ["test/suite.test.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: [...builtins, ...builtins.map((b) => `node:${b}`)],
    plugins: [
      {
        name: "obsidian-mock",
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({
            path: "obsidian",
            namespace: "obsidian-mock",
          }));
          build.onLoad({ filter: /.*/, namespace: "obsidian-mock" }, () => ({
            contents: `
              import { StateField } from "@codemirror/state";
              export const editorLivePreviewField = StateField.define({
                create() { return true; },
                update(v) { return v; },
              });
              export class App {}
              export class Component {}
              export class Notice {}
              export class Plugin {}
              export class PluginSettingTab {}
              export class Setting {}
              export const sanitizeHTMLToDom = (html) => ({ html });
            `,
            loader: "js",
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
    outfile,
    logLevel: "warning",
  });

  const res = spawnSync(process.execPath, ["--test", outfile], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  process.exitCode = res.status ?? 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
