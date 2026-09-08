import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ts = read('../client/src/render/celestialVoid.ts');
const starsTs = read('../client/src/render/celestialVoidStars.ts');

const scope = {};
for (const src of [read('../shared/src/constants.ts'), read('../client/src/config.ts'), ts]) {
  for (const [, name, expr] of src.matchAll(/^(?:export )?const (\w+) =\s*([^;`]+);$/gm)) {
    try { scope[name] = Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope)); } catch {  }
  }
}
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
const starsGen =
  stripTypeScriptTypes(starsTs).replace(/^export /gm, '') +
  `\nconst STAR_GRIDS=${JSON.stringify(grids)};`;
for (const src of [wheel, bake, gas, starsVert, starsFrag]) {
  if (src.includes('${')) throw new Error('unsubstituted: ' + src.match(/\$\{[^}]*\}/)[0]);
}

const html = readFileSync(new URL('./bench.html', import.meta.url), 'utf8');
const old = JSON.parse(html.split('\n')[1].replace(/^const SHADERS=/, '').replace(/;$/, ''));
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
const gl2Start = lines.findIndex((l) => l.startsWith('/*GL2*/'));
const gl2End = lines.findIndex((l) => l.startsWith('/*GL2-END*/'));
lines.splice(gl2Start + 1, gl2End - gl2Start - 1, readFileSync(new URL('./gl2.js', import.meta.url), 'utf8').trimEnd());
const runIdx = lines.findIndex((l) => l.startsWith('try{ '));
const hub = names.filter((k) => k === 'rev20' || k === 'cur');
lines[runIdx] = `try{ prep('rev10',SHADERS.rev10,2.6); for(const k of ${JSON.stringify(names)}) prep(k,SHADERS[k],2.6/${DISK_SCALE});`
  + ` for(const k of ${JSON.stringify(hub)}) prep(k+' @hub',SHADERS[k],2.6/${DISK_SCALE},'hub',progs[k]);`;
writeFileSync(new URL('./bench.html', import.meta.url), lines.join('\n'));
console.log('variants:', names.join(' '));
