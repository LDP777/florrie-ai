/**
 * Apply the emoji verdicts, and only the verdicts.
 *
 * 134 remaining emoji sites were classified one at a time by reading where each
 * value is CONSUMED rather than where it is written, then every "safe to
 * convert" call was handed to a second pass whose only job was to refute it.
 * 92 convert, 41 are copy, 1 is the brand mark.
 *
 * The 41 matter more than the 92. They are message bodies: Campaigns'
 * MESSAGE_TEMPLATES seed campaigns.message_template, which the backend passes
 * verbatim as the `body` of a real WhatsApp message. Converting one would send
 * a client the word "sparkles". That is the whole reason this is a verdict file
 * applied by a script and not a regex over \p{Extended_Pictographic}.
 *
 * Two edit shapes, decided from the AST rather than from the line:
 *   - a string in a data object   { icon: '✨' }  ->  { icon: 'sparkles' }
 *     (the render site already calls iconName(), so the name resolves)
 *   - a glyph in JSX text          <span>📬</span> ->  <Icon name="inbox" inline />
 *
 * Anything the classifier was not certain about is left exactly as it is.
 *
 *   node scripts/codemod-emoji-verdicts.mjs           # report
 *   node scripts/codemod-emoji-verdicts.mjs --write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const SRC = new URL('../src', import.meta.url).pathname;
const VERDICTS = process.env.VERDICTS || '/tmp/inv2/verdicts.json';
const WRITE = process.argv.includes('--write');

const all = JSON.parse(readFileSync(VERDICTS, 'utf8'));
const converts = all.filter(s => s.verdict === 'convert' && s.iconName);

const byFile = {};
for (const s of converts) (byFile[s.file] ||= []).push(s);

let inData = 0, inJsx = 0, missed = 0, filesTouched = 0;
const notes = [];

for (const [rel, sites] of Object.entries(byFile)) {
  const file = join(SRC, rel);
  let code;
  try { code = readFileSync(file, 'utf8'); }
  catch { notes.push(`${rel}: gone`); continue; }

  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'] }); }
  catch (err) { notes.push(`${rel}: does not parse (${err.message})`); continue; }

  // Line numbers drift. The verdicts were taken before the icon-as-text and
  // money codemods ran, and both inserted lines into these same files, so an
  // exact line match silently lost 28 approved sites — a fix that reports
  // success and does two thirds of the job.
  //
  // So: match on the glyph, and take the candidate nearest the recorded line.
  // The glyph has to agree, which is what stops a verdict for one 💬 being
  // applied to a different 💬 elsewhere in the file; the window only decides
  // between candidates that are already identical.
  const pending = sites.map(s => ({ ...s, used: false }));
  const WINDOW = 40;

  const edits = [];
  const same = (a, b) => {
    const norm = x => x.replace(/️|‍/g, '');
    return norm(a) === norm(b);
  };
  const claim = (line, glyph) => {
    let best = null, bestDist = Infinity;
    for (const s of pending) {
      if (s.used || !same(s.glyph, glyph)) continue;
      const d = Math.abs(s.line - line);
      if (d < bestDist) { best = s; bestDist = d; }
    }
    if (!best || bestDist > WINDOW) return null;
    best.used = true;
    return best;
  };

  traverse(ast, {
    // { icon: '✨' } — swap the value for the glyph name.
    StringLiteral(path) {
      const line = path.node.loc.start.line;
      const value = path.node.value;
      if (!/\p{Extended_Pictographic}/u.test(value)) return;
      // Only a lone glyph. A string with words in it is copy, whatever the
      // verdict said, and the classifier's own rule agrees.
      const stripped = value.replace(/[\p{Extended_Pictographic}️‍\s]/gu, '');
      if (stripped.length) return;
      const site = claim(line, value.trim());
      if (!site) return;
      edits.push({ start: path.node.start, end: path.node.end, text: `'${site.iconName}'` });
      inData++;
    },

    // <span>📬</span> — replace the glyph itself with an <Icon>.
    JSXText(path) {
      const raw = path.node.value;
      if (!/\p{Extended_Pictographic}/u.test(raw)) return;
      const startLine = path.node.loc.start.line;
      for (const m of [...raw.matchAll(/\p{Extended_Pictographic}️?/gu)]) {
        const before = raw.slice(0, m.index);
        const line = startLine + (before.match(/\n/g) || []).length;
        const site = claim(line, m[0]);
        if (!site) continue;
        edits.push({
          start: path.node.start + m.index,
          end: path.node.start + m.index + m[0].length,
          text: `{<Icon name="${site.iconName}" inline />}`,
        });
        inJsx++;
      }
    },
  });

  for (const s of pending) {
    if (s.used) continue;
    missed++;
    notes.push(`${rel}:${s.line} ${s.glyph} -> ${s.iconName}: could not locate it; left alone`);
  }

  if (!edits.length) continue;
  filesTouched++;
  if (!WRITE) continue;

  let out = code;
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  if (/<Icon /.test(out) && !/^import Icon[ ,]/m.test(out)) {
    const depth = rel.split('/').length - 1;
    const path0 = rel.startsWith('components/ui/') ? './Icon'
      : (depth === 0 ? './components/ui/Icon' : '../'.repeat(depth) + 'components/ui/Icon');
    const lastImport = [...out.matchAll(/^import .*$/gm)].pop();
    const line = `import Icon from '${path0}';`;
    out = lastImport
      ? out.slice(0, lastImport.index + lastImport[0].length) + '\n' + line + out.slice(lastImport.index + lastImport[0].length)
      : line + '\n' + out;
  }

  try { parse(out, { sourceType: 'module', plugins: ['jsx'] }); }
  catch (err) { notes.push(`${rel}: REFUSED, would not parse (${err.message})`); continue; }
  writeFileSync(file, out);
}

const kept = all.length - converts.length;
console.log(`${WRITE ? 'converted' : 'would convert'} ${inData + inJsx} of ${converts.length} approved sites across ${filesTouched} files`);
console.log(`  ${inData} icon names in data, ${inJsx} glyphs in markup`);
console.log(`  ${kept} deliberately kept (message bodies, sentinels, the brand mark)`);
if (missed) console.log(`  ${missed} could not be located and were left alone`);
for (const n of notes.slice(0, 20)) console.log('    ' + n);
