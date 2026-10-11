// Manual browser diagnostic. Import through Vite's /@fs route and call setup(renderer).
// Reports pipeline stages separately; no frame-rate or end-to-end latency claim.
// Pipeline uses current raw/binomial modes; microkernel retains the historical
// protected reference and bare averaging loop for the original cost comparison.
import { fixtureMirror } from '../client/test/support/mesherFixtures.ts';
import { createDirectChunkBuildSource, createWorkerChunkBuildSource } from '../client/src/render/chunkBuildSource.ts';
import { createGpuChunkBuildSource } from '../client/src/render/gpuMesher/gpuChunkBuildSource.ts';
import { createTerrainMirror, chunksDirtiedByCell, sampleRenderHeight, isCellReceived } from '../client/src/terrain/mirror.ts';
import { applySculpt, BAND_HEIGHT } from '../shared/src/index.ts';

import { protectedDrawnSample } from './protected-kernel-reference.ts';
const MODES = ['raw', 'binomial'];
const CASES = [{name:'interior',x:24,y:24},{name:'near-seam',x:27,y:24},{name:'seam',x:32,y:24}];
const summarize = values => {
  const sorted = [...values].sort((a,b)=>a-b);
  return { n: values.length, median: sorted[Math.floor(sorted.length/2)], p95: sorted[Math.ceil(sorted.length*.95)-1], samples: values };
};
function copy(base, mode) {
  const m = createTerrainMirror(base.map.size);
  m.map.cells.set(base.map.cells);
  for (const [i,spans] of base.map.columnSpans) m.map.columnSpans.set(i,spans.slice());
  for (const i of base.received) m.received.add(i);
  m.surfaceMode=mode; m.surfaceRevision=0;
  return m;
}
function stamp(base,mode,x,y) {
  const m=copy(base,mode), start=performance.now();
  // HUD width 2.0 is radius 4 cells (confirmed against brushNominalWidthWorldUnits).
  const cells=applySculpt(m.map,x,y,4,BAND_HEIGHT,{tool:'stamp',profile:'hard',anchor:'clicked'});
  const dirty=new Set();
  for(const c of cells) for(const i of chunksDirtiedByCell(m,c.x,c.y)) dirty.add(i);
  return {m,dirty:[...dirty],editMs:performance.now()-start,cells:cells.length};
}
export function kernel(name='genesis-noise') {
  const m=fixtureMirror(name), size=m.map.size, scratch=new Int32Array(25);
  const source={size,sample:(x,y)=>sampleRenderHeight(m,x,y),available:(x,y)=>isCellReceived(m,x,y),layered:(x,y)=>m.map.columnSpans.has(y*size+x)};
  const clamp=v=>Math.max(0,Math.min(size-1,v));
  const plain=(x,y)=>{let n=0;for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++)n+=source.sample(clamp(x+i),clamp(y+j))*(i===0?2:1)*(j===0?2:1);return n;};
  const fns={raw:(x,y)=>source.sample(x,y),binomial:plain,protected:(x,y)=>protectedDrawnSample(source,x,y,null,scratch)};
  const values={raw:[],binomial:[],protected:[]}; let checksum=0, retained=0, changed=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const raw=source.sample(x,y)*16,p=plain(x,y),v=fns.protected(x,y);if(p!==raw){changed++;if(v===raw)retained++;}}
  for(let round=0;round<11;round++)for(const mode of round%2?['protected','binomial','raw']:['raw','binomial','protected']){
    const start=performance.now();for(let repeat=0;repeat<4;repeat++)for(let y=0;y<size;y++)for(let x=0;x<size;x++)checksum+=fns[mode](x,y);
    if(round>=2) values[mode].push(performance.now()-start);
  }
  return {name,samplesPerBatch:4*size*size,filterChanges:changed,guardRestores:retained,checksum,ms:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,summarize(v)]))};
}
export function setup(renderer) {
  const cpu=createWorkerChunkBuildSource();
  const direct=createDirectChunkBuildSource();
  let gpu=null;
  return {
    async cpu(name='played') {
      const base=fixtureMirror(name), cases=[];
      for(const c of CASES){const values={raw:[], 'binomial':[]},metadata={};
      if(stamp(base,'raw',c.x,c.y).cells===0){cases.push({case:c.name,skipped:'stamp is a no-op'});continue;}
      for(let round=0;round<14;round++)for(const mode of round%2?[...MODES].reverse():MODES){
        const s=stamp(base,mode,c.x,c.y);
        const start=performance.now();await Promise.all(s.dirty.map(i=>cpu.build(s.m,i,round)));
        if(round>=4) values[mode].push(performance.now()-start);
        metadata[mode]={chunks:s.dirty.length,cells:s.cells,editMs:s.editMs};
      }
      cases.push({case:c.name,metadata,workerRoundtripMs:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,summarize(v)]))});}
      return {name,cases};
    },
    async gpu(name='played') {
      gpu??=await createGpuChunkBuildSource(renderer,direct);
      if(!gpu)throw new Error('GPU unavailable');
      const device=renderer.backend.device,base=fixtureMirror(name),cases=[];
      for(const c of CASES){const values={raw:[], 'binomial':[]},emit={raw:[], 'binomial':[]},metadata={};
      if(stamp(base,'raw',c.x,c.y).cells===0){cases.push({case:c.name,skipped:'stamp is a no-op'});continue;}
      for(let round=0;round<14;round++)for(const mode of round%2?[...MODES].reverse():MODES){
        const s=stamp(base,mode,c.x,c.y);
        const start=performance.now();const answers=await Promise.all(s.dirty.map(i=>gpu.build(s.m,i,round)));
        const counted=performance.now();const targets=[],encoder=device.createCommandEncoder();
        for(const a of answers){if(!a||a.kind!=='gpu')throw new Error('CPU fallback');const target=device.createBuffer({size:Math.max(1,a.vertexCount)*8,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});targets.push(target);a.gpu.emit(encoder,{positions:target,localOriginX:a.gpu.originX,localOriginZ:a.gpu.originZ},0);}
        gpu.recordEmitTimestamps(encoder);device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
        if(round>=4){values[mode].push(counted-start);emit[mode].push(performance.now()-counted);}
        for(const t of targets)t.destroy();for(const a of answers)a.gpu.release();
        metadata[mode]={chunks:s.dirty.length,cells:s.cells};
      }
      cases.push({case:c.name,metadata,countReadbackWallMs:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,summarize(v)])),emitAndQueueWaitWallMs:Object.fromEntries(Object.entries(emit).map(([k,v])=>[k,summarize(v)])),totalWallMs:Object.fromEntries(MODES.map(k=>[k,summarize(values[k].map((v,i)=>v+emit[k][i]))]))});}
      return {name,cases,note:'Wall times include GPU scheduling, host buffer allocation and readback; not isolated shader timestamps.'};
    },
    dispose(){cpu.dispose();direct.dispose();gpu?.dispose();},
  };
}
