// Renders each SHADERS variant in bench.html to PNGs via WSL Chrome (SwiftShader).
// Two poses per variant: shots/<name>.png (the view anchor, the reference framing) and
// shots/<name>_hub.png (the same tilt zoomed on the hub, where the bake's texels are largest).
// Usage: node shot.mjs [names...]
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const html = readFileSync(new URL('./bench.html', import.meta.url), 'utf8');
const shaders = JSON.parse(html.split('\n')[1].replace(/^const SHADERS=/, '').replace(/;$/, ''));
const gl2 = readFileSync(new URL('./gl2.js', import.meta.url), 'utf8');
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(shaders);
const W = 1280, H = 720;
for (const name of names) {
  // rev10 predates DISK_SCALE, so it keeps the reference's own eye distance.
  const dist = name === 'rev10' ? 2.6 : 2.6 / 0.85;
  const variant = typeof shaders[name] === 'string' ? { wheel: shaders[name] } : shaders[name];
  for (const kind of ['view', 'hub']) {
    const page = `<canvas id=c width=${W} height=${H}></canvas><pre id=out></pre><script>
${gl2}
const V=${JSON.stringify(variant)};
try{
const gl=makeGL(document.getElementById('c'));
const P=prepVariant(gl,V,${W},${H},${dist},${JSON.stringify(kind)});
drawFrame(gl,P,${W},${H},0.7);gl.finish();
document.getElementById('out').textContent=document.getElementById('c').toDataURL('image/png');
}catch(e){document.getElementById('out').textContent='ERR '+e.message;}
</script>`;
    const suffix = kind === 'hub' ? '_hub' : '';
    const f = new URL(`./shots/_${name}${suffix}.html`, import.meta.url);
    writeFileSync(f, page);
    const dom = execSync(`google-chrome --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --dump-dom "file://${f.pathname}" 2>/dev/null`, { maxBuffer: 64e6 }).toString();
    const m = dom.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
    if (!m) { console.error(name, kind, 'no image', dom.slice(0, 600)); continue; }
    writeFileSync(new URL(`./shots/${name}${suffix}.png`, import.meta.url), Buffer.from(m[1], 'base64'));
    console.log(name + suffix, 'ok');
  }
}
