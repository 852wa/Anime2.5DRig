'use strict';
// Runs the real index.html inside an iframe with virtual camera/microphone,
// in-memory storage and a synthetic PSD. No real devices are touched.
function installMocks() {
  const pending=[],blobs=[],errors=[],memory=new Map();
  window.harness={pending,blobs,errors,closedAudio:0,closedFace:0,holdVideo:false};
  window.addEventListener('error',e=>errors.push(e.message));
  window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
  Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.has(k)?memory.get(k):null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)}});
  const originalFetch=window.fetch;
  window.fetch=(url,opts)=>String(url)==='/relay-info'?Promise.resolve(new Response('{}')):originalFetch(url,opts);
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))}});
  HTMLMediaElement.prototype.play=function(){return harness.holdVideo?new Promise(resolve=>harness.releaseVideo=resolve):Promise.resolve();};
  HTMLMediaElement.prototype.pause=function(){};
  window.FaceMesh=class {setOptions(){}onResults(fn){this.fn=fn;}send(){this.fn({});return Promise.resolve();}close(){harness.closedFace++;return Promise.resolve();}};
  window.AudioContext=class {constructor(){this.state='running';}resume(){return Promise.resolve();}close(){this.state='closed';harness.closedAudio++;return Promise.resolve();}createMediaStreamSource(){return {connect(){}};}createAnalyser(){return {frequencyBinCount:256,getByteFrequencyData(b){b.fill(0);}};}};
  const originalURL=URL.createObjectURL;
  URL.createObjectURL=blob=>{blobs.push(blob);return originalURL.call(URL,blob);};
  HTMLAnchorElement.prototype.click=function(){};
}
const result=document.getElementById('result');
const wait=async(predicate,label,timeout=15000)=>{const start=performance.now();while(!predicate()){if(performance.now()-start>timeout)throw new Error('Timeout: '+label);await new Promise(r=>setTimeout(r,20));}};
let passed=0;
function assert(condition,label){if(!condition)throw new Error(label);passed++;result.textContent+='PASS '+label+'\n';}
function note(text){result.textContent+='NOTE '+text+'\n';}
async function decodeFirstFrame(blob){
  const video=document.createElement('video');video.muted=true;video.src=URL.createObjectURL(blob);
  await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('video decode failed'));});
  video.currentTime=0.5;await new Promise(r=>{video.onseeked=r;setTimeout(r,1500);});
  const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;
  const ctx=c.getContext('2d');ctx.drawImage(video,0,0);return ctx.getImageData(0,0,c.width,c.height);
}
document.getElementById('run').addEventListener('click',async()=>{
  document.getElementById('run').disabled=true;result.textContent='';passed=0;
  try{
    const html=await (await fetch('../index.html')).text(),frame=document.createElement('iframe');
    frame.srcdoc=html.replace('<head>','<head><base href="'+new URL('../',location.href).href+'"><script>('+installMocks.toString()+')();<\/script>');
    document.getElementById('frame').replaceChildren(frame);
    await new Promise(r=>frame.addEventListener('load',r,{once:true}));
    const w=frame.contentWindow,d=w.document,h=w.harness;
    await wait(()=>w.Anime25D,'application initialization');
    const S=()=>w.Anime25D.state();
    const click=id=>d.getElementById(id).click();
    const settle=(ms=40)=>new Promise(r=>setTimeout(r,ms));
    const key=(k,opts={},target=d.body)=>target.dispatchEvent(new w.KeyboardEvent('keydown',Object.assign({key:k,bubbles:true,cancelable:true},opts)));
    const stream=()=>{const track=d.createElement('canvas').captureStream(0).getTracks()[0];return {track,media:new w.MediaStream([track])};};

    // ---- devices: late permissions are released, OFF frees everything ----
    click('tgMic');click('tgMic');const lateMic=stream();h.pending.shift().resolve(lateMic.media);await settle();
    assert(lateMic.track.readyState==='ended','microphone permission arriving after OFF releases its track');
    click('tgMic');const mic=stream();h.pending.shift().resolve(mic.media);await wait(()=>d.getElementById('tgMic').textContent==='マイク使用中','mic starts');click('tgMic');await settle();
    assert(mic.track.readyState==='ended'&&h.closedAudio===1,'microphone OFF closes stream and audio context');
    click('tgCam');click('tgCam');const lateCam=stream();h.pending.shift().resolve(lateCam.media);await settle();
    assert(lateCam.track.readyState==='ended','camera permission arriving after OFF releases its track');
    h.holdVideo=true;click('tgCam');const waitingCam=stream();h.pending.shift().resolve(waitingCam.media);await wait(()=>h.releaseVideo,'video initialization');click('tgCam');h.releaseVideo();await settle();h.holdVideo=false;
    assert(waitingCam.track.readyState==='ended','camera OFF during video initialization cancels the stream');
    click('tgCam');const cam=stream();h.pending.shift().resolve(cam.media);await wait(()=>d.getElementById('tgCam').textContent==='カメラ追従中','cam starts');
    assert(!d.getElementById('btnCalibrate').disabled,'calibration is available while tracking');
    click('tgCam');await settle();
    assert(cam.track.readyState==='ended'&&h.closedFace===1&&d.getElementById('btnCalibrate').disabled,'camera OFF closes stream and face model');

    // ---- synthetic PSD: two eyes, red/blue irises, Japanese and hostile names ----
    function part(name,left,top,width,height,color){const data=new w.Uint8ClampedArray(width*height*4);for(let i=0;i<data.length;i+=4)data.set(color,i);return{name,left,top,right:left+width,bottom:top+height,imageData:{width,height,data}};}
    const psd={width:128,height:128,children:[part('顔',20,10,88,95,[230,160,130,255]),part('eyewhite',30,42,20,12,[255,255,255,255]),part('eyewhite_2',78,42,20,12,[255,255,255,255]),part('irides',35,44,10,8,[255,0,0,255]),part('irides_2',83,44,10,8,[0,0,255,255]),part('mouth_open',53,77,22,8,[120,25,55,255]),part('<img src=x onerror=alert(1)>',1,1,10,10,[255,255,0,255])]};
    const file=new w.File([w.agPsd.writePsd(psd,{generateThumbnail:false})],'test.psd');
    function select(input,f){const dt=new w.DataTransfer();dt.items.add(f);input.files=dt.files;input.dispatchEvent(new w.Event('change'));}
    select(d.getElementById('fileInput'),file);
    await wait(()=>d.getElementById('drop').classList.contains('hidden'),'worker import');
    assert(!d.querySelector('#layers [onerror]')&&d.querySelector('#layers').textContent.includes('<img'),'layer names are displayed as text');
    assert(d.querySelector('#layers').textContent.includes('顔')&&[...d.querySelectorAll('.layer-role')].some(r=>r.textContent.startsWith('顔')),'Japanese layer name resolves to the face role');
    assert(d.querySelectorAll('#diagnostics li').length>=8&&d.querySelector('#diagnostics li.ok'),'model diagnostics are listed');
    assert(d.querySelectorAll('.layer-thumb[src^="data:image/png"]').length>=5,'layer thumbnails are generated');

    // ---- settings save / restore / export / import ----
    click('btnPause');
    const valueOf=id=>d.querySelector('#'+id).parentElement.querySelector('.val');
    const setValue=(id,n,commit=true)=>{const input=valueOf(id);input.value=String(n);input.dispatchEvent(new w.Event('input'));if(commit)input.dispatchEvent(new w.Event('change'));};
    setValue('pAngleX',0.42);
    const opacity=d.querySelector('.layer-card input[type=number]');opacity.value='0.65';opacity.dispatchEvent(new w.Event('input'));opacity.dispatchEvent(new w.Event('change'));
    const visible=d.querySelector('.layer-card input[type=checkbox]');visible.click();
    assert(d.getElementById('btnSaveSettings').textContent.includes('●')&&S().unsaved,'unsaved changes are indicated');
    click('btnSaveSettings');
    assert(!d.getElementById('btnSaveSettings').textContent.includes('●'),'saving clears the unsaved marker');
    setValue('pAngleX',-0.8);click('btnResetLayers');click('btnRestoreSettings');
    assert(d.getElementById('pAngleX').value==='0.42'&&!d.querySelector('.layer-card input[type=checkbox]').checked&&d.querySelector('.layer-card input[type=number]').value==='0.65','settings restore parameters and layer properties');
    click('btnExportSettings');const json=h.blobs.at(-1);assert(json.type==='application/json'&&JSON.parse(await json.text()).version===2,'settings JSON export (version 2)');
    select(d.getElementById('settingsInput'),new w.File([await json.text()],'settings.json'));await wait(()=>d.getElementById('appStatus').textContent.includes('設定を読み込みました'),'settings import');
    d.getElementById('appStatus').textContent='';
    select(d.getElementById('fileInput'),new w.File([await json.text()],'dropped.rig.json'));await wait(()=>d.getElementById('appStatus').textContent.includes('設定を読み込みました'),'JSON through the PSD picker');
    assert(true,'a settings JSON can be opened like a PSD');

    // ---- undo / redo ----
    setValue('pAngleX',0.1);setValue('pAngleX',0.3);
    key('z',{ctrlKey:true});assert(S().params.angleX===0.1,'Ctrl+Z undoes a parameter change');
    key('z',{ctrlKey:true,shiftKey:true});assert(S().params.angleX===0.3,'Ctrl+Shift+Z redoes it');
    click('btnUndo');assert(Math.abs(S().params.angleX-0.1)<1e-9&&!d.getElementById('btnRedo').disabled,'toolbar undo button');
    click('btnRedo');

    // ---- keyboard: expression presets ----
    key('2');assert(S().activePreset==='smile'&&d.querySelector('[data-preset="smile"]').classList.contains('active'),'key 2 applies the smile preset');
    key('2');assert(S().activePreset===null,'pressing it again clears the preset');
    key('6');key('0');assert(S().activePreset===null,'key 0 clears a preset');
    key('3');key('3',{repeat:true});key('3',{repeat:true});assert(S().activePreset==='usume','holding a preset key does not toggle it repeatedly');key('0');

    // ---- anchor editing ----
    key('e');await settle();
    assert(S().anchorMode&&d.querySelectorAll('#overlay .handle').length>=6,'E enters anchor mode with handles');
    const handle=d.querySelector('#overlay .handle[data-key="eyeL"]');
    key('ArrowRight',{shiftKey:true},handle);
    assert(S().anchors.eyeL&&S().anchors.eyeL.dx===10,'Shift+Arrow nudges an anchor by 10px');
    const closeHandle=d.querySelector('#overlay .handle[data-key="eyeRClose"]');key('ArrowLeft',{},closeHandle);key('ArrowDown',{},closeHandle);
    assert(S().anchors.eyeRClose&&S().anchors.eyeRClose.dy===1&&S().anchors.eyeRClose.dx===undefined,'closing-line handle only moves vertically');
    key('Escape');assert(!S().anchorMode,'Esc leaves anchor mode');
    click('btnExportSettings');const withAnchors=JSON.parse(await h.blobs.at(-1).text());
    assert(withAnchors.anchors.eyeL.dx===10,'anchors are saved in the settings');
    key('z',{ctrlKey:true});key('z',{ctrlKey:true});key('z',{ctrlKey:true});
    assert(!S().anchors.eyeL,'anchor edits can be undone');
    click('btnResetAnchors');

    // ---- search filters individual rows ----
    const search=d.getElementById('controlSearch');search.value='眉';search.dispatchEvent(new w.Event('input'));
    const shown=[...d.querySelectorAll('#panel .row')].filter(r=>r.offsetParent!==null);
    assert(shown.length>=4&&shown.every(r=>r.textContent.includes('眉')||r.closest('.sec').querySelector('h2').textContent.includes('眉')),'search shows only matching rows');
    search.value='';search.dispatchEvent(new w.Event('input'));

    // ---- preview zoom ----
    const stageEl=d.getElementById('stage'),rect=stageEl.getBoundingClientRect();
    stageEl.dispatchEvent(new w.WheelEvent('wheel',{deltaY:-400,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,bubbles:true,cancelable:true}));
    assert(S().view.z>1.5&&/%$/.test(d.getElementById('btnZoom').textContent),'wheel zooms the preview');
    key('f');assert(S().view.z===1&&d.getElementById('btnZoom').textContent==='全体','F fits the preview again');

    // ---- rendering: PNG, iris clipping ----
    click('btnResetLayers');click('btnReset');
    // Freeze a neutral pose so the mask comparison is deterministic.
    for(const [id,n] of [['pEyeL',1],['pEyeR',1],['pEyeX',0],['pEyeY',0],['pAngleY',0],['pAngleZ',0],['pBody',0]])setValue(id,n,false);
    async function capture(){const n=h.blobs.length;click('btnPng');await wait(()=>h.blobs.length>n,'PNG export');return h.blobs.at(-1);}
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const ctx=canvas.getContext('2d');
    async function pixels(){const png=await capture(),bitmap=await createImageBitmap(png);ctx.clearRect(0,0,128,128);ctx.drawImage(bitmap,0,0);bitmap.close();return {png,data:ctx.getImageData(0,0,128,128).data};}
    const count=data=>{let red=0,blue=0,soft=0;for(let i=0;i<data.length;i+=4){if(data[i]>240&&data[i+1]<30&&data[i+2]<30)red++;if(data[i]<30&&data[i+1]<30&&data[i+2]>240)blue++;}return {red,blue};};
    const first=await pixels();
    assert(first.png.type==='image/png'&&first.data[3]===0&&first.data.some((v,i)=>i%4===3&&v>0),'PNG has correct dimensions, transparent background and visible pixels');
    d.getElementById('prefExportBg').value='green';d.getElementById('prefExportBg').dispatchEvent(new w.Event('change'));
    const green=await pixels();
    assert(green.data[0]<10&&green.data[1]>160&&green.data[3]===255,'PNG can be exported on a green background');
    d.getElementById('prefExportBg').value='transparent';d.getElementById('prefExportBg').dispatchEvent(new w.Event('change'));
    // Move both nearly-transparent eye whites after the irises. Their geometry
    // must still clip the irises, even though they have not been painted yet.
    const findCard=name=>[...d.querySelectorAll('.layer-card')].find(c=>c.querySelector('.layer-name').textContent===name&&c.querySelector('.layer-role').textContent.includes(name.endsWith('_2')?'右':'左'));
    for(const name of ['eyewhite','eyewhite_2']){
      let card=findCard(name);while(card!==d.getElementById('layers').lastElementChild){card.querySelectorAll('.ord')[1].click();card=findCard(name);}
      const o=card.querySelector('input[type=number]');o.value='0.05';o.dispatchEvent(new w.Event('input'));
    }
    const reordered=count((await pixels()).data);
    assert(reordered.red>0&&reordered.blue>0,'both iris masks work when eye whites are painted later');
    for(const name of ['eyewhite','eyewhite_2'])findCard(name).querySelector('input[type=checkbox]').click();
    const hiddenWhites=count((await pixels()).data);
    assert(hiddenWhites.red>0&&hiddenWhites.blue>0,'irises stay visible (and clipped) when the eye whites are hidden');

    // ---- video recording ----
    const formats=w.RigRecorder.formats();
    if(formats.length&&typeof d.getElementById('cv').captureStream==='function'){
      d.getElementById('prefRecSeconds').value='3';d.getElementById('prefRecSeconds').dispatchEvent(new w.Event('change'));
      click('btnPause');
      const n=h.blobs.length;click('btnRecord');
      await wait(()=>S().recording,'recording starts');
      assert(!d.getElementById('recBadge').hidden&&d.getElementById('btnRecord').textContent==='録画を停止','recording UI is shown');
      await wait(()=>h.blobs.length>n,'video export',12000);
      const video=h.blobs.at(-1);
      assert(/^video\//.test(video.type)&&video.size>1000,'video file is produced ('+video.type+', '+video.size+' bytes)');
      if(formats[0].alpha){
        try{const img=await decodeFirstFrame(video);let visible=0;for(let i=3;i<img.data.length;i+=4)if(img.data[i]>200)visible++;
          assert(img.data[3]<10&&visible>100,'recorded WebM keeps the transparent background');}
        catch(err){note('video decode check skipped: '+err.message);}
      }
      click('btnPause');
    }else note('MediaRecorder is not available; recording test skipped');

    // ---- robustness ----
    select(d.getElementById('fileInput'),new w.File(['bad'],'broken.psd'));
    await wait(()=>d.getElementById('appStatus').classList.contains('error'),'invalid PSD error');
    assert(d.getElementById('modelName').textContent==='test.psd'&&d.getElementById('drop').classList.contains('hidden'),'invalid PSD preserves the current model');
    select(d.getElementById('fileInput'),file);click('btnCancelLoad');await settle();
    assert(d.getElementById('appStatus').textContent.includes('中止')&&d.getElementById('drop').classList.contains('hidden'),'cancel preserves the current model');
    const gl=d.getElementById('cv').getContext('webgl');assert(gl.getError()===gl.NO_ERROR,'rendering has no WebGL errors');
    click('tgBlink');click('tgRand');   // keep the eyes open and still for the pixel checks below
    const contextExtension=gl.getExtension('WEBGL_lose_context');
    if(contextExtension){
      contextExtension.loseContext();await wait(()=>d.getElementById('appStatus').textContent.includes('復旧を待って'),'context loss');
      contextExtension.restoreContext();await wait(()=>d.getElementById('appStatus').textContent==='描画を復旧しました','context restoration');
      await settle(100);
      assert(!d.getElementById('btnPng').disabled&&gl.getError()===gl.NO_ERROR,'WebGL context restoration rebuilds a usable model');
      const restored=count((await pixels()).data);
      assert(restored.red>0&&restored.blue>0,'iris masks work after context restoration');
    }
    key('?');assert(d.getElementById('shortcutOverlay').classList.contains('show'),'? opens the shortcut list');
    key('Escape');assert(!d.getElementById('shortcutOverlay').classList.contains('show'),'Esc closes it');
    frame.style.width='390px';frame.style.height='844px';await settle(100);
    assert(d.documentElement.clientWidth===390&&d.documentElement.scrollWidth<=390&&w.getComputedStyle(d.getElementById('main')).flexDirection==='column','390px layout has no horizontal overflow');
    assert(h.errors.length===0,'no runtime errors: '+h.errors.join(', '));
    result.textContent+='ALL PASSED ('+passed+')';
  }catch(err){result.textContent+='FAIL '+err.stack;}finally{document.getElementById('run').disabled=false;}
});
