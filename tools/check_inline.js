// AshGrid inline-script syntax gate (Phase 185) — index.html still carries a
// large inline <script> (the game loop / update / render / match setup). The CI
// `find js -name '*.js' | node --check` step CANNOT see it, so a typo there (or
// a botched modularization extraction) ships a hard parse error with zero test
// coverage. This parses every SRCLESS inline <script> block in index.html in
// script context (vm.Script compiles + throws SyntaxError WITHOUT executing) so
// the bloat-reduction / extraction work can't silently break the boot.
//
//   node tools/check_inline.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'index.html');
const raw = fs.readFileSync(file, 'utf8');
// Blank out HTML comments (keep newlines so line numbers stay accurate) — some
// comments contain the literal text "<script>"/"</script>" and would otherwise
// be matched as fake inline blocks.
const html = raw.replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '));

// Match only bare `<script>` … `</script>` (no attributes → inline classic
// script). `<script src=...>` and `<script type="module">` are skipped (the
// former has nothing to parse here; we have no inline modules).
const re = /<script>([\s\S]*?)<\/script>/g;
let m, idx = 0, problems = 0, checked = 0;
while ((m = re.exec(html)) !== null) {
  const code = m[1];
  if (!code.trim()) continue;
  idx++;
  // line number of this block's opening tag (for a useful error location)
  const line = html.slice(0, m.index).split('\n').length;
  try {
    // Parses as a top-level script; does NOT run. Throws on syntax errors.
    new vm.Script(code, { filename: `index.html#inline@${line}` });
    checked++;
    const lines = code.split('\n').length;
    console.log(`  ✓ inline <script> @ line ${line} parses (${lines} lines)`);
  } catch (e) {
    problems++;
    console.error(`  ✗ inline <script> @ line ${line}: ${e.name}: ${e.message}`);
  }
}

if (idx === 0) {
  console.error('FAIL — no inline <script> blocks found in index.html (regex/structure changed?)');
  process.exit(1);
}
if (problems === 0) {
  console.log(`OK — ${checked} inline <script> block(s) parse cleanly.`);
  process.exit(0);
}
console.error(`\nFAIL — ${problems} inline <script> block(s) have syntax errors.`);
process.exit(1);
