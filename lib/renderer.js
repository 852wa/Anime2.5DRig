/*!
 * Anime2.5DRig — renderer.js
 * WebGL1 mesh renderer. Eye whites are rendered into an off-screen coverage
 * texture first (left eye → red, right eye → green) and the irises sample it,
 * so the pupils are clipped with smooth, anti-aliased edges regardless of the
 * painting order or the eye-white opacity.
 * MIT License
 */
(function(root){
'use strict';
const VS='attribute vec2 aPos;attribute vec2 aUV;uniform vec2 uRes;varying vec2 vUV;'+
  'void main(){vUV=aUV;vec2 c=aPos/uRes*2.0-1.0;gl_Position=vec4(c.x,-c.y,0.0,1.0);}';
const FS='#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n'+
  'varying vec2 vUV;uniform sampler2D uTex;uniform sampler2D uMask;uniform vec2 uRes;uniform float uAlpha;'+
  'uniform vec2 uMaskCh;uniform float uUseMask;uniform float uMaskOut;'+
  'void main(){vec4 c=texture2D(uTex,vUV);'+
  'if(uMaskOut>0.5){gl_FragColor=vec4(c.a);return;}'+
  'float m=1.0;if(uUseMask>0.5){m=dot(texture2D(uMask,gl_FragCoord.xy/uRes).rg,uMaskCh);}'+
  'gl_FragColor=c*(uAlpha*m);}';

function createRenderer(gl){
  let prog=null,loc=null,maskTex=null,maskFbo=null,maskW=0,maskH=0;
  function shader(type,src){
    const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const msg=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(msg);}
    return s;
  }
  function init(){
    prog=gl.createProgram();
    gl.attachShader(prog,shader(gl.VERTEX_SHADER,VS));gl.attachShader(prog,shader(gl.FRAGMENT_SHADER,FS));
    gl.linkProgram(prog);
    for(const s of gl.getAttachedShaders(prog)){gl.detachShader(prog,s);gl.deleteShader(s);}
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    loc={pos:gl.getAttribLocation(prog,'aPos'),uv:gl.getAttribLocation(prog,'aUV')};
    for(const u of ['uRes','uAlpha','uTex','uMask','uMaskCh','uUseMask','uMaskOut'])loc[u]=gl.getUniformLocation(prog,u);
    gl.enableVertexAttribArray(loc.pos);gl.enableVertexAttribArray(loc.uv);
    gl.uniform1i(loc.uTex,0);gl.uniform1i(loc.uMask,1);
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
    maskTex=null;maskFbo=null;maskW=maskH=0;
  }
  function texture(image){
    const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    if(image)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    return t;
  }
  function ensureMask(w,h){
    if(maskTex&&maskW===w&&maskH===h)return;
    if(maskTex)gl.deleteTexture(maskTex);if(maskFbo)gl.deleteFramebuffer(maskFbo);
    maskTex=texture(null);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    maskFbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,maskFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,maskTex,0);
    const ok=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    if(!ok)throw new Error('瞳のマスク用メモリを確保できません。PSDを縮小してください');
    maskW=w;maskH=h;
  }
  // Upload one mesh + texture. `mesh` = {positions, uvs, indices, image}.
  function upload(L,mesh){
    L.vboPos=gl.createBuffer();L.vboUV=gl.createBuffer();L.ibo=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,L.vboPos);gl.bufferData(gl.ARRAY_BUFFER,mesh.positions,gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,L.vboUV);gl.bufferData(gl.ARRAY_BUFFER,mesh.uvs,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,L.ibo);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,mesh.indices,gl.STATIC_DRAW);
    L.nIdx=mesh.indices.length;
    gl.activeTexture(gl.TEXTURE0);L.tex=texture(mesh.image);
    if(!L.vboPos||!L.vboUV||!L.ibo||!L.tex||gl.getError()!==gl.NO_ERROR)throw new Error('描画メモリを確保できません。PSDを縮小してください');
  }
  function dispose(L){
    if(L.tex)gl.deleteTexture(L.tex);if(L.vboPos)gl.deleteBuffer(L.vboPos);
    if(L.vboUV)gl.deleteBuffer(L.vboUV);if(L.ibo)gl.deleteBuffer(L.ibo);
    L.tex=L.vboPos=L.vboUV=L.ibo=null;
  }
  function positions(L,data){gl.bindBuffer(gl.ARRAY_BUFFER,L.vboPos);gl.bufferSubData(gl.ARRAY_BUFFER,0,data);}
  function bind(L){
    gl.bindBuffer(gl.ARRAY_BUFFER,L.vboPos);gl.vertexAttribPointer(loc.pos,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,L.vboUV);gl.vertexAttribPointer(loc.uv,2,gl.FLOAT,false,0,0);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,L.tex);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,L.ibo);
  }
  /**
   * frame = {width, height, background:[r,g,b,a] premultiplied,
   *          masks:[{L, side:'L'|'R'}], items:[{L, alpha, clip:'L'|'R'|null}]}
   */
  function draw(frame){
    const W=frame.width,H=frame.height;
    gl.useProgram(prog);gl.uniform2f(loc.uRes,W,H);gl.uniform1f(loc.uUseMask,0);
    const hasMask={L:false,R:false};
    if(frame.masks.length&&frame.items.some(i=>i.clip)){
      ensureMask(W,H);
      // Unbind the mask from its sampler first, or WebGL reports a feedback loop.
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,null);gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER,maskFbo);gl.viewport(0,0,W,H);
      gl.colorMask(true,true,true,true);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(loc.uMaskOut,1);gl.uniform1f(loc.uAlpha,1);
      for(const m of frame.masks){
        gl.colorMask(m.side==='L',m.side==='R',false,false);hasMask[m.side]=true;
        bind(m.L);gl.drawElements(gl.TRIANGLES,m.L.nIdx,gl.UNSIGNED_SHORT,0);
      }
      gl.colorMask(true,true,true,true);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    }
    gl.uniform1f(loc.uMaskOut,0);
    gl.viewport(0,0,W,H);
    const bg=frame.background||[0,0,0,0];
    gl.clearColor(bg[0],bg[1],bg[2],bg[3]);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,maskTex);gl.activeTexture(gl.TEXTURE0);
    let masked=false;
    for(const it of frame.items){
      bind(it.L);gl.uniform1f(loc.uAlpha,it.alpha);
      const clip=it.clip&&hasMask[it.clip];
      if(clip){gl.uniform1f(loc.uUseMask,1);gl.uniform2f(loc.uMaskCh,it.clip==='L'?1:0,it.clip==='R'?1:0);masked=true;}
      else if(masked){gl.uniform1f(loc.uUseMask,0);masked=false;}
      gl.drawElements(gl.TRIANGLES,it.L.nIdx,gl.UNSIGNED_SHORT,0);
    }
    gl.uniform1f(loc.uUseMask,0);
  }
  init();
  return {init,upload,dispose,positions,draw,texture};
}
root.RigRenderer={create:createRenderer};
})(typeof self!=='undefined'?self:this);
