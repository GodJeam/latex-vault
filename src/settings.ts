import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LatexVaultPlugin from "./main";
import type { Language } from "./i18n";

export type LatexEngine = "auto" | "pdf" | "dvi";

export interface LatexSettings {
  language: Language;
  enabled: boolean;
  engine: LatexEngine;
  latexBin: string;
  dvisvgmBin: string;
  extraPreamble: string;
  livePreview: boolean;
  shellEscape: boolean;
}

export const DEFAULT_SETTINGS: LatexSettings = {
  language: "en",
  enabled: true,
  engine: "auto",
  latexBin: "",
  dvisvgmBin: "",
  extraPreamble: "",
  livePreview: true,
  shellEscape: false,
};

export class LatexSettingTab extends PluginSettingTab {
  plugin: LatexVaultPlugin;

  constructor(app: App, plugin: LatexVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const t = (s: string) => this.plugin.t(s);
    containerEl.empty();

    containerEl.createEl("h2", { text: t("LaTeX rendering") });

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
      .setName(t("Render LaTeX code blocks with local TeX"))
      .setDesc(t(
        "Renders ```latex-vault blocks (and the legacy ```tikz, ```tikzcd, ```pgfplots) using the TeX installed on the system (MiKTeX/TeX Live). Any installed package works: TikZ, pgfplots, matrices, algorithms, code listings, math. Rendering happens before the TikZJax plugin, so it takes precedence."
      ))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            this.plugin.settings.enabled = value;
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
          .setValue(this.plugin.settings.livePreview)
          .onChange(async (value) => {
            this.plugin.settings.livePreview = value;
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
          .setValue(this.plugin.settings.engine)
          .onChange(async (value) => {
            this.plugin.settings.engine = value as LatexEngine;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("latex/pdflatex binary path"))
      .setDesc(t("Leave empty for automatic lookup in the PATH (recommended). Use a full path only if needed."))
      .addText((text) =>
        text
          .setPlaceholder("(auto)")
          .setValue(this.plugin.settings.latexBin)
          .onChange(async (value) => {
            this.plugin.settings.latexBin = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("dvisvgm binary path"))
      .setDesc(t("Leave empty for automatic lookup in the PATH (recommended)."))
      .addText((text) =>
        text
          .setPlaceholder("(auto)")
          .setValue(this.plugin.settings.dvisvgmBin)
          .onChange(async (value) => {
            this.plugin.settings.dvisvgmBin = value.trim();
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
          .setValue(this.plugin.settings.extraPreamble)
          .onChange(async (value) => {
            this.plugin.settings.extraPreamble = value;
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
          .setValue(this.plugin.settings.shellEscape)
          .onChange(async (value) => {
            this.plugin.settings.shellEscape = value;
            await this.plugin.saveSettings();
            await this.plugin.renderer.clearCache();
          })
      );

    new Setting(containerEl)
      .setName(t("Test LaTeX rendering"))
      .setDesc(t("Runs a test diagram with pgfplots, circuitikz and libraries to verify the configuration."))
      .addButton((btn) =>
        btn.setButtonText(t("Test")).onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText(t("Rendering..."));
          try {
            await this.plugin.renderer.render(
              "\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}\n\\usepackage[siunitx]{circuitikz}\n\\usetikzlibrary{positioning, arrows.meta}\n\\begin{tikzpicture}\n\\draw (0,0) to[R=1k] (3,0);\n\\node[draw, right=1cm of {(3,0)}] (b) {OK};\n\\draw[-{Stealth}] (3,0) -- (b);\n\\end{tikzpicture}"
            );
            new Notice(t("LaTeX rendering succeeded: the TeX configuration works."));
          } catch (e) {
            new Notice(`${t("LaTeX rendering error:")} ${(e as Error).message}`);
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
            await this.plugin.renderer.clearCache();
            new Notice(t("LaTeX cache cleared."));
          } finally {
            btn.setDisabled(false);
          }
        })
      );
  }
}