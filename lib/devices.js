/*!
 * Anime2.5DRig — devices.js
 * Camera face tracking (MediaPipe FaceMesh, bundled and version-pinned) and
 * microphone level input. Both can be switched off while they are still
 * starting; late permissions are released immediately.
 * MIT License
 */
(function(root){
'use strict';
const FM_VERSION='0.4.1633559619';
const LOCAL_BASE='lib/vendor/face_mesh/';
const CDN_BASE='https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@'+FM_VERSION+'/';
let scriptPromise=null,fmBase=LOCAL_BASE;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;

function loadScript(url,timeout){
  return new Promise((resolve,reject)=>{
    const s=document.createElement('script');s.src=url;s.async=true;
    const timer=setTimeout(()=>{s.remove();reject(new Error('顔追跡モデルの読み込みがタイムアウトしました'));},timeout||20000);
    s.onload=()=>{clearTimeout(timer);resolve();};
    s.onerror=()=>{clearTimeout(timer);s.remove();reject(new Error('顔追跡モデルを取得できません'));};
    document.head.appendChild(s);
  });
}
// Bundled copy first (offline, pinned); the same version from the CDN otherwise.
function loadFaceMesh(){
  if(root.FaceMesh)return Promise.resolve();
  if(!scriptPromise){
    scriptPromise=loadScript(LOCAL_BASE+'face_mesh.js',8000).then(()=>{fmBase=LOCAL_BASE;})
      .catch(()=>loadScript(CDN_BASE+'face_mesh.js').then(()=>{fmBase=CDN_BASE;}))
      .catch(err=>{scriptPromise=null;throw err;});
  }
  return scriptPromise;
}
function locateFile(file){
  // Only the SIMD build is bundled; very old browsers fetch the plain build.
  if(fmBase===LOCAL_BASE&&/wasm_bin/.test(file)&&!/simd/.test(file))return CDN_BASE+file;
  return fmBase+file;
}
function cameraError(err){
  const n=err&&err.name;
  if(n==='NotAllowedError'||n==='PermissionDeniedError')return 'ブラウザのカメラ許可を確認してください';
  if(n==='NotReadableError'||n==='TrackStartError')return '他のアプリがカメラを使用中です';
  if(n==='NotFoundError'||n==='DevicesNotFoundError')return 'カメラが見つかりません';
  if(typeof isSecureContext!=='undefined'&&!isSecureContext)return 'https または localhost で開いてください';
  return (err&&err.message)||String(err);
}

// Timers on the main thread are throttled (down to 1 Hz) when the editor window
// is minimised or covered. Worker timers are not, so tracking and the OBS relay
// keep running while you look at OBS. Falls back to setTimeout.
function createTicker(ms,fn){
  let worker=null,timer=null,stopped=false;
  try{
    const src='let t=null;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};';
    const url=URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
    worker=new Worker(url);URL.revokeObjectURL(url);
    worker.onmessage=()=>{if(!stopped)fn();};
    worker.onerror=()=>{worker.terminate();worker=null;if(!stopped)loop();};
    worker.postMessage(ms);
  }catch(err){worker=null;}
  function loop(){if(stopped)return;fn();timer=setTimeout(loop,ms);}
  if(!worker)timer=setTimeout(loop,ms);
  return {stop(){stopped=true;clearTimeout(timer);if(worker){worker.postMessage(0);worker.terminate();worker=null;}}};
}

// Landmarks drawn on the small preview: eye, brow and mouth outlines.
const PREVIEW_POINTS=[33,133,159,145,263,362,386,374,70,105,107,300,334,336,61,291,13,14,1,468,473];

function createCamera(opts){
  const o=Object.assign({onResults:null,onState:null,preview:null},opts);
  let gen=0,session=null,lastPreview=0;
  const state=(s,msg)=>{o.onState&&o.onState(s,msg);};
  function drawPreview(video,lm){
    const c=o.preview;if(!c||!c.isConnected||c.offsetParent===null)return;
    const now=performance.now();if(now-lastPreview<60)return;lastPreview=now;
    const ctx=c.getContext('2d'),w=c.width,h=c.height;
    ctx.save();ctx.clearRect(0,0,w,h);ctx.translate(w,0);ctx.scale(-1,1);
    try{ctx.drawImage(video,0,0,w,h);}catch(err){}
    if(lm){ctx.fillStyle='#ff6f91';for(const i of PREVIEW_POINTS){const p=lm[i];if(p)ctx.fillRect(p.x*w-1.5,p.y*h-1.5,3,3);}}
    ctx.restore();
    if(!lm){ctx.fillStyle='rgba(0,0,0,.55)';ctx.fillRect(0,h-22,w,22);ctx.fillStyle='#ffb3c4';ctx.font='12px sans-serif';ctx.fillText('顔を検出できません',8,h-7);}
  }
  function loop(s,token){
    let busy=false,nextAt=0;
    const step=async()=>{
      if(token!==gen||busy)return;
      const v=s.video,t0=performance.now();
      // Poll quickly but only process new video frames, one at a time, and
      // leave the page idle for at least half the processing time (slow PCs).
      if(t0<nextAt||v.readyState<2||v.currentTime===s.lastTime)return;
      busy=true;
      try{s.lastTime=v.currentTime;s.pending=s.fm.send({image:v});await s.pending;}
      catch(err){if(token===gen){stop();state('error','顔追跡が停止しました。カメラを再度ONにしてください');}}
      finally{busy=false;const t1=performance.now();nextAt=t1+Math.max(8,(t1-t0)*0.5);}
    };
    s.ticker=createTicker(16,step);
  }
  async function start(){
    const token=++gen;let stream=null;
    try{
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error('https または localhost で開いてください');
      state('loading');
      if(!root.FaceMesh)await loadFaceMesh();
      if(token!==gen)return false;
      try{stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});}
      catch(e1){
        if(e1.name==='OverconstrainedError'||e1.name==='ConstraintNotSatisfiedError')stream=await navigator.mediaDevices.getUserMedia({video:true});
        else throw e1;
      }
      if(token!==gen){stream.getTracks().forEach(t=>t.stop());return false;}
      const video=document.createElement('video');video.srcObject=stream;video.muted=true;video.playsInline=true;
      const s={video,stream,fm:null,pending:null,timer:null,lastTime:-1};session=s;
      await video.play();
      if(token!==gen)return false;
      s.fm=new root.FaceMesh({locateFile});
      s.fm.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:0.5,minTrackingConfidence:0.5});
      s.fm.onResults(res=>{
        if(token!==gen)return;
        const lm=res&&res.multiFaceLandmarks&&res.multiFaceLandmarks[0]||null;
        drawPreview(video,lm);
        o.onResults&&o.onResults(lm,video);
      });
      stream.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(token===gen){stop();state('error','カメラが切断されました');}}));
      state('on');
      loop(s,token);
      return true;
    }catch(err){
      if(stream)try{stream.getTracks().forEach(t=>t.stop());}catch(e){}
      if(token!==gen)return false;
      stop(true);
      throw new Error(cameraError(err));
    }
  }
  function stop(quiet){
    gen++;
    const s=session;session=null;
    if(s){
      clearTimeout(s.timer);if(s.ticker)s.ticker.stop();s.stream.getTracks().forEach(t=>t.stop());
      try{s.video.pause();}catch(err){}s.video.srcObject=null;
      Promise.resolve(s.pending).catch(()=>{}).then(()=>s.fm&&s.fm.close()).catch(()=>{});
    }
    if(o.preview){const ctx=o.preview.getContext('2d');ctx&&ctx.clearRect(0,0,o.preview.width,o.preview.height);}
    if(!quiet)state('off');
  }
  return {start,stop,get active(){return !!session;}};
}

function createMic(opts){
  const o=Object.assign({onState:null},opts);
  let gen=0,stream=null,ctx=null,analyser=null,buf=null,level=0,raw=0;
  const state=(s,msg)=>{o.onState&&o.onState(s,msg);};
  async function start(){
    const token=++gen;let st=null,ac=null;
    try{
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error('https または localhost で開いてください');
      state('loading');
      st=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:false}});
      if(token!==gen){st.getTracks().forEach(t=>t.stop());return false;}
      const AC=root.AudioContext||root.webkitAudioContext;
      ac=new AC();stream=st;ctx=ac;
      await ac.resume();
      if(token!==gen){st.getTracks().forEach(t=>t.stop());if(ac.state!=='closed')await ac.close();return false;}
      const src=ac.createMediaStreamSource(st);analyser=ac.createAnalyser();analyser.fftSize=512;
      buf=new Uint8Array(analyser.frequencyBinCount);src.connect(analyser);
      st.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(token===gen){stop(true);state('error','マイクが切断されました');}}));
      state('on');
      return true;
    }catch(err){
      if(st)st.getTracks().forEach(t=>t.stop());
      if(ac&&ac.state!=='closed')ac.close().catch(()=>{});
      if(token!==gen)return false;
      stop(true);
      throw new Error(err.name==='NotAllowedError'?'ブラウザのマイク許可を確認してください':err.message);
    }
  }
  function stop(quiet){
    gen++;
    if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;
    if(ctx)ctx.close().catch(()=>{});ctx=null;analyser=null;buf=null;level=0;raw=0;
    if(!quiet)state('off');
  }
  // Speech band energy (≈190 Hz–3.7 kHz) → 0..1 with gain and a noise gate.
  function sample(gain,gate){
    if(!analyser)return 0;
    analyser.getByteFrequencyData(buf);
    let s=0;for(let i=2;i<40;i++)s+=buf[i];s/=38*255;
    raw=clamp(s*3.2,0,1);
    const g=clamp(gate||0,0,0.9),v=clamp((raw*(gain||1)-g)/(1-g),0,1);
    level+=(v-level)*0.45;
    return level;
  }
  return {start,stop,sample,get active(){return !!analyser;},get raw(){return raw;},get level(){return level;}};
}

root.RigDevices={createCamera,createMic,createTicker,FM_VERSION};
})(typeof self!=='undefined'?self:this);
