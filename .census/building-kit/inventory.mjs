import {registerHooks} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root = new URL('../../', import.meta.url);
registerHooks({load(url, context, next) {
  const result=next(url,context);
  if(url.endsWith('/structures/client/models.ts')) return {...result,source:readFileSync(fileURLToPath(url),'utf8')+'\nexport {buildTierParts,buildDurandsParts};'};
  if(url.endsWith('/temples/client/temple.ts')) return {...result,source:readFileSync(fileURLToPath(url),'utf8')+'\nexport {buildTempleGeometry};'};
  return result;
}});
globalThis.document={createElement(){return {width:0,height:0,getContext(){return null;}};}};
const models=await import(new URL('plugins/structures/client/models.ts',root));
const fishing=await import(new URL('plugins/structures/client/fishingHuts.ts',root));
const temple=await import(new URL('plugins/temples/client/temple.ts',root));
const {Vector3,Matrix4}=await import(new URL('client/node_modules/three/build/three.module.js',root));
const {fitToRadius}=await import(new URL('plugins/structures/client/parts.ts',root));
const protocol=await import(new URL('plugins/structures/protocol.ts',root));
const all={};
function capture(id,parts,source,front='+Z') {
  const v=new Vector3(), verts=[],faces=[],colors=[],pieces=[];
  for(const [partIndex,part] of parts.entries()) for(const matrix of part.localMatrices) {
    const start=verts.length, first=faces.length, geo=part.geometry,p=geo.attributes.position,c=geo.attributes.color;
    for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).applyMatrix4(matrix);verts.push(v.toArray());}
    const ix=geo.index?.array ?? Array.from({length:p.count},(_,i)=>i);
    for(let i=0;i<ix.length;i+=3){faces.push([start+ix[i],start+ix[i+1],start+ix[i+2]]);colors.push(c?[c.getX(ix[i]),c.getY(ix[i]),c.getZ(ix[i])]:part.material.color.toArray());}
    pieces.push({part_index:partIndex,first_face:first,face_count:faces.length-first});
  }
  const min=[0,1,2].map(a=>Math.min(...verts.map(v=>v[a]))),max=[0,1,2].map(a=>Math.max(...verts.map(v=>v[a])));
  all[id]={source,front,vertices:verts,faces,colors,pieces,bounds:{min,max,dimensions:min.map((v,i)=>max[i]-v)}};
}
const tiers=models.buildTierParts();
protocol.STRUCTURE_TIERS.forEach((id,i)=>capture(id,tiers[i],'plugins/structures/client/models.ts (original procedural base)'));
fishing.FISHING_HUT_NAMES.forEach((id,i)=>capture(id,fishing.FISHING_HUT_BUILDERS[i](),'plugins/structures/client/fishingHuts.ts (original procedural base)'));
capture('durands',fitToRadius(models.buildDurandsParts().parts,protocol.STRUCTURE_SURVEYED_GROUND_RADIUS/protocol.STRUCTURE_SCALE_MAX),'plugins/structures/client/models.ts (original procedural base)');
const geo=temple.buildTempleGeometry();
capture('temple',[{geometry:geo,localMatrices:[new Matrix4()],material:null}],'plugins/temples/client/temple.ts (original procedural base)','+X');
writeFileSync(new URL('source-inventory.json',import.meta.url),JSON.stringify(all));
console.log(JSON.stringify(Object.fromEntries(Object.entries(all).map(([id,a])=>[id,{...a.bounds,triangles:a.faces.length,front:a.front} ])),null,2));
