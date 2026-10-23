# LaTeX Vault

An **Obsidian** plugin that renders LaTeX code blocks in your vault using a **local TeX installation** (MiKTeX / TeX Live), producing SVG images: TikZ diagrams, pgfplots, matrices, algorithms, code listings, math — with **any installed package**, including the ones TikZJax cannot load.

> Formerly **TikZ Vault** (`tikz-vault`). See [Migrating from TikZ Vault](#migrating-from-tikz-vault).

> **Note**: this project was entirely generated using large language models (LLMs) via opencode. The code received **little personal review**: use it with due caution, test it, and report or fix any issues you find.

## Features

- Renders ```latex-vault blocks (plus the legacy ```tikz, ```tikzcd, ```pgfplots) to **SVG using your local TeX** (MiKTeX / TeX Live), in both Reading and Edit mode.
- Supports **any LaTeX package** (pgfplots, circuitikz, tikz-cd, forest, nicematrix, algorithmicx, listings, ...), unlike TikZJax.
- Automatic `pdflatex + dvisvgm` / `latex + dvisvgm` fallback, with disk caching.
- In Edit mode the code stays available behind a closed "Show LaTeX code" toggle.
- Smart wrapping: bare TikZ commands and pgfplots axes are wrapped in a `tikzpicture`, while self-contained environments (`forest`, `circuitikz`, `quantikz`, `karnaugh-map`, `bytefield`) and non-picture content (matrices, algorithms, code listings, math) are typeset as-is.
- Optional **shell-escape** (off by default) for packages that run external tools.

## Requirements

- Obsidian (desktop).
- A local **TeX** installation with `latex`/`pdflatex` and `dvisvgm` on your `PATH` (or configured in the plugin settings):

| Platform | Recommended TeX | Notes |
|---|---|---|
| Windows | MiKTeX | set the `latex`/`dvisvgm` binary paths in settings if not on `PATH` |
| macOS | MacTeX / TeX Live | binaries usually in `/Library/TeX/texbin` |
| Linux | TeX Live (`texlive-full`) | binaries usually in `/usr/bin` |

For the build you also need **Node.js**.

## Installation

1. Clone the repo and build:

```bash
git clone https://github.com/GodJeam/latex-vault.git
cd latex-vault
npm install
npm run build
```

2. Copy the generated files into your vault:

```
<vault>/.obsidian/plugins/latex-vault/
    ├── main.js
    ├── manifest.json
    └── styles.css
```

3. In Obsidian: Settings → Community plugins → enable **LaTeX Vault**.

## Usage

Wrap LaTeX code in a ```latex-vault fenced block:

````markdown
```latex-vault
\begin{tikzpicture}
\draw (0,0) circle (1);
\end{tikzpicture}
```
````

Blocks are not limited to diagrams: matrices, pseudocode, code listings and formulas work too:

````markdown
```latex-vault
$\begin{pNiceMatrix} 1 & 2 \\ 3 & 4 \end{pNiceMatrix}$
```

```latex-vault
\begin{algorithmic}
\For{$i = 1$ to $n$}
  \State $s \gets s + a_i$
\EndFor
\end{algorithmic}
```
````

### Preamble and packages

Leading lines with preamble commands (`\usepackage`, `\usetikzlibrary`, `\newcommand`, `\lstset`, ...) are moved to the preamble. A block containing `\documentclass` is compiled verbatim; one containing `\begin{document}` only gets the missing class and `tikz`.

`tikz`, `amsmath` and `amssymb` are always loaded. These packages are loaded automatically when their environments/commands are detected (unless you load them yourself):

| Detected | Package |
|---|---|
| `tikzcd` | `tikz-cd` |
| `axis` (any pgfplots axis), `\addplot` | `pgfplots` (`compat=1.18`) |
| `forest` / `circuitikz` / `quantikz` | `forest` / `circuitikz` / `quantikz` |
| `karnaugh-map` / `bytefield` | `karnaugh-map` / `bytefield` |
| `pNiceMatrix`, `NiceArray`, ... / `blockarray` | `nicematrix` / `blkarray` |
| `algorithmic` | `algpseudocode` |
| `lstlisting` / `minted` / `tcolorbox` | `listings` / `minted` / `tcolorbox` |
| `\dv`, `\pdv`, `\bra`, `\ket` | `physics` |
| `\coloneqq`, `\mathclap`, ... | `mathtools` |
| `\cancel` / `\SI`, `\num`, ... | `cancel` / `siunitx` |

Floats (`algorithm`, `figure`, `table`) are forced to the `[H]` placement so they render inside the standalone image; `\begin{algorithm}` loads `algorithm` automatically unless you load `algorithm2e`.

Any other installed package can be loaded with `\usepackage` in the block or in the **Extra preamble** setting. A full TeX installation (e.g. `texlive-scheme-full`) avoids missing-package errors.

> **minted**: recent TeX Live versions run it in restricted mode. If yours does not, enable **shell-escape** in the settings — only for trusted vaults, since it lets code blocks execute commands.

The ```latex-vault tag is dedicated to the plugin, so Obsidian's ```latex syntax highlighting keeps working for code you only want to show. The ```tikz, ```tikzcd and ```pgfplots tags still work for existing notes.

In the plugin settings you can configure the engine, binary paths, an extra preamble, shell-escape, and the interface language (English by default, Italian optional). Use the **Test** button to verify your TeX configuration.

## Migrating from TikZ Vault

1. Install LaTeX Vault in `<vault>/.obsidian/plugins/latex-vault/` and enable it.
2. Disable and delete the old **TikZ Vault** plugin (`plugins/tikz-vault/`) — both plugins render ```tikz blocks.
3. Settings are imported automatically from the old plugin on first load (as long as its `data.json` still exists), and existing ```tikz blocks keep working.

## Structure

- `src/` — TypeScript source
- `build/` — build tooling (esbuild config, tsconfig)
- `main.js` / `manifest.json` / `styles.css` — built plugin files (copy into the vault)

## License

GPL-3.0 — see [LICENSE](LICENSE).