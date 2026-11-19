import { MarkdownView, Notice, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { LatexRenderer } from "./renderer";
import { livePreviewExtension, recalcEffect } from "./livePreview";
import {
  DEFAULT_SETTINGS,
  LatexSettingTab,
  type DarkModeAdaptation,
  type LatexSettings,
} from "./settings";
import { translate, type TranslationKey } from "./i18n";
import { LANGUAGE_SELECTOR } from "./languages";
import { createLoadingStatus, renderErrorElement, renderSvgElement } from "./ui";

const DARK_MODE_CLASSES: Record<DarkModeAdaptation, string> = {
  auto: "latex-vault-dark-auto",
  paper: "latex-vault-dark-paper",
  none: "latex-vault-dark-none",
};

export default class LatexVaultPlugin extends Plugin {
  settings: LatexSettings = { ...DEFAULT_SETTINGS };
  renderer!: LatexRenderer;
  renderConfigVersion = 0;

  async onload(): Promise<void> {
    const { data, fromLegacyPlugin } = await this.loadLegacyAwareData();
    const { settings: migrated, changed } = migrateSettings(data);
    this.settings = migrated;
    if (fromLegacyPlugin || changed) {
      await this.saveSettings();
    }

    this.applyDarkModeClass();

    this.renderer = new LatexRenderer(this);
    // Drop stale/oversized cached renders asynchronously once Obsidian layout is ready.
    this.app.workspace.onLayoutReady(() => {
      void this.renderer.cleanupCache();
    });

    this.registerEditorExtension(livePreviewExtension(this));

    this.addCommand({
      id: "clear-cache",
      name: this.t("Clear LaTeX rendering cache"),
      callback: async () => {
        await this.renderer.clearCache();
        this.bumpRenderConfig(true);
        new Notice(this.t("LaTeX cache cleared."));
      },
    });

    this.addCommand({
      id: "toggle-live-preview",
      name: this.t("Toggle LaTeX live preview"),
      callback: async () => {
        this.settings.livePreview = !this.settings.livePreview;
        await this.saveSettings();
        this.refreshOpenViews();
        new Notice(
          this.settings.livePreview
            ? this.t("LaTeX live preview enabled.")
            : this.t("LaTeX live preview disabled.")
        );
      },
    });

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
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.remove(...Object.values(DARK_MODE_CLASSES));
    }
  }

  applyDarkModeClass(): void {
    if (typeof document === "undefined" || !document.body) return;
    document.body.classList.remove(...Object.values(DARK_MODE_CLASSES));
    document.body.classList.add(DARK_MODE_CLASSES[this.settings.darkMode]);
  }

  bumpRenderConfig(rerenderReading = false): void {
    this.renderConfigVersion++;
    this.refreshOpenViews(rerenderReading);
  }

  refreshOpenViews(rerenderReading = false): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      const cm = (leaf.view.editor as unknown as { cm?: EditorView })?.cm;
      if (cm && typeof cm.dispatch === "function") {
        cm.dispatch({ effects: recalcEffect.of(null) });
      }
      if (rerenderReading && leaf.view.previewMode) {
        leaf.view.previewMode.rerender(true);
      }
    });
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
  t(text: TranslationKey): string {
    return translate(this.settings?.language ?? "en", text);
  }

  private buildContainer(): HTMLElement {
    const container = document.createElement("div");
    container.className = "latex-result";
    container.appendChild(createLoadingStatus(this.t("Rendering LaTeX with local TeX...")));
    return container;
  }

  private async fillContainer(container: HTMLElement, code: string): Promise<void> {
    const status = container.querySelector(".latex-status") as HTMLElement | null;
    try {
      const svg = await this.renderer.render(code);
      status?.remove();
      container.appendChild(renderSvgElement(svg));
    } catch (e) {
      status?.remove();
      container.appendChild(renderErrorElement(this.t("LaTeX rendering error"), e));
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

const VALID_LANGUAGES = new Set(["en", "it"]);
const VALID_ENGINES = new Set(["auto", "pdf", "dvi"]);
const VALID_DARK_MODES = new Set(["auto", "paper", "none"]);

// Map pre-0.4 setting keys (tikzEngine, tikzLatexBin, ...) and validate every
// field loaded from data.json so corrupted values cannot break runtime behavior.
export function migrateSettings(data: unknown): {
  settings: LatexSettings;
  changed: boolean;
} {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { settings: { ...DEFAULT_SETTINGS }, changed: data !== null && data !== undefined };
  }
  const raw: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  let changed = false;
  const legacyKeys: Record<string, string> = {
    tikzEnabled: "enabled",
    tikzEngine: "engine",
    tikzLatexBin: "latexBin",
    tikzDvisvgmBin: "dvisvgmBin",
    tikzExtraPreamble: "extraPreamble",
    tikzLivePreview: "livePreview",
    tikzShellEscape: "shellEscape",
  };
  for (const [oldKey, newKey] of Object.entries(legacyKeys)) {
    if (oldKey in raw) {
      if (!(newKey in raw)) raw[newKey] = raw[oldKey];
      delete raw[oldKey];
      changed = true;
    }
  }

  const out: LatexSettings = { ...DEFAULT_SETTINGS };
  const knownKeys = new Set<string>(Object.keys(DEFAULT_SETTINGS));
  for (const k of Object.keys(raw)) {
    if (!knownKeys.has(k)) changed = true;
  }

  if ("language" in raw) {
    if (typeof raw.language === "string" && VALID_LANGUAGES.has(raw.language)) {
      out.language = raw.language as LatexSettings["language"];
    } else {
      changed = true;
    }
  }
  if ("engine" in raw) {
    if (typeof raw.engine === "string" && VALID_ENGINES.has(raw.engine)) {
      out.engine = raw.engine as LatexSettings["engine"];
    } else {
      changed = true;
    }
  }
  if ("darkMode" in raw) {
    if (typeof raw.darkMode === "string" && VALID_DARK_MODES.has(raw.darkMode)) {
      out.darkMode = raw.darkMode as LatexSettings["darkMode"];
    } else {
      changed = true;
    }
  }
  for (const key of ["enabled", "livePreview", "shellEscape"] as const) {
    if (key in raw) {
      if (typeof raw[key] === "boolean") {
        out[key] = raw[key] as boolean;
      } else {
        changed = true;
      }
    }
  }
  for (const key of ["latexBin", "dvisvgmBin"] as const) {
    if (key in raw) {
      if (typeof raw[key] === "string" && !(raw[key] as string).includes("\0")) {
        out[key] = (raw[key] as string).trim();
      } else {
        changed = true;
      }
    }
  }
  if ("extraPreamble" in raw) {
    if (typeof raw.extraPreamble === "string") {
      out.extraPreamble = raw.extraPreamble;
    } else {
      changed = true;
    }
  }

  return { settings: out, changed };
}
