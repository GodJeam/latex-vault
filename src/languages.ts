// Code block languages rendered by the plugin. "latex-vault" is the primary,
// dedicated tag (it does not clash with Obsidian's own ```latex syntax
// highlighting); the TikZ tags are kept for backward compatibility.
export const LANGUAGES = ["latex-vault", "tikz", "tikzcd", "pgfplots"];

export const LANGUAGE_SET = new Set(LANGUAGES);

export const LANGUAGE_SELECTOR = LANGUAGES.map((l) => `pre > code.language-${l}`).join(", ");

export const FENCE_RE = new RegExp("^```(" + LANGUAGES.join("|") + ")(\\s|$)", "i");

export interface FenceOpening {
  char: "`" | "~";
  len: number;
  info: string;
  isLatex: boolean;
}

const OPENING_FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Parse a CommonMark opening code fence line (backticks or tildes). */
export function parseOpeningFence(line: string): FenceOpening | null {
  const m = OPENING_FENCE_RE.exec(line);
  if (!m) return null;
  const marker = m[1];
  const char = marker[0] as "`" | "~";
  const info = m[2];
  // CommonMark: backtick fence info strings cannot contain backticks.
  if (char === "`" && info.includes("`")) return null;
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return {
    char,
    len: marker.length,
    info,
    isLatex: LANGUAGE_SET.has(lang),
  };
}

/** Check whether a line closes an open fence of the given marker char and length. */
export function isClosingFence(line: string, char: "`" | "~", minLen: number): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  if (!m) return false;
  return m[1][0] === char && m[1].length >= minLen;
}

export function isLatexOpeningFence(line: string): boolean {
  return parseOpeningFence(line)?.isLatex === true;
}
