# Contributing to LaTeX Vault

## Branches

- **`main`**: Stable releases only. Do not push or open Pull Requests directly against `main`.
- **`dev`**: Active development branch. Branch from `dev` and open Pull Requests against `dev`.

```bash
git switch dev
git pull origin dev
git switch -c feat/my-change   # or fix/*, refactor/*, docs/*
```

## Setup & Commands

```bash
npm install
npm test        # Run offline unit & mock TeX tests
npm run build   # Type-check and compile main.js
npm run dev     # Watch build during development
```

`main.js` is gitignored and compiled automatically on release by GitHub Actions; never commit it.

To test inside Obsidian, copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/latex-vault/`. To test the plugin offline without a local TeX installation, set both binary paths in Settings to [`test/mock-tex.mjs`](test/mock-tex.mjs).

## Conventions

- Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `build:`, `chore:`).
- Keep user-facing strings typed and translated in both `en` and `it` inside [`src/i18n.ts`](src/i18n.ts), and share Reading/Edit DOM helpers via [`src/ui.ts`](src/ui.ts).
- Add regression tests under `test/` for bug fixes and new renderer/editor behavior; CI runs `npm test` and `npm run build` on both Ubuntu and Windows.
