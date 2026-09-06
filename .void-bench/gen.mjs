// Regenerates bench.html's SHADERS block from client/src/render/celestialVoid.ts.
// Usage: node .void-bench/gen.mjs [name=CONST:value,CONST:value ...]
// Each arg names a variant with GLSL const overrides applied to the wheel, bake AND gas sources;
// 'cur' is the unmodified source. Each variant is { wheel, bake, gas } — bake is absent for rev10,
// which predates the log-polar bake and needs no texture, and gas is absent for every variant that
// predates the half-res gas pass (#341), i.e. rev10, rev18 and rev19, which march inline.
import { readFileSync, writeFileSync } from 'node:fs';
const ts = readFileSync(new URL('../client/src/render/celestialVoid.ts', import.meta.url), 'utf8');

// Every single-line top-level `const NAME = expr;` in the TS, evaluated in file order so later
// ones can use earlier ones. The few that reach for an import (MIN_HEIGHT) throw and are dropped;
// nothing the GLSL interpolates depends on them. This is what makes `${...}` substitution below
// need no hand-maintained table: the shader's constants have exactly one source, the TS.
const scope = {};
for (const [, name, expr] of ts.matchAll(/^const (\w+) = ([^;`]+);$/gm)) {
  try { scope[name] = Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope)); } catch { /* needs an import */ }
}
const subst = (src) => src.replace(/\$\{([^}]+)\}/g, (_, expr) =>
  Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope)));

const block = (name) => {
  const m = ts.match(new RegExp(`const ${name} = /\\* glsl \\*/ \`([\\s\\S]*?)\n\`;`, 'm'));
  return m ? m[1] : null;
};
const common = block('COMMON_GLSL');
const fields = block('WHEEL_FIELDS_GLSL')?.replace('${COMMON_GLSL}', common) ?? null;
const inline = (src) => src === null ? null
  : subst(src.replace('${WHEEL_FIELDS_GLSL}', fields ?? '').replace('${COMMON_GLSL}', common));
const wheel = inline(block('WHEEL_GLSL'));
const bake = inline(block('BAKE_GLSL'));
const gas = inline(block('GAS_GLSL'));
if (wheel.includes('${')) throw new Error('unsubstituted: ' + wheel.match(/\$\{[^}]*\}/)[0]);

const html = readFileSync(new URL('./bench.html', import.meta.url), 'utf8');
const old = JSON.parse(html.split('\n')[1].replace(/^const SHADERS=/, '').replace(/;$/, ''));
// Frozen reference variants: shader sources kept in bench.html and never regenerated, so a change
// can be timed against what it replaced on the same harness. rev10 predates DISK_SCALE and is
// posed at the reference's own eye distance; the rest are posed like `cur`.
const FROZEN = ['rev18', 'rev19'];
const asVariant = (v) => typeof v === 'string' ? { wheel: v } : v;
const variant = (w, b, g) => Object.assign({ wheel: w }, b === null ? {} : { bake: b }, g === null ? {} : { gas: g });
const out = { rev10: asVariant(old.rev10) };
const names = [];
for (const k of FROZEN) if (old[k]) { out[k] = asVariant(old[k]); names.push(k); }
out.cur = variant(wheel, bake, gas); names.push('cur');
for (const arg of process.argv.slice(2)) {
  const [name, ov] = arg.split('=');
  let w = wheel, b = bake, g = gas;
  for (const pair of ov.split(',')) {
    const [c, v] = pair.split(':');
    const re = new RegExp(`(const (float|int)\\s+${c}\\s*=\\s*)[^;]+;`);
    if (![w, b, g].some((src) => src !== null && re.test(src))) throw new Error('no const ' + c);
    // A float const needs a float literal: `GAS_BAKE_SIZE:1024` must not compile as an int.
    const sub = (_m, head, type) => `${head}${type === 'float' && /^-?\d+$/.test(v) ? v + '.0' : v};`;
    w = w.replace(re, sub);
    if (b !== null) b = b.replace(re, sub);
    if (g !== null) g = g.replace(re, sub);
  }
  out[name] = variant(w, b, g); names.push(name);
}
const DISK_SCALE = scope['DISK_SCALE'];
const lines = html.split('\n');
lines[1] = 'const SHADERS=' + JSON.stringify(out) + ';';
// Inline gl2.js between its markers: a file:// page cannot load a sibling script.
const gl2Start = lines.findIndex((l) => l.startsWith('/*GL2*/'));
const gl2End = lines.findIndex((l) => l.startsWith('/*GL2-END*/'));
lines.splice(gl2Start + 1, gl2End - gl2Start - 1, readFileSync(new URL('./gl2.js', import.meta.url), 'utf8').trimEnd());
const runIdx = lines.findIndex((l) => l.startsWith('try{ '));
lines[runIdx] = `try{ prep('rev10',SHADERS.rev10,2.6); for(const k of ${JSON.stringify(names)}) prep(k,SHADERS[k],2.6/${DISK_SCALE});`;
writeFileSync(new URL('./bench.html', import.meta.url), lines.join('\n'));
console.log('variants:', names.join(' '));
