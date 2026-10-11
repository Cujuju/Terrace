import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {simplifyLoop} from '../client/src/terrain/contourSmoothing.ts';
import {groupLoops} from '../client/src/terrain/triangulation.ts';
import {drawnBandOfSample} from '../shared/src/index.ts';

const original=JSON.parse(gunzipSync(await readFile(new URL('measurements.json.gz',import.meta.url))));
const prefix=(await readFile(new URL('run.mjs',import.meta.url),'utf8')).split('const output=')[0];
await writeFile(new URL('.visual-model.mjs',import.meta.url),prefix+'\nexport {cases,contours,production,dense,cubicContours,warp};\n');
const {cases,contours,production,dense,cubicContours,warp}=await import('./.visual-model.mjs');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matches=cases.map(f=>({name:f.name,heightsMatch:digest([...f.map.cells])===digest(original.cases.find(c=>c.name===f.name).heights)}));
if(matches.some(m=>!m.heightsMatch))throw new Error('Archived input changed');
const round=v=>Math.round(v*10000)/10000;
const CORNER_TRIM_CELLS=0.15,CORNER_TRIM_FRACTION=0.25,BEZIER_STEPS=8;
function roundedCorners(loops){return loops.map(loop=>{const out=[];for(let i=0;i<loop.length;i++){const p=loop[(i+loop.length-1)%loop.length],q=loop[i],r=loop[(i+1)%loop.length],a=Math.hypot(p.x-q.x,p.z-q.z),b=Math.hypot(r.x-q.x,r.z-q.z),d=Math.min(CORNER_TRIM_CELLS,CORNER_TRIM_FRACTION*Math.min(a,b));if(!d||q.rect){out.push(q);continue;}const enter={x:q.x+(p.x-q.x)*d/a,z:q.z+(p.z-q.z)*d/a},exit={x:q.x+(r.x-q.x)*d/b,z:q.z+(r.z-q.z)*d/b};for(let j=0;j<=BEZIER_STEPS;j++){const t=j/BEZIER_STEPS,u=1-t;out.push({x:u*u*enter.x+2*u*t*q.x+t*t*exit.x,z:u*u*enter.z+2*u*t*q.z+t*t*exit.z,rect:0});}}return out;});}
function pack(loops){return groupLoops(loops.map(simplifyLoop)).map(p=>[p.outer,...p.holes].map(l=>l.map(p=>[round(p.x-32),round(p.z-32)])));}
const data=[];
for(const f of cases){
  const full=f.name==='stamp'||f.name==='stamp-smooth';
  const bands=full?Array.from({length:drawnBandOfSample(Math.max(...f.map.cells))+2},(_,i)=>i):f.name==='layered-opening-control'?[4]:[f.bands.at(-1)];
  const modes={};
  for(const band of bands){
    const baseline=contours(production,f.map,band),reference=contours(dense,f.map,band,false,false);
    const variants={production:baseline,'gentle-bezier':roundedCorners(baseline),'dense-bilinear':reference,'derived-binomial':contours(dense,f.map,band,true,false),'four-corner-smoothstep':reference.map(l=>l.map(p=>({...p,x:warp(p.x),z:warp(p.z)}))),'neighbor-cubic':cubicContours(f.map,band),'packed-position-model':baseline.map(l=>l.map(p=>({...p,x:Math.round(p.x*256)/256,z:Math.round(p.z*256)/256})))};
    for(const [name,loops]of Object.entries(variants))(modes[name]??=[]).push({band,polygons:pack(loops)});
  }
  data.push({name:f.name,full,bands,modes});
}
const serialized=JSON.stringify(data);
await writeFile(new URL('visual-data.json',import.meta.url),serialized);
await writeFile(new URL('visual-data.json.gz',import.meta.url),gzipSync(serialized));
await writeFile(new URL('visual-provenance.json',import.meta.url),JSON.stringify({matches,coordinateRoundingCells:0.0001,loopReduction:'production simplifyLoop epsilon',bezier:{CORNER_TRIM_CELLS,CORNER_TRIM_FRACTION,BEZIER_STEPS,scope:'new appearance candidate; no collision/topology guarantee'},fullBandFields:['stamp','stamp-smooth'],purpose:'offline appearance rendering, not an application/GPU-port screenshot',dataBytes:Buffer.byteLength(serialized)},null,2));
console.log(JSON.stringify({bytes:Buffer.byteLength(serialized),matches}));
