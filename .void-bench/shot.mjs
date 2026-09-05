// Renders each SHADERS variant in bench.html to a PNG via WSL Chrome (SwiftShader). Usage: node shot.mjs [names...]
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const html = readFileSync(new URL('./bench.html', import.meta.url), 'utf8');
const shaders = JSON.parse(html.split('\n')[1].replace(/^const SHADERS=/, '').replace(/;$/, ''));
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(shaders);
const W = 1280, H = 720;
for (const name of names) {
  const dist = name === 'rev10' ? 2.6 : 2.6 / 0.85;
  const page = `<canvas id=c width=${W} height=${H}></canvas><pre id=out></pre><script>
const SRC=${JSON.stringify(shaders[name])};
const gl=document.getElementById('c').getContext('webgl',{preserveDrawingBuffer:true,antialias:false});
function sh(t,src){const s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
const t=Math.PI/3,ct=Math.cos(t),st=Math.sin(t),dist=${dist};
const prog=gl.createProgram();gl.attachShader(prog,sh(gl.VERTEX_SHADER,'attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}'));gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,SRC));gl.linkProgram(prog);gl.useProgram(prog);
const loc=gl.getAttribLocation(prog,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
const U=n=>gl.getUniformLocation(prog,n);
gl.uniform2f(U('u_res'),${W},${H});gl.uniform1f(U('u_focal'),1.2);gl.uniform1f(U('u_time'),0.7);
gl.uniformMatrix3fv(U('u_toDisk'),false,[1,0,0, 0,ct,st, 0,-st,ct]);gl.uniform3f(U('u_origin'),0,-st*dist,ct*dist);gl.uniform1f(U('u_dome'),0);
gl.drawArrays(gl.TRIANGLES,0,3);gl.finish();
document.getElementById('out').textContent=document.getElementById('c').toDataURL('image/png');
</script>`;
  const f = new URL(`./shots/_${name}.html`, import.meta.url);
  writeFileSync(f, page);
  const dom = execSync(`google-chrome --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --dump-dom "file://${f.pathname}" 2>/dev/null`, { maxBuffer: 64e6 }).toString();
  const m = dom.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!m) { console.error(name, 'no image', dom.slice(0, 400)); continue; }
  writeFileSync(new URL(`./shots/${name}.png`, import.meta.url), Buffer.from(m[1], 'base64'));
  console.log(name, 'ok');
}
