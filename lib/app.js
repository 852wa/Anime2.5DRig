(function(){
"use strict";
const QUERY=new URLSearchParams(location.search);
const OBS_MODE=QUERY.get('obs')==='1', CAMERA_MODE=QUERY.get('cam')==='1';
if(OBS_MODE) document.body.classList.add('obs');
const trackingChannel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('anime25d-camera'):null;
let trackingPostBusy=false;
const RT=window.RigRuntime;
let modelId='', modelName='', currentRig=null, background='checker', paused=false, contextLost=false, lastFrame=null, capturePending=false;
const statusEl=document.getElementById('appStatus');
function status(message,error=false){statusEl.textContent=message;statusEl.classList.toggle('error',error);}
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);}
const cv = document.getElementById('cv');
const gl = cv.getContext('webgl', {alpha:true, stencil:true, antialias:true, premultipliedAlpha:true});
if(!gl){ document.getElementById('stage').textContent='WebGL未対応'; return; }

// ---------- GL setup ----------
function sh(type, src){ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) {const msg=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(msg);} return s; }
let prog,locPos,locUV,locRes,locCut,locAl;
function initGL(){
prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER,
 'attribute vec2 aPos; attribute vec2 aUV; uniform vec2 uRes; varying vec2 vUV;'+
 'void main(){ vUV=aUV; vec2 c = aPos/uRes*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0); }'));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER,
 'precision mediump float; varying vec2 vUV; uniform sampler2D uTex; uniform float uCut; uniform float uAlpha;'+
 'void main(){ vec4 c=texture2D(uTex,vUV); if(c.a<uCut) discard; gl_FragColor=c*uAlpha; }'));
gl.linkProgram(prog);
for(const shader of gl.getAttachedShaders(prog)){gl.detachShader(prog,shader);gl.deleteShader(shader);}
if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
locPos=gl.getAttribLocation(prog,'aPos'); locUV=gl.getAttribLocation(prog,'aUV');
locRes=gl.getUniformLocation(prog,'uRes'); locCut=gl.getUniformLocation(prog,'uCut'); locAl=gl.getUniformLocation(prog,'uAlpha');
gl.enableVertexAttribArray(locPos); gl.enableVertexAttribArray(locUV);
gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
}
initGL();

// ---------- model state (mutable, rebuilt per PSD) ----------
let layers=[], A=null, CW=768, CH=768, FS=1, NP=null, BP=null, FC=null, CHEST=null, hasEyeClose2=false;
const bounce={x:0,v:0,dy:0};

function mkTex(imgData){
  const t=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,imgData);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  return t;
}

function disposeLayers(list){for(const L of list){gl.deleteTexture(L.tex);gl.deleteBuffer(L.vboPos);gl.deleteBuffer(L.vboUV);gl.deleteBuffer(L.ibo);}}
function prepareLayers(rig){
  const A=rig.anchors,CW=rig.canvas.w,prepared=[];
  const maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxViewport=gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  if(rig.canvas.w>maxViewport[0]||rig.canvas.h>maxViewport[1])throw new Error('この端末の描画サイズを超えています。PSDを縮小してください');
  try{
  for(const Lr of rig.layers){
    if(Lr.w>maxTexture||Lr.h>maxTexture)throw new Error('画像パーツがこの端末の上限 '+maxTexture+'px を超えています');
    const L=Object.assign({visible:true,opacity:1},Lr,{id:String(Lr.z)+':'+Lr.name});
    L.defaultDepth=L.depth;L.defaultOpacity=L.opacity;
    prepared.push(L);
    const cell=(L.phys?30:42)*Math.max(0.6,CW/768);
    const {nx,ny}=RT.meshSize(L.w,L.h,cell);
    const nv=(nx+1)*(ny+1);
    const base=new Float32Array(nv*2), uv=new Float32Array(nv*2);
    let k=0;
    for(let j=0;j<=ny;j++) for(let i=0;i<=nx;i++){
      base[k]=L.x+L.w*i/nx; base[k+1]=L.y+L.h*j/ny; uv[k]=i/nx; uv[k+1]=j/ny; k+=2;
    }
    const idx=[];
    for(let j=0;j<ny;j++) for(let i=0;i<nx;i++){
      const a=j*(nx+1)+i, b=a+1, c=a+nx+1, d=c+1; idx.push(a,b,c,b,d,c);
    }
    L.base=base; L.cur=new Float32Array(base); L.nIdx=idx.length;
    L.bn=Rigger.baseName(L.name.replace(/_(l|r)$/,''));
    if(L.strands&&L.strands.length){
      const S=L.strands, nS=S.length;
      let spacing=120;
      if(nS>1){ const ds=[]; for(let s=1;s<nS;s++)ds.push(S[s].x-S[s-1].x); ds.sort((a,b)=>a-b); spacing=ds[ds.length>>1]; }
      const sig=Math.max(1,spacing*0.6);
      L.sw=new Float32Array(nv*nS); L.su=new Float32Array(nv);
      L.spr=S.map((s,i)=>({stiff:{x:0,v:0,dx:0}, soft:{x:0,v:0,dx:0}, phase:i*1.37+L.z}));
      for(let v=0;v<nv;v++){
        const x=base[v*2], y=base[v*2+1];
        let tot=0;
        for(let s=0;s<nS;s++){ const w=Math.exp(-Math.pow((x-S[s].x)/sig,2)); L.sw[v*nS+s]=w; tot+=w; }
        let rY=0,tY=0;
        if(tot>1e-6){ for(let s=0;s<nS;s++){ L.sw[v*nS+s]/=tot; rY+=L.sw[v*nS+s]*S[s].rootY; tY+=L.sw[v*nS+s]*S[s].tipY; } }
        else { L.sw[v*nS+0]=1; rY=S[0].rootY; tY=S[0].tipY; }
        L.su[v]=Math.min(1,Math.max(0,(y-rY)/Math.max(1,tY-rY)));
      }
      if(L.bn==='front hair'){
        const fw=A.face.x1-A.face.x0, fcx=A.face.cx;
        const f=36, b1=fcx-fw*0.22, b2=fcx+fw*0.22;
        L.bw=new Float32Array(nv*3);
        for(let v=0;v<nv;v++){ const x=base[v*2];
          const s1=smooth((x-b1)/f+0.5), s2=smooth((x-b2)/f+0.5);
          L.bw[v*3]=1-s1; L.bw[v*3+1]=s1*(1-s2); L.bw[v*3+2]=s2; }
      }
    }
    L.vboPos=gl.createBuffer(); L.vboUV=gl.createBuffer(); L.ibo=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,L.vboPos); gl.bufferData(gl.ARRAY_BUFFER,L.cur,gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,L.vboUV); gl.bufferData(gl.ARRAY_BUFFER,uv,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,L.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(idx),gl.STATIC_DRAW);
    const idata=(typeof ImageData!=='undefined')?new ImageData(L.img.data,L.img.width,L.img.height):L.img;
    L.tex=mkTex(idata); delete L.img;
    if(!L.vboPos||!L.vboUV||!L.ibo||!L.tex||gl.getError()!==gl.NO_ERROR)throw new Error('描画メモリを確保できません。PSDを縮小してください');
  }
  return prepared;
  }catch(err){disposeLayers(prepared);throw err;}
}
function applyRig(rig){
  if(contextLost)throw new Error('描画の復旧を待ってから読み込んでください');
  const prepared=prepareLayers(rig);
  disposeLayers(layers); layers=prepared; currentRig=rig;
  CW=rig.canvas.w; CH=rig.canvas.h; A=rig.anchors; FS=A.faceScale;
  NP=A.neckPivot; BP=A.bodyPivot; FC={x:A.face.cx,y:A.face.cy};
  CHEST={cx:NP.cx,cy:A.neckBottom+(A.face.y1-A.face.y0)*0.60,rx:Math.max(1,(A.face.x1-A.face.x0)*0.60),ry:Math.max(1,(A.face.y1-A.face.y0)*0.45)};
  Object.assign(bounce,{x:0,v:0,dy:0}); lastFrame=null; blinkT=-1;blinkVariant=1;irisBounceT=-1;
  hasEyeClose2=layers.some(L=>L.bn==='eye_close2');
  cv.width=CW; cv.height=CH; fit();
  renderLayerList();
  const nStr=layers.reduce((s,L)=>s+(L.strands?L.strands.length:0),0);
  document.getElementById('rigInfo').textContent =
    layers.length+'パーツ / 髪'+nStr+'房を自動リグ'+
    '\n'+CW+' × '+CH+'px'+(rig.warnings.length?('\n⚠ '+rig.warnings.join('\n⚠ ')):'');
  document.getElementById('drop').classList.add('hidden');
  document.querySelectorAll('[data-model-action]').forEach(b=>b.disabled=false);
}

// ---------- PSD loading ----------
const dropEl=document.getElementById('drop'), dropStatus=document.getElementById('dropStatus');
let loadTicket=0,loaderWorker=null,loadController=null,cancelWorker=null;
function cancelLoad(){
  loadTicket++;loadController?.abort();loadController=null;
  loaderWorker?.terminate();loaderWorker=null;
  cancelWorker?.(new DOMException('中止','AbortError'));cancelWorker=null;
  document.getElementById('btnCancelLoad').hidden=true;
  dropEl.classList.toggle('hidden',!!layers.length);dropStatus.textContent='';
}
function loadProgress(message){dropStatus.textContent=message;status(message);}
async function parseModel(buffer,generic,ticket){
  if(location.protocol!=='file:'&&typeof Worker!=='undefined'){
    return new Promise((resolve,reject)=>{
      cancelWorker=reject;loaderWorker=new Worker('lib/psd-worker.js');
      loaderWorker.onmessage=ev=>{
        if(ticket!==loadTicket)return;
        if(ev.data.progress){loadProgress(ev.data.progress);return;}
        loaderWorker.terminate();loaderWorker=null;cancelWorker=null;
        if(ev.data.error)reject(new Error(ev.data.error));else resolve(ev.data);
      };
      loaderWorker.onerror=()=>{loaderWorker?.terminate();loaderWorker=null;cancelWorker=null;reject(new Error('PSD解析を開始できません。localhostで開き直してください'));};
      loaderWorker.postMessage({buffer,generic},[buffer]);
    });
  }
  // Direct file opening cannot reliably start a worker. Keep that workflow usable.
  await new Promise(r=>setTimeout(r,20));
  if(ticket!==loadTicket)throw new DOMException('中止','AbortError');
  const options={useImageData:true,skipThumbnail:true,skipCompositeImageData:true};
  Rigger.validatePsd(agPsd.readPsd(new Uint8Array(buffer),{...options,skipLayerImageData:true}));
  const psd=agPsd.readPsd(new Uint8Array(buffer),{...options,skipCompositeImageData:false}),pre=Rigger.cleanPsdLayers(psd);
  return {psd,pre,rig:Rigger.buildRig(psd,{generic})};
}
async function loadModel(source,name){
  cancelLoad();const ticket=loadTicket;
  loadController=new AbortController();const signal=loadController.signal;
  document.getElementById('btnCancelLoad').hidden=false;
  dropEl.classList.remove('hidden');loadProgress(name+' を読み込み中…');
  try{
    if(!window.agPsd) throw new Error('lib/ag-psd.min.js が未読込です。ZIPを展開してから開く / lib フォルダを index.html と同じ階層に配置してください');
    if(!window.Rigger) throw new Error('lib/rigger.js が未読込です。lib フォルダの配置を確認してください');
    const buf=await source(signal);
    RT.validateHeader(buf);
    const id=RT.fingerprint(buf);
    await customGenericReady;
    if(ticket!==loadTicket)return;
    const {psd,pre,rig}=await parseModel(buf,genericOpts().generic,ticket);
    if(ticket!==loadTicket)return;
    applyRig(rig);
    modelId=id;modelName=name;lastPsd=psd;lastPre=pre;
    document.getElementById('modelName').textContent=name;
    resetParams();restoreSettings(true);
    if(pre.noisy>0) document.getElementById('rigInfo').textContent += '\nノイズ除去: '+pre.noisy+'/'+pre.layers+'レイヤー';
    dropStatus.textContent='';
    status(name+' を読み込みました');
  }catch(err){
    if(ticket!==loadTicket||err.name==='AbortError')return;
    dropStatus.textContent='エラー: '+err.message; status(dropStatus.textContent,true);
    dropEl.classList.toggle('hidden',!!layers.length);
  }finally{
    if(ticket===loadTicket){document.getElementById('btnCancelLoad').hidden=true;loadController=null;}
  }
}
document.getElementById('btnCancelLoad').addEventListener('click',()=>{cancelLoad();status('読み込みを中止しました');});
let customGeneric=null;
async function loadCustomGeneric(){
  if(typeof fetch==='undefined'||!window.agPsd||!window.Rigger) return;
  async function grab(url){
    try{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
      let buffer;
      try{const r=await fetch(url,{signal:controller.signal});if(!r.ok)return null;buffer=await r.arrayBuffer();}finally{clearTimeout(timer);}
      RT.validateHeader(buffer);
      const psd=window.agPsd.readPsd(new Uint8Array(buffer),{useImageData:true,skipThumbnail:true,skipCompositeImageData:true});
      return window.Rigger.flattenPsdToImg(psd);
    }catch(err){ return null; }
  }
  const [eye,mouth]=await Promise.all([grab('eye_close.psd'),grab('mouth_close.psd')]);
  const g={};
  if(eye){ const s=window.Rigger.splitImgLR(eye); if(s){ g.eyeL=s.l; g.eyeR=s.r; } }
  if(mouth) g.mouth=mouth;
  if(g.eyeL||g.mouth) customGeneric=g;
}
const customGenericReady=loadCustomGeneric();
function genericOpts(){
  const GP=window.GenericParts;
  const base=GP?{eyeL:GP.get('eyeL'),eyeR:GP.get('eyeR'),mouth:GP.get('mouth')}:{};
  const g=Object.assign({},base,customGeneric||{});
  return (g.eyeL||g.mouth)?{generic:g}:{};
}
document.getElementById('btnFile').addEventListener('click',()=>document.getElementById('fileInput').click());
document.getElementById('btnOpen').addEventListener('click',()=>document.getElementById('fileInput').click());
function loadFile(f){
  return loadModel(async()=>{if(!/\.psd$/i.test(f.name))throw new Error('拡張子が .psd のファイルを選んでください');if(f.size>RT.MAX_FILE_BYTES)throw new Error('PSDは128MB以下にしてください');return f.arrayBuffer();},f.name);
}
document.getElementById('fileInput').addEventListener('change',ev=>{
  const f=ev.target.files[0];ev.target.value='';if(f)loadFile(f);
});
const SAMPLE_FILES={A:'sample2.psd',B:'sample.psd'};
async function loadSample(key='B'){
  const filename=SAMPLE_FILES[key];
  if(!filename)return;
  return loadModel(async signal=>{
    const r=await fetch(filename,{signal});
    if(!r.ok) throw new Error(filename+' が見つかりません（HTTP '+r.status+'）');
    if(Number(r.headers.get('Content-Length'))>RT.MAX_FILE_BYTES)throw new Error('PSDは128MB以下にしてください');
    return r.arrayBuffer();
  },filename);
}
document.querySelectorAll('[data-sample]').forEach(button=>button.addEventListener('click',()=>loadSample(button.dataset.sample)));
if(OBS_MODE) loadSample();
(function(){ const miss=[];
  if(!window.agPsd)miss.push('ag-psd.min.js'); if(!window.Rigger)miss.push('rigger.js'); if(!window.GenericParts)miss.push('genericparts.js');
  if(miss.length) dropStatus.textContent='⚠ lib/'+miss.join(', lib/')+' が読み込めていません（ZIP展開・libフォルダの配置を確認）';
})();
['dragover','dragenter'].forEach(ev=>window.addEventListener(ev,e=>{if(!e.dataTransfer?.types.includes('Files'))return;e.preventDefault();document.getElementById('stage').classList.add('dragover');}));
['dragleave','drop'].forEach(ev=>window.addEventListener(ev,e=>{e.preventDefault();document.getElementById('stage').classList.remove('dragover');}));
window.addEventListener('drop',async e=>{
  const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
  if(f)loadFile(f);
});

// ---------- params ----------
const P = { angleX:0, angleY:0, angleZ:0, eyeOpenL:1, eyeOpenR:1, eyeX:0, eyeY:0, brow:0,
            mouthOpen:0, mouthForm:0, mouthCY:0, body:0, physAmp:2, soft:2,
            browAngL:0, browAngR:0, browAngSym:0, bangL:0, bangC:0, bangR:0,
            armY:0, armPos:0, bust:2.5, bustY:1, irisScale:1, mouthEase:0.72, eyeEase:0.3,
            fhAmp:2, fhSoft:0.4, eyeCY:0, eyeCAng:0, mouthCAng:0, eyeScaleL:1, eyeScaleR:1, mouthScale:1 };
const DEFAULTS = Object.assign({}, P);
let lastPsd=null, lastPre=null;
const T = Object.assign({}, P);
const cur = Object.assign({}, P);
const auto = { idle:true, blink:true, rand:true, talk:!OBS_MODE, mouse:false, mic:false, phys:true, cam:false };
const autoDefaults={...auto};
if(OBS_MODE) document.getElementById('tgTalk').classList.remove('on');

const sliders = { pAngleX:'angleX',pAngleY:'angleY',pAngleZ:'angleZ',pEyeL:'eyeOpenL',pEyeR:'eyeOpenR',
  pEyeX:'eyeX',pEyeY:'eyeY',pBrow:'brow',pMouthOpen:'mouthOpen',pMouthForm:'mouthForm',
  pBody:'body',pPhysAmp:'physAmp',pSoft:'soft',pMouthCY:'mouthCY',
  pBrowAngL:'browAngL',pBrowAngR:'browAngR',pBrowAngSym:'browAngSym',
  pBangL:'bangL',pBangC:'bangC',pBangR:'bangR',pArmY:'armY',pArmPos:'armPos',
  pBust:'bust',pBustY:'bustY',pIrisScale:'irisScale',pMouthEase:'mouthEase',pEyeEase:'eyeEase',
  pFhAmp:'fhAmp',pFhSoft:'fhSoft',pEyeCY:'eyeCY',pEyeCAng:'eyeCAng',pMouthCAng:'mouthCAng',
  pEyeScaleL:'eyeScaleL',pEyeScaleR:'eyeScaleR',pMouthScale:'mouthScale' };
const parameterRanges={};
for(const id in sliders){
  const el=document.getElementById(id), key=sliders[id], v=el.parentNode.querySelector('.val');
  const label=el.parentNode.querySelector('label');label.htmlFor=id;
  const number=document.createElement('input');number.type='number';number.className='val';number.min=el.min;number.max=el.max;number.step=el.step;number.value=el.value;number.setAttribute('aria-label',label.textContent+'の数値');v.replaceWith(number);
  parameterRanges[key]=[Number(el.min),Number(el.max)];
  const upd=()=>{T[key]=Number(el.value);number.value=el.value;if(paused&&lastFrame)lastFrame[key]=T[key];activePreset=null;clearPresetHighlight();};
  el.addEventListener('input',upd);
  number.addEventListener('input',()=>{if(number.value!==''&&Number.isFinite(number.valueAsNumber)){el.value=RT.clamp(number.valueAsNumber,...parameterRanges[key]);T[key]=Number(el.value);if(paused&&lastFrame)lastFrame[key]=T[key];activePreset=null;clearPresetHighlight();}});
  number.addEventListener('change',()=>{if(number.value!==''&&Number.isFinite(number.valueAsNumber))el.value=RT.clamp(number.valueAsNumber,...parameterRanges[key]);upd();});
  el.addEventListener('dblclick',()=>{el.value=DEFAULTS[key];upd();});
  el.title='ダブルクリックで初期値に戻す';T[key]=Number(el.value);
}
function setSlider(key,val){ for(const id in sliders) if(sliders[id]===key){
  const el=document.getElementById(id);el.value=RT.clamp(val,...parameterRanges[key]);T[key]=Number(el.value);el.parentNode.querySelector('.val').value=el.value;if(paused&&lastFrame)lastFrame[key]=T[key]; } }

const toggleIds={idle:'tgIdle',blink:'tgBlink',rand:'tgRand',talk:'tgTalk',cam:'tgCam',mouse:'tgMouse',mic:'tgMic',phys:'tgPhys'};
function syncToggle(key){const el=document.getElementById(toggleIds[key]);el.classList.toggle('on',auto[key]);el.setAttribute('aria-pressed',String(auto[key]));}
function setAuto(key,value){
  auto[key]=value;syncToggle(key);
  if(key==='mic'){if(value)initMic();else stopMic();}
  if(key==='cam'){if(value)initCam();else stopCam();}
  if(key==='blink'&&!value){blinkT=-1;blinkVariant=1;irisBounceT=-1;}
}
Object.entries(toggleIds).forEach(([key,id])=>{
  const old=document.getElementById(id),el=document.createElement('button');el.id=id;el.className=old.className;el.textContent=old.textContent;el.type='button';old.replaceWith(el);syncToggle(key);
  el.addEventListener('click',()=>setAuto(key,!auto[key]));
});
const presets={
  neutral:{eyeOpenL:1,eyeOpenR:1,brow:0,mouthOpen:0,mouthForm:0,irisScale:1},
  smile:{eyeOpenL:0,eyeOpenR:0,brow:0.45,mouthOpen:0,mouthForm:0.9,irisScale:1},
  usume:{eyeOpenL:0.5,eyeOpenR:0.5,brow:0.35,mouthOpen:1,mouthForm:0.8,irisScale:1},
  surprise:{eyeOpenL:1,eyeOpenR:1,brow:1,mouthOpen:0.75,mouthForm:-0.1,irisScale:0.7},
  jito:{eyeOpenL:0.4,eyeOpenR:0.4,brow:-0.6,mouthOpen:0,mouthForm:-0.4,irisScale:1},
  winkL:{eyeOpenL:0,eyeOpenR:1,brow:0.2,mouthOpen:0.4,mouthForm:0.7,irisScale:1},
  winkR:{eyeOpenL:1,eyeOpenR:0,brow:0.2,mouthOpen:0.4,mouthForm:0.7,irisScale:1} };
let activePreset=null;
function clearPresetHighlight(){ document.querySelectorAll('[data-preset]').forEach(x=>{x.classList.remove('active');x.setAttribute('aria-pressed','false');}); }
document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>{
  const name=b.dataset.preset;
  clearPresetHighlight();
  if(activePreset===name){ activePreset=null;
    const p=presets.neutral; for(const k in p) setSlider(k,p[k]);
  } else {
    activePreset=name; b.classList.add('active');b.setAttribute('aria-pressed','true');
    const p=presets[name]; for(const k in p) setSlider(k,p[k]);
  }
}));
function resetParams(){
  activePreset=null; clearPresetHighlight();
  for(const id in sliders) setSlider(sliders[id], DEFAULTS[sliders[id]]);
  Object.assign(cur,T);
}
document.getElementById('btnReset').addEventListener('click',()=>{
  resetParams();
  document.getElementById('utilStatus').textContent='全パラメータを初期値に戻しました';
});
document.getElementById('btnSavePsd').addEventListener('click',()=>{
  const st=document.getElementById('utilStatus');
  if(!lastPsd){ st.textContent='先にPSDを読み込んでください'; return; }
  try{
    st.textContent='書き出し中…';
    const out=window.agPsd.writePsd(lastPsd,{generateThumbnail:false});
    const blob=new Blob([out],{type:'application/octet-stream'});
    download(blob,(modelName.replace(/\.psd$/i,'')||'model')+'_clean.psd');
    st.textContent='軽量PSDを保存しました（'+(blob.size/1e6).toFixed(1)+'MB / ノイズ除去+トリム済み）';
  }catch(err){ st.textContent='書き出しエラー: '+err.message; }
});
function setBackground(value){
  background=value;
  const s=document.getElementById('stage'); s.className='';
  if(value==='checker'||value==='green')s.classList.add(value);
  s.style.background=value==='dark'?'#14151c':'';
  document.querySelectorAll('[data-bg]').forEach(b=>{b.classList.toggle('active',b.dataset.bg===value);b.setAttribute('aria-pressed',String(b.dataset.bg===value));});
}
document.querySelectorAll('[data-bg]').forEach(b=>b.addEventListener('click',()=>setBackground(b.dataset.bg)));
setBackground(background);

function settingsSnapshot(){return {format:'anime25d-settings',version:1,modelId,modelName,params:{...T},preset:activePreset,auto:Object.fromEntries(['idle','blink','rand','talk','mouse','phys'].map(k=>[k,auto[k]])),background,layers:layers.map(L=>({id:L.id,visible:L.visible,opacity:L.opacity,depth:L.depth}))};}
function applySettings(value){
  const data=RT.settings(value,modelId,parameterRanges,layers.map(L=>L.id));
  activePreset=null;clearPresetHighlight();
  for(const [key,n] of Object.entries(data.params))setSlider(key,n);
  activePreset=data.preset;
  document.querySelectorAll('[data-preset]').forEach(b=>{const selected=b.dataset.preset===activePreset;b.classList.toggle('active',selected);b.setAttribute('aria-pressed',String(selected));});
  Object.assign(cur,T);
  for(const [key,n] of Object.entries(data.auto))setAuto(key,n);
  const byId=new Map(layers.map(L=>[L.id,L]));layers=data.layers.map(record=>Object.assign(byId.get(record.id),record));
  setBackground(data.background);renderLayerList();
}
function restoreSettings(quiet=false){
  try{
    if(quiet)for(const k of ['idle','blink','rand','talk','mouse','phys'])setAuto(k,autoDefaults[k]);
    const saved=localStorage.getItem('anime25d.settings.'+modelId);
    if(!saved){if(!quiet)status('このモデルの保存済み調整はありません');return;}
    applySettings(JSON.parse(saved));document.getElementById('utilStatus').textContent='保存した調整を復元しました';
  }catch(err){document.getElementById('utilStatus').textContent='調整を復元できません: '+err.message;}
}
document.getElementById('btnSaveSettings').addEventListener('click',()=>{
  try{localStorage.setItem('anime25d.settings.'+modelId,JSON.stringify(settingsSnapshot()));status('このモデルの調整をブラウザに保存しました');}
  catch(err){status('ブラウザに保存できません。設定JSONを書き出してください',true);}
});
document.getElementById('btnRestoreSettings').addEventListener('click',()=>restoreSettings());
document.getElementById('btnExportSettings').addEventListener('click',()=>{download(new Blob([JSON.stringify(settingsSnapshot(),null,2)],{type:'application/json'}),modelName.replace(/\.psd$/i,'')+'.rig.json');status('設定JSONを書き出しました');});
document.getElementById('btnImportSettings').addEventListener('click',()=>document.getElementById('settingsInput').click());
document.getElementById('settingsInput').addEventListener('change',async ev=>{
  const f=ev.target.files[0];ev.target.value='';if(!f)return;const id=modelId;
  try{if(f.size>1024*1024)throw new Error('設定JSONは1MB以下にしてください');const value=JSON.parse(await f.text());if(id!==modelId)throw new Error('モデルが切り替わりました。設定を選び直してください');applySettings(value);status('設定を読み込みました。「調整を保存」で記憶できます');}
  catch(err){status('設定を読み込めません: '+err.message,true);}
});
function togglePause(){paused=!paused;const b=document.getElementById('btnPause');b.textContent=paused?'再生':'一時停止';b.setAttribute('aria-pressed',String(paused));status(paused?'一時停止中 — 数値を調整して静止画を保存できます':'再生中');}
document.getElementById('btnPause').addEventListener('click',togglePause);
document.getElementById('btnPng').addEventListener('click',()=>{capturePending=true;});
document.getElementById('btnResetLayers').addEventListener('click',()=>{layers.sort((a,b)=>a.z-b.z);for(const L of layers){L.visible=true;L.depth=L.defaultDepth;L.opacity=L.defaultOpacity;}renderLayerList();status('レイヤー設定を初期化しました');});

// ---------- README viewer ----------
function mdToHtml(md){
  const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const inline=s=>esc(s)
    .replace(/\*\*(.+?)\*\*/g,'<b>$1</b>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,text,url)=>/^(https?:\/\/|#)/i.test(url)?'<a href="'+url+'" target="_blank" rel="noopener">'+text+'</a>':text);
  const lines=md.split(/\r?\n/);
  let html='', inCode=false, inList=false, inTable=false;
  for(const l of lines){
    if(l.startsWith('```')){ html+=inCode?'</code></pre>':'<pre><code>'; inCode=!inCode; continue; }
    if(inCode){ html+=esc(l)+'\n'; continue; }
    if(/^\|/.test(l.trim())){
      if(/^\|[\s\-|:]+\|?$/.test(l.trim())) continue;
      const cells=l.trim().split('|').slice(1,-1).map(c=>inline(c.trim()));
      if(!inTable){ html+='<table><tr>'+cells.map(c=>'<th>'+c+'</th>').join('')+'</tr>'; inTable=true; }
      else html+='<tr>'+cells.map(c=>'<td>'+c+'</td>').join('')+'</tr>';
      continue;
    } else if(inTable){ html+='</table>'; inTable=false; }
    if(/^\s*[-*] /.test(l)){ if(!inList){html+='<ul>';inList=true;}
      html+='<li>'+inline(l.replace(/^\s*[-*] /,''))+'</li>'; continue; }
    else if(inList){ html+='</ul>'; inList=false; }
    const h=l.match(/^(#{1,4}) (.*)/);
    if(h){ html+='<h'+h[1].length+'>'+inline(h[2])+'</h'+h[1].length+'>'; continue; }
    if(/^> /.test(l)){ html+='<blockquote>'+inline(l.slice(2))+'</blockquote>'; continue; }
    if(l.trim()!=='') html+='<p>'+inline(l)+'</p>';
  }
  if(inCode)html+='</code></pre>'; if(inList)html+='</ul>'; if(inTable)html+='</table>';
  return html;
}
let readmeLoaded=false,readmeFocus=null;
async function openReadme(){
  const ov=document.getElementById('readmeOverlay');
  readmeFocus=document.activeElement;
  ov.classList.add('show');
  document.getElementById('readmeClose').focus();
  if(readmeLoaded) return;
  const body=document.getElementById('readmeBody');
  try{
    const r=await fetch('README.md');
    if(!r.ok) throw new Error('HTTP '+r.status);
    body.innerHTML=mdToHtml(await r.text());
    readmeLoaded=true;
  }catch(err){
    body.innerHTML='<p>README.md を取得できませんでした。'+
      '<a href="https://github.com/852wa/Anime2.5DRig#readme" target="_blank" rel="noopener">GitHubで読む</a></p>';
  }
}
document.getElementById('btnReadme').addEventListener('click',openReadme);
document.getElementById('btnReadme2').addEventListener('click',openReadme);
function closeReadme(){document.getElementById('readmeOverlay').classList.remove('show');readmeFocus?.focus();}
document.getElementById('readmeClose').addEventListener('click',closeReadme);
document.getElementById('readmeOverlay').addEventListener('click',e=>{if(e.target.id==='readmeOverlay')closeReadme();});
document.addEventListener('keydown',e=>{
  if(document.getElementById('readmeOverlay').classList.contains('show')){
    if(e.key==='Escape'){e.preventDefault();closeReadme();}
    if(e.key==='Tab'){
      const items=[...document.querySelectorAll('#readmeOverlay button,#readmeOverlay a[href]')];
      if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items[items.length-1].focus();}
      else if(!e.shiftKey&&document.activeElement===items[items.length-1]){e.preventDefault();items[0].focus();}
    }
    return;
  }
  if(e.code==='Space'&&layers.length&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!/INPUT|TEXTAREA|BUTTON|SELECT/.test(e.target.tagName)&&!e.target.closest('[role="button"]')){e.preventDefault();togglePause();}
});

// ---------- mouse ----------
function renderLayerList(){
  const container=document.getElementById('layers');container.replaceChildren();
  layers.forEach((L,i)=>{
    const card=document.createElement('div');card.className='layer-card';card.classList.toggle('is-hidden',!L.visible);
    const top=document.createElement('div');top.className='layer-top';
    const visible=document.createElement('input');visible.type='checkbox';visible.checked=L.visible;visible.setAttribute('aria-label',L.name+'を表示');
    visible.addEventListener('change',()=>{L.visible=visible.checked;card.classList.toggle('is-hidden',!L.visible);});
    const name=document.createElement('span');name.className='layer-name';name.textContent=L.name;name.title=L.name+(L.synthetic?' / 自動生成':'');
    top.append(visible,name);
    for(const d of [-1,1]){const b=document.createElement('button');b.className='ord';b.textContent=d<0?'↑':'↓';b.setAttribute('aria-label',L.name+(d<0?'を奥へ':'を手前へ'));b.disabled=i+d<0||i+d>=layers.length;
      b.addEventListener('click',()=>{[layers[i],layers[i+d]]=[layers[i+d],layers[i]];renderLayerList();container.children[i+d].querySelector(d<0?'.ord':'.ord:last-child')?.focus();});top.append(b);}
    card.append(top);
    for(const [key,label,max] of [['opacity','濃さ',1],['depth','奥行き',2]]){
      const row=document.createElement('div');row.className='row';const caption=document.createElement('label');caption.textContent=label;
      const range=document.createElement('input');range.type='range';range.min='0';range.max=String(max);range.step='0.01';range.value=L[key];range.id='layer-'+i+'-'+key;caption.htmlFor=range.id;range.setAttribute('aria-label',L.name+'の'+label);
      const value=document.createElement('input');value.type='number';value.min='0';value.max=String(max);value.step='0.01';value.value=L[key];value.setAttribute('aria-label',L.name+'の'+label+'の数値');
      range.addEventListener('input',()=>{L[key]=Number(range.value);value.value=range.value;});
      value.addEventListener('input',()=>{if(value.value!==''&&Number.isFinite(value.valueAsNumber)){L[key]=RT.clamp(value.valueAsNumber,0,max);range.value=L[key];}});
      value.addEventListener('change',()=>{if(value.value!==''&&Number.isFinite(value.valueAsNumber))L[key]=RT.clamp(value.valueAsNumber,0,max);range.value=L[key];value.value=L[key];});
      row.append(caption,range,value);card.append(row);
    }
    container.append(card);
  });
}
function collapseSection(h,value){h.parentNode.classList.toggle('collapsed',value);h.setAttribute('aria-expanded',String(!value));}
document.querySelectorAll('#panel .sec > h2').forEach(h=>{
  h.tabIndex=0;h.setAttribute('role','button');h.setAttribute('aria-expanded','true');
  h.addEventListener('click',()=>collapseSection(h,!h.parentNode.classList.contains('collapsed')));
  h.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();h.click();}});
});
document.getElementById('btnCollapse').addEventListener('click',ev=>{const all=[...document.querySelectorAll('#panel .sec > h2')],value=all.some(h=>!h.parentNode.classList.contains('collapsed'));for(const h of all)collapseSection(h,value);ev.target.textContent=value?'すべて開く':'すべて畳む';});
document.getElementById('controlSearch').addEventListener('input',ev=>{
  const q=ev.target.value.trim().toLowerCase();let matches=0;
  document.querySelectorAll('#panel .sec').forEach(sec=>{const found=!q||sec.textContent.toLowerCase().includes(q);sec.hidden=!found;if(found)matches++;if(q&&found)collapseSection(sec.querySelector('h2'),false);});
  document.getElementById('searchEmpty').hidden=matches>0;
});

let mouse={x:0,y:0,in:false};
cv.addEventListener('mousemove',e=>{ const r=cv.getBoundingClientRect();
  mouse.x=(e.clientX-r.left)/r.width*2-1; mouse.y=(e.clientY-r.top)/r.height*2-1; mouse.in=true; });
cv.addEventListener('mouseleave',()=>mouse.in=false);

// ---------- mic ----------
let micLevel=0, analyser=null, micBuf=null;
let micStream=null,micContext=null,micGeneration=0;
function stopMic(){
  micGeneration++;micStream?.getTracks().forEach(t=>t.stop());micStream=null;
  micContext?.close().catch(()=>{});micContext=null;analyser=null;micBuf=null;micLevel=0;
  document.getElementById('tgMic').textContent='マイク口パク';
}
async function initMic(){
  const token=++micGeneration;let stream=null,ac=null;
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('https または localhost で開いてください');
    document.getElementById('tgMic').textContent='マイク準備中…';
    stream=await navigator.mediaDevices.getUserMedia({audio:true});
    if(token!==micGeneration||!auto.mic){stream.getTracks().forEach(t=>t.stop());return;}
    ac=new (window.AudioContext||window.webkitAudioContext)();micStream=stream;micContext=ac;
    await ac.resume();
    if(token!==micGeneration||!auto.mic){stream.getTracks().forEach(t=>t.stop());if(ac.state!=='closed')await ac.close();return;}
    const src=ac.createMediaStreamSource(stream);analyser=ac.createAnalyser();analyser.fftSize=512;
    micBuf=new Uint8Array(analyser.frequencyBinCount);src.connect(analyser);
    stream.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(token===micGeneration){setAuto('mic',false);status('マイクが切断されました',true);}}));
    document.getElementById('tgMic').textContent='マイク使用中';
  }catch(err){
    stream?.getTracks().forEach(t=>t.stop());if(ac&&ac.state!=='closed')ac.close().catch(()=>{});
    if(token!==micGeneration)return;
    auto.mic=false;syncToggle('mic');stopMic();status('マイクを開始できません: '+(err.name==='NotAllowedError'?'ブラウザのマイク許可を確認してください':err.message),true);
  }
}

// ---------- webcam face tracking (MediaPipe FaceMesh, lazy CDN) ----------
const cam={live:false,ax:0,ay:0,az:0,eL:1,eR:1,mo:0,ex:0,ey:0};
let camPhysScale=1;   // カメラ追従中は揺れ・柔らかさを0.5倍
let camSession=null,camGeneration=0,faceScript=null,lastTrackingAt=0,trackingEvents=null,lastPublishAt=0,relayEnabled=false;
const localHost=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
const relayReady=localHost?fetch('/relay-info').then(r=>r.ok?r.json():null).then(info=>relayEnabled=info?.protocol==='anime25d-tracking-v1').catch(()=>false):Promise.resolve(false);
function loadScript(u){return new Promise((res,rej)=>{const s=document.createElement('script');s.src=u;const timer=setTimeout(()=>{s.remove();rej(new Error('顔追跡モデルの読み込みがタイムアウトしました'));},20000);s.onload=()=>{clearTimeout(timer);res();};s.onerror=()=>{clearTimeout(timer);s.remove();rej(new Error('顔追跡モデルを取得できません'));};document.head.appendChild(s);});}
function publishTracking(force=false){
  if(OBS_MODE)return;
  const now=performance.now();if(!force&&now-lastPublishAt<65)return;lastPublishAt=now;
  const clean=RT.tracking(cam);if(!clean)return;
  trackingChannel?.postMessage({type:'face',cam:clean,at:Date.now()});
  if(relayEnabled&&!trackingPostBusy){
    trackingPostBusy=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
    fetch('/tracking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(clean),signal:controller.signal})
      .catch(()=>{}).finally(()=>{clearTimeout(timer);trackingPostBusy=false;});
  }
}
function stopCam(){
  camGeneration++;cam.live=false;lastTrackingAt=0;publishTracking(true);
  const session=camSession;camSession=null;
  if(session){clearTimeout(session.timer);session.stream.getTracks().forEach(t=>t.stop());session.video.pause();session.video.srcObject=null;
    Promise.resolve(session.pending).catch(()=>{}).then(()=>session.fm?.close()).catch(()=>{});}
  document.getElementById('tgCam').textContent='カメラ追従';
}
async function camLoop(session,token){
  if(token!==camGeneration||!auto.cam)return;
  try{
    if(session.video.readyState>=2){session.pending=session.fm.send({image:session.video});await session.pending;}
  }catch(err){if(token===camGeneration){setAuto('cam',false);status('顔追跡が停止しました。カメラを再度ONにしてください',true);}return;}
  if(token===camGeneration&&auto.cam)session.timer=setTimeout(()=>camLoop(session,token),33);
}
async function initCam(){
  if(OBS_MODE){status('通常ブラウザからの追跡を待っています');return;}
  const chip=document.getElementById('tgCam');
  const token=++camGeneration;let st=null,session=null;
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('https または localhost で開いてください');
    chip.textContent='カメラ準備中…';
    if(!window.FaceMesh){
      if(!faceScript)faceScript=loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js').catch(err=>{faceScript=null;throw err;});
      await faceScript;
    }
    if(token!==camGeneration||!auto.cam)return;
    try{
      st=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480}}});
    }catch(e1){
      if(e1.name==='OverconstrainedError'||e1.name==='ConstraintNotSatisfiedError'){
        st=await navigator.mediaDevices.getUserMedia({video:true});   // 制約を緩めて再試行
      } else throw e1;
    }
    if(token!==camGeneration||!auto.cam){st.getTracks().forEach(t=>t.stop());return;}
    const video=document.createElement('video');video.srcObject=st;video.muted=true;video.playsInline=true;
    session={video,stream:st,fm:null,pending:null,timer:null};camSession=session;
    await video.play();
    if(token!==camGeneration||!auto.cam)return;
    session.fm=new window.FaceMesh({locateFile:f=>'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/'+f});
    session.fm.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:0.5,minTrackingConfidence:0.5});
    session.fm.onResults(res=>{if(token===camGeneration&&auto.cam)onFace(res);});
    st.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(token===camGeneration){setAuto('cam',false);status('カメラが切断されました',true);}}));
    chip.textContent='カメラ追従中';
    camLoop(session,token);
  }catch(err){
    if(st){ try{ st.getTracks().forEach(t=>t.stop()); }catch(e){} }   // 後始末して次回リトライ可能に
    if(token!==camGeneration)return;
    stopCam();
    const msg=
      err.name==='NotAllowedError'||err.name==='PermissionDeniedError' ? 'カメラ許可が必要' :
      err.name==='NotReadableError'||err.name==='TrackStartError' ? 'カメラ使用中(他アプリ)' :
      err.name==='NotFoundError'||err.name==='DevicesNotFoundError' ? 'カメラ未検出' :
      err.name==='CdnError' ? 'モデル読込失敗(通信)' :
      !window.isSecureContext ? 'httpsが必要' : err.message;
    status('カメラを開始できません: '+msg,true);
    auto.cam=false;syncToggle('cam');
  }
}
function onFace(res){
  const lm=res.multiFaceLandmarks&&res.multiFaceLandmarks[0];
  if(!lm||lm.length<468){cam.live=false;publishTracking();return;}
  cam.live=true;
  lastTrackingAt=performance.now();
  const Pt=i=>lm[i];
  const d=(a,b)=>Math.hypot(Pt(a).x-Pt(b).x, Pt(a).y-Pt(b).y);
  const mix=(o,v)=>o+(v-o)*0.5;
  const chL=Pt(454), chR=Pt(234), nose=Pt(1), fh=Pt(10), chin=Pt(152);
  const fw=Math.hypot(chL.x-chR.x, chL.y-chR.y)||1e-4;
  const yaw=((nose.x-(chL.x+chR.x)/2)/fw)*3.2;
  const pitch=(((nose.y-(fh.y+chin.y)/2)/Math.abs(chin.y-fh.y||1e-4))-0.10)*3.0;
  const roll=Math.atan2(Pt(263).y-Pt(33).y, Pt(263).x-Pt(33).x);
  cam.ax=mix(cam.ax,-yaw); cam.ay=mix(cam.ay,-pitch); cam.az=mix(cam.az,-roll*1.4);
  const eo=(t,b,c1,c2)=>{ const r=d(t,b)/(d(c1,c2)||1e-4); return Math.min(1,Math.max(0,(r-0.09)/0.17)); };
  const linkedEye=Math.min(eo(159,145,33,133),eo(386,374,362,263));
  cam.eL=mix(cam.eL,linkedEye);
  cam.eR=mix(cam.eR,linkedEye);
  const mr=d(13,14)/(d(61,291)||1e-4);
  cam.mo=mix(cam.mo, Math.min(1,Math.max(0,(mr-0.03)/0.32)));
  if(lm.length>=478){
    const gz=(ir,c1,c2)=>{ const mx=(Pt(c1).x+Pt(c2).x)/2, w=Math.abs(Pt(c1).x-Pt(c2).x)||1e-4;
      return (Pt(ir).x-mx)/w; };
    const gx=(gz(468,33,133)+gz(473,362,263))/2;
    const gy=((Pt(468).y+Pt(473).y)/2-(Pt(159).y+Pt(145).y+Pt(386).y+Pt(374).y)/4)/fw;
    cam.ex=mix(cam.ex,-gx*5); cam.ey=mix(cam.ey,-gy*10);
  }
  const clean=RT.tracking(cam);if(clean)Object.assign(cam,clean);else cam.live=false;
  publishTracking();
}
if(CAMERA_MODE){
  auto.cam=true;
  syncToggle('cam');
  if(OBS_MODE){
    // OBSはカメラを直接開かず、通常ブラウザで計算した追跡値を受信する。
    if(trackingChannel) trackingChannel.onmessage=ev=>{
      if(!ev.data||ev.data.type!=='face') return;
      if(!Number.isFinite(ev.data.at)||Math.abs(Date.now()-ev.data.at)>2000)return;
      receiveTracking(ev.data.cam);
    };
    relayReady.then(enabled=>{if(!enabled)return;trackingEvents=new EventSource('/tracking-events');
      trackingEvents.onmessage=ev=>{try{receiveTracking(JSON.parse(ev.data));}catch(err){}};
      trackingEvents.onerror=()=>{cam.live=false;};});
  } else initCam();
}
function receiveTracking(value){const clean=RT.tracking(value);if(!clean||!auto.cam)return;Object.assign(cam,clean);lastTrackingAt=performance.now();}
window.addEventListener('pagehide',()=>{stopMic();stopCam();trackingChannel?.close();trackingEvents?.close();cancelLoad();});

// ---------- animation state ----------
let blinkT=-1, blinkVariant=1, blinkBounceStarted=false, irisBounceT=-1,
    nextBlink=(typeof performance!=='undefined'?performance.now():0)+1800;
let rnd={ax:0,ay:0,az:0,bd:0,ex:0,ey:0}, nextRnd=0;
let talkOn=false, talkV=0, talkTgt=0, nextTalkState=0, nextSyl=0;
function clamp(v,a,b){return v<a?a:v>b?b:v}
function smooth(t){t=clamp(t,0,1);return t*t*(3-2*t)}

function fadeAlpha(L,e){
  if(!L.fade) return 1;
  if(L.fade==='eyeOpen'){ const v=L.side==='L'?e.eyeOpenL:e.eyeOpenR; return smooth((v-(0.10+e.eyeEase*0.45))/0.15); }
  if(L.fade==='eyeClose'||L.fade==='eyeClose2'){
    const alternate=blinkVariant===2&&layers.some(p=>p.fade==='eyeClose2'&&p.side===L.side&&p.visible&&p.opacity>0);
    if((L.fade==='eyeClose2')!==alternate) return 0;
    const v=L.side==='L'?e.eyeOpenL:e.eyeOpenR; return 1-smooth((v-(0.10+e.eyeEase*0.45))/0.15);
  }
  if(L.fade==='mouthOpen') return smooth((e.mouthOpen-(0.05+e.mouthEase*0.35))/0.12);
  if(L.fade==='mouthClose') return 1-smooth((e.mouthOpen-(0.05+e.mouthEase*0.35))/0.12);
  return 1;
}

function deform(L, e){
  const b=L.base, o=L.cur, n=b.length;
  const isHead=L.group==='head';
  const az=e.angleZ*0.07, cz=Math.cos(az), sz=Math.sin(az);
  const ab=e.body*0.028, cb=Math.cos(ab), sb=Math.sin(ab);
  const nm=L.name, bn=L.bn;
  const eyeSide=L.side, EA=eyeSide==='L'?A.eyeL:(eyeSide==='R'?A.eyeR:null);
  const vOpen=eyeSide==='L'?e.eyeOpenL:e.eyeOpenR;
  const mo=e.mouthOpen;
  const mHalfW=(A.mouth.x1-A.mouth.x0)/2;
  const nS=L.strands?L.strands.length:0;
  const bcx=L.x+L.w/2, bcy=L.y+L.h/2;
  const isFH=(bn==='front hair');
  for(let k=0;k<n;k+=2){
    let x=b[k], y=b[k+1];
    const vi=k>>1;
    // --- closed-eye / mouth scale ---
    if(EA && (bn==='eye_close'||bn==='eye_close2')){
      const sE=eyeSide==='L'?e.eyeScaleL:e.eyeScaleR;
      if(sE!==1){ const cxE=(EA.x0+EA.x1)/2, cyE=(EA.y0+EA.y1)/2;
        x=cxE+(x-cxE)*sE; y=cyE+(y-cyE)*sE; }
    }
    if(bn==='mouth_open'||bn==='mouth_close'){
      const sM=e.mouthScale;
      if(sM!==1){ x=A.mouth.cx+(x-A.mouth.cx)*sM; y=A.mouth.cy+(y-A.mouth.cy)*sM; }
    }
    // --- local features ---
    if(L.fade==='eyeOpen'&&EA){
      if(bn==='irides'){
        const isc=e.irisScale;
        const ibx=e.irisBounceX||1, iby=e.irisBounceY||1;
        x=EA.icx+(x-EA.icx)*isc*ibx; y=EA.icy+(y-EA.icy)*isc*iby;
        x+=e.eyeX*11*FS; y+=e.eyeY*6*FS;
        const tl=smooth((0.32-vOpen)/0.32);           // iris stays round until nearly closed
        y = EA.closeY + (y-EA.closeY)*(1-0.80*tl);
      } else {
        y = EA.closeY + (y-EA.closeY)*(1-0.85*(1-vOpen));   // lid compression
      }
    }
    if((L.fade==='eyeClose'||L.fade==='eyeClose2')&&EA){
      y -= vOpen*3;
      y += e.eyeCY*14*FS;
      const thE=e.eyeCAng*0.3*(eyeSide==='L'?1:-1);
      if(thE){ const ct=Math.cos(thE), st=Math.sin(thE), rx=x-bcx, ry=y-bcy;
        x=bcx+rx*ct-ry*st; y=bcy+rx*st+ry*ct; }
    }
    if(bn==='eyebrow'){
      y += (-e.brow*9 + (1-vOpen)*3.5)*FS;
      const th=(eyeSide==='L'?(e.browAngL+e.browAngSym):(e.browAngR-e.browAngSym))*0.30;
      if(th){ const ct=Math.cos(th), st=Math.sin(th), rx=x-bcx, ry=y-bcy;
        x=bcx+rx*ct-ry*st; y=bcy+rx*st+ry*ct; }
    }
    if(L.fade==='mouthOpen'){
      y = A.mouth.y0 + (y-A.mouth.y0)*(0.5+0.5*mo);
      const q=Math.pow(Math.abs(x-A.mouth.cx)/(mHalfW+4),1.5);
      y -= e.mouthForm*6*FS*(q-0.35);
    }
    if(L.fade==='mouthClose'){
      y += e.mouthCY*14*FS;   // 形（笑い）は閉じ口には適用しない
      const thM=e.mouthCAng*0.35;
      if(thM){ const ct=Math.cos(thM), st=Math.sin(thM), rx=x-A.mouth.cx, ry=y-A.mouth.cy;
        x=A.mouth.cx+rx*ct-ry*st; y=A.mouth.cy+rx*st+ry*ct; }
    }
    if(bn==='face' && y>A.mouth.cy){
      y += mo*6*FS*smooth((y-A.mouth.cy)/(A.face.y1-A.mouth.cy));
    }
    // --- head transform ---
    let hw = isHead?1:(L.group==='body'?0.16:0);   // body subtly follows head XYZ
    if(bn==='neck') hw = 0.55*smooth((A.neckBottom-y)/Math.max(1,A.neckBottom-A.neckTop));
    if(hw>0){
      let rx=x-NP.cx, ry=y-NP.cy;
      const rx2=rx*cz-ry*sz, ry2=rx*sz+ry*cz;
      x+=(rx2-rx)*hw; y+=(ry2-ry)*hw;
      const dd=L.depth;
      x += hw*FS*( e.angleX*(14+40*(dd-1)) + e.angleX*(NP.cy-y)*0.028 );
      y += hw*FS*( -e.angleY*(9+30*(dd-1)) - e.angleY*(dd-1)*(y-FC.y)*0.05 );
    }
    // --- breathing ---
    y -= (L.group==='body'?e.breath*2.0:e.breathHead*1.6)*FS;
    if(bn==='topwear'&&y<CHEST.cy) y -= e.breath*2.2*FS*smooth((CHEST.cy-y)/(CHEST.ry*2));   // shoulders rise
    if(bn==='topwear') x = NP.cx + (x-NP.cx)*(1+e.breath*0.003);
    // --- bust jiggle ---
    if(bn==='topwear'){
      const gx=(x-CHEST.cx)/CHEST.rx, gy=(y-(CHEST.cy+e.bustY*70*FS))/CHEST.ry;
      y += bounce.dy*e.bust*Math.exp(-gx*gx-gy*gy);
    }
    // --- arms ---
    if(bn==='handwear'){
      const w=smooth((y-L.y)/L.h*1.15);
      y -= e.armY*30*FS*w;
      y += e.armPos*40*FS;
      x += e.armY*6*FS*w*(x<NP.cx?1:-1);
    }
    // --- bang blocks ---
    if(L.bw&&L.su){ const m=Math.pow(L.su[vi],1.4)*22*FS;
      x += (e.bangL*L.bw[vi*3]+e.bangC*L.bw[vi*3+1]+e.bangR*L.bw[vi*3+2])*m;
    }
    // --- hair strand physics (stiff top, fluffy bottom; front hair has own params) ---
    if(nS && auto.phys){
      const u=isFH?Math.min(1,L.su[vi]*1.6):L.su[vi];
      const amp=Math.pow(u,isFH?1.8:2.1)*(isFH?e.fhAmp:e.physAmp);
      const softMix=Math.pow(u,1.2)*(isFH?e.fhSoft:e.soft);
      let dx=0;
      for(let s=0;s<nS;s++){
        const w=L.sw[vi*nS+s]; if(w<0.001)continue;
        const sp=L.spr[s];
        dx += w*( sp.stiff.dx*(1-softMix) + sp.soft.dx*softMix );
      }
      x += dx*amp; y += Math.abs(dx)*amp*0.12;
    }
    o[k]=x; o[k+1]=y;
  }
  // --- body rotation (around bottom center) ---
  if(Math.abs(ab)>1e-4){
    for(let k=0;k<n;k+=2){
      const rx=o[k]-BP.cx, ry=o[k+1]-BP.cy;
      o[k]=BP.cx+rx*cb-ry*sb; o[k+1]=BP.cy+rx*sb+ry*cb;
    }
  }
}

// ---------- main loop ----------
let last=performance.now(),simulationTime=last,fpsN=0,fpsT=last;
function fit(){
  const st=document.getElementById('stage'), s=Math.min(st.clientWidth/CW, st.clientHeight/CH);
  cv.style.width=(CW*s)+'px'; cv.style.height=(CH*s)+'px';
}
window.addEventListener('resize',fit);
if(typeof ResizeObserver!=='undefined')new ResizeObserver(fit).observe(document.getElementById('stage'));
function animate(now,dt){
  const t=now/1000;
  let tgt=Object.assign({},T);
  const camLive=auto.cam&&cam.live&&performance.now()-lastTrackingAt<1200;
  if(camLive){
    tgt.angleX=clamp(cam.ax,-1,1); tgt.angleY=clamp(cam.ay,-1,1); tgt.angleZ=clamp(cam.az,-1,1);
    tgt.eyeOpenL=Math.min(tgt.eyeOpenL,cam.eL); tgt.eyeOpenR=Math.min(tgt.eyeOpenR,cam.eR);
    tgt.eyeX=clamp(cam.ex,-1,1); tgt.eyeY=clamp(cam.ey,-1,1);
    tgt.mouthOpen=Math.max(tgt.mouthOpen,cam.mo);
    tgt.body=clamp(tgt.body+cam.ax*0.25,-1,1);
  }
  if(!camLive&&auto.mouse&&mouse.in){ tgt.angleX=clamp(mouse.x*0.9,-1,1); tgt.angleY=clamp(-mouse.y*0.7,-1,1);
    tgt.eyeX=clamp(mouse.x*1.2,-1,1); tgt.eyeY=clamp(-mouse.y*0.8,-1,1); }
  if(auto.idle&&!camLive){
    tgt.angleX+=0.13*Math.sin(t*0.42)+0.05*Math.sin(t*1.13);
    tgt.angleY+=0.08*Math.sin(t*0.31+1.7);
    tgt.angleZ+=0.07*Math.sin(t*0.23+0.5);
    tgt.body +=0.10*Math.sin(t*0.19+2.1);
  }
  if(auto.rand&&!camLive){
    if(now>nextRnd){ nextRnd=now+1400+Math.random()*2600;
      rnd.ax=(Math.random()*2-1)*0.55; rnd.ay=(Math.random()*2-1)*0.40;
      rnd.az=(Math.random()*2-1)*0.35; rnd.bd=(Math.random()*2-1)*0.30;
      rnd.ex=(Math.random()*2-1)*0.60; rnd.ey=(Math.random()*2-1)*0.35; }
    tgt.angleX=clamp(tgt.angleX+rnd.ax,-1,1); tgt.angleY=clamp(tgt.angleY+rnd.ay,-1,1);
    tgt.angleZ=clamp(tgt.angleZ+rnd.az,-1,1); tgt.body=clamp(tgt.body+rnd.bd,-1,1);
    tgt.eyeX=clamp(tgt.eyeX+rnd.ex,-1,1); tgt.eyeY=clamp(tgt.eyeY+rnd.ey,-1,1);
  }
  if(auto.talk&&!camLive&&!auto.mic&&!activePreset){
    if(now>nextTalkState){ talkOn=!talkOn; nextTalkState=now+(talkOn?1200+Math.random()*2200:600+Math.random()*1800); }
    if(talkOn&&now>nextSyl){ nextSyl=now+70+Math.random()*110; talkTgt=Math.random()<0.25?0.04:0.25+Math.random()*0.75; }
    if(!talkOn)talkTgt=0;
    talkV+=(talkTgt-talkV)*Math.min(1,dt*22);
    tgt.mouthOpen=Math.max(tgt.mouthOpen,talkV);
  }
  if(auto.blink&&!camLive&&!activePreset){
    if(blinkT<0 && now>nextBlink){ blinkT=0; blinkBounceStarted=false; blinkVariant=hasEyeClose2&&Math.random()<0.2?2:1; nextBlink=now+1600+Math.random()*3800; if(Math.random()<0.18)nextBlink=now+280; }
    if(blinkT>=0){ blinkT+=dt;
      const d=blinkT, hold=blinkVariant===2?3.4:0.34; let v;
      if(d<0.08)v=1-d/0.08; else if(d<0.08+hold)v=0; else if(d<0.24+hold){
        v=(d-0.08-hold)/0.16;
        if(!blinkBounceStarted&&v>0.12){ blinkBounceStarted=true; irisBounceT=0; }
      } else{v=1;blinkT=-1;}
      tgt.eyeOpenL=Math.min(tgt.eyeOpenL,v); tgt.eyeOpenR=Math.min(tgt.eyeOpenR,v);
    }
  }
  if(irisBounceT>=0){ irisBounceT+=dt; if(irisBounceT>0.52) irisBounceT=-1; }
  if(auto.mic&&analyser){ analyser.getByteFrequencyData(micBuf);
    let s=0; for(let i=2;i<40;i++)s+=micBuf[i]; s/=38*255;
    micLevel+=(clamp(s*3.2,0,1)-micLevel)*0.45;
    tgt.mouthOpen=Math.max(tgt.mouthOpen,micLevel);
  }
  for(const k in cur){tgt[k]=RT.clamp(tgt[k],...parameterRanges[k]);cur[k]+=(tgt[k]-cur[k])*(1-Math.exp(-dt*14));}
  const e=Object.assign({},cur);
  e.irisBounceX=1; e.irisBounceY=1;
  if(irisBounceT>=0){
    const p=irisBounceT/0.52, damp=Math.exp(-2.2*p);
    // 全体スケールの弾みへ、縦横で逆方向のつぶれ・伸びを重ねる。
    const scale=1+0.18*Math.sin(p*Math.PI*4.0)*damp;
    const squash=0.10*Math.sin(p*Math.PI*4.0+Math.PI/2)*damp;
    e.irisBounceX=scale*(1+squash);
    e.irisBounceY=scale*(1-squash);
  }
  camPhysScale+=((camLive?0.5:1)-camPhysScale)*Math.min(1,dt*4);
  e.physAmp*=camPhysScale; e.soft*=camPhysScale; e.fhAmp*=camPhysScale; e.fhSoft*=camPhysScale;
  e.breath=0.5+0.5*Math.sin(t*2*Math.PI/3.4);
  e.breathHead=0.5+0.5*Math.sin(t*2*Math.PI/3.4-0.6);   // head follows chest with a lag

  // strand springs
  const headDX=(e.angleX*14+e.angleZ*0.07*(NP.cy-FC.y))*FS;
  for(const L of layers){
    if(!L.spr) continue;
    for(const sp of L.spr){
      const wind=auto.idle?(1.8*Math.sin(t*0.8+sp.phase)+1.0*Math.sin(t*1.9+sp.phase*2.3)):0;
      const txv=headDX+wind*FS;
      RT.spring(sp.stiff,txv,70,9,dt);
      sp.stiff.dx=-(sp.stiff.x-txv)*2.2;
      RT.spring(sp.soft,txv,16,1.3,dt);
      sp.soft.dx=-(sp.soft.x-txv)*3.0;
    }
  }
  // bust bounce
  { const bustTgt=(e.breath*3.0 - e.angleY*6.0 + e.body*4.0)*FS;
    RT.spring(bounce,bustTgt,140,4.2,dt);
    bounce.dy=-(bounce.x-bustTgt)*3.0; }
  return e;
}
function bindLayer(L){
  gl.bindBuffer(gl.ARRAY_BUFFER,L.vboPos);gl.vertexAttribPointer(locPos,2,gl.FLOAT,false,0,0);
  gl.bindBuffer(gl.ARRAY_BUFFER,L.vboUV);gl.vertexAttribPointer(locUV,2,gl.FLOAT,false,0,0);
  gl.bindTexture(gl.TEXTURE_2D,L.tex);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,L.ibo);
}
function render(e){
  gl.viewport(0,0,CW,CH);
  gl.clearColor(0,0,0,0); gl.clearStencil(0);
  gl.stencilMask(0xff);gl.colorMask(true,true,true,true);
  gl.clear(gl.COLOR_BUFFER_BIT|gl.STENCIL_BUFFER_BIT);
  gl.uniform2f(locRes,CW,CH);
  const active=[];
  for(const L of layers){
    if(!L.visible)continue;const alpha=fadeAlpha(L,e)*L.opacity;if(alpha<0.004)continue;
    deform(L,e);gl.bindBuffer(gl.ARRAY_BUFFER,L.vboPos);gl.bufferSubData(gl.ARRAY_BUFFER,0,L.cur);
    active.push({L,alpha});
  }
  // Build the eye masks before painting: layer order cannot change clip geometry.
  gl.enable(gl.STENCIL_TEST);gl.colorMask(false,false,false,false);gl.uniform1f(locAl,1);gl.uniform1f(locCut,0.25);
  for(const {L} of active){if(L.bn!=='eyewhite'||!L.side)continue;const bit=L.side==='L'?1:2;
    bindLayer(L);gl.stencilMask(bit);gl.stencilFunc(gl.ALWAYS,bit,bit);gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE);gl.drawElements(gl.TRIANGLES,L.nIdx,gl.UNSIGNED_SHORT,0);}
  gl.colorMask(true,true,true,true);gl.stencilMask(0);gl.uniform1f(locCut,0);
  for(const {L,alpha} of active){
    bindLayer(L);gl.uniform1f(locAl,alpha);
    if(L.bn==='irides'&&L.side){const bit=L.side==='L'?1:2;gl.enable(gl.STENCIL_TEST);gl.stencilFunc(gl.EQUAL,bit,bit);gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);}
    else gl.disable(gl.STENCIL_TEST);
    gl.drawElements(gl.TRIANGLES,L.nIdx,gl.UNSIGNED_SHORT,0);
  }
  gl.disable(gl.STENCIL_TEST);gl.stencilMask(0xff);
}
function tick(now){
  requestAnimationFrame(tick);
  const dt=Math.max(0,Math.min(0.05,(now-last)/1000));last=now;
  if(!layers.length||!A||contextLost)return;
  if(!paused||!lastFrame){simulationTime+=dt*1000;lastFrame=animate(simulationTime,dt);}
  render(lastFrame);
  if(capturePending){
    capturePending=false;
    cv.toBlob(blob=>{if(blob){download(blob,(modelName.replace(/\.psd$/i,'')||'avatar')+'.png');status('透過PNGを書き出しました（'+CW+' × '+CH+'px）');}else status('PNGを書き出せませんでした',true);},'image/png');
  }
  fpsN++; if(now-fpsT>500){ document.getElementById('fps').textContent=Math.round(fpsN*1000/(now-fpsT))+' fps';
    fpsN=0; fpsT=now; }
}
cv.addEventListener('webglcontextlost',ev=>{ev.preventDefault();contextLost=true;capturePending=false;status('描画が一時停止しました。復旧を待っています',true);});
cv.addEventListener('webglcontextrestored',()=>{
  try{const saved=currentRig?settingsSnapshot():null;layers=[];initGL();contextLost=false;if(currentRig){applyRig(currentRig);applySettings(saved);}status('描画を復旧しました');}
  catch(err){contextLost=true;status('描画の復旧に失敗しました。ページを再読み込みしてください',true);}
});
requestAnimationFrame(tick);
})();
