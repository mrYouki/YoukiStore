# YoukiStore

Community extension marketplace for the [YoukiShell](#) app.

## How this repo works

- `index.html` — the entire front-end. Static, no build step, no backend.
  Served via GitHub Pages. It only ever reads `index.json` (for the
  catalog/cards) and each extension's `README.md` (lazily, on the detail
  page) — it never fetches or displays `plugin.json`; that file exists
  purely for the submission bot's own use.
- `index.json` — the extension catalog. Each entry is a self-contained
  record built by the submission bot: name, stars, last-updated, and
  ready-to-use jsDelivr CDN URLs (icon, screenshots/media, README,
  release download). This file is updated automatically — don't edit it
  by hand.
- `submission-checker.js` — the script the bot runs against a submitted
  repo to verify it meets the 6 requirements (plugin.json, README.md, a
  media folder, an icon file inside it, an OSI-approved open-source
  license, and a GitHub Release with a downloadable asset).
- `.github/workflows/submission-check.yml` — the GitHub Action that
  triggers whenever someone opens an Issue titled `[Submit] ...`,
  runs the checker, and updates `index.json` automatically.

## Submitting an extension

**Before you open an Issue, copy the line below exactly as your Issue title, then paste your own repo link in the body.**

### Step 1 — Issue title (copy exactly):
```
[Submit] your-extension-name
```
Replace `your-extension-name` with your extension's actual name.

### Step 2 — Issue body (copy exactly, then replace the URL):
```
repo: https://github.com/your-username/your-extension
```
Replace `your-username/your-extension` with your **real, existing, public**
repository — not a placeholder. The bot checks that the repo actually
exists before anything else.

Your repository must contain, at its root:
- `plugin.json` with at least a `name` field
- `README.md`
- a media folder (`graphics/`, `media/`, `screenshots/`, or `images/`)
  with at least one image, gif, or short video
- an icon file inside that same media folder: `icon.png`, `icon.jpg`,
  `icon.jpeg`, or `icon.webp`
- a `LICENSE` file using a **real OSI-approved open-source license**
  (e.g. MIT, Apache-2.0, GPL-3.0, MPL-2.0) — one that lets anyone freely
  modify and redistribute the code, even if the license changes later.
  "Source-available" licenses that restrict modification, redistribution,
  or commercial reuse (Elastic License, Business Source License, SSPL,
  Commons Clause, CC-BY-NC, etc.) are **not accepted**, even though the
  code is visible on GitHub. The bot checks this using GitHub's own
  license detector, not just "does a LICENSE file exist".
- at least one published GitHub Release with a downloadable file attached

The bot will verify your repository automatically and either add it to
the store or comment back on your Issue with **exactly what's missing and
a suggestion for how to fix it**, then close the Issue as "not planned"
so it's clear the submission was rejected rather than left open. Once
you've fixed everything, just open a new Issue to re-submit.

## Setup notes for maintainers

`DATA_REPO` in `index.html` is already set to `mrYouki/YoukiStore` — the
front-end reads `index.json` straight from this repository via jsDelivr.
No further setup needed unless the repo is renamed or moved.
