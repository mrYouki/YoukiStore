#!/usr/bin/env node
/**
 * submission-checker.js
 * -----------------------------------------------------------------------
 * Runs inside a GitHub Action when someone opens an Issue asking to add
 * their extension to YoukiStore. Given a target repo (owner/name), it:
 *
 *   1. Checks for the 6 required components:
 *        - plugin.json
 *        - README.md
 *        - a media/graphics folder with at least one image (or short clip)
 *        - an OSI-approved open-source LICENSE (not merely "source
 *          available" — see LICENSE POLICY below)
 *        - an icon file (icon.png/.jpg/.jpeg/.webp) inside the media folder
 *        - at least one published GitHub Release with a downloadable asset
 *   2. Builds the index.json entry object if everything passes.
 *   3. Prints a machine-readable result to stdout (JSON) so the workflow
 *      YAML can read it with `steps.checker.outputs.result`.
 *
 * This script only READS from the target repo via the public GitHub REST
 * API (unauthenticated calls are fine here — checker runs rarely, not per
 * page-view, so the 60 req/hr limit is a non-issue). It does not require
 * any secret token for reading public repos.
 *
 * LICENSE POLICY
 * -----------------------------------------------------------------------
 * "Open source" here means the four freedoms hold even if the upstream
 * project changes its license later: anyone can read, modify, and
 * redistribute (including modified versions) under the terms already
 * granted. We rely on GitHub's own license detector (repo.license.spdx_id)
 * rather than re-parsing LICENSE text ourselves — GitHub already runs
 * licensee against the file and is far more reliable than a keyword match.
 *
 * We accept any SPDX id GitHub reports EXCEPT a denylist of known
 * "source-available"/non-OSI licenses that are commonly mistaken for open
 * source (Elastic License 2.0, Business Source License, SSPL, Commons
 * Clause, CC-BY-NC variants, "no license" placeholders, etc.) — these let
 * you view the code but restrict modification, redistribution, or
 * commercial reuse, which fails the "can be freely modified and reused"
 * bar even though the source is visible on GitHub.
 *
 * If GitHub could not detect a license at all (spdx_id is null or
 * "NOASSERTION") we reject too — an unrecognized/custom LICENSE file is
 * exactly the ambiguous case this check exists to catch, and defaulting to
 * "all rights reserved" is the legally safe assumption.
 *
 * Usage:
 *   node submission-checker.js <owner/repo>
 *
 * Exit codes:
 *   0 = check completed (see JSON "ok" field for pass/fail)
 *   1 = script-level error (bad input, network failure, etc.)
 * -----------------------------------------------------------------------
 */

const REQUIRED_MANIFEST_NAMES = ["plugin.json"];
const README_NAME = "README.md";
const MEDIA_DIR_CANDIDATES = ["graphics", "media", "screenshots", "images"];
const ICON_NAMES = ["icon.png", "icon.jpg", "icon.jpeg", "icon.webp"];

// SPDX ids GitHub's detector returns for licenses that are source-available
// but NOT open source by the definition above (restrict modification,
// redistribution, or commercial use of modified versions). Kept as a
// denylist (rather than an allowlist of "good" ids) so newly-added OSI
// licenses on GitHub's side don't need this list updated to be accepted.
const NON_OPEN_SOURCE_SPDX_IDS = new Set([
  "BUSL-1.1",        // Business Source License — converts to open source only after a delay
  "ELASTIC-2.0",      // Elastic License 2.0 — restricts offering as a hosted service
  "SSPL-1.0",         // Server Side Public License — copyleft trap for hosted services
  "CC-BY-NC-4.0",     // Non-commercial — blocks commercial reuse
  "CC-BY-NC-SA-4.0",
  "CC-BY-NC-ND-4.0",
  "CC-BY-ND-4.0",     // No-derivatives — blocks modification entirely
  "COMMONS-CLAUSE",   // Adds a "no sell" restriction on top of another license
  "UNLICENSED",       // GitHub's placeholder for "explicitly all rights reserved"
  "NOASSERTION",      // GitHub found a LICENSE file but couldn't classify it
]);

function isOpenSourceLicense(spdxId) {
  if (!spdxId) return false; // no license detected at all
  const id = spdxId.toUpperCase();
  return !NON_OPEN_SOURCE_SPDX_IDS.has(id);
}

async function ghGet(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "YoukiStore-Submission-Checker",
    },
  });
  return { ok: res.ok, status: res.status, json: res.ok ? await res.json() : null };
}

async function fileExists(owner, repo, path) {
  const { ok, json } = await ghGet(`/repos/${owner}/${repo}/contents/${path}`);
  if (!ok || !json) return null;
  return json; // contains download_url, size, etc.
}

async function findFirstExisting(owner, repo, candidates) {
  for (const name of candidates) {
    const found = await fileExists(owner, repo, name);
    if (found) return { name, meta: found };
  }
  return null;
}

async function checkMediaDir(owner, repo) {
  for (const dir of MEDIA_DIR_CANDIDATES) {
    const { ok, json } = await ghGet(`/repos/${owner}/${repo}/contents/${dir}`);
    if (ok && Array.isArray(json)) {
      // Accept images, gifs, and short video clips (mp4/webm/mov) as
      // valid gallery media — not just static screenshots.
      const media = json.filter(f => /\.(png|jpg|jpeg|webp|gif|mp4|webm|mov)$/i.test(f.name));
      if (media.length > 0) {
        const iconFile = media.find(f => ICON_NAMES.includes(f.name.toLowerCase()));
        return { dir, count: media.length, files: media.map(f => f.name), iconFile: iconFile ? iconFile.name : null };
      }
    }
  }
  return null;
}

async function checkLatestRelease(owner, repo) {
  const { ok, json } = await ghGet(`/repos/${owner}/${repo}/releases/latest`);
  if (!ok || !json) return null;
  const assets = (json.assets || []).filter(a => a.browser_download_url);
  if (assets.length === 0) return null;
  return {
    tag: json.tag_name,
    publishedAt: json.published_at,
    asset: assets[0].name,
    downloadUrl: assets[0].browser_download_url,
  };
}

async function main() {
  const target = process.argv[2];
  if (!target || !target.includes("/")) {
    console.error(JSON.stringify({ ok: false, error: "Usage: submission-checker.js <owner/repo>" }));
    process.exit(1);
  }
  const [owner, repo] = target.split("/");

  const result = {
    ok: false,
    repo: `${owner}/${repo}`,
    checkedAt: new Date().toISOString(),
    checks: {},
    missing: [],
    entry: null,
  };

  // 0. Repo must exist and be public. Checking this first avoids a
  // confusing cascade of "file not found" errors for every single
  // requirement when the real problem is just that the repo is private
  // or the URL was mistyped.
  const repoInfo = await ghGet(`/repos/${owner}/${repo}`);
  if (!repoInfo.ok) {
    result.missing.push(
      repoInfo.status === 404
        ? "Repository not found. Check the URL is correct and the repo is public (private repos can't be verified)."
        : `Could not reach repository (GitHub API status ${repoInfo.status}).`
    );
    result.ok = false;
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  if (repoInfo.json.private) {
    result.missing.push("Repository is private. YoukiStore only lists public extensions — make the repo public and resubmit.");
    result.ok = false;
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  // 1. Manifest
  const manifestFound = await findFirstExisting(owner, repo, REQUIRED_MANIFEST_NAMES);
  result.checks.manifest = !!manifestFound;
  if (!manifestFound) {
    result.missing.push(
      "plugin.json not found at repo root. Suggestion: add a plugin.json file at the top " +
      "level of your repo with at least a \"name\" field."
    );
  }

  // 2. README
  const readmeFound = await fileExists(owner, repo, README_NAME);
  result.checks.readme = !!readmeFound;
  if (!readmeFound) {
    result.missing.push(
      "README.md not found at repo root. Suggestion: add a README.md describing what your " +
      "extension does and how to use it."
    );
  }

  // 3. Media directory (+ icon file inside it)
  const mediaFound = await checkMediaDir(owner, repo);
  result.checks.media = !!mediaFound;
  if (!mediaFound) {
    result.missing.push(
      `No image/gif/video files found in any of: ${MEDIA_DIR_CANDIDATES.join(", ")}. ` +
      `Suggestion: create a top-level "graphics/" folder and add at least one screenshot ` +
      `(png/jpg/jpeg/webp/gif/mp4/webm/mov).`
    );
  }

  result.checks.icon = !!(mediaFound && mediaFound.iconFile);
  if (mediaFound && !mediaFound.iconFile) {
    result.missing.push(
      `Media folder "${mediaFound.dir}/" was found but has no icon file. Suggestion: add ` +
      `one of ${ICON_NAMES.join(", ")} inside "${mediaFound.dir}/" as your app/extension icon.`
    );
  } else if (!mediaFound) {
    result.missing.push(
      `No icon file found. Suggestion: once you add a media folder, include one of ` +
      `${ICON_NAMES.join(", ")} inside it.`
    );
  }

  // 4. License — must be a real OSI-style open-source license as detected
  // by GitHub's own license classifier (repo.license.spdx_id), not just
  // "a LICENSE file exists" and not a source-available license that
  // restricts modification/redistribution/commercial reuse.
  const spdxId = repoInfo.json.license ? repoInfo.json.license.spdx_id : null;
  const licenseName = repoInfo.json.license ? repoInfo.json.license.name : null;
  const licenseOk = isOpenSourceLicense(spdxId);
  result.checks.license = licenseOk;
  if (!spdxId || spdxId === "NOASSERTION") {
    result.missing.push(
      "No recognizable open-source LICENSE found at repo root. Suggestion: add a LICENSE " +
      "file using a standard OSI-approved license such as MIT, Apache-2.0, or GPL-3.0 " +
      "(GitHub can generate one for you when creating the file)."
    );
  } else if (!licenseOk) {
    result.missing.push(
      `Repository uses "${licenseName || spdxId}", which is source-available but not an ` +
      "open-source license — it restricts modification, redistribution, or commercial reuse " +
      "of modified versions. Suggestion: relicense under an OSI-approved permissive or " +
      "copyleft license (e.g. MIT, Apache-2.0, GPL-3.0, MPL-2.0) so anyone can freely modify " +
      "and reuse the code, even if this license changes later."
    );
  }

  // 5. Release with downloadable asset
  const release = await checkLatestRelease(owner, repo);
  result.checks.release = !!release;
  if (!release) {
    result.missing.push(
      "No GitHub Release with a downloadable asset found. Suggestion: publish a Release " +
      "(not just a git tag) from the repo's \"Releases\" page and attach a downloadable " +
      "file (e.g. a .zip of your extension)."
    );
  }

  result.ok = result.missing.length === 0;

  if (result.ok) {
    // We still fetch and parse plugin.json here as part of validation —
    // a submission with a broken/invalid manifest should fail the check,
    // since the live site would fail to resolve it later too.
    let manifestData = {};
    try {
      const rawUrl = manifestFound.meta.download_url;
      const manifestRes = await fetch(rawUrl);
      manifestData = await manifestRes.json();
      if (!manifestData.name) {
        result.missing.push("plugin.json is missing a required 'name' field");
        result.ok = false;
      }
    } catch (err) {
      result.missing.push(`plugin.json could not be parsed as JSON: ${err.message}`);
      result.ok = false;
    }

    if (result.ok) {
      // index.json stores ready-to-use CDN URLs (jsDelivr, mapped to the
      // GitHub repo's default branch) plus the display data (name, stars,
      // last-updated) the front-end needs. manifestUrl is kept here purely
      // as a record of where plugin.json lives — the front-end never
      // fetches it; index.json alone is a complete, self-sufficient
      // catalog entry, and README.md is the only other per-extension file
      // fetched (lazily, only when someone opens the detail page).
      const cdnBase = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@main`;

      result.entry = {
        id: repo.toLowerCase(),
        repo: `${owner}/${repo}`,
        name: manifestData.name,
        manifestUrl: `${cdnBase}/${manifestFound.name}`,
        readmeUrl: `${cdnBase}/${README_NAME}`,
        // iconFile is now a required check (see step 3 above), so this is
        // always populated by the time we get here — but we still fall
        // back gracefully to the front-end's onerror glyph just in case.
        iconUrl: mediaFound.iconFile ? `${cdnBase}/${mediaFound.dir}/${mediaFound.iconFile}` : null,
        mediaUrls: mediaFound.files.map(f => `${cdnBase}/${mediaFound.dir}/${f}`),
        releaseUrl: release.downloadUrl,
        releaseTag: release.tag,
        // Stars + last-updated come straight from the GitHub repo metadata
        // we already fetched in step 0 — not from plugin.json. This keeps
        // the front-end from ever needing to read plugin.json itself: it
        // only reads index.json (this file) and README.md.
        ghStars: repoInfo.json.stargazers_count || 0,
        updatedAt: repoInfo.json.pushed_at || repoInfo.json.updated_at,
        addedAt: new Date().toISOString(),
      };
    }
  }

  // Machine-readable output for the workflow step to consume.
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
