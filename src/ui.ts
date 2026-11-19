import { sanitizeHTMLToDom } from "obsidian";

export function createLoadingStatus(text: string): HTMLDivElement {
  const status = document.createElement("div");
  status.className = "latex-status latex-loading";
  status.textContent = text;
  return status;
}

export function renderSvgElement(svg: string): HTMLDivElement {
  const figure = document.createElement("div");
  figure.className = "latex-figure";
  figure.appendChild(sanitizeHTMLToDom(svg));
  return figure;
}

export function renderErrorElement(title: string, err: unknown): HTMLDivElement {
  const errBox = document.createElement("div");
  errBox.className = "latex-error";

  const titleEl = document.createElement("div");
  titleEl.className = "latex-error-title";
  titleEl.textContent = title;
  errBox.appendChild(titleEl);

  const pre = document.createElement("pre");
  pre.className = "latex-error-msg";
  pre.textContent = err instanceof Error ? err.message : String(err);
  errBox.appendChild(pre);

  return errBox;
}
