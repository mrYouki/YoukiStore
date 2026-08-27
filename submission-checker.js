#!/usr/bin/env node
/**
 * submission-checker.js
 * -----------------------------------------------------------------------
 * Runs inside a GitHub Action when someone opens an Issue asking to add
 * their extension to YoukiStore. Given a target repo (owner/name), it:
 *
 *   1. Checks for the 5 required components:
 *        - manifest.json (or config.json)
 *        - README.md
 *        - a media/graphics folder with at least one image
 *        - LICENSE file
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
 * Usage:
 *   node submission-checker.js <owner/repo>
 *
 * Exit codes:
 *   0 = check completed (see JSON "ok" field for pass/fail)
 *   1 = script-level error (bad input, network failure, etc.)
 * -----------------------------------------------------------------------
 */

const REQUIRED_MANIFEST_NAMES = ["manifest.json", "config.json"];
const README_NAME = "README.md";
const LICENSE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt"];
const MEDIA_DIR_CANDIDATES = ["graphics", "media", "screenshots", "images"];

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
        return { dir, count: media.length, files: media.map(f => f.name) };
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
  if (!manifestFound) result.missing.push("manifest.json (or config.json) not found at repo root");

  // 2. README
  const readmeFound = await fileExists(owner, repo, README_NAME);
  result.checks.readme = !!readmeFound;
  if (!readmeFound) result.missing.push("README.md not found at repo root");

  // 3. Media directory
  const mediaFound = await checkMediaDir(owner, repo);
  result.checks.media = !!mediaFound;
  if (!mediaFound) result.missing.push(`No image files found in any of: ${MEDIA_DIR_CANDIDATES.join(", ")}`);

  // 4. License
  const licenseFound = await findFirstExisting(owner, repo, LICENSE_NAMES);
  result.checks.license = !!licenseFound;
  if (!licenseFound) result.missing.push("LICENSE file not found at repo root");

  // 5. Release with downloadable asset
  const release = await checkLatestRelease(owner, repo);
  result.checks.release = !!release;
  if (!release) result.missing.push("No GitHub Release with a downloadable asset found");

  result.ok = result.missing.length === 0;

  if (result.ok) {
    // We still fetch and parse manifest.json here as part of validation —
    // a submission with a broken/invalid manifest should fail the check,
    // since the live site would fail to resolve it later too.
    let manifestData = {};
    try {
      const rawUrl = manifestFound.meta.download_url;
      const manifestRes = await fetch(rawUrl);
      manifestData = await manifestRes.json();
      if (!manifestData.name) {
        result.missing.push("manifest.json is missing a required 'name' field");
        result.ok = false;
      }
    } catch (err) {
      result.missing.push(`manifest.json could not be parsed as JSON: ${err.message}`);
      result.ok = false;
    }

    if (result.ok) {
      // index.json stores ready-to-use CDN URLs (jsDelivr, mapped to the
      // GitHub repo's default branch) for every file the front-end needs.
      // The site never has to build these paths itself — it just fetches
      // exactly what's stored here. This trades a slightly bigger
      // index.json for zero path-guessing logic on the client and one
      // fewer thing that breaks if folder conventions ever change (only
      // this bot needs updating, not every browser that's ever loaded
      // the site).
      const cdnBase = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@main`;

      result.entry = {
        id: repo.toLowerCase(),
        repo: `${owner}/${repo}`,
        manifestUrl: `${cdnBase}/${manifestFound.name}`,
        readmeUrl: `${cdnBase}/${README_NAME}`,
        // icon.png is a convention, not one of the 5 required checks —
        // if it's not actually in the media folder, the front-end's
        // onerror fallback (glyph icon) will kick in instead of a broken
        // image link.
        iconUrl: `${cdnBase}/${mediaFound.dir}/icon.png`,
        mediaUrls: mediaFound.files.map(f => `${cdnBase}/${mediaFound.dir}/${f}`),
        releaseUrl: release.downloadUrl,
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
