# YoukiStore

Community extension marketplace for the [YoukiShell](#) app.

## How this repo works

- `index.html` — the entire front-end. Static, no build step, no backend.
  Served via GitHub Pages.
- `index.json` — the extension catalog. Each entry is a set of ready-to-use
  jsDelivr CDN URLs pointing into the extension author's own repository
  (manifest, README, icon, screenshots, release download). This file is
  updated automatically by the submission bot — don't edit it by hand.
- `submission-checker.js` — the script the bot runs against a submitted
  repo to verify it meets the 5 requirements (manifest.json, README.md,
  a media folder, a LICENSE file, and a GitHub Release with a downloadable
  asset).
- `.github/workflows/submission-check.yml` — the GitHub Action that
  triggers whenever someone opens an Issue titled `[Submit] ...`,
  runs the checker, and updates `index.json` automatically.

## Submitting an extension

Open a new Issue titled `[Submit] your-extension-name` with a body like:

```
repo: https://github.com/your-username/your-extension
```

The bot will verify your repository and either add it to the store or
comment back with what's missing.

## Setup notes for maintainers

`DATA_REPO` in `index.html` is already set to `mrYouki/YoukiStore` — the
front-end reads `index.json` straight from this repository via jsDelivr.
No further setup needed unless the repo is renamed or moved.
