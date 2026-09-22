import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { applySculpt, createHeightmap, bandLevelHeight, drawnLevelThreshold, DRAWN_GROUND_BAND_BIAS as BIAS, DEFAULT_SCULPT_AMOUNT, columnSampleAtBand, setColumn, BEDROCK_BAND } from '../shared/src/index.ts';
import * as production from '../client/src/terrain/contours.ts';
import { simplifyLoop } from '../client/src/terrain/contourSmoothing.ts';

// Disposable offline measurements; no application mutations or regression assertions.
const SIZE=64, ORIGIN=16, SPAN=32, DENSE_SEGMENTS=32, ARC_STEP=0.25;
const FILTER_WEIGHTS=[1,2,1], FILTER_DENOM=16, ROOT_STEPS=40;
const source=await readFile(new URL('../client/src/terrain/contours.ts',import.meta.url),'utf8');
const denseSource=`const ISOLINE_SAMPLES_PER_CELL = ${DENSE_SEGMENTS};\n`+source
  .replace('  ISOLINE_SAMPLES_PER_CELL,','')
  .replace("from '@terrace/shared'",`from '${new URL('../shared/src/index.ts',import.meta.url).href}'`)
  .replace("from './mirror.ts'",`from '${new URL('../client/src/terrain/mirror.ts',import.meta.url).href}'`);
await writeFile(new URL('dense-contours.ts',import.meta.url),denseSource);
const dense=await import('./dense-contours.ts');
const SUBCELLS=8, FIELD_SCALE=256;
const fineSource=denseSource.replace(`const ISOLINE_SAMPLES_PER_CELL = ${DENSE_SEGMENTS};`,'const ISOLINE_SAMPLES_PER_CELL = 1;').replace('Math.max(CHUNK_SIZE, 2 * MAX_BRUSH_RADIUS + 2)',String(SPAN*SUBCELLS));
await writeFile(new URL('fine-contours.ts',import.meta.url),fineSource);
const fine=await import('./fine-contours.ts');
const clone=m=>({size:m.size,cells:Int16Array.from(m.cells),columnSpans:new Map([...m.columnSpans].map(([k,v])=>[k,Int16Array.from(v)]))});
const cases=[], map=createHeightmap(SIZE), strokes=[];
map.cells.fill(bandLevelHeight(0));
function stroke(x,y,radius,amount,options){const changed=applySculpt(map,x,y,radius,amount,options);strokes.push({x,y,radius,amount,options,changedCells:changed.length});}
const stamp={tool:'stamp',profile:'soft',anchor:'clicked',spill:'banded'};
for(let p=0;p<12;p++)stroke(32,32,4,DEFAULT_SCULPT_AMOUNT,stamp);
for(let p=0;p<3;p++)stroke(35,30,2,DEFAULT_SCULPT_AMOUNT,stamp);
cases.push({name:'stamp',map:clone(map),strokes:[...strokes],bands:[4,8,12]});
for(const [x,y] of [[30,27],[27,30],[36,32],[31,36]])for(let p=0;p<3;p++)stroke(x,y,6,-DEFAULT_SCULPT_AMOUNT,{tool:'smooth',anchor:'clicked',spill:'banded',smoothLambda:50});
cases.push({name:'stamp-smooth',map:clone(map),strokes:[...strokes],bands:[4,8,12]});
const analytic=createHeightmap(SIZE);
for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++)analytic.cells[y*SIZE+x]=bandLevelHeight(16)-(x-32)**2-(y-32)**2;
cases.push({name:'integer-paraboloid-control',map:analytic,strokes:[],bands:[4,8,12]});
const needle=createHeightmap(SIZE);needle.cells.fill(bandLevelHeight(0));needle.cells[32*SIZE+32]=bandLevelHeight(1);
cases.push({name:'single-cell-band-control',map:needle,strokes:[],bands:[1]});
const hole=createHeightmap(SIZE);hole.cells.fill(bandLevelHeight(0));hole.cells[32*SIZE+32]=bandLevelHeight(-1);
cases.push({name:'single-cell-water-hole-control',map:hole,strokes:[],bands:[0]});
const layered=clone(cases[0].map);
for(let y=29;y<=35;y++)for(let x=29;x<=35;x++)setColumn(layered,x,y,[{floorBand:BEDROCK_BAND,ceiling:bandLevelHeight(2)},{floorBand:8,ceiling:sampleUnchecked(layered,x,y)}]);
cases.push({name:'layered-opening-control',map:layered,strokes:[],bands:[4,8,12]});
function sampleUnchecked(m,x,y){return m.cells[y*SIZE+x];}
const sample=(m,x,y)=>m.cells[Math.max(0,Math.min(SIZE-1,y))*SIZE+Math.max(0,Math.min(SIZE-1,x))];
function bandSample(m,x,y,band){return m.columnSpans.size?columnSampleAtBand(m,Math.max(0,Math.min(SIZE-1,x)),Math.max(0,Math.min(SIZE-1,y)),band):sample(m,x,y);}
function filtered(m,x,y,band){let n=0;for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++)n+=bandSample(m,x+i,y+j,band)*FILTER_WEIGHTS[i+1]*FILTER_WEIGHTS[j+1];return n;}
function contours(mod,m,band,filter=false,thin=true){
  mod.loadSampleField((x,y)=>filter?filtered(m,x+ORIGIN,y+ORIGIN,band):bandSample(m,x+ORIGIN,y+ORIGIN,band),SPAN);
  const threshold=filter?(drawnLevelThreshold(band)-BIAS)*FILTER_DENOM+BIAS:drawnLevelThreshold(band);
  const count=mod.marchLevel(threshold,ORIGIN,ORIGIN,null);
  const loops=mod.assembleLoops(count,ORIGIN,ORIGIN,mod.domainInside(threshold,null));
  return thin?loops.map(simplifyLoop):loops;
}
function cubic(a,b,c,d,t){return b+0.5*t*(c-a+t*(2*a-5*b+4*c-d+t*(3*(b-c)+d-a)));}
function cubicField(m,x,y,band){const ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy;const r=[];for(let j=-1;j<=2;j++)r.push(cubic(...[-1,0,1,2].map(i=>bandSample(m,ix+i,iy+j,band)),tx));return cubic(...r,ty);}
function cubicContours(m,band){fine.loadSampleField((x,y)=>Math.round(cubicField(m,ORIGIN+x/SUBCELLS,ORIGIN+y/SUBCELLS,band)*FIELD_SCALE),SPAN*SUBCELLS);const threshold=(drawnLevelThreshold(band)-BIAS)*FIELD_SCALE+BIAS;const count=fine.marchLevel(threshold,0,0,null);return fine.assembleLoops(count,0,0,fine.domainInside(threshold,null)).map(l=>l.map(p=>({...p,x:ORIGIN+p.x/SUBCELLS,z:ORIGIN+p.z/SUBCELLS})));}
function inverseSmooth(t){let lo=0,hi=1;for(let i=0;i<ROOT_STEPS;i++){const m=(lo+hi)/2;if(m*m*(3-2*m)<t)lo=m;else hi=m;}return (lo+hi)/2;}
function warp(v){const a=Math.floor(v);return a+inverseSmooth(v-a);}
function resample(loop){const out=[];let next=0;for(let i=0;i<loop.length;i++){const a=loop[i],b=loop[(i+1)%loop.length],len=Math.hypot(b.x-a.x,b.z-a.z);if(!len)continue;while(next<len){out.push({x:a.x+(b.x-a.x)*next/len,z:a.z+(b.z-a.z)*next/len});next+=ARC_STEP;}next-=len;}return out;}
function metrics(loops){let length=0,area=0,turn=0,vertices=0,maxTurn=0;for(const l of loops){vertices+=l.length;for(let i=0;i<l.length;i++){const a=l[i],b=l[(i+1)%l.length];length+=Math.hypot(b.x-a.x,b.z-a.z);area+=(a.x*b.z-a.z*b.x)/2;}const p=resample(l);for(let i=0;i<p.length;i++){const a=p[(i+p.length-1)%p.length],b=p[i],c=p[(i+1)%p.length];const ux=b.x-a.x,uz=b.z-a.z,vx=c.x-b.x,vz=c.z-b.z;const angle=Math.abs(Math.atan2(ux*vz-uz*vx,ux*vx+uz*vz));turn+=angle;maxTurn=Math.max(maxTurn,angle);}}return {loops:loops.length,vertices,length,area:Math.abs(area),absoluteTurn:turn,maxTurnDeg:maxTurn*180/Math.PI};}
function distance(p,a,b){const dx=b.x-a.x,dz=b.z-a.z;const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz)||0));return Math.hypot(p.x-a.x-t*dx,p.z-a.z-t*dz);}
function displacement(loops,base){if(!loops.length||!base.length)return null;let max=0,sum=0,count=0;for(const l of loops)for(const p of resample(l)){let best=Infinity;for(const r of base)for(let i=0;i<r.length;i++)best=Math.min(best,distance(p,r[i],r[(i+1)%r.length]));sum+=best;max=Math.max(max,best);count++;}return {sampledMaxCells:max,meanCells:sum/count};}
const output={sourceCommit:'4df27771dca0181dfd313cf85ec199cb42ae3be8',sourceHash:createHash('sha256').update(source).digest('hex'),scope:'Synthetic offline production-sculpt reproduction, not photographed patch. CPU extraction. Dense baseline retains production saddle decisions, not independent topology truth. Packed baseline models quantization, not GPU execution. Cubic is experimental float evaluation, not a deterministic production contract.',settings:{SIZE,ORIGIN,SPAN,DENSE_SEGMENTS,ARC_STEP,FILTER_WEIGHTS,FILTER_DENOM,SUBCELLS,FIELD_SCALE},cases:[]};
for(const f of cases){const rows=[];for(const band of f.bands){const baseline=contours(production,f.map,band),reference=contours(dense,f.map,band,false,false);
  const variants={production:baseline,'dense-bilinear':reference,'derived-binomial':contours(dense,f.map,band,true,false),'four-corner-smoothstep':reference.map(l=>l.map(p=>({...p,x:warp(p.x),z:warp(p.z)}))),'neighbor-cubic':cubicContours(f.map,band),'packed-position-model':baseline.map(l=>l.map(p=>({...p,x:Math.round(p.x*256)/256,z:Math.round(p.z*256)/256})))};
  for(const [name,loops]of Object.entries(variants))rows.push({band,name,...metrics(loops),displacementToDense:displacement(loops,reference),reverseDisplacementFromDense:displacement(reference,loops),points:loops});}
  const timings={};for(const [name,mod,filter]of [['production',production,false],['dense-bilinear',dense,false],['derived-binomial',dense,true]]){const repeats=25,start=performance.now();for(let i=0;i<repeats;i++)for(const b of f.bands)contours(mod,f.map,b,filter);timings[name]=(performance.now()-start)/repeats;}
  output.cases.push({name:f.name,size:SIZE,heights:[...f.map.cells],spans:[...f.map.columnSpans].map(([k,v])=>[k,[...v]]),strokes:f.strokes,rows,timingMsPerBandSet:timings});
}
await writeFile(new URL('measurements.json',import.meta.url),JSON.stringify(output));
await writeFile(new URL('measurements.json.gz',import.meta.url),gzipSync(JSON.stringify(output)));
console.log(JSON.stringify(output.cases.map(c=>({name:c.name,timingMsPerBandSet:c.timingMsPerBandSet,rows:c.rows.map(({points,...r})=>r)})),null,2));
