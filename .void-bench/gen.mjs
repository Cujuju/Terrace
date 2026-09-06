// Regenerates bench.html's SHADERS block from client/src/render/celestialVoid.ts.
// Usage: node .void-bench/gen.mjs [name=CONST:value,CONST:value ...]
// Each arg names a variant with GLSL const overrides applied to the wheel, bake, gas AND star
// sources; 'cur' is the unmodified source. Each variant is { wheel, bake, gas, stars } — bake is
// absent for rev10, which predates the log-polar bake and needs no texture; gas is absent for every
// variant that predates the half-res gas pass (#341), i.e. rev10, rev18 and rev19, which march
// inline; and stars is absent for every variant that predates the point cloud (#342), i.e.
// everything up to rev20, which finds its stars in the wheel program instead.
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ts = read('../client/src/render/celestialVoid.ts');
const starsTs = read('../client/src/render/celestialVoidStars.ts');

// Every top-level `const NAME = expr;` whose expression carries no semicolon of its own (so it may
// wrap over lines but is not a function body), evaluated in file order so later ones can use
// earlier ones. The two config files come first because celestialVoid.ts's star extents are derived
// from world and camera constants it IMPORTS (CAMERA_MAX_DISTANCE, MIN_HEIGHT, DEFAULT_WORLD_SPAN);
// anything that still fails to evaluate — a multi-line const, one that reaches for import.meta —
// throws and is dropped, exactly as before. This is what makes `${...}` substitution below need no
// hand-maintained table: the shader's constants have exactly one source, the TS.
const scope = {};
for (const src of [read('../shared/src/constants.ts'), read('../client/src/config.ts'), ts]) {
  for (const [, name, expr] of src.matchAll(/^(?:export )?const (\w+) =\s*([^;`]+);$/gm)) {
    try { scope[name] = Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope)); } catch { /* needs an import, or is not a constant */ }
  }
}
// The star grids' table is the one multi-line const the bench needs a VALUE from: the point cloud's
// generator has to be handed the same three specs the app hands it.
const gridsSrc = ts.match(/^const STAR_GRIDS[^=]*= (\[[\s\S]*?\n\]);$/m)[1];
const grids = Function(...Object.keys(scope), `return (${gridsSrc});`)(...Object.values(scope));
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
const starsVert = inline(block('STARS_VERT_GLSL'));
const starsFrag = inline(block('STARS_FRAG_GLSL'));
// The generator itself, so bench.html and shot.mjs build the very buffers the app builds rather
// than a second implementation of the same formulas. Type stripping (Node 24) leaves the runtime
// bytes untouched; `export` goes because the blob is evaluated as a plain script, not a module.
const starsGen =
  stripTypeScriptTypes(starsTs).replace(/^export /gm, '') +
  `\nconst STAR_GRIDS=${JSON.stringify(grids)};`;
for (const src of [wheel, bake, gas, starsVert, starsFrag]) {
  if (src.includes('${')) throw new Error('unsubstituted: ' + src.match(/\$\{[^}]*\}/)[0]);
}

const html = readFileSync(new URL('./bench.html', import.meta.url), 'utf8');
const old = JSON.parse(html.split('\n')[1].replace(/^const SHADERS=/, '').replace(/;$/, ''));
// Frozen reference variants: shader sources kept in bench.html and never regenerated, so a change
// can be timed against what it replaced on the same harness. rev10 predates DISK_SCALE and is
// posed at the reference's own eye distance; the rest are posed like `cur`.
const FROZEN = ['rev18', 'rev19', 'rev20'];
const asVariant = (v) => typeof v === 'string' ? { wheel: v } : v;
const variant = (w, b, g, sv, sf) => Object.assign({ wheel: w },
  b === null ? {} : { bake: b }, g === null ? {} : { gas: g },
  sv === null ? {} : { stars: { vert: sv, frag: sf, gen: starsGen } });
const out = { rev10: asVariant(old.rev10) };
const names = [];
for (const k of FROZEN) if (old[k]) { out[k] = asVariant(old[k]); names.push(k); }
out.cur = variant(wheel, bake, gas, starsVert, starsFrag); names.push('cur');
for (const arg of process.argv.slice(2)) {
  const [name, ov] = arg.split('=');
  let w = wheel, b = bake, g = gas, sv = starsVert, sf = starsFrag;
  for (const pair of ov.split(',')) {
    const [c, v] = pair.split(':');
    const re = new RegExp(`(const (float|int)\\s+${c}\\s*=\\s*)[^;]+;`);
    if (![w, b, g, sv, sf].some((src) => src !== null && re.test(src))) throw new Error('no const ' + c);
    // A float const needs a float literal: `GAS_BAKE_SIZE:1024` must not compile as an int.
    const sub = (_m, head, type) => `${head}${type === 'float' && /^-?\d+$/.test(v) ? v + '.0' : v};`;
    w = w.replace(re, sub);
    if (b !== null) b = b.replace(re, sub);
    if (g !== null) g = g.replace(re, sub);
    sv = sv.replace(re, sub); sf = sf.replace(re, sub);
  }
  out[name] = variant(w, b, g, sv, sf); names.push(name);
}
const DISK_SCALE = scope['DISK_SCALE'];
const lines = html.split('\n');
lines[1] = 'const SHADERS=' + JSON.stringify(out) + ';';
// Inline gl2.js between its markers: a file:// page cannot load a sibling script.
const gl2Start = lines.findIndex((l) => l.startsWith('/*GL2*/'));
const gl2End = lines.findIndex((l) => l.startsWith('/*GL2-END*/'));
lines.splice(gl2Start + 1, gl2End - gl2Start - 1, readFileSync(new URL('./gl2.js', import.meta.url), 'utf8').trimEnd());
const runIdx = lines.findIndex((l) => l.startsWith('try{ '));
// The point cloud's cost depends on the POSE (the march's did not), so the two variants that
// bracket phase 3 are timed at the hub pose as well as at the reference one.
const hub = names.filter((k) => k === 'rev20' || k === 'cur');
lines[runIdx] = `try{ prep('rev10',SHADERS.rev10,2.6); for(const k of ${JSON.stringify(names)}) prep(k,SHADERS[k],2.6/${DISK_SCALE});`
  + ` for(const k of ${JSON.stringify(hub)}) prep(k+' @hub',SHADERS[k],2.6/${DISK_SCALE},'hub',progs[k]);`;
writeFileSync(new URL('./bench.html', import.meta.url), lines.join('\n'));
console.log('variants:', names.join(' '));
