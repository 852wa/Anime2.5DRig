'use strict';
function installMocks() {
  const pending=[],blobs=[],errors=[],memory=new Map();
  window.harness={pending,blobs,errors,closedAudio:0,closedFace:0,holdVideo:false};
  window.addEventListener('error',e=>errors.push(e.message));
  window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
  Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)}});
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
const wait=async(predicate,label,timeout=10000)=>{const start=performance.now();while(!predicate()){if(performance.now()-start>timeout)throw new Error('Timeout: '+label);await new Promise(r=>setTimeout(r,20));}};
function assert(condition,label){if(!condition)throw new Error(label);result.textContent+='PASS '+label+'\n';}
document.getElementById('run').addEventListener('click',async()=>{
  document.getElementById('run').disabled=true;result.textContent='';
  try{
    const html=await (await fetch('../index.html')).text(),frame=document.createElement('iframe');
    frame.srcdoc=html.replace('<head>','<head><base href="'+new URL('../',location.href).href+'"><script>('+installMocks.toString()+')();<\/script>');
    document.getElementById('frame').replaceChildren(frame);
    await new Promise(r=>frame.addEventListener('load',r,{once:true}));
    const w=frame.contentWindow,d=w.document,h=w.harness;
    await wait(()=>d.getElementById('tgMic').tagName==='BUTTON','application initialization');
    const click=id=>d.getElementById(id).click();
    const settle=()=>new Promise(r=>setTimeout(r,40));
    const stream=()=>{const track=d.createElement('canvas').captureStream(0).getTracks()[0];return {track,media:new w.MediaStream([track])};};
    click('tgMic');click('tgMic');const lateMic=stream();h.pending.shift().resolve(lateMic.media);await settle();
    assert(lateMic.track.readyState==='ended','microphone permission arriving after OFF releases its track');
    click('tgMic');const mic=stream();h.pending.shift().resolve(mic.media);await wait(()=>d.getElementById('tgMic').textContent==='マイク使用中','mic starts');click('tgMic');await settle();
    assert(mic.track.readyState==='ended'&&h.closedAudio===1,'microphone OFF closes stream and audio context');
    click('tgCam');click('tgCam');const lateCam=stream();h.pending.shift().resolve(lateCam.media);await settle();
    assert(lateCam.track.readyState==='ended','camera permission arriving after OFF releases its track');
    h.holdVideo=true;click('tgCam');const waitingCam=stream();h.pending.shift().resolve(waitingCam.media);await wait(()=>h.releaseVideo,'video initialization');click('tgCam');h.releaseVideo();await settle();h.holdVideo=false;
    assert(waitingCam.track.readyState==='ended','camera OFF during video initialization cancels the stream');
    click('tgCam');const cam=stream();h.pending.shift().resolve(cam.media);await wait(()=>d.getElementById('tgCam').textContent==='カメラ追従中','cam starts');click('tgCam');await settle();
    assert(cam.track.readyState==='ended'&&h.closedFace===1,'camera OFF closes stream and face model');
    function part(name,left,top,width,height,color){const data=new w.Uint8ClampedArray(width*height*4);for(let i=0;i<data.length;i+=4)data.set(color,i);return{name,left,top,right:left+width,bottom:top+height,imageData:{width,height,data}};}
    const psd={width:128,height:128,children:[part('face',20,10,88,95,[230,160,130,255]),part('eyewhite',30,42,20,12,[255,255,255,255]),part('eyewhite_2',78,42,20,12,[255,255,255,255]),part('irides',35,44,10,8,[255,0,0,255]),part('irides_2',83,44,10,8,[0,0,255,255]),part('mouth_open',53,77,22,8,[120,25,55,255]),part('<img src=x onerror=alert(1)>',1,1,10,10,[255,255,0,255])]};
    const file=new w.File([w.agPsd.writePsd(psd,{generateThumbnail:false})],'test.psd');
    function select(input,file){const dt=new w.DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new w.Event('change'));}
    select(d.getElementById('fileInput'),file);
    await wait(()=>d.getElementById('drop').classList.contains('hidden'),'worker import');
    assert(!d.querySelector('#layers img')&&d.querySelector('#layers').textContent.includes('<img'),'layer names are displayed as text');
    click('btnPause');
    const value=d.querySelector('#pAngleX').parentElement.querySelector('.val');value.value='0.42';value.dispatchEvent(new w.Event('input'));
    const opacity=d.querySelector('.layer-card input[type=number]');opacity.value='0.65';opacity.dispatchEvent(new w.Event('input'));
    const visible=d.querySelector('.layer-card input[type=checkbox]');visible.click();
    click('btnSaveSettings');value.value='-0.8';value.dispatchEvent(new w.Event('input'));click('btnResetLayers');click('btnRestoreSettings');
    assert(d.getElementById('pAngleX').value==='0.42'&&!d.querySelector('.layer-card input[type=checkbox]').checked&&d.querySelector('.layer-card input[type=number]').value==='0.65','settings restore parameters and layer properties');
    click('btnExportSettings');const json=h.blobs.at(-1);assert(json.type==='application/json','settings JSON export');
    select(d.getElementById('settingsInput'),new w.File([await json.text()],'settings.json'));await wait(()=>d.getElementById('appStatus').textContent.includes('設定を読み込みました'),'settings import');
    click('btnResetLayers');click('btnReset');
    // Freeze a neutral pose so the mask comparison is deterministic.
    for(const [id,n] of [['pEyeL',1],['pEyeR',1],['pEyeX',0],['pEyeY',0],['pAngleY',0],['pAngleZ',0],['pBody',0]]){const input=d.querySelector('#'+id).parentElement.querySelector('.val');input.value=String(n);input.dispatchEvent(new w.Event('input'));}
    async function capture(){const n=h.blobs.length;click('btnPng');await wait(()=>h.blobs.length>n,'PNG export');return h.blobs.at(-1);}
    const png=await capture(),bitmap=await createImageBitmap(png),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const pixels=ctx.getImageData(0,0,128,128).data;bitmap.close();
    assert(png.type==='image/png'&&canvas.width===128&&pixels[3]===0&&pixels.some((v,i)=>i%4===3&&v>0),'PNG has correct dimensions, transparent background and visible pixels');
    // Move both nearly-transparent eye whites after the irises. Their geometry
    // must still clip the irises, even though they have not been painted yet.
    for(const name of ['eyewhite_l','eyewhite_2_r']){
      const find=()=>[...d.querySelectorAll('.layer-card')].find(c=>c.querySelector('.layer-name').textContent===name);
      let card=find();while(card!==d.getElementById('layers').lastElementChild){card.querySelectorAll('.ord')[1].click();card=find();}
      const opacity=card.querySelector('input[type=number]');opacity.value='0.05';opacity.dispatchEvent(new w.Event('input'));
    }
    const png2=await capture(),bitmap2=await createImageBitmap(png2);ctx.clearRect(0,0,128,128);ctx.drawImage(bitmap2,0,0);bitmap2.close();
    const reordered=ctx.getImageData(0,0,128,128).data;let red=0,blue=0;
    for(let i=0;i<reordered.length;i+=4){if(reordered[i]>240&&reordered[i+1]<30&&reordered[i+2]<30)red++;if(reordered[i]<30&&reordered[i+1]<30&&reordered[i+2]>240)blue++;}
    assert(red>0&&blue>0,'both iris masks work when eye whites are painted later');
    select(d.getElementById('fileInput'),new w.File(['bad'],'broken.psd'));
    await wait(()=>d.getElementById('appStatus').classList.contains('error'),'invalid PSD error');
    assert(d.getElementById('modelName').textContent==='test.psd'&&d.getElementById('drop').classList.contains('hidden'),'invalid PSD preserves the current model');
    select(d.getElementById('fileInput'),file);click('btnCancelLoad');await settle();
    assert(d.getElementById('appStatus').textContent.includes('中止')&&d.getElementById('drop').classList.contains('hidden'),'cancel preserves the current model');
    const gl=d.getElementById('cv').getContext('webgl');assert(gl.getError()===gl.NO_ERROR,'rendering has no WebGL errors');
    const contextExtension=gl.getExtension('WEBGL_lose_context');
    if(contextExtension){
      contextExtension.loseContext();await wait(()=>d.getElementById('appStatus').textContent.includes('復旧を待って'),'context loss');
      contextExtension.restoreContext();await wait(()=>d.getElementById('appStatus').textContent==='描画を復旧しました','context restoration');
      assert(!d.getElementById('btnPng').disabled&&gl.getError()===gl.NO_ERROR,'WebGL context restoration rebuilds a usable model');
    }
    frame.style.width='390px';frame.style.height='844px';await settle();
    assert(d.documentElement.clientWidth===390&&d.documentElement.scrollWidth<=390&&w.getComputedStyle(d.getElementById('main')).flexDirection==='column','390px layout has no horizontal overflow');
    assert(h.errors.length===0,'no runtime errors: '+h.errors.join(', '));
    result.textContent+='ALL PASSED';
  }catch(err){result.textContent+='FAIL '+err.stack;}finally{document.getElementById('run').disabled=false;}
});
