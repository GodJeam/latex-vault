import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TikzVaultPlugin from "./main";
import type { Language } from "./i18n";

export type TikzEngine = "auto" | "pdf" | "dvi";

export interface TikzSettings {
  language: Language;
  tikzEnabled: boolean;
  tikzEngine: TikzEngine;
  tikzLatexBin: string;
  tikzDvisvgmBin: string;
  tikzExtraPreamble: string;
  tikzLivePreview: boolean;
  tikzShellEscape: boolean;
}

export const DEFAULT_SETTINGS: TikzSettings = {
  language: "en",
  tikzEnabled: true,
  tikzEngine: "auto",
  tikzLatexBin: "",
  tikzDvisvgmBin: "",
  tikzExtraPreamble: "",
  tikzLivePreview: true,
  tikzShellEscape: false,
};

export class TikzSettingTab extends PluginSettingTab {
  plugin: TikzVaultPlugin;

  constructor(app: App, plugin: TikzVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const t = (s: string) => this.plugin.t(s);
    containerEl.empty();

    containerEl.createEl("h2", { text: t("Rendering TikZ") });

    new Setting(containerEl)
      .setName(t("Language"))
      .setDesc(t(
        "Interface language. English is the default. Some command names update after reloading Obsidian."
      ))
      .addDropdown((dd) =>
        dd
          .addOption("en", t("English"))
          .addOption("it", t("Italian"))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as Language;
            await this.plugin.saveSettings();
            new Notice(t("Language changed. Reload Obsidian to apply it everywhere."));
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t("Render TikZ code blocks with local TeX"))
      .setDesc(t(
        "Renders ```tikz blocks in your notes using the TeX installed on the system (MiKTeX/TeX Live). Supports ALL external libraries (pgfplots, circuitikz, tikz-cd, forest, etc.) that TikZJax cannot load. Rendering happens before the TikZJax plugin, so it takes precedence."
      ))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.tikzEnabled)
          .onChange(async (value) => {
            this.plugin.settings.tikzEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("Live preview in Edit mode"))
      .setDesc(t(
        "Show the image also in Edit mode, below the code block. The preview updates automatically when the code changes."
      ))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.tikzLivePreview)
          .onChange(async (value) => {
            this.plugin.settings.tikzLivePreview = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("Rendering engine"))
      .setDesc(t(
        "auto tries pdflatex+dvisvgm and falls back to latex+dvisvgm. 'pdf' is more compatible with modern packages, 'dvi' is more traditional."
      ))
      .addDropdown((dd) =>
        dd
          .addOption("auto", t("Auto (recommended)"))
          .addOption("pdf", t("pdflatex + dvisvgm (PDF)"))
          .addOption("dvi", t("latex + dvisvgm (DVI)"))
          .setValue(this.plugin.settings.tikzEngine)
          .onChange(async (value) => {
            this.plugin.settings.tikzEngine = value as TikzEngine;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("latex/pdflatex binary path"))
      .setDesc(t("Leave empty for automatic lookup in the PATH (recommended). Use a full path only if needed."))
      .addText((text) =>
        text
          .setPlaceholder("(auto)")
          .setValue(this.plugin.settings.tikzLatexBin)
          .onChange(async (value) => {
            this.plugin.settings.tikzLatexBin = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("dvisvgm binary path"))
      .setDesc(t("Leave empty for automatic lookup in the PATH (recommended)."))
      .addText((text) =>
        text
          .setPlaceholder("(auto)")
          .setValue(this.plugin.settings.tikzDvisvgmBin)
          .onChange(async (value) => {
            this.plugin.settings.tikzDvisvgmBin = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("Extra preamble"))
      .setDesc(t(
        "Lines to add to the preamble of every rendering. Useful to load frequently used libraries, e.g. \\usepackage{pgfplots} or \\usetikzlibrary{positioning, arrows.meta}."
      ))
      .addTextArea((text) =>
        text
          .setPlaceholder("\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}")
          .setValue(this.plugin.settings.tikzExtraPreamble)
          .onChange(async (value) => {
            this.plugin.settings.tikzExtraPreamble = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("Enable shell-escape"))
      .setDesc(t(
        "Required by packages that run external programs, such as minted (needs Pygments). Security risk: code blocks can execute commands on your system. Enable only for trusted vaults."
      ))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.tikzShellEscape)
          .onChange(async (value) => {
            this.plugin.settings.tikzShellEscape = value;
            await this.plugin.saveSettings();
            await this.plugin.tikzRenderer.clearCache();
          })
      );

    new Setting(containerEl)
      .setName(t("Test TikZ rendering"))
      .setDesc(t("Runs a test diagram with pgfplots, circuitikz and libraries to verify the configuration."))
      .addButton((btn) =>
        btn.setButtonText(t("Test")).onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText(t("Rendering..."));
          try {
            await this.plugin.tikzRenderer.render(
              "\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}\n\\usepackage[siunitx]{circuitikz}\n\\usetikzlibrary{positioning, arrows.meta}\n\\begin{tikzpicture}\n\\draw (0,0) to[R=1k] (3,0);\n\\node[draw, right=1cm of {(3,0)}] (b) {OK};\n\\draw[-{Stealth}] (3,0) -- (b);\n\\end{tikzpicture}"
            );
            new Notice(t("TikZ rendering succeeded: the TeX configuration works."));
          } catch (e) {
            new Notice(`${t("TikZ rendering error:")} ${(e as Error).message}`);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText(t("Test"));
          }
        })
      );

    new Setting(containerEl)
      .setName(t("Clear rendering cache"))
      .setDesc(t("Deletes the already compiled SVGs (useful after preamble changes or to free space)."))
      .addButton((btn) =>
        btn.setButtonText(t("Clear")).onClick(async () => {
          btn.setDisabled(true);
          try {
            await this.plugin.tikzRenderer.clearCache();
            new Notice(t("TikZ cache cleared."));
          } finally {
            btn.setDisabled(false);
          }
        })
      );
  }
}