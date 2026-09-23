/*!
 * Anime2.5DRig — obs-sync.js
 * Keeps the OBS view (?obs=1) in step with the editing browser.
 *  - tracking: camera / microphone values, ~25 Hz (BroadcastChannel + local relay)
 *  - state:    parameters, expression, layers, anchors (settings snapshot)
 *  - model:    the PSD itself, so OBS shows whatever the editor opened
 * The relay endpoints only exist when the page is served by obs_server.py.
 * MIT License
 */
(function(root){
'use strict';
const RELAY_V1='anime25d-tracking-v1', RELAY_V2='anime25d-relay-v2';

function create(options){
  const o=Object.assign({obsMode:false,onTracking:null,onState:null,onModel:null,onStatus:null,validateTracking:null},options);
  const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('anime25d-camera'):null;
  const localHost=['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&location.protocol.startsWith('http');
  let uploadController=null,uploadToken=0;
  const st={relay:false,features:[],viewers:0,serverModel:null,uploading:false,uploaded:null,error:null,enabled:true};
  let events=null,trackingBusy=false,lastTrackingAt=0,stateTimer=null,pendingState=null,stateBusy=false;
  let modelCopy=null,pollTimer=null,closed=false;

  function emit(){o.onStatus&&o.onStatus(Object.assign({},st));}
  function has(feature){return st.relay&&st.features.includes(feature);}
  async function probe(){
    if(!localHost||typeof fetch==='undefined'){emit();return st;}
    try{
      const r=await fetch('/relay-info',{cache:'no-store'});
      const info=r.ok?await r.json():null;
      if(info&&info.protocol===RELAY_V2){st.relay=true;st.features=Array.isArray(info.features)?info.features:[];st.viewers=info.viewers|0;st.serverModel=info.model||null;}
      else if(info&&info.protocol===RELAY_V1){st.relay=true;st.features=['tracking'];}
      else st.relay=false;
      st.error=null;
    }catch(err){st.relay=false;st.error=err.message;}
    emit();return st;
  }
  const ready=probe();

  // ---------- OBS side ----------
  function listen(){
    if(channel)channel.onmessage=ev=>{
      const m=ev.data;if(!m||typeof m!=='object')return;
      if(!Number.isFinite(m.at)||Math.abs(Date.now()-m.at)>2000)return;
      if(m.type==='face'&&o.onTracking)o.onTracking(m.cam);
      else if(m.type==='state'&&o.onState)o.onState(m.state);
    };
    ready.then(()=>{
      if(!st.relay||closed)return;
      events=new EventSource('/tracking-events');
      events.onmessage=ev=>{try{o.onTracking&&o.onTracking(JSON.parse(ev.data));}catch(err){}};
      events.addEventListener('state',ev=>{try{o.onState&&o.onState(JSON.parse(ev.data));}catch(err){}});
      events.addEventListener('model',ev=>{try{o.onModel&&o.onModel(JSON.parse(ev.data));}catch(err){}});
      events.onerror=()=>{o.onTracking&&o.onTracking(null);};
    });
  }
  async function fetchModel(){
    const r=await fetch('/model/current',{cache:'no-store'});
    if(!r.ok)throw new Error('OBS用のモデルがまだ送られていません');
    let name='model.psd';
    try{name=decodeURIComponent(r.headers.get('X-Model-Name')||'')||name;}catch(err){}
    return {buffer:await r.arrayBuffer(),name,id:r.headers.get('X-Model-Id')||''};
  }
  async function fetchState(){
    const r=await fetch('/state/current',{cache:'no-store'});
    return r.status===200?r.json():null;
  }

  // ---------- editor side ----------
  function publishTracking(clean,force){
    if(o.obsMode||!clean)return;
    const now=performance.now();if(!force&&now-lastTrackingAt<40)return;lastTrackingAt=now;
    channel&&channel.postMessage({type:'face',cam:clean,at:Date.now()});
    if(!has('tracking')||trackingBusy||!st.enabled)return;
    trackingBusy=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
    fetch('/tracking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(clean),signal:controller.signal})
      .catch(()=>{}).finally(()=>{clearTimeout(timer);trackingBusy=false;});
  }
  // Throttled (not debounced): a continuous slider drag still reaches OBS every 120 ms.
  function publishState(state,immediate){
    if(o.obsMode||!state)return;
    pendingState=state;
    if(immediate){clearTimeout(stateTimer);stateTimer=setTimeout(flushState,0);}
    else if(!stateTimer)stateTimer=setTimeout(flushState,120);
  }
  async function flushState(){
    stateTimer=null;
    if(!pendingState)return;
    const state=pendingState;
    channel&&channel.postMessage({type:'state',state,at:Date.now()});
    if(!has('state')||!st.enabled)return;
    if(stateBusy){stateTimer=setTimeout(flushState,120);return;}
    pendingState=null;stateBusy=true;
    try{await fetch('/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});}
    catch(err){}finally{stateBusy=false;}
  }
  function canUploadModel(){return !o.obsMode&&has('model')&&st.enabled;}
  // Remembers the latest model even when it cannot be sent yet (sync off, relay
  // down); a newer upload aborts an older one so OBS always ends on the latest.
  async function publishModel(buffer,name,id){
    modelCopy={buffer,name,id};
    if(!canUploadModel())return false;
    uploadController&&uploadController.abort();
    const controller=uploadController=new AbortController(),token=++uploadToken;
    st.uploading=true;emit();
    try{
      const r=await fetch('/model',{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Model-Name':encodeURIComponent(name),'X-Model-Id':id},body:buffer,signal:controller.signal});
      if(!r.ok)throw new Error('HTTP '+r.status);
      if(token===uploadToken){st.uploaded=id;st.serverModel={id,name};st.error=null;}
    }catch(err){if(token===uploadToken&&err.name!=='AbortError')st.error='OBSへモデルを送れません: '+err.message;}
    finally{if(token===uploadToken){st.uploading=false;uploadController=null;emit();}}
    return token===uploadToken&&!st.error;
  }
  // The relay keeps the model in memory; if it restarts, send ours again.
  function startPolling(){
    if(o.obsMode||pollTimer)return;
    pollTimer=setInterval(async()=>{
      const before=st.relay;await probe();
      if(!st.relay||!modelCopy||!st.enabled||st.uploading)return;
      // Re-send only when the relay lost its model (restart); never fight another editor tab.
      const serverId=st.serverModel&&st.serverModel.id;
      if(!serverId||!before)publishModel(modelCopy.buffer,modelCopy.name,modelCopy.id);
    },5000);
  }
  function setEnabled(value){
    st.enabled=!!value;emit();
    if(st.enabled&&modelCopy&&st.serverModel?.id!==modelCopy.id)publishModel(modelCopy.buffer,modelCopy.name,modelCopy.id);
  }
  function close(){closed=true;clearInterval(pollTimer);clearTimeout(stateTimer);events&&events.close();channel&&channel.close();}

  return {ready,probe,listen,fetchModel,fetchState,publishTracking,publishState,publishModel,canUploadModel,startPolling,setEnabled,close,mayRelay:localHost,
    get status(){return Object.assign({},st);}};
}
root.ObsSync={create};
})(typeof self!=='undefined'?self:this);
