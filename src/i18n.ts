export type Language = "en" | "it";

// English is the default and is used inline in the code. This map provides
// the Italian translations for the optional "it" language setting.
const IT: Record<string, string> = {
  "Language": "Lingua",
  "Interface language. English is the default. Some command names update after reloading Obsidian.":
    "Lingua dell'interfaccia. L'inglese è il default. Alcuni nomi dei comandi si aggiornano dopo il ricaricamento di Obsidian.",
  "Language changed. Reload Obsidian to apply it everywhere.":
    "Lingua cambiata. Ricarica Obsidian per applicarla ovunque.",
  "English": "Inglese",
  "Italian": "Italiano",
  "LaTeX rendering": "Rendering LaTeX",
  "Render LaTeX code blocks with local TeX":
    "Render dei blocchi LaTeX con TeX locale",
  "Renders ```latex-vault blocks (and the legacy ```tikz, ```tikzcd, ```pgfplots) using the TeX installed on the system (MiKTeX/TeX Live). Any installed package works: TikZ, pgfplots, matrices, algorithms, code listings, math. Rendering happens before the TikZJax plugin, so it takes precedence.":
    "Rende i blocchi ```latex-vault (e i vecchi ```tikz, ```tikzcd, ```pgfplots) con il TeX installato sul sistema (MiKTeX/TeX Live). Funziona qualsiasi pacchetto installato: TikZ, pgfplots, matrici, algoritmi, codice, matematica. Il rendering avviene prima del plugin TikZJax, quindi ha la precedenza.",
  "Live preview in Edit mode": "Anteprima in modifica (live preview)",
  "Show the image also in Edit mode, below the code block. The preview updates automatically when the code changes.":
    "Mostra l'immagine anche in modalità modifica, sotto il blocco di codice. L'anteprima viene aggiornata automaticamente quando il codice cambia.",
  "Rendering engine": "Motore di rendering",
  "auto tries pdflatex+dvisvgm and falls back to latex+dvisvgm. 'pdf' is more compatible with modern packages, 'dvi' is more traditional.":
    "auto prova pdflatex+dvisvgm e ripiega su latex+dvisvgm. 'pdf' è più compatibile con i pacchetti moderni, 'dvi' è più tradizionale.",
  "Auto (recommended)": "Auto (consigliato)",
  "pdflatex + dvisvgm (PDF)": "pdflatex + dvisvgm (PDF)",
  "latex + dvisvgm (DVI)": "latex + dvisvgm (DVI)",
  "latex/pdflatex binary path": "Percorso binario latex/pdflatex",
  "Leave empty for automatic lookup in the PATH (recommended). Use a full path only if needed.":
    "Lascia vuoto per la ricerca automatica nel PATH (consigliato). Usa il percorso completo solo se serve.",
  "dvisvgm binary path": "Percorso binario dvisvgm",
  "Leave empty for automatic lookup in the PATH (recommended).":
    "Lascia vuoto per la ricerca automatica nel PATH (consigliato).",
  "Extra preamble": "Preambolo aggiuntivo",
  "Lines to add to the preamble of every rendering. Useful to load frequently used libraries, e.g. \\usepackage{pgfplots} or \\usetikzlibrary{positioning, arrows.meta}.":
    "Linee da aggiungere al preambolo di ogni rendering. Utile per caricare librerie usate di frequente, es. \\usepackage{pgfplots} oppure \\usetikzlibrary{positioning, arrows.meta}.",
  "Enable shell-escape": "Abilita shell-escape",
  "Required by packages that run external programs, such as minted (needs Pygments). Security risk: code blocks can execute commands on your system. Enable only for trusted vaults.":
    "Necessario per pacchetti che eseguono programmi esterni, come minted (richiede Pygments). Rischio di sicurezza: i blocchi di codice possono eseguire comandi sul sistema. Abilitalo solo per vault fidati.",
  "Test LaTeX rendering": "Testa rendering LaTeX",
  "Runs a test diagram with pgfplots, circuitikz and libraries to verify the configuration.":
    "Esegue un diagramma di prova con pgfplots, circuitikz e librerie per verificare la configurazione.",
  "Test": "Test",
  "Rendering...": "Rendering in corso...",
  "LaTeX rendering succeeded: the TeX configuration works.":
    "Rendering LaTeX riuscito: la configurazione TeX funziona.",
  "LaTeX rendering error:": "Errore rendering LaTeX:",
  "Clear rendering cache": "Svuota cache rendering",
  "Deletes the already compiled SVGs (useful after preamble changes or to free space).":
    "Elimina gli SVG già compilati (utile dopo modifiche al preambolo o per liberare spazio).",
  "Clear": "Svuota",
  "LaTeX cache cleared.": "Cache LaTeX svuotata.",
  "Rendering LaTeX with local TeX...": "Rendering LaTeX con TeX locale…",
  "Show LaTeX code": "Mostra codice LaTeX",
  "Hide LaTeX code": "Nascondi codice LaTeX",
  "LaTeX rendering error": "Errore di rendering LaTeX",
  "Rendering LaTeX...": "Rendering LaTeX…",
  "Attempt": "Tentativo",
};

export function translate(lang: Language, text: string): string {
  if (lang === "it") return IT[text] ?? text;
  return text;
}