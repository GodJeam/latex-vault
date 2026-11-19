import { Plugin, sanitizeHTMLToDom } from "obsidian";
import { LatexRenderer } from "./renderer";
import { livePreviewExtension } from "./livePreview";
import { DEFAULT_SETTINGS, LatexSettingTab, LatexSettings } from "./settings";
import { translate } from "./i18n";
import { LANGUAGE_SELECTOR } from "./languages";

export default class LatexVaultPlugin extends Plugin {
  settings!: LatexSettings;
  renderer!: LatexRenderer;

  async onload(): Promise<void> {
    const { data, fromLegacyPlugin } = await this.loadLegacyAwareData();
    const { settings: migrated, changed } = migrateSettings(data);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
    if (fromLegacyPlugin || changed) {
      await this.saveSettings();
    }

    this.renderer = new LatexRenderer(this);
    // Drop stale/oversized cached renders asynchronously once Obsidian layout is ready.
    this.app.workspace.onLayoutReady(() => {
      void this.renderer.cleanupCache();
    });

    this.registerEditorExtension(livePreviewExtension(this));

    this.registerMarkdownPostProcessor(
      async (el) => {
        if (!this.settings.enabled) return;
        try {
          const candidates = Array.from(
            el.querySelectorAll<HTMLElement>(LANGUAGE_SELECTOR)
          );
          const jobs: Array<{ container: HTMLElement; code: string }> = [];
          for (const codeEl of candidates) {
            const pre = codeEl.parentElement as HTMLElement | null;
            if (!pre) continue;
            const code = codeEl.textContent ?? "";
            const container = this.buildContainer();
            pre.replaceWith(container);
            jobs.push({ container, code });
          }
          await Promise.all(
            jobs.map(({ container, code }) =>
              this.fillContainer(container, code).catch((e) => {
                console.error("latex-vault: error in the LaTeX post-processor:", e);
              })
            )
          );
        } catch (e) {
          console.error("latex-vault: error in the LaTeX post-processor:", e);
        }
      },
      -1000
    );

    this.addSettingTab(new LatexSettingTab(this.app, this));
  }

  onunload(): void {
    this.renderer?.destroy();
  }

  // Settings of the plugin, falling back to the data of the old "tikz-vault"
  // plugin id so that renaming the plugin does not lose the configuration.
  private async loadLegacyAwareData(): Promise<{
    data: Record<string, unknown> | null;
    fromLegacyPlugin: boolean;
  }> {
    const data = await this.loadData();
    if (data) return { data, fromLegacyPlugin: false };
    const legacy = `${this.app.vault.configDir}/plugins/tikz-vault/data.json`;
    try {
      if (await this.app.vault.adapter.exists(legacy)) {
        return {
          data: JSON.parse(await this.app.vault.adapter.read(legacy)),
          fromLegacyPlugin: true,
        };
      }
    } catch (e) {
      console.error("latex-vault: cannot read legacy tikz-vault settings:", e);
    }
    return { data: null, fromLegacyPlugin: false };
  }

  // Translate a UI string according to the selected language.
  t(text: string): string {
    return translate(this.settings?.language ?? "en", text);
  }

  private buildContainer(): HTMLElement {
    const container = document.createElement("div");
    container.className = "latex-result";
    const status = container.createEl("div", { cls: "latex-status" });
    status.setText(this.t("Rendering LaTeX with local TeX..."));
    status.addClass("latex-loading");
    return container;
  }

  private async fillContainer(container: HTMLElement, code: string): Promise<void> {
    const status = container.querySelector(".latex-status") as HTMLElement | null;
    try {
      const svg = await this.renderer.render(code);
      status?.remove();
      const figure = container.createEl("div", { cls: "latex-figure" });
      figure.appendChild(sanitizeHTMLToDom(svg));
    } catch (e) {
      status?.remove();
      const errBox = container.createEl("div", { cls: "latex-error" });
      errBox.createEl("div", {
        text: this.t("LaTeX rendering error"),
        cls: "latex-error-title",
      });
      errBox.createEl("pre", {
        text: e instanceof Error ? e.message : String(e),
        cls: "latex-error-msg",
      });
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

// Map the pre-0.4 setting keys (tikzEngine, tikzLatexBin, ...) to the new ones.
export function migrateSettings(data: Record<string, unknown> | null): {
  settings: Partial<LatexSettings>;
  changed: boolean;
} {
  if (!data) return { settings: {}, changed: false };
  const out: Record<string, unknown> = { ...data };
  let changed = false;
  const keys: Record<string, string> = {
    tikzEnabled: "enabled",
    tikzEngine: "engine",
    tikzLatexBin: "latexBin",
    tikzDvisvgmBin: "dvisvgmBin",
    tikzExtraPreamble: "extraPreamble",
    tikzLivePreview: "livePreview",
    tikzShellEscape: "shellEscape",
  };
  for (const [oldKey, newKey] of Object.entries(keys)) {
    if (oldKey in out) {
      if (!(newKey in out)) out[newKey] = out[oldKey];
      delete out[oldKey];
      changed = true;
    }
  }
  return { settings: out as Partial<LatexSettings>, changed };
}
