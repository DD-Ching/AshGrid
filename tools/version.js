#!/usr/bin/env node
/* eslint-disable */
// ============ ASSET VERSION STAMP + INTEGRITY CHECK (Phase 142) ============
// One tiny tool to kill a whole class of deploy bugs:
//   • cache staleness — a JS file changed but its index.html ?v= didn't, so
//     browsers keep the old cached copy.
//   • version drift — ?v= numbers scattered (180/186/190/192…), impossible to
//     reason about "what's deployed".
//   • forgot `git add` — index.html references js/new_file.js but the file was
//     never committed, so on deploy it 404s and the page silently falls back.
//
// Usage (run from anywhere; paths resolve against the repo root):
//   node tools/version.js check        verify every <script src="js/*"> file
//                                       exists, is git-tracked, and shares ONE
//                                       version; also verify sw.js ASSETS exist.
//                                       Exits 1 on any problem (CI / pre-commit).
//   node tools/version.js stamp [N]    set every local js ?v= AND the sw.js
//                                       cache name to version N (default: the
//                                       current max + 1). Adds ?v= to bare tags.
//
// No dependencies. CommonJS. Single source of truth for the build version.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const SW = path.join(ROOT, 'sw.js');

// Match a local js <script src>, capturing path + (optional) version.
//   group 1 = js path (e.g. js/foo.js or js/audio/bar.js)
//   group 3 = version digits, or undefined when the tag has no ?v=
const SCRIPT_RE = /<script\s+src="(js\/[^"?]+\.js)(\?v=(\d+))?"/g;

function read(f)  { return fs.readFileSync(f, 'utf8'); }
function write(f, s) { fs.writeFileSync(f, s); }

// Set of files git knows about (tracked OR staged). A file referenced by
// index.html but absent here is the classic "forgot git add → silent fallback".
function gitTrackedSet() {
  let out = '';
  try { out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }); }
  catch (e) { console.warn('  (warning: git not available — skipping tracked check)'); return null; }
  return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
}

function scriptTags(html) {
  const tags = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    tags.push({ jsPath: m[1], version: m[3] != null ? m[3] : null });
  }
  return tags;
}

// sw.js precache list — extract the quoted './...' relative paths.
function swAssets(swSrc) {
  const out = [];
  const re = /'(\.\/[^']+)'/g;
  let m;
  while ((m = re.exec(swSrc)) !== null) out.push(m[1]);
  return out;
}

function check() {
  const html = read(INDEX);
  const tags = scriptTags(html);
  const tracked = gitTrackedSet();
  let problems = 0;
  const versions = new Set();

  console.log(`Checking ${tags.length} local <script src="js/*"> tags…`);
  for (const t of tags) {
    const abs = path.join(ROOT, t.jsPath);
    if (!fs.existsSync(abs)) { console.error(`  MISSING FILE   ${t.jsPath}`); problems++; continue; }
    if (tracked && !tracked.has(t.jsPath)) { console.error(`  NOT GIT-TRACKED ${t.jsPath}  (forgot git add?)`); problems++; }
    if (t.version == null) { console.error(`  NO ?v=         ${t.jsPath}`); problems++; versions.add('none'); }
    else versions.add(t.version);
  }

  if (versions.size > 1) {
    console.error(`  VERSION DRIFT  ${tags.length} tags carry ${versions.size} different versions: ${[...versions].sort().join(', ')}`);
    problems++;
  } else if (versions.size === 1) {
    console.log(`  ✓ single version: ${[...versions][0]}`);
  }

  // sw.js precache integrity
  if (fs.existsSync(SW)) {
    const assets = swAssets(read(SW));
    let missingAssets = 0;
    for (const a of assets) {
      if (!fs.existsSync(path.join(ROOT, a))) { console.error(`  MISSING ASSET  (sw.js) ${a}`); missingAssets++; }
    }
    if (missingAssets === 0) console.log(`  ✓ sw.js: ${assets.length} precache assets all present`);
    problems += missingAssets;
  }

  if (problems === 0) { console.log('OK — all script files exist, are tracked, and share one version.'); process.exit(0); }
  console.error(`FAIL — ${problems} problem(s).`);
  process.exit(1);
}

function currentMaxVersion(html) {
  let max = 0;
  for (const t of scriptTags(html)) if (t.version != null) max = Math.max(max, parseInt(t.version, 10));
  // also consider the sw cache number so we never go backwards
  if (fs.existsSync(SW)) {
    const m = read(SW).match(/ashgrid-v(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

function stamp(nArg) {
  let html = read(INDEX);
  const N = nArg != null ? parseInt(nArg, 10) : currentMaxVersion(html) + 1;
  if (!Number.isInteger(N) || N <= 0) { console.error(`Bad version: ${nArg}`); process.exit(1); }

  // Stamp every local js tag: rewrite ?v=… or add it where missing.
  let stamped = 0;
  html = html.replace(SCRIPT_RE, (full, jsPath) => {
    stamped++;
    return `<script src="${jsPath}?v=${N}"`;
  });
  write(INDEX, html);

  // Stamp the sw.js cache name's version number (keep the descriptive suffix).
  let swChanged = false;
  if (fs.existsSync(SW)) {
    const src = read(SW);
    const next = src.replace(/ashgrid-v\d+/, `ashgrid-v${N}`);
    if (next !== src) { write(SW, next); swChanged = true; }
  }

  console.log(`Stamped ${stamped} script tags → ?v=${N}${swChanged ? '; sw.js cache → ashgrid-v' + N : ''}.`);
  console.log('Run `node tools/version.js check` + a browser load to verify.');
}

const [, , cmd, arg] = process.argv;
if (cmd === 'check') check();
else if (cmd === 'stamp') stamp(arg);
else { console.error('Usage: node tools/version.js <check|stamp [N]>'); process.exit(2); }
