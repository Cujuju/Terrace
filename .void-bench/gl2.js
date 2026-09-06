// WebGL2 helpers shared by bench.html and shot.mjs. A file:// page cannot load a sibling
// script, so both INLINE this file (gen.mjs at the /*GL2*/ marker, shot.mjs into its page).
// The context matches the app's (three r185 is WebGL2-only).
function makeGL(canvas){
  const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true,antialias:false});
  if(!gl)throw new Error('no webgl2');
  // Needed to RENDER into a half-float texture; filtering half-float is core in WebGL2.
  gl.getExtension('EXT_color_buffer_half_float')||gl.getExtension('EXT_color_buffer_float');
  const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  return gl;
}
function makeProgram(gl,src){
  const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);
    if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(o));return o;};
  const p=gl.createProgram();
  gl.attachShader(p,sh(gl.VERTEX_SHADER,'attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}'));
  gl.attachShader(p,sh(gl.FRAGMENT_SHADER,src));gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
  gl.useProgram(p);
  const loc=gl.getAttribLocation(p,'p');gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  return p;
}
// Runs a variant's bake shader into the two log-polar textures the wheel samples:
// [0] gasPattern (rgb colour, a pattern), [1] gasLevel (r). Same format, wrap, filtering and
// mipmaps as the app's render targets, so the bench sees the app's filtering. The returned ms is
// the one-off startup cost (both draws plus both mip chains), not part of the per-frame timing.
function makeBake(gl,src,vpW,vpH){
  const size=Number(src.match(/const float GAS_BAKE_SIZE\s*=\s*([0-9.]+)/)[1]);
  const prog=makeProgram(gl,src);
  const field=gl.getUniformLocation(prog,'u_bakeField');
  // [0] carries colour and pattern, [1] only the level: RGBA16F and R16F, as in the app.
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
// The eye poses, in the shader's own uniform layout. 'view' is the reference view anchor, the eye
// `dist` disk units from the hub with the disk tilted 60 deg. 'hub' is the same tilt and the same
// hub-centred framing at HUB_POSE_FRACTION of that distance, which is where the bake's texels are
// largest on screen - the pose that decides GAS_BAKE_SIZE.
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
