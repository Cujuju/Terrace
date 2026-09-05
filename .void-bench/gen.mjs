// Regenerates bench.html's SHADERS block from client/src/render/celestialVoid.ts.
// Usage: node .void-bench/gen.mjs [name=CONST:value,CONST:value ...]
// Each arg names a variant with GLSL const overrides applied to WHEEL_GLSL; 'cur' is the unmodified source.
import { readFileSync, writeFileSync } from 'node:fs';
const ts = readFileSync(new URL('../client/src/render/celestialVoid.ts', import.meta.url), 'utf8');
const num = (n) => Number(ts.match(new RegExp(`^const ${n} = ([^;]+);`, 'm'))[1].replace(/[^0-9./*-]/g, '') ? eval(ts.match(new RegExp(`^const ${n} = ([^;]+);`, 'm'))[1]) : 0);
const DISK_SCALE = num('DISK_SCALE');
const WPU = 200 * DISK_SCALE;
const subs = {
  'NEBULA_ZOOM.toFixed(1)': num('NEBULA_ZOOM').toFixed(1),
  'DISK_THICKNESS.toFixed(3)': (num('DISK_THICKNESS_WORLD') / WPU).toFixed(3),
  'STAR_FIELD_DEPTH.toFixed(3)': (num('STAR_FIELD_DEPTH_WORLD') / WPU).toFixed(3),
};
const block = (name) => ts.match(new RegExp(`const ${name} = /\\* glsl \\*/ \`([\\s\\S]*?)\n\`;`, 'm'))[1];
const common = block('COMMON_GLSL');
let wheel = block('WHEEL_GLSL').replace('${COMMON_GLSL}', common);
for (const [k, v] of Object.entries(subs)) wheel = wheel.split('${' + k + '}').join(v);
if (wheel.includes('${')) throw new Error('unsubstituted: ' + wheel.match(/\$\{[^}]*\}/)[0]);
const html = readFileSync(new URL('./bench.html', import.meta.url), 'utf8');
const old = JSON.parse(html.split('\n')[1].replace(/^const SHADERS=/, '').replace(/;$/, ''));
const out = { rev10: old.rev10, cur: wheel };
const names = ['cur'];
for (const arg of process.argv.slice(2)) {
  const [name, ov] = arg.split('=');
  let src = wheel;
  for (const pair of ov.split(',')) {
    const [c, v] = pair.split(':');
    const re = new RegExp(`(const (?:float|int)\\s+${c}\\s*=\\s*)[^;]+;`);
    if (!re.test(src)) throw new Error('no const ' + c);
    src = src.replace(re, `$1${v};`);
  }
  out[name] = src; names.push(name);
}
const lines = html.split('\n');
lines[1] = 'const SHADERS=' + JSON.stringify(out) + ';';
const runIdx = lines.findIndex((l) => l.startsWith('try{ '));
lines[runIdx] = `try{ prep('rev10',SHADERS.rev10,2.6); for(const k of ${JSON.stringify(names)}) prep(k,SHADERS[k],2.6/${DISK_SCALE});`;
writeFileSync(new URL('./bench.html', import.meta.url), lines.join('\n'));
console.log('variants:', names.join(' '));
