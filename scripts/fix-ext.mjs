// Idempotent, correct rewriter for relative import/export specifiers so the
// compiled output runs under Node's native ESM resolver (--module NodeNext).
//   './foo'            -> './foo.js'             (foo.ts/.tsx/.jsx exists)
//   './tools'          -> './tools/index.js'     (directory with index.*)
//   './tools.js'       -> './tools/index.js'     (stray .js on a directory)
//   './opentui/index'  -> './opentui/index.js'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const srcExts = ['.ts', '.tsx', '.jsx'];

function resolveToSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const noJs = spec.replace(/\.js$/, '');
  const base = resolve(dirname(fromFile), noJs);
  // Directory with index file?
  let st;
  try {
    st = statSync(base);
  } catch {
    st = null;
  }
  if (st && st.isDirectory()) {
    for (const e of srcExts) {
      if (existsSync(join(base, 'index' + e))) return `${noJs}/index.js`;
    }
    return null; // directory without index: leave alone
  }
  // File: exists as .ts/.tsx/.jsx?
  for (const e of srcExts) {
    if (existsSync(base + e)) return `${noJs}.js`;
  }
  // non-source file (.js/.json) — keep as-is
  if (existsSync(base + '.js') || existsSync(base + '.json')) return null;
  return null;
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(ts|tsx|jsx|mts|cts)$/.test(name)) continue;
    if (name.endsWith('.d.ts')) continue;
    let src = readFileSync(p, 'utf8');
    const re =
      /(\bfrom\s+|\bimport\s+|\bexport\s+\*\s+from\s+|\bexport\s*\{[^}]*\}\s+from\s+)(['"])(\.[^'"]*?)(['"])/g;
    const dynRe = /\bimport\s*\(\s*(['"])(\.[^'"]*?)\1\s*\)/g;
    let changed = false;
    let out = src.replace(re, (m, kw, q1, spec, q2) => {
      const fixed = resolveToSpec(p, spec);
      if (!fixed || fixed === spec) return m;
      changed = true;
      return `${kw}${q1}${fixed}${q2}`;
    });
    out = out.replace(dynRe, (m, q, spec) => {
      const fixed = resolveToSpec(p, spec);
      if (!fixed || fixed === spec) return m;
      changed = true;
      return `import(${q}${fixed}${q})`;
    });
    if (changed) {
      writeFileSync(p, out);
      console.log('patched', p.replace(root, 'src'));
    }
  }
}
walk(root);
console.log('done');
