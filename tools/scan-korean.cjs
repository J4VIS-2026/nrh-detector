/**
 * 한글 식별자가 남았는지 본다. **주석·문자열은 안 본다** - TypeScript 파서로
 * `Identifier` 노드만 고른다.
 *
 *     node tools/scan-korean.cjs
 */
const ts = require('typescript');
const fs = require('fs');
const path = require('path');

const hangul = /[가-힣]/;

function collect(code, name, found) {
  const src = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  (function walk(n) {
    if (ts.isIdentifier(n) && hangul.test(n.text)) found.set(n.text, (found.get(n.text) ?? 0) + 1);
    n.forEachChild(walk);
  })(src);
}

function files(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|dist|\.git|out|clips/.test(e.name)) files(p, out); }
    else if (/\.(ts|tsx|mjs|js|html)$/.test(e.name) && !e.name.startsWith('scan-')) out.push(p);
  }
  return out;
}

let total = 0;
for (const f of files('.')) {
  const text = fs.readFileSync(f, 'utf8');
  const found = new Map();
  if (f.endsWith('.html')) {
    for (const m of text.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)) collect(m[1], f, found);
  } else collect(text, f, found);
  if (found.size) {
    console.log(`${f}: ${[...found].map(([k, v]) => `${k}(${v})`).join(' ')}`);
    total += found.size;
  }
}
console.log(total === 0 ? '한글 식별자 없음' : `한글 식별자 ${total}종 남음`);
process.exit(total === 0 ? 0 : 1);
