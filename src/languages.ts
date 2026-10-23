// Code block languages rendered by the plugin. "latex-vault" is the primary,
// dedicated tag (it does not clash with Obsidian's own ```latex syntax
// highlighting); the TikZ tags are kept for backward compatibility.
export const LANGUAGES = ["latex-vault", "tikz", "tikzcd", "pgfplots"];

export const LANGUAGE_SELECTOR = LANGUAGES.map((l) => `pre > code.language-${l}`).join(", ");

export const FENCE_RE = new RegExp("^```(" + LANGUAGES.join("|") + ")(\\s|$)", "i");
