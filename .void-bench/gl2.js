function makeGL(canvas){
  const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true,antialias:false});
  if(!gl)throw new Error('no webgl2');
  gl.getExtension('EXT_color_buffer_half_float')||gl.getExtension('EXT_color_buffer_float');
  const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  gl.fullscreenBuffer=b;
  return gl;
}
function linkProgram(gl,vsSrc,fsSrc,bind){
  const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);
    if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(o));return o;};
  const p=gl.createProgram();
  gl.attachShader(p,sh(gl.VERTEX_SHADER,vsSrc));gl.attachShader(p,sh(gl.FRAGMENT_SHADER,fsSrc));
  if(bind)for(const n in bind)gl.bindAttribLocation(p,bind[n],n);
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function makeProgram(gl,src){
  const p=linkProgram(gl,'attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}',src);
  gl.useProgram(p);
  gl.bindVertexArray(null);gl.bindBuffer(gl.ARRAY_BUFFER,gl.fullscreenBuffer);
  const loc=gl.getAttribLocation(p,'p');gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  return p;
}
function makeBake(gl,src,vpW,vpH){
  const size=Number(src.match(/const float GAS_BAKE_SIZE\s*=\s*([0-9.]+)/)[1]);
  const prog=makeProgram(gl,src);
  const field=gl.getUniformLocation(prog,'u_bakeField');
  const texs=[gl.RGBA16F,gl.R16F].map((fmt)=>{
    const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    gl.texStorage2D(gl.TEXTURE_2D,Math.log2(size)+1,fmt,size,size);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    return t;});
  const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);gl.viewport(0,0,size,size);
  const t0=performance.now();
  for(let i=0;i<2;i++){
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texs[i],0);
    const st=gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if(st!==gl.FRAMEBUFFER_COMPLETE)throw new Error('bake FBO 0x'+st.toString(16)+' - half-float RT unsupported');
    gl.uniform1f(field,i);gl.drawArrays(gl.TRIANGLES,0,3);}
  for(const t of texs){gl.bindTexture(gl.TEXTURE_2D,t);gl.generateMipmap(gl.TEXTURE_2D);}
  gl.finish();
  const ms=performance.now()-t0;
  gl.deleteFramebuffer(fb);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,vpW,vpH);
  return {texs,size,ms};
}
function bindBake(gl,prog,bake){
  if(!bake)return;
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,bake.texs[0]);
  gl.uniform1i(gl.getUniformLocation(prog,'u_gasBake'),0);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,bake.texs[1]);
  gl.uniform1i(gl.getUniformLocation(prog,'u_gasLevel'),1);
}
const HUB_POSE_FRACTION=1/6;
function pose(gl,prog,resW,resH,dist,kind){
  const t=Math.PI/3,ct=Math.cos(t),st=Math.sin(t);
  const d=kind==='hub'?dist*HUB_POSE_FRACTION:dist;
  const U=n=>gl.getUniformLocation(prog,n);
  gl.uniform2f(U('u_res'),resW,resH);gl.uniform1f(U('u_focal'),1.2);
  gl.uniformMatrix3fv(U('u_toDisk'),false,[1,0,0, 0,ct,st, 0,-st,ct]);
  gl.uniform3f(U('u_origin'),0,-st*d,ct*d);
  gl.uniform1f(U('u_dome'),kind==='hub'?1:0);
}
const GAS_HALF_UNIT=2;
function makeGas(gl,src,W,H){
  const div=Number(src.match(/const float GAS_RES_DIVISOR\s*=\s*([0-9.]+)/)[1]);
  const w=Math.ceil(W/div), h=Math.ceil(H/div);
  const prog=makeProgram(gl,src);
  const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA16F,w,h);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  const st=gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if(st!==gl.FRAMEBUFFER_COMPLETE)throw new Error('gas FBO 0x'+st.toString(16)+' - half-float RT unsupported');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,W,H);
  return {prog,tex,fb,w,h,time:gl.getUniformLocation(prog,'u_time')};
}
const STARS_POSITION_DECL='attribute vec3 position;\n';
function makeStars(gl,S,reuse){
  const prog=linkProgram(gl,STARS_POSITION_DECL+S.vert,S.frag,{position:0,starShape:1});
  const t0=performance.now();
  const grids=reuse||(()=>{
    const G=Function(S.gen+'\nreturn {STAR_GRIDS:STAR_GRIDS,generateStarGrid:generateStarGrid};')();
    return G.STAR_GRIDS.map((spec)=>{
      const b=G.generateStarGrid(spec);
      const vao=gl.createVertexArray();gl.bindVertexArray(vao);
      for(const [loc,data] of [[0,b.position],[1,b.shape]]){
        const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
        gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,0,0);}
      gl.bindVertexArray(null);
      return {vao,count:b.count};});})();
  gl.finish();
  const ms=reuse?0:performance.now()-t0;
  const range=gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  gl.useProgram(prog);
  gl.uniform1f(gl.getUniformLocation(prog,'u_pointSizeMax'),range[1]);
  gl.uniform1i(gl.getUniformLocation(prog,'u_gasHalf'),GAS_HALF_UNIT);
  return {prog,grids,ms,range,
    time:gl.getUniformLocation(prog,'u_time'),grid:gl.getUniformLocation(prog,'u_starGrid')};
}
function prepVariant(gl,V,W,H,dist,kind,reuse){
  const bake=V.bake?(reuse?reuse.bake:makeBake(gl,V.bake,W,H)):null;
  const gas=V.gas?makeGas(gl,V.gas,W,H):null;
  const stars=V.stars?makeStars(gl,V.stars,reuse&&reuse.stars?reuse.stars.grids:null):null;
  const prog=makeProgram(gl,V.wheel);
  pose(gl,prog,W,H,dist,kind);
  if(stars){gl.useProgram(stars.prog);pose(gl,stars.prog,W,H,dist,kind);gl.useProgram(prog);}
  if(gas){
    gl.useProgram(gas.prog);
    pose(gl,gas.prog,W,H,dist,kind);
    gl.uniform2f(gl.getUniformLocation(gas.prog,'u_gasRes'),gas.w,gas.h);
    bindBake(gl,gas.prog,bake);
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog,'u_gasHalf'),GAS_HALF_UNIT);
  } else bindBake(gl,prog,bake);
  return {prog,bake,gas,stars,time:gl.getUniformLocation(prog,'u_time'),samples:[]};
}
function drawFrame(gl,P,W,H,t){
  if(P.gas){
    gl.bindFramebuffer(gl.FRAMEBUFFER,P.gas.fb);gl.viewport(0,0,P.gas.w,P.gas.h);
    gl.useProgram(P.gas.prog);bindBake(gl,P.gas.prog,P.bake);
    gl.uniform1f(P.gas.time,t);gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,W,H);
    gl.activeTexture(gl.TEXTURE0+GAS_HALF_UNIT);gl.bindTexture(gl.TEXTURE_2D,P.gas.tex);
  }
  gl.useProgram(P.prog);
  if(!P.gas)bindBake(gl,P.prog,P.bake);
  gl.uniform1f(P.time,t);gl.drawArrays(gl.TRIANGLES,0,3);
  if(P.stars){
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
    gl.useProgram(P.stars.prog);gl.uniform1f(P.stars.time,t);
    P.stars.grids.forEach((g,i)=>{
      gl.uniform1f(P.stars.grid,i);gl.bindVertexArray(g.vao);
      gl.drawArrays(gl.POINTS,0,g.count);});
    gl.bindVertexArray(null);gl.disable(gl.BLEND);
  }
}
