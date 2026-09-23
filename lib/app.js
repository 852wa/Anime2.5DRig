/*!
 * Anime2.5DRig — app.js
 * Editor UI, animation, input devices and OBS view.
 * Classic script (no modules) so that index.html also works from file://.
 * MIT License
 */
(function(){
'use strict';
const APP_VERSION='2.0.0';
const RT=window.RigRuntime, FF=window.FaceFeatures;
const QUERY=new URLSearchParams(location.search);
const OBS_MODE=QUERY.get('obs')==='1', CAMERA_MODE=QUERY.get('cam')==='1';
if(OBS_MODE)document.body.classList.add('obs');
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
function smooth(t){t=clamp(t,0,1);return t*t*(3-2*t);}
const round2=v=>Math.round(v*1000)/1000;
$('appVersion').textContent='v'+APP_VERSION.replace(/\.0$/,'');

// ---------- small helpers ----------
const statusEl=$('appStatus');let statusTimer=null;
function status(message,error=false){
  statusEl.textContent=message;statusEl.classList.toggle('error',error);statusEl.classList.remove('fade');
  clearTimeout(statusTimer);if(!error)statusTimer=setTimeout(()=>statusEl.classList.add('fade'),6000);
}
function download(blob,name){
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.style.display='none';
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),10000);
}
function storageGet(key){try{return localStorage.getItem(key);}catch(err){return null;}}
function storageSet(key,value){localStorage.setItem(key,value);}
function baseFileName(){return RT.safeFileName(modelName,'avatar');}

// ---------- WebGL ----------
const cv=$('cv');
const gl=cv.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:false});
if(!gl){$('dropStatus').textContent='このブラウザではWebGLを使用できません。ハードウェアアクセラレーションを有効にしてください。';return;}
let renderer;
try{renderer=window.RigRenderer.create(gl);}catch(err){$('dropStatus').textContent='描画の初期化に失敗しました: '+err.message;return;}
const EXPORT_BG={transparent:[0,0,0,0],green:[0,177/255,64/255,1],dark:[20/255,21/255,28/255,1]};

// ---------- model state (rebuilt per PSD) ----------
let modelId='',modelName='',currentRig=null,background='checker',paused=false,contextLost=false,lastFrame=null,capturePending=false,dirty=true;
let layers=[],A=null,baseAnchors=null,anchorOffsets={},CW=768,CH=768,FS=1,NP=null,BP=null,FC=null,CHEST=null,hasEyeClose2=false;
let lastPsd=null,lastPre=null,anchorMode=false,anchorPreview=null,highlightLayer=null;
const bounce={x:0,v:0,dy:0};
function invalidate(){dirty=true;}

function makeThumb(img){
  if(OBS_MODE||typeof document==='undefined')return '';
  try{
    const s=Math.min(1,64/Math.max(img.width,img.height)),tw=Math.max(1,Math.round(img.width*s)),th=Math.max(1,Math.round(img.height*s));
    const full=document.createElement('canvas');full.width=img.width;full.height=img.height;full.getContext('2d').putImageData(img,0,0);
    const t=document.createElement('canvas');t.width=tw;t.height=th;const ctx=t.getContext('2d');ctx.imageSmoothingQuality='high';ctx.drawImage(full,0,0,tw,th);
    return t.toDataURL('image/png');
  }catch(err){return '';}
}
function prepareLayers(rig){
  const prepared=[],W=rig.canvas.w;
  const maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE),maxViewport=gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  if(rig.canvas.w>maxViewport[0]||rig.canvas.h>maxViewport[1]||rig.canvas.w>maxTexture||rig.canvas.h>maxTexture)throw new Error('この端末の描画サイズ（'+Math.min(maxViewport[0],maxTexture)+'px）を超えています。PSDを縮小してください');
  try{
    for(const Lr of rig.layers){
      if(Lr.w>maxTexture||Lr.h>maxTexture)throw new Error('画像パーツがこの端末の上限 '+maxTexture+'px を超えています');
      const L=Object.assign({visible:true,opacity:1},Lr,{id:String(Lr.z)+':'+Lr.name});
      delete L.img;
      L.defaultDepth=L.depth;L.defaultOpacity=L.opacity;
      prepared.push(L);
      const cell=(L.phys?30:42)*Math.max(0.6,W/768);
      const {nx,ny}=RT.meshSize(L.w,L.h,cell),nv=(nx+1)*(ny+1);
      const base=new Float32Array(nv*2),uv=new Float32Array(nv*2);
      let k=0;
      for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++){base[k]=L.x+L.w*i/nx;base[k+1]=L.y+L.h*j/ny;uv[k]=i/nx;uv[k+1]=j/ny;k+=2;}
      const idx=new Uint16Array(nx*ny*6);let q=0;
      for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const a=j*(nx+1)+i,b=a+1,c=a+nx+1,d=c+1;idx[q++]=a;idx[q++]=b;idx[q++]=c;idx[q++]=b;idx[q++]=d;idx[q++]=c;}
      L.base=base;L.cur=new Float32Array(base);
      L.bn=Rigger.baseName(L.name.replace(/_(l|r)$/,''));
      if(L.strands&&L.strands.length){
        const S=L.strands,nS=S.length;
        let spacing=120;
        if(nS>1){const ds=[];for(let s=1;s<nS;s++)ds.push(S[s].x-S[s-1].x);ds.sort((a,b)=>a-b);spacing=ds[ds.length>>1];}
        const sig=Math.max(1,spacing*0.6);
        L.sw=new Float32Array(nv*nS);L.su=new Float32Array(nv);
        L.spr=S.map((s,i)=>({stiff:{x:0,v:0,dx:0},soft:{x:0,v:0,dx:0},phase:i*1.37+L.z}));
        for(let v=0;v<nv;v++){
          const x=base[v*2],y=base[v*2+1];let tot=0;
          for(let s=0;s<nS;s++){const w=Math.exp(-Math.pow((x-S[s].x)/sig,2));L.sw[v*nS+s]=w;tot+=w;}
          let rY=0,tY=0;
          if(tot>1e-6){for(let s=0;s<nS;s++){L.sw[v*nS+s]/=tot;rY+=L.sw[v*nS+s]*S[s].rootY;tY+=L.sw[v*nS+s]*S[s].tipY;}}
          else{L.sw[v*nS]=1;rY=S[0].rootY;tY=S[0].tipY;}
          L.su[v]=clamp((y-rY)/Math.max(1,tY-rY),0,1);
        }
      }
      const image=(typeof ImageData!=='undefined')?new ImageData(Lr.img.data,Lr.img.width,Lr.img.height):Lr.img;
      L.thumb=makeThumb(image);
      renderer.upload(L,{positions:L.cur,uvs:uv,indices:idx,image});
    }
    return prepared;
  }catch(err){prepared.forEach(renderer.dispose);throw err;}
}
// Front-hair block weights depend on the face anchor, so they follow anchor edits.
function buildBangWeights(L){
  if(L.bn!=='front hair'||!L.su){L.bw=null;return;}
  const fw=A.face.x1-A.face.x0,fcx=A.face.cx,f=36,b1=fcx-fw*0.22,b2=fcx+fw*0.22,nv=L.base.length/2;
  L.bw=new Float32Array(nv*3);
  for(let v=0;v<nv;v++){const x=L.base[v*2],s1=smooth((x-b1)/f+0.5),s2=smooth((x-b2)/f+0.5);L.bw[v*3]=1-s1;L.bw[v*3+1]=s1*(1-s2);L.bw[v*3+2]=s2;}
}
function applyAnchors(){
  if(!baseAnchors)return;
  const a=JSON.parse(JSON.stringify(baseAnchors)),o=anchorOffsets,off=k=>o[k]||{};
  a.face.cx+=off('face').dx||0;a.face.cy+=off('face').dy||0;
  for(const s of ['L','R']){const e=a['eye'+s];if(!e)continue;e.icx+=off('eye'+s).dx||0;e.icy+=off('eye'+s).dy||0;e.closeY+=off('eye'+s+'Close').dy||0;}
  const m=off('mouth');for(const k of ['cx','x0','x1'])a.mouth[k]+=m.dx||0;for(const k of ['cy','y0','y1'])a.mouth[k]+=m.dy||0;
  a.neckPivot.cx+=off('neck').dx||0;a.neckPivot.cy+=off('neck').dy||0;
  A=a;FS=A.faceScale;NP=A.neckPivot;BP=A.bodyPivot;FC={x:A.face.cx,y:A.face.cy};
  const ch=off('chest'),fh=A.face.y1-A.face.y0;
  CHEST={cx:NP.cx+(ch.dx||0),cy:A.neckBottom+fh*0.60+(ch.dy||0),rx:Math.max(1,(A.face.x1-A.face.x0)*0.60),ry:Math.max(1,fh*0.45)};
  for(const L of layers)buildBangWeights(L);
  const n=Object.keys(anchorOffsets).length;
  $('anchorSummary').textContent=n?n+'か所を手動で調整中':'すべて自動検出の位置です';
  renderOverlay();invalidate();
}
function applyRig(rig){
  if(contextLost)throw new Error('描画の復旧を待ってから読み込んでください');
  const prepared=prepareLayers(rig);
  layers.forEach(renderer.dispose);layers=prepared;currentRig=rig;
  CW=rig.canvas.w;CH=rig.canvas.h;
  baseAnchors=JSON.parse(JSON.stringify(rig.anchors));anchorOffsets={};
  applyAnchors();
  Object.assign(bounce,{x:0,v:0,dy:0});lastFrame=null;blinkT=-1;blinkVariant=1;irisBounceT=-1;
  hasEyeClose2=layers.some(L=>L.bn==='eye_close2');maskFailed=false;
  cv.width=CW;cv.height=CH;
  $('overlay').setAttribute('viewBox','0 0 '+CW+' '+CH);
  resetView();fit();
  expandedLayers.clear();renderLayerList();renderDiagnostics(rig);
  $('drop').classList.add('hidden');
  document.querySelectorAll('[data-model-action]').forEach(b=>b.disabled=false);
  updateRecordAvailability();
  invalidate();
}

// ---------- PSD loading ----------
const dropEl=$('drop'),dropStatus=$('dropStatus');
let loadTicket=0,loaderWorker=null,loadController=null,cancelWorker=null;
function setLoading(on){$('btnCancelLoad').hidden=!on;$('loadProgress').hidden=!on;}
function cancelLoad(){
  loadTicket++;loadController?.abort();loadController=null;
  loaderWorker?.terminate();loaderWorker=null;
  cancelWorker?.(new DOMException('中止','AbortError'));cancelWorker=null;
  setLoading(false);
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
      loaderWorker.onerror=ev=>{ev.preventDefault?.();loaderWorker?.terminate();loaderWorker=null;cancelWorker=null;reject(new Error('PSD解析を開始できません（メモリ不足の可能性があります）。localhostで開き直すか、PSDを縮小してください'));};
      loaderWorker.postMessage({buffer,generic},[buffer]);
    });
  }
  // Direct file opening cannot reliably start a worker. Keep that workflow usable.
  await new Promise(r=>setTimeout(r,20));
  if(ticket!==loadTicket)throw new DOMException('中止','AbortError');
  const id=RT.fingerprint(buffer);
  const options={useImageData:true,skipThumbnail:true,skipCompositeImageData:true};
  Rigger.validatePsd(agPsd.readPsd(new Uint8Array(buffer),{...options,skipLayerImageData:true}));
  const psd=agPsd.readPsd(new Uint8Array(buffer),{...options,skipCompositeImageData:false}),pre=Rigger.cleanPsdLayers(psd);
  return {psd,pre,rig:Rigger.buildRig(psd,{generic}),id};
}
/** source(signal) resolves to an ArrayBuffer or {buffer, name}. */
async function loadModel(source,name,opts={}){
  cancelLoad();const ticket=loadTicket;
  loadController=new AbortController();const signal=loadController.signal;
  setLoading(true);
  dropEl.classList.remove('hidden');loadProgress(name+' を読み込み中…');
  try{
    if(!window.agPsd)throw new Error('lib/ag-psd.min.js が未読込です。ZIPを展開してから開く / lib フォルダを index.html と同じ階層に配置してください');
    if(!window.Rigger)throw new Error('lib/rigger.js が未読込です。lib フォルダの配置を確認してください');
    const got=await source(signal);
    let buf=got,displayName=name;
    if(got&&!(got instanceof ArrayBuffer)&&got.buffer instanceof ArrayBuffer){buf=got.buffer;displayName=got.name||name;}
    RT.validateHeader(buf);
    await customGenericReady;
    if(ticket!==loadTicket)return;
    let relayCopy=null;
    if(!OBS_MODE&&opts.relay!==false&&sync.mayRelay)relayCopy=buf.slice(0);   // kept so OBS can be (re)synced later
    if(ticket!==loadTicket)return;
    const parsed=await parseModel(buf,genericOpts().generic,ticket);
    if(ticket!==loadTicket)return;
    setAnchorMode(false);
    applyRig(parsed.rig);
    modelId=parsed.id||'';modelName=displayName;lastPsd=parsed.psd;lastPre=parsed.pre;
    $('modelName').textContent=displayName;$('modelName').title=displayName;
    document.title=(OBS_MODE?'OBS · ':'')+displayName+' — Anime2.5DRig';
    resetParams();restoreSettings(true);
    history.reset(historySnapshot());savedSettings=comparableSettings();updateHistoryButtons();updateDirty();
    if(parsed.pre.noisy>0)$('rigInfo').textContent+='\nノイズ除去: '+parsed.pre.noisy+'/'+parsed.pre.layers+'レイヤー';
    dropStatus.textContent='';
    status(displayName+' を読み込みました');
    if(relayCopy)sync.publishModel(relayCopy,displayName,modelId);
    syncState(true);
    if(OBS_MODE)afterObsModel();
  }catch(err){
    if(ticket!==loadTicket||err.name==='AbortError')return;
    dropStatus.textContent='エラー: '+err.message;status(dropStatus.textContent,true);
    dropEl.classList.toggle('hidden',!!layers.length);
  }finally{
    if(ticket===loadTicket){setLoading(false);loadController=null;}
  }
}
$('btnCancelLoad').addEventListener('click',()=>{cancelLoad();status('読み込みを中止しました');});
let customGeneric=null;
async function loadCustomGeneric(){
  if(typeof fetch==='undefined'||!window.agPsd||!window.Rigger||location.protocol==='file:')return;
  async function grab(url){
    try{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
      let buffer;
      try{const r=await fetch(url,{signal:controller.signal});if(!r.ok)return null;buffer=await r.arrayBuffer();}finally{clearTimeout(timer);}
      RT.validateHeader(buffer);
      const psd=window.agPsd.readPsd(new Uint8Array(buffer),{useImageData:true,skipThumbnail:true,skipCompositeImageData:true});
      return window.Rigger.flattenPsdToImg(psd);
    }catch(err){return null;}
  }
  const [eye,mouth]=await Promise.all([grab('eye_close.psd'),grab('mouth_close.psd')]);
  const g={};
  if(eye){const s=window.Rigger.splitImgLR(eye);if(s){g.eyeL=s.l;g.eyeR=s.r;}}
  if(mouth)g.mouth=mouth;
  if(g.eyeL||g.mouth)customGeneric=g;
}
const customGenericReady=loadCustomGeneric();
function genericOpts(){
  const GP=window.GenericParts;
  const base=GP?{eyeL:GP.get('eyeL'),eyeR:GP.get('eyeR'),mouth:GP.get('mouth')}:{};
  const g=Object.assign({},base,customGeneric||{});
  return (g.eyeL||g.mouth)?{generic:g}:{};
}
$('btnFile').addEventListener('click',()=>$('fileInput').click());
$('btnOpen').addEventListener('click',()=>$('fileInput').click());
function loadFile(f){
  return loadModel(async()=>{
    if(!/\.psd$/i.test(f.name))throw new Error('拡張子が .psd のファイルを選んでください');
    if(f.size>RT.MAX_FILE_BYTES)throw new Error('PSDは128MB以下にしてください');
    return f.arrayBuffer();
  },f.name);
}
function openFile(f){if(/\.json$/i.test(f.name))importSettingsFile(f);else loadFile(f);}
$('fileInput').addEventListener('change',ev=>{const f=ev.target.files[0];ev.target.value='';if(f)openFile(f);});
function fetchSource(path){
  return async signal=>{
    const r=await fetch(path,{signal});
    if(!r.ok)throw new Error(path+' が見つかりません（HTTP '+r.status+'）');
    if(Number(r.headers.get('Content-Length'))>RT.MAX_FILE_BYTES)throw new Error('PSDは128MB以下にしてください');
    return r.arrayBuffer();
  };
}
const SAMPLE_FILES={A:'sample2.psd',B:'sample.psd'};
function loadSample(key='B'){const filename=SAMPLE_FILES[key];if(filename)return loadModel(fetchSource(filename),filename);}
document.querySelectorAll('[data-sample]').forEach(button=>button.addEventListener('click',()=>loadSample(button.dataset.sample)));
(function(){const miss=[];
  if(!window.agPsd)miss.push('ag-psd.min.js');if(!window.Rigger)miss.push('rigger.js');if(!window.GenericParts)miss.push('genericparts.js');
  if(miss.length)dropStatus.textContent='⚠ lib/'+miss.join(', lib/')+' が読み込めていません（ZIP展開・libフォルダの配置を確認）';
})();
// Drag & drop: PSD opens a model, JSON imports settings.
let dragDepth=0;
const hasFiles=e=>!!e.dataTransfer&&[...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter',e=>{if(!hasFiles(e)||OBS_MODE)return;e.preventDefault();dragDepth++;$('stage').classList.add('dragover');});
window.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';});
window.addEventListener('dragleave',e=>{if(!hasFiles(e))return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('stage').classList.remove('dragover');});
window.addEventListener('drop',e=>{
  e.preventDefault();dragDepth=0;$('stage').classList.remove('dragover');
  const f=hasFiles(e)&&e.dataTransfer.files[0];if(f&&!OBS_MODE)openFile(f);
});

// ---------- parameters ----------
const P={angleX:0,angleY:0,angleZ:0,eyeOpenL:1,eyeOpenR:1,eyeX:0,eyeY:0,brow:0,
  mouthOpen:0,mouthForm:0,mouthCY:0,body:0,physAmp:2,soft:2,
  browAngL:0,browAngR:0,browAngSym:0,bangL:0,bangC:0,bangR:0,
  armY:0,armPos:0,bust:2.5,bustY:1,irisScale:1,mouthEase:0.72,eyeEase:0.3,
  fhAmp:2,fhSoft:0.4,eyeCY:0,eyeCAng:0,mouthCAng:0,eyeScaleL:1,eyeScaleR:1,mouthScale:1,accAmp:1};
const DEFAULTS=Object.assign({},P);
const T=Object.assign({},P);
const cur=Object.assign({},P);
const auto={idle:true,blink:true,rand:true,talk:!OBS_MODE,mouse:false,mic:false,phys:true,cam:false};
const autoDefaults={...auto};
if(OBS_MODE)$('tgTalk').classList.remove('on');

const sliders={pAngleX:'angleX',pAngleY:'angleY',pAngleZ:'angleZ',pEyeL:'eyeOpenL',pEyeR:'eyeOpenR',
  pEyeX:'eyeX',pEyeY:'eyeY',pBrow:'brow',pMouthOpen:'mouthOpen',pMouthForm:'mouthForm',
  pBody:'body',pPhysAmp:'physAmp',pSoft:'soft',pMouthCY:'mouthCY',
  pBrowAngL:'browAngL',pBrowAngR:'browAngR',pBrowAngSym:'browAngSym',
  pBangL:'bangL',pBangC:'bangC',pBangR:'bangR',pArmY:'armY',pArmPos:'armPos',
  pBust:'bust',pBustY:'bustY',pIrisScale:'irisScale',pMouthEase:'mouthEase',pEyeEase:'eyeEase',
  pFhAmp:'fhAmp',pFhSoft:'fhSoft',pEyeCY:'eyeCY',pEyeCAng:'eyeCAng',pMouthCAng:'mouthCAng',
  pEyeScaleL:'eyeScaleL',pEyeScaleR:'eyeScaleR',pMouthScale:'mouthScale',pAccAmp:'accAmp'};
const sliderOf={};
const parameterRanges={};
// Attach a number box to every range row. onValue(value, final) is called on edits.
function bindRange(el,onValue){
  const v=el.parentNode.querySelector('.val'),label=el.parentNode.querySelector('label');label.htmlFor=el.id;
  const number=document.createElement('input');number.type='number';number.className='val';number.min=el.min;number.max=el.max;number.step=el.step;number.value=el.value;
  number.setAttribute('aria-label',label.textContent+'の数値');v.replaceWith(number);
  const range=[Number(el.min),Number(el.max)];
  el.addEventListener('input',()=>{number.value=el.value;onValue(Number(el.value),false);});
  el.addEventListener('change',()=>onValue(Number(el.value),true));
  number.addEventListener('input',()=>{if(number.value!==''&&Number.isFinite(number.valueAsNumber)){el.value=RT.clamp(number.valueAsNumber,...range);onValue(Number(el.value),false);}});
  number.addEventListener('change',()=>{if(number.value!==''&&Number.isFinite(number.valueAsNumber))el.value=RT.clamp(number.valueAsNumber,...range);number.value=el.value;onValue(Number(el.value),true);});
  return {number,range,set(value){el.value=RT.clamp(value,...range);number.value=el.value;return Number(el.value);}};
}
for(const id in sliders){
  const el=$(id),key=sliders[id];
  const b=bindRange(el,(value,final)=>{
    T[key]=value;if(paused&&lastFrame)lastFrame[key]=value;
    if(activePreset){activePreset=null;highlightPresets();}
    invalidate();if(key==='bustY')renderOverlay();
    if(final)commitHistory();else syncState();
  });
  sliderOf[key]=b;parameterRanges[key]=b.range;
  el.addEventListener('dblclick',()=>{T[key]=b.set(DEFAULTS[key]);if(paused&&lastFrame)lastFrame[key]=T[key];invalidate();commitHistory();});
  el.title='ダブルクリックで初期値に戻す';T[key]=Number(el.value);
}
function setSlider(key,val){
  const b=sliderOf[key];if(!b)return;
  T[key]=b.set(val);if(paused&&lastFrame)lastFrame[key]=T[key];invalidate();
}

const toggleIds={idle:'tgIdle',blink:'tgBlink',rand:'tgRand',talk:'tgTalk',cam:'tgCam',mouse:'tgMouse',mic:'tgMic',phys:'tgPhys'};
const toggleLabels={cam:'カメラ追従',mic:'マイク口パク'};
function syncToggle(key){const el=$(toggleIds[key]);el.classList.toggle('on',auto[key]);el.setAttribute('aria-pressed',String(auto[key]));}
function setAuto(key,value){
  const changed=auto[key]!==value;
  auto[key]=value;syncToggle(key);
  if(key==='mic'){if(value)startMic();else mic.stop();}
  if(key==='cam'){if(value)startCam();else stopCam();}
  if(key==='mic'||key==='cam')updateLiveTicker();
  if(key==='blink'&&!value){blinkT=-1;blinkVariant=1;irisBounceT=-1;}
  if(changed&&RT.AUTO_KEYS.includes(key)){updateDirty();syncState();}
}
Object.entries(toggleIds).forEach(([key,id])=>{syncToggle(key);$(id).addEventListener('click',()=>setAuto(key,!auto[key]));});

const PRESET_ORDER=['neutral','smile','usume','surprise','jito','winkL','winkR'];
const presets={
  neutral:{eyeOpenL:1,eyeOpenR:1,brow:0,mouthOpen:0,mouthForm:0,irisScale:1},
  smile:{eyeOpenL:0,eyeOpenR:0,brow:0.45,mouthOpen:0,mouthForm:0.9,irisScale:1},
  usume:{eyeOpenL:0.5,eyeOpenR:0.5,brow:0.35,mouthOpen:1,mouthForm:0.8,irisScale:1},
  surprise:{eyeOpenL:1,eyeOpenR:1,brow:1,mouthOpen:0.75,mouthForm:-0.1,irisScale:0.7},
  jito:{eyeOpenL:0.4,eyeOpenR:0.4,brow:-0.6,mouthOpen:0,mouthForm:-0.4,irisScale:1},
  winkL:{eyeOpenL:0,eyeOpenR:1,brow:0.2,mouthOpen:0.4,mouthForm:0.7,irisScale:1},
  winkR:{eyeOpenL:1,eyeOpenR:0,brow:0.2,mouthOpen:0.4,mouthForm:0.7,irisScale:1}};
let activePreset=null;
function highlightPresets(){document.querySelectorAll('[data-preset]').forEach(b=>{const on=b.dataset.preset===activePreset;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});}
function togglePreset(name){
  if(!presets[name])return;
  if(activePreset===name){activePreset=null;for(const k in presets.neutral)setSlider(k,presets.neutral[k]);}
  else{for(const k in presets[name])setSlider(k,presets[name][k]);activePreset=name;}
  highlightPresets();commitHistory();syncState(true);
}
function clearPreset(){if(!activePreset)return;togglePreset(activePreset);}
document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>togglePreset(b.dataset.preset)));
function resetParams(){
  activePreset=null;highlightPresets();
  for(const key in sliderOf)setSlider(key,DEFAULTS[key]);
  Object.assign(cur,T);
}
$('btnReset').addEventListener('click',()=>{resetParams();commitHistory();$('utilStatus').textContent='全パラメータを初期値に戻しました';});
$('btnSavePsd').addEventListener('click',()=>{
  const st=$('utilStatus');
  if(!lastPsd){st.textContent='先にPSDを読み込んでください';return;}
  try{
    st.textContent='書き出し中…';
    const out=window.agPsd.writePsd(lastPsd,{generateThumbnail:false});
    const blob=new Blob([out],{type:'application/octet-stream'});
    download(blob,baseFileName()+'_clean.psd');
    st.textContent='軽量PSDを保存しました（'+(blob.size/1e6).toFixed(1)+'MB / ノイズ除去+トリム済み）';
  }catch(err){st.textContent='書き出しエラー: '+err.message;}
});
function setBackground(value){
  background=RT.BACKGROUNDS.includes(value)?value:'checker';
  const s=$('stage');s.classList.remove('checker','green','dark');s.classList.add(background);
  document.querySelectorAll('[data-bg]').forEach(b=>{b.classList.toggle('active',b.dataset.bg===background);b.setAttribute('aria-pressed',String(b.dataset.bg===background));});
}
document.querySelectorAll('[data-bg]').forEach(b=>b.addEventListener('click',()=>{setBackground(b.dataset.bg);commitHistory();}));
setBackground(background);

// ---------- settings, history, dirty state ----------
function settingsSnapshot(){
  return {format:RT.SETTINGS_FORMAT,version:RT.SETTINGS_VERSION,app:'Anime2.5DRig '+APP_VERSION,modelId,modelName,params:{...T},preset:activePreset,
    auto:Object.fromEntries(RT.AUTO_KEYS.map(k=>[k,auto[k]])),background,
    layers:layers.map(L=>({id:L.id,visible:L.visible,opacity:L.opacity,depth:L.depth})),anchors:JSON.parse(JSON.stringify(anchorOffsets))};
}
function comparableSettings(){const s=settingsSnapshot();delete s.modelName;delete s.app;return JSON.stringify(s);}
function defaultLayerOrder(){return layers.slice().sort((a,b)=>a.z-b.z).map(L=>L.id);}
function applySettings(value,opts={}){
  const data=RT.settings(value,modelId,parameterRanges,layers.map(L=>L.id),DEFAULTS,{anyModel:!!opts.anyModel,anchorLimit:Math.max(CW,CH)});
  activePreset=null;
  for(const [key,n] of Object.entries(data.params))setSlider(key,n);
  activePreset=data.preset;highlightPresets();
  Object.assign(cur,T);
  if(opts.auto!==false)for(const [key,n] of Object.entries(data.auto))setAuto(key,n);
  const byId=new Map(layers.map(L=>[L.id,L])),records=new Map(data.layers.map(r=>[r.id,r]));
  layers=RT.mergeLayerOrder(defaultLayerOrder(),data.layers.map(r=>r.id)).map(id=>{
    const L=byId.get(id),r=records.get(id);
    if(r){L.visible=r.visible;L.opacity=r.opacity;L.depth=r.depth;}
    else{L.visible=true;L.opacity=L.defaultOpacity;L.depth=L.defaultDepth;}
    return L;
  });
  anchorOffsets=data.anchors;applyAnchors();
  setBackground(data.background);renderLayerList();invalidate();
  return data;
}
function layerDiffNote(data){const n=data.missingLayers+data.unknownLayers;return n?'（レイヤー構成の違い '+n+' 件は初期値のまま）':'';}
function restoreSettings(quiet=false){
  try{
    if(quiet)for(const k of RT.AUTO_KEYS)setAuto(k,autoDefaults[k]);
    const saved=storageGet('anime25d.settings.'+modelId);
    if(!saved){if(!quiet)status('このモデルの保存済み調整はありません');return false;}
    const data=applySettings(JSON.parse(saved));
    $('utilStatus').textContent='保存した調整を復元しました'+layerDiffNote(data);
    if(!quiet){commitHistory();savedSettings=comparableSettings();updateDirty();syncState(true);}
    return true;
  }catch(err){$('utilStatus').textContent='調整を復元できません: '+err.message;return false;}
}
function saveSettings(){
  if(!layers.length)return;
  try{storageSet('anime25d.settings.'+modelId,JSON.stringify(settingsSnapshot()));savedSettings=comparableSettings();updateDirty();status('このモデルの調整をブラウザに保存しました');}
  catch(err){status('ブラウザに保存できません。設定JSONを書き出してください',true);}
}
$('btnSaveSettings').addEventListener('click',saveSettings);
$('btnRestoreSettings').addEventListener('click',()=>restoreSettings());
$('btnExportSettings').addEventListener('click',()=>{download(new Blob([JSON.stringify(settingsSnapshot(),null,2)],{type:'application/json'}),baseFileName()+'.rig.json');status('設定JSONを書き出しました');});
$('btnImportSettings').addEventListener('click',()=>$('settingsInput').click());
async function importSettingsFile(f){
  const id=modelId;
  try{
    if(!layers.length)throw new Error('先にPSDを読み込んでください');
    if(f.size>1024*1024)throw new Error('設定JSONは1MB以下にしてください');
    const value=JSON.parse(await f.text());
    if(id!==modelId)throw new Error('モデルが切り替わりました。設定を選び直してください');
    const data=applySettings(value);commitHistory();syncState(true);
    status('設定を読み込みました'+layerDiffNote(data)+'。「調整を保存」で記憶できます');
  }catch(err){status('設定を読み込めません: '+err.message,true);}
}
$('settingsInput').addEventListener('change',ev=>{const f=ev.target.files[0];ev.target.value='';if(f)importSettingsFile(f);});

const history=RT.createHistory(150);
let savedSettings='',unsaved=false;
function historySnapshot(){
  const p={};for(const k in T)p[k]=round2(T[k]);
  return JSON.stringify({p,preset:activePreset,bg:background,a:anchorOffsets,l:layers.map(L=>[L.id,L.visible,round2(L.opacity),round2(L.depth)])});
}
function commitHistory(){
  if(!layers.length)return;
  history.push(historySnapshot());updateHistoryButtons();updateDirty();syncState();
}
function restoreHistory(snap,label){
  if(!snap)return;
  const s=JSON.parse(snap);
  for(const k in s.p)setSlider(k,s.p[k]);
  activePreset=s.preset;highlightPresets();
  setBackground(s.bg);
  anchorOffsets=s.a||{};applyAnchors();
  const byId=new Map(layers.map(L=>[L.id,L]));
  layers=s.l.map(([id,visible,opacity,depth])=>Object.assign(byId.get(id),{visible,opacity,depth}));
  renderLayerList();invalidate();updateHistoryButtons();updateDirty();syncState(true);
  status(label);
}
function undo(){if(history.canUndo)restoreHistory(history.undo(),'元に戻しました');}
function redo(){if(history.canRedo)restoreHistory(history.redo(),'やり直しました');}
function updateHistoryButtons(){$('btnUndo').disabled=!history.canUndo;$('btnRedo').disabled=!history.canRedo;}
$('btnUndo').addEventListener('click',undo);$('btnRedo').addEventListener('click',redo);
function updateDirty(){
  unsaved=!!layers.length&&!OBS_MODE&&comparableSettings()!==savedSettings;
  const b=$('btnSaveSettings');b.textContent=unsaved?'調整を保存 ●':'調整を保存';
  b.title=unsaved?'未保存の変更があります（Ctrl+S）':'このブラウザに保存（Ctrl+S）';
}
window.addEventListener('beforeunload',e=>{if(unsaved){e.preventDefault();e.returnValue='';}});

function togglePause(){
  paused=!paused;const b=$('btnPause');b.textContent=paused?'再生':'一時停止';b.setAttribute('aria-pressed',String(paused));
  invalidate();status(paused?'一時停止中 — 数値を調整して静止画を保存できます':'再生中');
}
$('btnPause').addEventListener('click',togglePause);
$('btnResetLayers').addEventListener('click',()=>{
  layers.sort((a,b)=>a.z-b.z);for(const L of layers){L.visible=true;L.depth=L.defaultDepth;L.opacity=L.defaultOpacity;}
  renderLayerList();invalidate();commitHistory();status('レイヤー設定を初期化しました');
});

// ---------- export: PNG / video ----------
const recorder=window.RigRecorder?window.RigRecorder.create(cv):null;
function exportBackground(){return (capturePending||(recorder&&recorder.active))?EXPORT_BG[prefs.exportBg]||EXPORT_BG.transparent:EXPORT_BG.transparent;}
function capturePng(){if(layers.length){capturePending=true;invalidate();}}
$('btnPng').addEventListener('click',capturePng);$('btnPng2').addEventListener('click',capturePng);
function updateRecordAvailability(){
  const formats=window.RigRecorder?window.RigRecorder.formats():[];
  const ok=formats.length&&typeof cv.captureStream==='function';
  for(const id of ['btnRecord','btnRecord2'])if(!ok)$(id).disabled=true;
  if(!ok)$('recordStatus').textContent='このブラウザは動画書き出しに対応していません（Chrome / Edge / Firefox を使用してください）';
}
function setRecordingUi(on){
  $('btnRecord').textContent=on?'録画を停止':'録画';$('btnRecord2').textContent=on?'録画を停止して保存':'録画を開始';
  $('btnRecord').classList.toggle('recording',on);$('btnRecord2').classList.toggle('recording',on);$('recBadge').hidden=!on;
}
async function toggleRecording(){
  if(!recorder||!layers.length)return;
  if(recorder.active){recorder.stop();return;}
  const fmt=prefs.recFormat;
  setRecordingUi(true);invalidate();
  try{
    const res=await recorder.start({seconds:prefs.recSeconds,fps:prefs.recFps,format:fmt,
      onProgress:(t,total)=>{$('recBadge').textContent='● REC '+t.toFixed(1)+' / '+total+'s';}});
    download(res.blob,baseFileName()+'.'+res.format.ext);
    const note=prefs.exportBg==='transparent'&&!res.format.alpha?'（この形式は透過を保持しません）':'';
    status('動画を書き出しました（'+CW+' × '+CH+'px・'+res.seconds.toFixed(1)+'秒・'+(res.blob.size/1e6).toFixed(1)+'MB）'+note);
  }catch(err){
    if(err.name==='AbortError')status('録画を中止しました');else status('録画できません: '+err.message,true);
  }finally{setRecordingUi(false);invalidate();}
}
$('btnRecord').addEventListener('click',toggleRecording);$('btnRecord2').addEventListener('click',toggleRecording);

// ---------- dialogs (README / shortcuts) ----------
function mdToHtml(md){
  const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const inline=s=>esc(s)
    .replace(/\*\*(.+?)\*\*/g,'<b>$1</b>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,text,url)=>/^(https?:\/\/|#)/i.test(url)||/^[\w\-./]+\.md(#[\w-]*)?$/.test(url)?'<a href="'+url+'" target="_blank" rel="noopener">'+text+'</a>':text);
  const lines=md.split(/\r?\n/);
  let html='',inCode=false,list=null,inTable=false;
  const closeList=()=>{if(list){html+='</'+list+'>';list=null;}};
  for(const l of lines){
    if(l.startsWith('```')){closeList();html+=inCode?'</code></pre>':'<pre><code>';inCode=!inCode;continue;}
    if(inCode){html+=esc(l)+'\n';continue;}
    if(/^\|/.test(l.trim())){
      closeList();
      if(/^\|[\s\-|:]+\|?$/.test(l.trim()))continue;
      const cells=l.trim().split('|').slice(1,-1).map(c=>inline(c.trim()));
      if(!inTable){html+='<table><tr>'+cells.map(c=>'<th>'+c+'</th>').join('')+'</tr>';inTable=true;}
      else html+='<tr>'+cells.map(c=>'<td>'+c+'</td>').join('')+'</tr>';
      continue;
    }else if(inTable){html+='</table>';inTable=false;}
    const ul=/^\s*[-*] /.test(l),ol=/^\s*\d+\. /.test(l);
    if(ul||ol){const tag=ul?'ul':'ol';if(list!==tag){closeList();html+='<'+tag+'>';list=tag;}
      html+='<li>'+inline(l.replace(/^\s*([-*]|\d+\.) /,''))+'</li>';continue;}
    closeList();
    const h=l.match(/^(#{1,4}) (.*)/);
    if(h){html+='<h'+h[1].length+'>'+inline(h[2])+'</h'+h[1].length+'>';continue;}
    if(/^> /.test(l)){html+='<blockquote>'+inline(l.slice(2))+'</blockquote>';continue;}
    if(l.trim()!=='')html+='<p>'+inline(l)+'</p>';
  }
  if(inCode)html+='</code></pre>';closeList();if(inTable)html+='</table>';
  return html;
}
let dialogFocus=null;
function openDialog(id,focusId){
  dialogFocus=document.activeElement;$(id).classList.add('show');$(focusId).focus();
}
function closeDialog(){
  const open=document.querySelector('.overlay-dialog.show');if(!open)return;
  open.classList.remove('show');dialogFocus?.focus?.();
}
let readmeLoaded=false;
async function openReadme(){
  openDialog('readmeOverlay','readmeClose');
  if(readmeLoaded)return;
  const body=$('readmeBody');
  try{
    const r=await fetch('README.md');
    if(!r.ok)throw new Error('HTTP '+r.status);
    body.innerHTML=mdToHtml(await r.text());readmeLoaded=true;
  }catch(err){
    body.innerHTML='<p>README.md を取得できませんでした。<a href="https://github.com/852wa/Anime2.5DRig#readme" target="_blank" rel="noopener">GitHubで読む</a></p>';
  }
}
$('btnReadme').addEventListener('click',openReadme);$('btnReadme2').addEventListener('click',openReadme);
$('readmeClose').addEventListener('click',closeDialog);$('shortcutClose').addEventListener('click',closeDialog);
document.querySelectorAll('.overlay-dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)closeDialog();}));
const SHORTCUTS=[
  [['Space'],'一時停止 / 再生'],[['1','〜','7'],'表情プリセット（同じキーで解除）'],[['0'],'表情プリセットを解除'],
  [['Ctrl','Z'],'元に戻す'],[['Ctrl','Shift','Z'],'やり直す（Ctrl+Y も可）'],[['Ctrl','S'],'調整をブラウザに保存'],
  [['Ctrl','O'],'PSDを開く'],[['E'],'アンカー編集モード'],[['F'],'プレビューを全体表示に戻す'],
  [['B'],'背景を切り替え'],[['ホイール'],'プレビューの拡大・縮小'],[['ドラッグ'],'拡大中のプレビューを移動'],
  [['ダブルクリック'],'プレビューを全体表示に戻す'],[['?'],'この一覧を表示'],[['Esc'],'ダイアログ・アンカー編集を閉じる']];
$('shortcutTable').innerHTML=SHORTCUTS.map(([keys,desc])=>'<tr><td>'+keys.map(k=>k==='〜'?'〜':'<kbd>'+k+'</kbd>').join(' ')+'</td><td>'+desc+'</td></tr>').join('');
$('btnShortcuts').addEventListener('click',()=>openDialog('shortcutOverlay','shortcutClose'));

// ---------- keyboard ----------
document.addEventListener('keydown',e=>{
  const dlg=document.querySelector('.overlay-dialog.show');
  if(dlg){
    if(e.key==='Escape'){e.preventDefault();closeDialog();}
    if(e.key==='Tab'){
      const items=[...dlg.querySelectorAll('button,a[href]')];
      if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items[items.length-1].focus();}
      else if(!e.shiftKey&&document.activeElement===items[items.length-1]){e.preventDefault();items[0].focus();}
    }
    return;
  }
  if(OBS_MODE)return;
  const t=e.target,tag=t.tagName;
  const textEntry=(tag==='INPUT'&&!['range','checkbox','button'].includes(t.type))||tag==='TEXTAREA'||tag==='SELECT'||t.isContentEditable;
  const mod=e.ctrlKey||e.metaKey,k=e.key.toLowerCase();
  if(mod&&!e.altKey){
    if(k==='s'){e.preventDefault();if(!e.repeat)saveSettings();return;}
    if(k==='o'){e.preventDefault();if(!e.repeat)$('fileInput').click();return;}
    if(textEntry)return;   // native undo inside text boxes
    if(k==='z'&&!e.shiftKey){e.preventDefault();undo();}
    else if((k==='z'&&e.shiftKey)||k==='y'){e.preventDefault();redo();}
    return;
  }
  if(textEntry||e.altKey||e.ctrlKey||e.metaKey)return;
  if(e.repeat&&!e.key.startsWith('Arrow')){if(e.code==='Space'||/^[0-7ebf?]$/i.test(e.key))e.preventDefault();return;}
  if(t.closest&&t.closest('#overlay .handle')&&e.key.startsWith('Arrow'))return;   // arrow keys move anchors
  if(e.code==='Space'){
    if(layers.length&&!/BUTTON|INPUT/.test(tag)&&!t.closest('[role="button"]')){e.preventDefault();togglePause();}
    return;
  }
  if(/^[0-7]$/.test(e.key)&&layers.length){e.preventDefault();if(e.key==='0')clearPreset();else togglePreset(PRESET_ORDER[Number(e.key)-1]);return;}
  if(k==='e'&&layers.length){e.preventDefault();setAnchorMode(!anchorMode);return;}
  if(k==='f'){e.preventDefault();resetView();return;}
  if(k==='b'){e.preventDefault();const i=RT.BACKGROUNDS.indexOf(background);setBackground(RT.BACKGROUNDS[(i+1)%RT.BACKGROUNDS.length]);commitHistory();return;}
  if(e.key==='?'){e.preventDefault();openDialog('shortcutOverlay','shortcutClose');return;}
  if(e.key==='Escape'&&anchorMode){e.preventDefault();setAnchorMode(false);}
});

// ---------- layer list ----------
const expandedLayers=new Set();let dragLayerIndex=-1;
function layerRole(L){
  const parts=[];
  const role=window.Rigger.roleLabel?window.Rigger.roleLabel(L.bn):null;
  parts.push(role||(L.unknown?'未分類 → '+(L.group==='head'?'頭':'体')+'に追従':L.bn));
  if(L.side)parts.push(L.side==='L'?'左':'右');
  if(L.strands&&L.strands.length)parts.push((L.phys==='sway'?'揺れ':'房')+L.strands.length);
  if(L.synthetic)parts.push('自動生成');
  return parts.join(' · ');
}
function moveLayer(from,to){
  if(from===to||from<0||to<0||from>=layers.length||to>=layers.length)return;
  const [L]=layers.splice(from,1);layers.splice(to,0,L);
  renderLayerList();invalidate();commitHistory();
}
function renderLayerList(){
  const container=$('layers');container.replaceChildren();
  layers.forEach((L,i)=>{
    const card=document.createElement('div');card.className='layer-card';card.classList.toggle('is-hidden',!L.visible);card.dataset.index=i;
    const top=document.createElement('div');top.className='layer-top';
    const thumb=document.createElement('img');thumb.className='layer-thumb';thumb.alt='';thumb.draggable=true;thumb.title='ドラッグで並べ替え';
    if(L.thumb)thumb.src=L.thumb;
    thumb.addEventListener('dragstart',e=>{dragLayerIndex=i;card.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/x-anime25d-layer',String(i));});
    thumb.addEventListener('dragend',()=>{dragLayerIndex=-1;card.classList.remove('dragging');container.querySelectorAll('.drag-over').forEach(c=>c.classList.remove('drag-over'));});
    card.addEventListener('dragover',e=>{if(dragLayerIndex<0)return;e.preventDefault();card.classList.add('drag-over');});
    card.addEventListener('dragleave',()=>card.classList.remove('drag-over'));
    card.addEventListener('drop',e=>{if(dragLayerIndex<0)return;e.preventDefault();e.stopPropagation();moveLayer(dragLayerIndex,i);});
    const visible=document.createElement('input');visible.type='checkbox';visible.checked=L.visible;visible.setAttribute('aria-label',(L.source||L.name)+'を表示');
    visible.addEventListener('change',()=>{L.visible=visible.checked;card.classList.toggle('is-hidden',!L.visible);invalidate();commitHistory();});
    const text=document.createElement('div');text.className='layer-text';
    const name=document.createElement('span');name.className='layer-name';name.textContent=L.source||L.name;name.title=(L.source||L.name)+(L.source&&L.source!==L.name?' → '+L.name:'');
    const role=document.createElement('span');role.className='layer-role';role.classList.toggle('unknown',!!L.unknown);role.textContent=layerRole(L);
    text.append(name,role);
    top.append(thumb,visible,text);
    for(const d of [-1,1]){
      const b=document.createElement('button');b.type='button';b.className='ord';b.textContent=d<0?'↑':'↓';
      b.setAttribute('aria-label',(L.source||L.name)+(d<0?'を奥へ':'を手前へ'));b.disabled=i+d<0||i+d>=layers.length;
      b.addEventListener('click',()=>{moveLayer(i,i+d);container.children[i+d]?.querySelector(d<0?'.ord':'.ord:nth-of-type(2)')?.focus();});
      top.append(b);
    }
    const more=document.createElement('button');more.type='button';more.className='more';
    const open=expandedLayers.has(L.id);more.textContent=open?'▾':'▸';more.setAttribute('aria-expanded',String(open));more.setAttribute('aria-label',(L.source||L.name)+'の詳細');
    top.append(more);card.append(top);
    const details=document.createElement('div');details.className='layer-details';details.hidden=!open;
    more.addEventListener('click',()=>{const now=!expandedLayers.has(L.id);if(now)expandedLayers.add(L.id);else expandedLayers.delete(L.id);details.hidden=!now;more.textContent=now?'▾':'▸';more.setAttribute('aria-expanded',String(now));});
    for(const [key,label,max] of [['opacity','濃さ',1],['depth','奥行き',2]]){
      const row=document.createElement('div');row.className='row';const caption=document.createElement('label');caption.textContent=label;
      const range=document.createElement('input');range.type='range';range.min='0';range.max=String(max);range.step='0.01';range.value=L[key];range.id='layer-'+i+'-'+key;caption.htmlFor=range.id;range.setAttribute('aria-label',(L.source||L.name)+'の'+label);
      const value=document.createElement('input');value.type='number';value.min='0';value.max=String(max);value.step='0.01';value.value=L[key];value.setAttribute('aria-label',(L.source||L.name)+'の'+label+'の数値');
      range.addEventListener('input',()=>{L[key]=Number(range.value);value.value=range.value;invalidate();syncState();});
      range.addEventListener('change',commitHistory);
      value.addEventListener('input',()=>{if(value.value!==''&&Number.isFinite(value.valueAsNumber)){L[key]=RT.clamp(value.valueAsNumber,0,max);range.value=L[key];invalidate();}});
      value.addEventListener('change',()=>{if(value.value!==''&&Number.isFinite(value.valueAsNumber))L[key]=RT.clamp(value.valueAsNumber,0,max);range.value=L[key];value.value=L[key];invalidate();commitHistory();});
      row.append(caption,range,value);details.append(row);
    }
    card.append(details);
    card.addEventListener('mouseenter',()=>{highlightLayer=L.id;renderOverlay();});
    card.addEventListener('mouseleave',()=>{if(highlightLayer===L.id){highlightLayer=null;renderOverlay();}});
    container.append(card);
  });
  if(!layers.length){const p=document.createElement('p');p.className='section-hint';p.textContent='PSDの読み込み後に表示されます';container.append(p);}
  applySearch();
}

// ---------- diagnostics ----------
function renderDiagnostics(rig){
  const list=$('diagnostics');list.replaceChildren();
  const real=bn=>layers.filter(L=>L.bn===bn&&!L.synthetic),synth=bn=>layers.some(L=>L.bn===bn&&L.synthetic);
  const sides=bn=>new Set(real(bn).map(L=>L.side).filter(Boolean)).size;
  const add=(cls,text,note)=>{const li=document.createElement('li');li.className=cls;li.textContent=text;if(note){const s=document.createElement('small');s.textContent=' — '+note;li.append(s);}list.append(li);};
  const eyePart=(bn,label,required)=>{const n=sides(bn);if(n>=2)add('ok',label);else if(n===1)add('warn',label,'片側だけ見つかりました');else add(required?'bad':'warn',label,'見つかりません');};
  add(real('face').length?'ok':'bad','顔（face）',real('face').length?'':'見つからないため顔の位置を推定しています');
  eyePart('eyewhite','白目（eyewhite）',true);eyePart('irides','瞳（irides）',true);eyePart('eyelash','まつ毛（eyelash）',false);
  const ec=sides('eye_close');
  if(ec>=2)add('ok','閉じ目（eye_close）');else if(synth('eye_close'))add('auto','閉じ目','汎用差分を自動配置（「目」の差分バーで調整可）');else add('warn','閉じ目（eye_close）','まぶたの圧縮だけでまばたきします');
  if(layers.some(L=>L.bn==='eye_close2'))add('ok','長い閉じ目（eye_close2）');
  eyePart('eyebrow','眉（eyebrow）',false);
  add(real('mouth_open').length?'ok':'bad','開き口（mouth_open）',real('mouth_open').length?'':'口パクできません');
  if(real('mouth_close').length)add('ok','閉じ口（mouth_close）');else if(synth('mouth_close'))add('auto','閉じ口','汎用差分を自動配置（「口」のバーで調整可）');else add('warn','閉じ口（mouth_close）','見つかりません');
  const strands=bn=>layers.filter(L=>L.bn===bn).reduce((s,L)=>s+(L.strands?L.strands.length:0),0);
  const hair=['front hair','side hair','ahoge','back hair'].filter(bn=>layers.some(L=>L.bn===bn));
  if(hair.length)add('ok','髪の物理',hair.map(bn=>(Rigger.roleLabel(bn)||bn)+' '+strands(bn)+'房').join('・'));
  else add('warn','髪の物理','front hair / back hair（前髪・後ろ髪）が見つかりません');
  const unknown=layers.filter(L=>L.unknown);
  if(unknown.length)add('warn','未分類のレイヤー '+unknown.length+'件',unknown.map(L=>L.source||L.name).join('、')+'（名前を規約に合わせると動きが付きます）');
  for(const w of rig.warnings)if(/空のレイヤー|アンカー/.test(w))add('warn',w);
  const nStr=layers.reduce((s,L)=>s+(L.strands?L.strands.length:0),0);
  $('rigInfo').textContent=layers.length+'パーツ / 揺れもの'+nStr+'本を自動リグ\n'+CW+' × '+CH+'px';
}

// ---------- panel: collapse & search ----------
function collapseSection(sec,value){sec.classList.toggle('collapsed',value);sec.querySelector('h2').setAttribute('aria-expanded',String(!value));}
document.querySelectorAll('#panel .sec > h2').forEach(h=>{
  h.tabIndex=0;h.setAttribute('role','button');h.setAttribute('aria-expanded','true');
  h.addEventListener('click',()=>{collapseSection(h.parentNode,!h.parentNode.classList.contains('collapsed'));saveCollapsed();});
  h.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();h.click();}});
});
function saveCollapsed(){
  prefs.collapsed=[...document.querySelectorAll('#panel .sec.collapsed')].map(s=>s.dataset.sec);savePrefs();
  const all=[...document.querySelectorAll('#panel .sec')];$('btnCollapse').textContent=all.every(s=>s.classList.contains('collapsed'))?'すべて開く':'すべて畳む';
}
$('btnCollapse').addEventListener('click',()=>{const all=[...document.querySelectorAll('#panel .sec')],value=all.some(s=>!s.classList.contains('collapsed'));for(const s of all)collapseSection(s,value);saveCollapsed();});
const FILTER_ITEMS='.row,.toggles>*,.btns>*,.layer-card,.check-row,.field-row,.copy-row,.meter';
function applySearch(){
  const q=$('controlSearch').value.trim().toLowerCase();let matches=0;
  document.querySelectorAll('#panel .sec').forEach(sec=>{
    const items=[...sec.querySelectorAll(FILTER_ITEMS)];
    items.forEach(i=>i.classList.remove('filtered-out'));
    sec.querySelectorAll('.section-hint').forEach(i=>i.classList.remove('filtered-out'));
    if(!q){sec.hidden=false;matches++;return;}
    const title=sec.querySelector('h2').textContent.toLowerCase().includes(q);
    let any=title;
    if(!title){
      for(const i of items){const hit=(i.textContent+' '+(i.getAttribute('aria-label')||'')+' '+(i.title||'')+' '+[...i.querySelectorAll('[aria-label]')].map(x=>x.getAttribute('aria-label')).join(' ')).toLowerCase().includes(q);i.classList.toggle('filtered-out',!hit);if(hit)any=true;}
      sec.querySelectorAll('.section-hint').forEach(i=>i.classList.add('filtered-out'));
    }
    sec.hidden=!any;if(any){matches++;collapseSection(sec,false);}
  });
  $('searchEmpty').hidden=matches>0;
}
$('controlSearch').addEventListener('input',applySearch);

// ---------- preview: fit, zoom & pan ----------
const stage=$('stage'),vp=$('viewport'),view={z:1,x:0,y:0};let fitScale=1,baseLeft=0,baseTop=0;
function fit(){
  const W=stage.clientWidth,H=stage.clientHeight;
  fitScale=Math.max(1e-3,Math.min(W/CW,H/CH));
  const w=CW*fitScale,h=CH*fitScale;baseLeft=(W-w)/2;baseTop=(H-h)/2;
  vp.style.width=w+'px';vp.style.height=h+'px';applyView();
}
function applyView(){
  vp.style.transform='translate('+(baseLeft+view.x)+'px,'+(baseTop+view.y)+'px) scale('+view.z+')';
  const isFit=view.z===1&&!view.x&&!view.y;
  $('btnZoom').textContent=isFit?'全体':Math.round(fitScale*view.z*100)+'%';
  renderOverlay();
}
function resetView(){view.z=1;view.x=0;view.y=0;applyView();}
function zoomAt(factor,cx,cy){
  const z2=clamp(view.z*factor,0.5,16);
  const lx=(cx-baseLeft-view.x)/view.z,ly=(cy-baseTop-view.y)/view.z;
  view.x=cx-baseLeft-z2*lx;view.y=cy-baseTop-z2*ly;view.z=z2;applyView();
}
window.addEventListener('resize',fit);
if(typeof ResizeObserver!=='undefined')new ResizeObserver(fit).observe(stage);
$('btnZoom').addEventListener('click',resetView);
const pointers=new Map();let pinch=null;
function stagePoint(e){const r=stage.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
function panTarget(e){return !OBS_MODE&&layers.length&&!e.target.closest('#drop,#stageTools,#camPreview,#overlay .handle,button');}
if(!OBS_MODE){
  stage.addEventListener('wheel',e=>{
    if(!layers.length||e.target.closest('#drop,#camPreview'))return;
    e.preventDefault();const p=stagePoint(e),dy=e.deltaMode===1?e.deltaY*16:e.deltaY;
    zoomAt(Math.exp(-dy*0.0015),p.x,p.y);
  },{passive:false});
  stage.addEventListener('pointerdown',e=>{
    if(!panTarget(e)||(e.pointerType==='mouse'&&e.button!==0&&e.button!==1))return;
    stage.setPointerCapture(e.pointerId);pointers.set(e.pointerId,stagePoint(e));
    if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),m:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};}
    stage.classList.add('panning');
  });
  stage.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;
    const prev=pointers.get(e.pointerId),p=stagePoint(e);pointers.set(e.pointerId,p);
    if(pointers.size===1){view.x+=p.x-prev.x;view.y+=p.y-prev.y;applyView();}
    else if(pointers.size===2&&pinch){
      const [a,b]=[...pointers.values()],d=Math.hypot(a.x-b.x,a.y-b.y),m={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      view.x+=m.x-pinch.m.x;view.y+=m.y-pinch.m.y;zoomAt(d/Math.max(1,pinch.d),m.x,m.y);pinch={d,m};
    }
  });
  const endPointer=e=>{pointers.delete(e.pointerId);if(pointers.size<2)pinch=null;if(!pointers.size)stage.classList.remove('panning');};
  stage.addEventListener('pointerup',endPointer);stage.addEventListener('pointercancel',endPointer);
  stage.addEventListener('dblclick',e=>{if(panTarget(e))resetView();});
}

// ---------- overlay: anchors & layer highlight ----------
const overlay=$('overlay'),SVG_NS='http://www.w3.org/2000/svg';
function svg(tag,attrs){const el=document.createElementNS(SVG_NS,tag);for(const k in attrs)el.setAttribute(k,attrs[k]);return el;}
function anchorHandles(){
  const out=[];if(!A)return out;
  out.push({key:'face',label:'顔の中心',x:A.face.cx,y:A.face.cy,axes:['dx','dy']});
  for(const s of ['L','R']){
    const e=A['eye'+s];if(!e)continue;const name=s==='L'?'左目':'右目';
    out.push({key:'eye'+s,label:name,x:e.icx,y:e.icy,axes:['dx','dy'],place:'above'});
    out.push({key:'eye'+s+'Close',label:name+' 閉じ位置',x:s==='L'?e.x0-4:e.x1+4,y:e.closeY,axes:['dy'],cls:'close',guide:[e.x0,e.x1],place:s==='L'?'left':'right'});
  }
  out.push({key:'mouth',label:'口',x:A.mouth.cx,y:A.mouth.cy,axes:['dx','dy']});
  out.push({key:'neck',label:'首の回転軸',x:NP.cx,y:NP.cy,axes:['dx','dy']});
  if(layers.some(L=>L.bn==='topwear'))out.push({key:'chest',label:'胸',x:CHEST.cx,y:CHEST.cy+T.bustY*70*FS,axes:['dx','dy'],cls:'chest'});
  return out;
}
let dragAnchor=null;
function psdPerPx(){const r=overlay.getBoundingClientRect();return r.width>0?CW/r.width:1;}
function renderOverlay(){
  if(OBS_MODE)return;
  overlay.replaceChildren();
  if(!layers.length)return;
  const u=psdPerPx();
  // Sizes are given in PSD units per screen pixel so handles stay the same size at any zoom.
  if(highlightLayer){const L=layers.find(x=>x.id===highlightLayer);if(L)overlay.append(svg('rect',{class:'layer-box',x:L.x,y:L.y,width:L.w,height:L.h,'stroke-width':1.5*u}));}
  if(!anchorMode)return;
  for(const h of anchorHandles()){
    if(h.guide)overlay.append(svg('line',{class:'guide',x1:h.guide[0],x2:h.guide[1],y1:h.y,y2:h.y,'stroke-width':u,'stroke-dasharray':4*u+' '+4*u}));
    const g=svg('g',{class:'handle'+(h.cls?' '+h.cls:''),tabindex:'0',role:'button','aria-label':h.label+'（ドラッグまたは矢印キーで移動）','data-key':h.key});
    if(dragAnchor&&dragAnchor.key===h.key)g.classList.add('dragging');
    g.append(svg('circle',{cx:h.x,cy:h.y,r:7*u,'stroke-width':2*u}));
    const place=h.place||'right';
    const tx=svg('text',{x:place==='left'?h.x-11*u:place==='above'?h.x:h.x+11*u,y:place==='above'?h.y-12*u:h.y+4*u,'font-size':12*u,'stroke-width':3*u,
      'text-anchor':place==='left'?'end':place==='above'?'middle':'start'});
    tx.textContent=h.label;g.append(tx);
    g.addEventListener('pointerdown',e=>startAnchorDrag(e,h));
    g.addEventListener('keydown',e=>nudgeAnchor(e,h));
    overlay.append(g);
  }
}
function toPsd(e){const r=overlay.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width*CW,y:(e.clientY-r.top)/r.height*CH};}
function startAnchorDrag(e,h){
  if(e.button!==undefined&&e.button!==0)return;
  e.preventDefault();e.stopPropagation();
  const id=e.pointerId,start=toPsd(e),base=Object.assign({dx:0,dy:0},anchorOffsets[h.key]);
  dragAnchor={key:h.key};
  if(h.cls==='close')anchorPreview=h.key.slice(3,4);
  // Handles are re-created on every move, so follow the pointer on window.
  const move=ev=>{
    if(ev.pointerId!==id)return;
    const p=toPsd(ev),o={};
    if(h.axes.includes('dx'))o.dx=Math.round(base.dx+p.x-start.x);
    if(h.axes.includes('dy'))o.dy=Math.round(base.dy+p.y-start.y);
    setAnchorOffset(h.key,o);
  };
  const up=ev=>{
    if(ev.pointerId!==id)return;
    window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);
    dragAnchor=null;anchorPreview=null;commitHistory();renderOverlay();invalidate();
    overlay.querySelector('[data-key="'+h.key+'"]')?.focus({preventScroll:true});
  };
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);
}
function setAnchorOffset(key,o){
  const clean=RT.anchors({[key]:o},Math.max(CW,CH));
  if(clean[key])anchorOffsets[key]=clean[key];else delete anchorOffsets[key];
  applyAnchors();syncState();
}
function nudgeAnchor(e,h){
  const step=e.shiftKey?10:1,d={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[e.key];
  if(!d)return;
  e.preventDefault();e.stopPropagation();
  const o=Object.assign({dx:0,dy:0},anchorOffsets[h.key]);
  if(h.axes.includes('dx'))o.dx+=d[0];if(h.axes.includes('dy'))o.dy+=d[1];
  if(!h.axes.includes('dx'))delete o.dx;
  setAnchorOffset(h.key,o);commitHistory();
  overlay.querySelector('[data-key="'+h.key+'"]')?.focus();
}
function setAnchorMode(on){
  on=!!on&&layers.length>0&&!OBS_MODE;
  if(anchorMode===on)return;
  anchorMode=on;anchorPreview=null;
  for(const id of ['btnAnchorMode','btnAnchorMode2'])$(id).setAttribute('aria-pressed',String(on));
  $('anchorHint').hidden=!on;
  if(!on)Object.assign(cur,T);
  renderOverlay();invalidate();
  if(on)status('アンカー編集中 — 静止したポーズで基準点を調整します');
}
$('btnAnchorMode').addEventListener('click',()=>setAnchorMode(!anchorMode));
$('btnAnchorMode2').addEventListener('click',()=>setAnchorMode(!anchorMode));
$('btnResetAnchors').addEventListener('click',()=>{anchorOffsets={};applyAnchors();commitHistory();syncState(true);status('アンカーを自動検出の位置に戻しました');});

// ---------- preferences (per browser) ----------
const PREF_SCHEMA={
  headGain:[0.3,2,1],eyeGain:[0.5,2,1],mouthGain:[0.5,2.5,1],browGain:[0,2,1],gazeGain:[0,2,1],smoothing:[0,1,0.5],
  linkEyes:['bool',true],trackBrow:['bool',true],trackSmile:['bool',true],camPreview:['bool',true],
  micGain:[0.25,4,1],micGate:[0,0.5,0.05],
  exportBg:['enum',['transparent','green','dark'],'transparent'],recSeconds:[1,60,5],recFps:['enum',[30,60],30],recFormat:['any',''],
  obsSync:['bool',true],collapsed:['any',[]],calibration:['any',null]};
let prefs=RT.prefs(null,PREF_SCHEMA);
try{prefs=RT.prefs(JSON.parse(storageGet('anime25d.prefs')||'null'),PREF_SCHEMA);}catch(err){}
if(!prefs.calibration||typeof prefs.calibration!=='object'||!Object.keys(FF.DEFAULT_NEUTRAL).every(k=>Number.isFinite(prefs.calibration[k])))prefs.calibration=null;
if(!Array.isArray(prefs.collapsed))prefs.collapsed=[];
let prefTimer=null;
function savePrefs(){clearTimeout(prefTimer);prefTimer=setTimeout(()=>{try{storageSet('anime25d.prefs',JSON.stringify(prefs));}catch(err){}},200);}
const prefSliders={prefHeadGain:'headGain',prefEyeGain:'eyeGain',prefMouthGain:'mouthGain',prefBrowGain:'browGain',prefGazeGain:'gazeGain',prefSmoothing:'smoothing',prefMicGain:'micGain',prefMicGate:'micGate'};
for(const [id,key] of Object.entries(prefSliders)){
  const el=$(id);el.value=prefs[key];
  const b=bindRange(el,value=>{prefs[key]=value;savePrefs();tracker.setOptions(trackerOptions());});
  el.addEventListener('dblclick',()=>{prefs[key]=b.set(PREF_SCHEMA[key][2]);savePrefs();tracker.setOptions(trackerOptions());});
  el.title='ダブルクリックで初期値に戻す';
}
const prefChecks={prefLinkEyes:'linkEyes',prefTrackBrow:'trackBrow',prefTrackSmile:'trackSmile',prefCamPreview:'camPreview',prefObsSync:'obsSync'};
for(const [id,key] of Object.entries(prefChecks)){
  const el=$(id);el.checked=prefs[key];
  el.addEventListener('change',()=>{prefs[key]=el.checked;savePrefs();tracker.setOptions(trackerOptions());if(key==='camPreview')updateCamPreview();if(key==='obsSync'){sync.setEnabled(el.checked);syncState(true);}});
}
const formatSelect=$('prefRecFormat');
(window.RigRecorder?window.RigRecorder.formats():[]).forEach(f=>{const o=document.createElement('option');o.value=f.mime;o.textContent=f.label;formatSelect.append(o);});
if(!formatSelect.options.length){const o=document.createElement('option');o.textContent='（非対応）';formatSelect.append(o);formatSelect.disabled=true;}
if([...formatSelect.options].some(o=>o.value===prefs.recFormat))formatSelect.value=prefs.recFormat;else prefs.recFormat=formatSelect.value;
$('prefExportBg').value=prefs.exportBg;$('prefRecSeconds').value=String(prefs.recSeconds);$('prefRecFps').value=String(prefs.recFps);
if(!$('prefRecSeconds').value)$('prefRecSeconds').value='5';
$('prefExportBg').addEventListener('change',e=>{prefs.exportBg=e.target.value;savePrefs();});
$('prefRecSeconds').addEventListener('change',e=>{prefs.recSeconds=Number(e.target.value);savePrefs();});
$('prefRecFps').addEventListener('change',e=>{prefs.recFps=Number(e.target.value);savePrefs();});
formatSelect.addEventListener('change',e=>{prefs.recFormat=e.target.value;savePrefs();});
for(const key of prefs.collapsed){const s=document.querySelector('#panel .sec[data-sec="'+key+'"]');if(s)collapseSection(s,true);}

// ---------- mouse follow ----------
const mouse={x:0,y:0,in:false};
cv.addEventListener('mousemove',e=>{const r=cv.getBoundingClientRect();mouse.x=clamp((e.clientX-r.left)/r.width*2-1,-1.5,1.5);mouse.y=clamp((e.clientY-r.top)/r.height*2-1,-1.5,1.5);mouse.in=true;});
cv.addEventListener('mouseleave',()=>mouse.in=false);

// ---------- camera & microphone ----------
function trackerOptions(){return {headGain:prefs.headGain,eyeGain:prefs.eyeGain,mouthGain:prefs.mouthGain,browGain:prefs.browGain,gazeGain:prefs.gazeGain,smoothing:prefs.smoothing,linkEyes:prefs.linkEyes,trackBrow:prefs.trackBrow,trackSmile:prefs.trackSmile};}
const tracker=new FF.Tracker(trackerOptions());
tracker.setCalibration(prefs.calibration);
const cam={live:false,ax:0,ay:0,az:0,eL:1,eR:1,mo:0,ex:0,ey:0,br:0,mf:0};
let lastTrackingAt=0,camPhysScale=1,remoteMic=0,remoteMicAt=0,micLevel=0;
function camChip(text,busy){const el=$('tgCam');el.textContent=text;el.classList.toggle('busy',!!busy);}
const camera=window.RigDevices.createCamera({
  preview:$('camCanvas'),
  onState:(s,msg)=>{
    if(s==='loading')camChip('カメラ準備中…',true);
    else if(s==='on'){camChip('カメラ追従中');tracker.reset();}
    else camChip(toggleLabels.cam);
    if(s==='error'){auto.cam=false;syncToggle('cam');status(msg,true);cam.live=false;sync.publishTracking(liveTracking(),true);updateLiveTicker();}
    $('btnCalibrate').disabled=s!=='on';updateCamPreview();
  },
  onResults:(lm,video)=>{
    const aspect=video.videoWidth&&video.videoHeight?video.videoWidth/video.videoHeight:4/3;
    const out=lm?tracker.update(lm,performance.now()/1000,aspect):null;
    if(!out){cam.live=false;return;}
    Object.assign(cam,out);cam.live=true;lastTrackingAt=performance.now();
  }
});
function startCam(){
  if(OBS_MODE){status('通常ブラウザからの追跡を待っています');return;}
  camera.start().catch(err=>{auto.cam=false;syncToggle('cam');camChip(toggleLabels.cam);status('カメラを開始できません: '+err.message,true);updateLiveTicker();});
}
function stopCam(){
  if(OBS_MODE)return;
  camera.stop();cam.live=false;lastTrackingAt=0;sync.publishTracking(liveTracking(),true);
}
function updateCamPreview(){$('camPreview').hidden=OBS_MODE||!prefs.camPreview||!camera.active;}
$('camPreviewClose').addEventListener('click',()=>{prefs.camPreview=false;$('prefCamPreview').checked=false;savePrefs();updateCamPreview();});
function calibrationText(){$('calibrationStatus').textContent=prefs.calibration?'記録済み（あなたの自然な表情を基準に判定します）':'未記録（標準の顔の比率で判定します）';$('btnClearCalibration').disabled=!prefs.calibration;}
calibrationText();
$('btnCalibrate').addEventListener('click',()=>{
  if(!camera.active)return;
  tracker.startCalibration();$('btnCalibrate').disabled=true;status('正面を向いて、自然な表情のまま1秒ほどお待ちください…');
  // Average at least 1 s and 5 frames (slow PCs track fewer frames per second).
  const started=performance.now();
  const poll=setInterval(()=>{
    const n=tracker.samples?tracker.samples.length:0,elapsed=performance.now()-started;
    if(camera.active&&elapsed<6000&&(elapsed<1000||n<5))return;
    clearInterval(poll);
    const c=tracker.finishCalibration();$('btnCalibrate').disabled=!camera.active;
    if(!c){status('顔を検出できなかったため記録できませんでした',true);return;}
    prefs.calibration=c;savePrefs();calibrationText();tracker.reset();status('正面の表情を記録しました（'+n+'フレーム）');
  },100);
});
$('btnClearCalibration').addEventListener('click',()=>{prefs.calibration=null;tracker.setCalibration(null);savePrefs();calibrationText();status('キャリブレーションを消去しました');});

function micChip(text,busy){const el=$('tgMic');el.textContent=text;el.classList.toggle('busy',!!busy);}
const mic=window.RigDevices.createMic({onState:(s,msg)=>{
  if(s==='loading')micChip('マイク準備中…',true);
  else if(s==='on')micChip('マイク使用中');
  else micChip(toggleLabels.mic);
  if(s==='error'){auto.mic=false;syncToggle('mic');status(msg,true);updateLiveTicker();}
}});
function startMic(){mic.start().catch(err=>{auto.mic=false;syncToggle('mic');micChip(toggleLabels.mic);status('マイクを開始できません: '+err.message,true);updateLiveTicker();});}
let meterAt=0;
function updateMeter(now){
  if(now-meterAt<50)return;meterAt=now;
  const m=$('micMeter');if(m.offsetParent===null)return;
  m.querySelector('.meter-level').style.width=(mic.active?Math.round(clamp(mic.raw*prefs.micGain,0,1)*100):0)+'%';
  m.querySelector('.meter-gate').style.left=Math.round(prefs.micGate*100)+'%';
}

// ---------- OBS sync ----------
const sync=window.ObsSync.create({obsMode:OBS_MODE,onTracking:receiveTracking,onState:receiveState,onModel:receiveModel,onStatus:renderObsStatus});
sync.setEnabled(prefs.obsSync);
function liveTracking(){
  const camOn=auto.cam&&cam.live&&performance.now()-lastTrackingAt<1200;
  const v={live:camOn,ax:cam.ax,ay:cam.ay,az:cam.az,eL:cam.eL,eR:cam.eR,mo:cam.mo,ex:cam.ex,ey:cam.ey,br:cam.br||0,mf:cam.mf||0};
  if(!camOn)Object.assign(v,{ax:0,ay:0,az:0,eL:1,eR:1,mo:0,ex:0,ey:0,br:0,mf:0});
  if(auto.mic&&mic.active)v.mic=micLevel;
  return RT.tracking(v);
}
function syncState(immediate){if(!OBS_MODE&&layers.length)sync.publishState({type:'state',settings:settingsSnapshot()},immediate);}
function receiveTracking(value){
  if(value===null){cam.live=false;return;}
  const clean=RT.tracking(value);if(!clean)return;
  if(clean.mic!==undefined){remoteMic=clean.mic;remoteMicAt=performance.now();}
  delete clean.mic;
  if(!auto.cam&&!OBS_MODE)return;
  Object.assign(cam,{br:0,mf:0},clean);lastTrackingAt=performance.now();
}
let pendingRemoteState=null,relayLoadingId=null;
function receiveState(state){
  if(!OBS_MODE||!state||!state.settings)return;
  if(!layers.length||state.settings.modelId!==modelId){pendingRemoteState=state;return;}
  try{applySettings(state.settings);}catch(err){}
}
async function loadFromRelay(id){
  relayLoadingId=id||'?';
  try{await loadModel(async()=>sync.fetchModel(),'OBS用モデル',{relay:false});}
  finally{if(relayLoadingId===(id||'?'))relayLoadingId=null;}
}
function receiveModel(info){
  if(!OBS_MODE||!info||!info.id)return;
  if(info.id===(relayLoadingId||modelId))return;   // already showing / already loading this one
  loadFromRelay(info.id);
}
async function afterObsModel(){
  if(pendingRemoteState&&pendingRemoteState.settings.modelId===modelId){const s=pendingRemoteState;pendingRemoteState=null;receiveState(s);return;}
  if(sync.status.relay){try{const s=await sync.fetchState();if(s)receiveState(s);return;}catch(err){}}
  const path=RT.safeRelativePath(QUERY.get('settings')||'','.json');
  if(path){try{const r=await fetch(path);if(r.ok)applySettings(await r.json(),{anyModel:true});}catch(err){console.warn('settings:',err.message);}}
}
const obsUrl=location.origin+location.pathname.replace(/[^/]*$/,'')+'?obs=1';
$('obsUrl').value=location.protocol.startsWith('http')?obsUrl:'（start_obs.bat で起動すると表示されます）';
$('btnCopyObsUrl').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('obsUrl').value);status('OBS用のURLをコピーしました');}catch(err){$('obsUrl').select();status('URLを選択しました。Ctrl+C でコピーしてください');}});
$('obsChip').addEventListener('click',()=>{const s=document.querySelector('.sec[data-sec="obs"]');collapseSection(s,false);s.scrollIntoView({behavior:'smooth',block:'start'});});
function renderObsStatus(st){
  if(OBS_MODE)return;
  const chip=$('obsChip'),text=$('obsStatus');
  chip.hidden=!st.relay;
  if(!st.relay){text.textContent='OBS中継サーバーに接続していません。start_obs.bat（python obs_server.py）で開くと、このブラウザで開いたPSD・調整・表情がOBSへ自動で反映されます。';return;}
  if(!st.features.includes('model')){chip.textContent='OBS';chip.className='obs-chip busy';text.textContent='古い obs_server.py です。表情・モデルの同期には最新版に置き換えてください（顔追跡のみ中継します）。';return;}
  const viewers=st.viewers|0;
  chip.className='obs-chip'+(!st.enabled?' off':st.uploading?' busy':'');
  chip.textContent=!st.enabled?'OBS 同期OFF':st.uploading?'OBS 送信中…':viewers?'OBS ● 表示中 '+viewers:'OBS 待機中';
  text.textContent=st.error?st.error:!st.enabled?'同期はOFFです。OBSには最後に送った状態が表示されます。':
    '中継サーバーに接続中 · OBS表示 '+viewers+'件 · '+(st.uploaded&&st.uploaded===modelId?'このモデルを送信済み':layers.length?'モデル送信待ち':'モデル未読込');
}

// ---------- animation ----------
let blinkT=-1,blinkVariant=1,blinkBounceStarted=false,irisBounceT=-1,nextBlink=performance.now()+1800;
const rnd={ax:0,ay:0,az:0,bd:0,ex:0,ey:0};let nextRnd=0;
let talkOn=false,talkV=0,talkTgt=0,nextTalkState=0,nextSyl=0;

function fadeAlpha(L,e,alt){
  if(!L.fade)return 1;
  if(L.fade==='eyeOpen'){const v=L.side==='L'?e.eyeOpenL:e.eyeOpenR;return smooth((v-(0.10+e.eyeEase*0.45))/0.15);}
  if(L.fade==='eyeClose'||L.fade==='eyeClose2'){
    const alternate=blinkVariant===2&&alt[L.side];
    if((L.fade==='eyeClose2')!==alternate)return 0;
    const v=L.side==='L'?e.eyeOpenL:e.eyeOpenR;return 1-smooth((v-(0.10+e.eyeEase*0.45))/0.15);
  }
  if(L.fade==='mouthOpen')return smooth((e.mouthOpen-(0.05+e.mouthEase*0.35))/0.12);
  if(L.fade==='mouthClose')return 1-smooth((e.mouthOpen-(0.05+e.mouthEase*0.35))/0.12);
  return 1;
}
const FRONTISH={'front hair':1,'side hair':1,'ahoge':1};
function deform(L,e){
  const b=L.base,o=L.cur,n=b.length;
  const isHead=L.group==='head';
  const az=e.angleZ*0.07,cz=Math.cos(az),sz=Math.sin(az);
  const ab=e.body*0.028,cb=Math.cos(ab),sb=Math.sin(ab);
  const bn=L.bn,eyeSide=L.side,EA=eyeSide==='L'?A.eyeL:(eyeSide==='R'?A.eyeR:null);
  const vOpen=eyeSide==='L'?e.eyeOpenL:e.eyeOpenR;
  const mo=e.mouthOpen,mHalfW=(A.mouth.x1-A.mouth.x0)/2;
  const nS=L.strands?L.strands.length:0;
  const bcx=L.x+L.w/2,bcy=L.y+L.h/2;
  const kind=L.phys==='sway'?'acc':FRONTISH[bn]?'fh':'bh';
  const physOn=nS&&auto.phys&&L.su;
  const ampK=kind==='acc'?e.accAmp*1.4:kind==='fh'?e.fhAmp:e.physAmp;
  const softK=kind==='acc'?0.8:kind==='fh'?e.fhSoft:e.soft;
  const powA=kind==='acc'?1.2:kind==='fh'?1.8:2.1;
  for(let k=0;k<n;k+=2){
    let x=b[k],y=b[k+1];
    const vi=k>>1;
    // --- closed-eye / mouth scale ---
    if(EA&&(bn==='eye_close'||bn==='eye_close2')){
      const sE=eyeSide==='L'?e.eyeScaleL:e.eyeScaleR;
      if(sE!==1){const cxE=(EA.x0+EA.x1)/2,cyE=(EA.y0+EA.y1)/2;x=cxE+(x-cxE)*sE;y=cyE+(y-cyE)*sE;}
    }
    if(bn==='mouth_open'||bn==='mouth_close'){
      const sM=e.mouthScale;
      if(sM!==1){x=A.mouth.cx+(x-A.mouth.cx)*sM;y=A.mouth.cy+(y-A.mouth.cy)*sM;}
    }
    // --- local features ---
    if(L.fade==='eyeOpen'&&EA){
      if(bn==='irides'){
        const isc=e.irisScale,ibx=e.irisBounceX||1,iby=e.irisBounceY||1;
        x=EA.icx+(x-EA.icx)*isc*ibx;y=EA.icy+(y-EA.icy)*isc*iby;
        x+=e.eyeX*11*FS;y+=e.eyeY*6*FS;
        const tl=smooth((0.32-vOpen)/0.32);   // iris stays round until nearly closed
        y=EA.closeY+(y-EA.closeY)*(1-0.80*tl);
      }else{
        y=EA.closeY+(y-EA.closeY)*(1-0.85*(1-vOpen));   // lid compression
      }
    }
    if((L.fade==='eyeClose'||L.fade==='eyeClose2')&&EA){
      y-=vOpen*3;y+=e.eyeCY*14*FS;
      const thE=e.eyeCAng*0.3*(eyeSide==='L'?1:-1);
      if(thE){const ct=Math.cos(thE),st=Math.sin(thE),rx=x-bcx,ry=y-bcy;x=bcx+rx*ct-ry*st;y=bcy+rx*st+ry*ct;}
    }
    if(bn==='eyebrow'){
      y+=(-e.brow*9+(1-vOpen)*3.5)*FS;
      const th=(eyeSide==='L'?(e.browAngL+e.browAngSym):(e.browAngR-e.browAngSym))*0.30;
      if(th){const ct=Math.cos(th),st=Math.sin(th),rx=x-bcx,ry=y-bcy;x=bcx+rx*ct-ry*st;y=bcy+rx*st+ry*ct;}
    }
    if(L.fade==='mouthOpen'){
      y=A.mouth.y0+(y-A.mouth.y0)*(0.5+0.5*mo);
      const q=Math.pow(Math.abs(x-A.mouth.cx)/(mHalfW+4),1.5);
      y-=e.mouthForm*6*FS*(q-0.35);
    }
    if(L.fade==='mouthClose'){
      y+=e.mouthCY*14*FS;
      const thM=e.mouthCAng*0.35;
      if(thM){const ct=Math.cos(thM),st=Math.sin(thM),rx=x-A.mouth.cx,ry=y-A.mouth.cy;x=A.mouth.cx+rx*ct-ry*st;y=A.mouth.cy+rx*st+ry*ct;}
    }
    if(bn==='face'&&y>A.mouth.cy)y+=mo*6*FS*smooth((y-A.mouth.cy)/Math.max(1,A.face.y1-A.mouth.cy));
    // --- head transform ---
    let hw=isHead?1:(L.group==='body'?0.16:0);   // body subtly follows head XYZ
    if(bn==='neck')hw=0.55*smooth((A.neckBottom-y)/Math.max(1,A.neckBottom-A.neckTop));
    if(hw>0){
      const rx=x-NP.cx,ry=y-NP.cy,rx2=rx*cz-ry*sz,ry2=rx*sz+ry*cz;
      x+=(rx2-rx)*hw;y+=(ry2-ry)*hw;
      const dd=L.depth;
      x+=hw*FS*(e.angleX*(14+40*(dd-1))+e.angleX*(NP.cy-y)*0.028);
      y+=hw*FS*(-e.angleY*(9+30*(dd-1))-e.angleY*(dd-1)*(y-FC.y)*0.05);
    }
    // --- breathing ---
    y-=(L.group==='body'?e.breath*2.0:e.breathHead*1.6)*FS;
    if(bn==='topwear'&&y<CHEST.cy)y-=e.breath*2.2*FS*smooth((CHEST.cy-y)/(CHEST.ry*2));   // shoulders rise
    if(bn==='topwear')x=NP.cx+(x-NP.cx)*(1+e.breath*0.003);
    // --- bust jiggle ---
    if(bn==='topwear'){
      const gx=(x-CHEST.cx)/CHEST.rx,gy=(y-(CHEST.cy+e.bustY*70*FS))/CHEST.ry;
      y+=bounce.dy*e.bust*Math.exp(-gx*gx-gy*gy);
    }
    // --- arms ---
    if(bn==='handwear'){
      const w=smooth((y-L.y)/L.h*1.15);
      y-=e.armY*30*FS*w;y+=e.armPos*40*FS;x+=e.armY*6*FS*w*(x<NP.cx?1:-1);
    }
    // --- bang blocks ---
    if(L.bw){const m=Math.pow(L.su[vi],1.4)*22*FS;x+=(e.bangL*L.bw[vi*3]+e.bangC*L.bw[vi*3+1]+e.bangR*L.bw[vi*3+2])*m;}
    // --- strand physics: stiff root, fluffy tips (front hair / accessories have their own params) ---
    if(physOn){
      const u=kind==='fh'?Math.min(1,L.su[vi]*1.6):L.su[vi];
      const amp=Math.pow(u,powA)*ampK,softMix=Math.min(1,Math.pow(u,1.2)*softK);
      let dx=0;
      for(let s=0;s<nS;s++){const w=L.sw[vi*nS+s];if(w<0.001)continue;const sp=L.spr[s];dx+=w*(sp.stiff.dx*(1-softMix)+sp.soft.dx*softMix);}
      x+=dx*amp;y+=Math.abs(dx)*amp*0.12;
    }
    o[k]=x;o[k+1]=y;
  }
  // --- body rotation (around bottom center) ---
  if(Math.abs(ab)>1e-4){
    for(let k=0;k<n;k+=2){const rx=o[k]-BP.cx,ry=o[k+1]-BP.cy;o[k]=BP.cx+rx*cb-ry*sb;o[k+1]=BP.cy+rx*sb+ry*cb;}
  }
}
function updateSprings(e,t,dt,wind){
  const headDX=(e.angleX*14+e.angleZ*0.07*(NP.cy-FC.y))*FS;
  const bodyDX=e.body*0.028*(BP.cy-NP.cy)*0.35+e.angleX*14*0.16*FS;
  for(const L of layers){
    if(!L.spr)continue;
    const base=L.group==='head'?headDX:bodyDX,windScale=L.phys==='sway'&&L.group!=='head'?2.5:1;
    for(const sp of L.spr){
      const w=wind?(1.8*Math.sin(t*0.8+sp.phase)+1.0*Math.sin(t*1.9+sp.phase*2.3))*windScale:0;
      const txv=base+w*FS;
      RT.spring(sp.stiff,txv,70,9,dt);sp.stiff.dx=-(sp.stiff.x-txv)*2.2;
      RT.spring(sp.soft,txv,16,1.3,dt);sp.soft.dx=-(sp.soft.x-txv)*3.0;
    }
  }
  const bustTgt=(e.breath*3.0-e.angleY*6.0+e.body*4.0)*FS;
  RT.spring(bounce,bustTgt,140,4.2,dt);bounce.dy=-(bounce.x-bustTgt)*3.0;
}
// Still pose used while editing anchors: handles line up with the drawing.
function restPose(dt){
  const e=Object.assign({},T,{angleX:0,angleY:0,angleZ:0,body:0,eyeX:0,eyeY:0,irisBounceX:1,irisBounceY:1,breath:0,breathHead:0});
  if(anchorPreview==='L')e.eyeOpenL=0;if(anchorPreview==='R')e.eyeOpenR=0;
  updateSprings(e,0,dt,false);
  return e;
}
function animate(now,dt){
  if(anchorMode)return restPose(dt);
  const t=now/1000;
  const tgt=Object.assign({},T);
  const camLive=(auto.cam||OBS_MODE)&&cam.live&&performance.now()-lastTrackingAt<1200;
  if(camLive){
    tgt.angleX=clamp(cam.ax,-1,1);tgt.angleY=clamp(cam.ay,-1,1);tgt.angleZ=clamp(cam.az,-1,1);
    tgt.eyeOpenL=Math.min(tgt.eyeOpenL,cam.eL);tgt.eyeOpenR=Math.min(tgt.eyeOpenR,cam.eR);
    tgt.eyeX=clamp(cam.ex,-1,1);tgt.eyeY=clamp(cam.ey,-1,1);
    tgt.mouthOpen=Math.max(tgt.mouthOpen,cam.mo);
    tgt.brow=clamp(tgt.brow+(cam.br||0),-1,1);tgt.mouthForm=clamp(tgt.mouthForm+(cam.mf||0),-1,1);
    tgt.body=clamp(tgt.body+cam.ax*0.25,-1,1);
  }
  if(!camLive&&auto.mouse&&mouse.in){tgt.angleX=clamp(mouse.x*0.9,-1,1);tgt.angleY=clamp(-mouse.y*0.7,-1,1);tgt.eyeX=clamp(mouse.x*1.2,-1,1);tgt.eyeY=clamp(-mouse.y*0.8,-1,1);}
  if(auto.idle&&!camLive){
    tgt.angleX+=0.13*Math.sin(t*0.42)+0.05*Math.sin(t*1.13);
    tgt.angleY+=0.08*Math.sin(t*0.31+1.7);
    tgt.angleZ+=0.07*Math.sin(t*0.23+0.5);
    tgt.body+=0.10*Math.sin(t*0.19+2.1);
  }
  if(auto.rand&&!camLive){
    if(now>nextRnd){nextRnd=now+1400+Math.random()*2600;
      rnd.ax=(Math.random()*2-1)*0.55;rnd.ay=(Math.random()*2-1)*0.40;rnd.az=(Math.random()*2-1)*0.35;
      rnd.bd=(Math.random()*2-1)*0.30;rnd.ex=(Math.random()*2-1)*0.60;rnd.ey=(Math.random()*2-1)*0.35;}
    tgt.angleX=clamp(tgt.angleX+rnd.ax,-1,1);tgt.angleY=clamp(tgt.angleY+rnd.ay,-1,1);
    tgt.angleZ=clamp(tgt.angleZ+rnd.az,-1,1);tgt.body=clamp(tgt.body+rnd.bd,-1,1);
    tgt.eyeX=clamp(tgt.eyeX+rnd.ex,-1,1);tgt.eyeY=clamp(tgt.eyeY+rnd.ey,-1,1);
  }
  const remoteMicLive=OBS_MODE&&performance.now()-remoteMicAt<500;
  if(auto.talk&&!camLive&&!auto.mic&&!remoteMicLive&&!activePreset){
    if(now>nextTalkState){talkOn=!talkOn;nextTalkState=now+(talkOn?1200+Math.random()*2200:600+Math.random()*1800);}
    if(talkOn&&now>nextSyl){nextSyl=now+70+Math.random()*110;talkTgt=Math.random()<0.25?0.04:0.25+Math.random()*0.75;}
    if(!talkOn)talkTgt=0;
    talkV+=(talkTgt-talkV)*Math.min(1,dt*22);
    tgt.mouthOpen=Math.max(tgt.mouthOpen,talkV);
  }
  if(auto.blink&&!camLive&&!activePreset){
    if(blinkT<0&&now>nextBlink){blinkT=0;blinkBounceStarted=false;blinkVariant=hasEyeClose2&&Math.random()<0.2?2:1;nextBlink=now+1600+Math.random()*3800;if(Math.random()<0.18)nextBlink=now+280;}
    if(blinkT>=0){blinkT+=dt;
      const d=blinkT,hold=blinkVariant===2?3.4:0.34;let v;
      if(d<0.08)v=1-d/0.08;else if(d<0.08+hold)v=0;else if(d<0.24+hold){
        v=(d-0.08-hold)/0.16;
        if(!blinkBounceStarted&&v>0.12){blinkBounceStarted=true;irisBounceT=0;}
      }else{v=1;blinkT=-1;}
      tgt.eyeOpenL=Math.min(tgt.eyeOpenL,v);tgt.eyeOpenR=Math.min(tgt.eyeOpenR,v);
    }
  }
  if(irisBounceT>=0){irisBounceT+=dt;if(irisBounceT>0.52)irisBounceT=-1;}
  if(auto.mic&&mic.active)tgt.mouthOpen=Math.max(tgt.mouthOpen,micLevel);
  if(remoteMicLive)tgt.mouthOpen=Math.max(tgt.mouthOpen,remoteMic);
  const kSmooth=1-Math.exp(-dt*14);
  for(const k in cur){tgt[k]=RT.clamp(tgt[k],...parameterRanges[k]);cur[k]+=(tgt[k]-cur[k])*kSmooth;}
  const e=Object.assign({},cur);
  e.irisBounceX=1;e.irisBounceY=1;
  if(irisBounceT>=0){
    const p=irisBounceT/0.52,damp=Math.exp(-2.2*p);
    const scale=1+0.18*Math.sin(p*Math.PI*4.0)*damp,squash=0.10*Math.sin(p*Math.PI*4.0+Math.PI/2)*damp;
    e.irisBounceX=scale*(1+squash);e.irisBounceY=scale*(1-squash);
  }
  camPhysScale+=((camLive?0.5:1)-camPhysScale)*Math.min(1,dt*4);   // calmer hair while tracking
  e.physAmp*=camPhysScale;e.soft*=camPhysScale;e.fhAmp*=camPhysScale;e.fhSoft*=camPhysScale;
  e.breath=0.5+0.5*Math.sin(t*2*Math.PI/3.4);
  e.breathHead=0.5+0.5*Math.sin(t*2*Math.PI/3.4-0.6);   // head follows chest with a lag
  updateSprings(e,t,dt,auto.idle);
  return e;
}

// ---------- render loop ----------
function render(e){
  const alt={L:false,R:false};
  for(const L of layers)if(L.fade==='eyeClose2'&&L.side&&L.visible&&L.opacity>0)alt[L.side]=true;
  const items=[],masks=[];
  for(const L of layers){
    const isMask=L.bn==='eyewhite'&&!!L.side;
    const alpha=L.visible?fadeAlpha(L,e,alt)*L.opacity:0;
    if(alpha<0.004&&!isMask)continue;
    deform(L,e);renderer.positions(L,L.cur);
    if(isMask)masks.push({L,side:L.side});
    if(alpha>=0.004)items.push({L,alpha,clip:L.bn==='irides'&&L.side?L.side:null});
  }
  const frame={width:CW,height:CH,background:exportBackground(),masks:maskFailed?[]:masks,items};
  try{renderer.draw(frame);}
  catch(err){
    if(maskFailed)throw err;
    maskFailed=true;status(err.message+'（瞳の切り抜きを無効にしました）',true);
    frame.masks=[];renderer.draw(frame);
  }
}
let maskFailed=false;
let last=performance.now(),simulationTime=last,fpsN=0,fpsT=last;
function tick(now){
  requestAnimationFrame(tick);
  const dt=Math.max(0,Math.min(0.05,(now-last)/1000));last=now;
  if(!OBS_MODE)updateMeter(now);
  if(!layers.length||!A||contextLost)return;
  if(anchorMode||!paused||!lastFrame){simulationTime+=dt*1000;lastFrame=animate(simulationTime,dt);dirty=true;}
  if(dirty||capturePending||(recorder&&recorder.active)){render(lastFrame);dirty=false;}
  if(capturePending){
    capturePending=false;
    cv.toBlob(blob=>{if(blob){download(blob,baseFileName()+'.png');status('PNGを書き出しました（'+CW+' × '+CH+'px'+(prefs.exportBg==='transparent'?'・透過':'')+'）');}else status('PNGを書き出せませんでした',true);},'image/png');
    invalidate();
  }
  fpsN++;if(now-fpsT>500){$('fps').textContent=Math.round(fpsN*1000/(now-fpsT))+' fps';fpsN=0;fpsT=now;}
}
cv.addEventListener('webglcontextlost',ev=>{ev.preventDefault();contextLost=true;capturePending=false;recorder?.cancel();status('描画が一時停止しました。復旧を待っています',true);});
cv.addEventListener('webglcontextrestored',()=>{
  try{
    const saved=currentRig?settingsSnapshot():null;layers=[];renderer.init();contextLost=false;
    if(currentRig){applyRig(currentRig);applySettings(saved);}
    status('描画を復旧しました');
  }catch(err){contextLost=true;status('描画の復旧に失敗しました。ページを再読み込みしてください',true);}
});
window.addEventListener('pagehide',()=>{mic.stop(true);camera.stop(true);liveTicker?.stop();liveTicker=null;sync.close();cancelLoad();recorder?.cancel();});

// Microphone sampling and the OBS relay run on a worker-driven ticker so they
// continue while the editor window is covered by OBS (rAF stops then).
let liveTicker=null;
function updateLiveTicker(){
  const need=!OBS_MODE&&(auto.cam||auto.mic);
  if(need&&!liveTicker)liveTicker=window.RigDevices.createTicker(20,()=>{
    micLevel=auto.mic&&mic.active?mic.sample(prefs.micGain,prefs.micGate):0;
    if(auto.cam||auto.mic)sync.publishTracking(liveTracking());
  });
  else if(!need&&liveTicker){liveTicker.stop();liveTicker=null;micLevel=0;}
}

// Read-only diagnostics for automated tests and bug reports.
Object.defineProperty(window,'Anime25D',{value:Object.freeze({version:APP_VERSION,state(){
  return {modelId,modelName,layers:layers.length,paused,anchorMode,activePreset,background,unsaved,
    anchors:JSON.parse(JSON.stringify(anchorOffsets)),params:Object.assign({},T),auto:Object.assign({},auto),
    cam:Object.assign({},cam),camLive:cam.live&&performance.now()-lastTrackingAt<1200,calibrated:!!prefs.calibration,
    view:Object.assign({},view),obs:sync.status,recording:!!(recorder&&recorder.active)};
}})});

// ---------- start ----------
if(OBS_MODE){
  auto.cam=true;
  sync.listen();
  (async()=>{
    await sync.ready;
    if(sync.status.relay&&sync.status.serverModel){await loadFromRelay(sync.status.serverModel.id);if(layers.length||relayLoadingId)return;}
    if(layers.length||relayLoadingId)return;   // a model arrived from the editor meanwhile
    const path=RT.safeRelativePath(QUERY.get('model')||'','.psd');
    if(path)await loadModel(fetchSource(path),path.split('/').pop(),{relay:false});
    else await loadSample('B');
  })();
}else{
  sync.startPolling();
  if(CAMERA_MODE)setAuto('cam',true);
}
requestAnimationFrame(tick);
})();
