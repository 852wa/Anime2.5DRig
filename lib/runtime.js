/* Shared, browser-independent validation and simulation helpers. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RigRuntime = factory();
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';
  const MAX_FILE_BYTES = 128 * 1024 * 1024;
  const SETTINGS_FORMAT = 'anime25d-settings';
  const SETTINGS_VERSION = 2;
  const PRESETS = ['neutral','smile','usume','surprise','jito','winkL','winkR'];
  const AUTO_KEYS = ['idle','blink','rand','talk','mouse','phys'];
  const BACKGROUNDS = ['checker','green','dark'];
  // Editable anchor offsets (PSD pixels) and the axes each one may move.
  const ANCHOR_KEYS = {face:['dx','dy'],eyeL:['dx','dy'],eyeR:['dx','dy'],eyeLClose:['dy'],eyeRClose:['dy'],mouth:['dx','dy'],neck:['dx','dy'],chest:['dx','dy']};
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isNum = v => typeof v === 'number' && Number.isFinite(v);

  function validateHeader(buffer) {
    if (!buffer || buffer.byteLength < 26) throw new Error('PSDファイルが短すぎます');
    if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('PSDは128MB以下にしてください');
    const v = new DataView(buffer);
    if (v.getUint32(0) !== 0x38425053 || v.getUint16(4) !== 1) throw new Error('対応するPSDファイルではありません（PSBは未対応）');
    const h = v.getUint32(14), w = v.getUint32(18);
    if (w < 2 || h < 2 || w*h > 24000000 || Math.max(w,h) > 16384) throw new Error('PSDのサイズは一辺16384px・2400万画素以内にしてください');
    if (v.getUint16(22) !== 8 || v.getUint16(24) !== 3) throw new Error('PSDをRGB・8bit/チャンネルで保存し直してください');
    return {w,h};
  }
  function fingerprint(buffer) {
    const b = new Uint8Array(buffer); let a = 2166136261, c = 5381;
    for (let i=0; i<b.length; i++) { a = Math.imul(a ^ b[i], 16777619); c = Math.imul(c, 33) ^ b[i]; }
    return b.length.toString(16)+'-'+(a>>>0).toString(16)+'-'+(c>>>0).toString(16);
  }
  function meshSize(w,h,cell) {
    let nx=Math.max(2,Math.round(w/cell)), ny=Math.max(2,Math.round(h/cell));
    while ((nx+1)*(ny+1)>65000) {
      if(nx>=ny) nx=Math.max(2,Math.floor(nx*0.9)); else ny=Math.max(2,Math.floor(ny*0.9));
    }
    return {nx,ny};
  }
  // Semi-implicit Euler with fixed 120 Hz sub-steps: stable from 10 to 240 fps.
  function spring(s,target,k,damping,dt) {
    const count=Math.max(1,Math.ceil(dt/(1/120))), h=dt/count;
    for(let i=0;i<count;i++){ s.v+=(-k*(s.x-target)-damping*s.v)*h; s.x+=s.v*h; }
  }

  // ---- face tracking relay ----
  const trackingKeys={ax:[-1,1],ay:[-1,1],az:[-1,1],eL:[0,1],eR:[0,1],mo:[0,1],ex:[-1,1],ey:[-1,1]};
  const optionalTrackingKeys={br:[-1,1],mf:[-1,1],mic:[0,1]};
  function tracking(value) {
    if(!value || typeof value!=='object' || typeof value.live!=='boolean') return null;
    const out={live:value.live};
    for(const [key,range] of Object.entries(trackingKeys)) {
      if(!isNum(value[key]))return null;
      out[key]=clamp(value[key],...range);
    }
    for(const [key,range] of Object.entries(optionalTrackingKeys)) {
      if(value[key]===undefined) continue;
      if(!isNum(value[key]))return null;
      out[key]=clamp(value[key],...range);
    }
    return out;
  }

  // ---- per-model settings ----
  function anchors(value, limit) {
    const out={};
    if(value==null) return out;
    if(typeof value!=='object' || Array.isArray(value)) throw new Error('アンカー設定が不正です');
    const lim=isNum(limit)&&limit>0?limit:16384;
    for(const [key,axes] of Object.entries(ANCHOR_KEYS)) {
      const rec=value[key];
      if(rec==null) continue;
      if(typeof rec!=='object') throw new Error('アンカー設定が不正です: '+key);
      const clean={};
      for(const axis of axes) {
        if(rec[axis]===undefined) continue;
        if(!isNum(rec[axis])) throw new Error('アンカー設定が不正です: '+key);
        const n=clamp(rec[axis],-lim,lim);
        if(n!==0) clean[axis]=Math.round(n*100)/100;
      }
      if(Object.keys(clean).length) out[key]=clean;
    }
    return out;
  }
  function settings(value,modelId,ranges,layerIds,defaults,options) {
    const opts=options||{};
    if (!value || value.format!==SETTINGS_FORMAT || !(value.version===1 || value.version===2)) throw new Error('対応する設定ファイルではありません');
    if (!opts.anyModel && value.modelId!==modelId) throw new Error('別のPSD用の設定です。保存時と同じPSDを読み込んでください');
    if(!value.params || typeof value.params!=='object' || !Array.isArray(value.layers)) throw new Error('設定の構造が不正です');
    const out={params:{},auto:{},layers:[],background:'checker',preset:null,anchors:{},missingLayers:0,unknownLayers:0};
    if(PRESETS.includes(value.preset))out.preset=value.preset;
    for(const [key,range] of Object.entries(ranges)) {
      const n=value.params[key];
      if(n===undefined){ if(defaults&&isNum(defaults[key]))out.params[key]=clamp(defaults[key],...range); continue; }
      if(!isNum(n)) throw new Error('数値設定が不正です: '+key);
      out.params[key]=clamp(n,...range);
    }
    for(const key of AUTO_KEYS) {
      const v=value.auto?.[key];
      if(v===undefined) continue;
      if(typeof v!=='boolean') throw new Error('自動動作の設定が不正です');
      out.auto[key]=v;
    }
    const known=new Set(layerIds), seen=new Set();
    for(const l of value.layers) {
      if(!l || typeof l.id!=='string' || seen.has(l.id) || typeof l.visible!=='boolean' ||
        !isNum(l.opacity) || !isNum(l.depth)) throw new Error('レイヤー設定が不正です');
      seen.add(l.id);
      if(!known.has(l.id)){out.unknownLayers++;continue;}
      out.layers.push({id:l.id,visible:l.visible,opacity:clamp(l.opacity,0,1),depth:clamp(l.depth,0,2)});
    }
    out.missingLayers=layerIds.filter(id=>!seen.has(id)).length;
    if(BACKGROUNDS.includes(value.background))out.background=value.background;
    out.anchors=anchors(value.anchors,opts.anchorLimit);
    return out;
  }
  // Merge a saved layer order into the current layer list. Layers the saved
  // file does not mention keep their default neighbours.
  function mergeLayerOrder(defaultIds, savedIds) {
    const saved=savedIds.filter(id=>defaultIds.includes(id));
    const out=saved.slice();
    defaultIds.forEach((id,i)=>{
      if(out.includes(id)) return;
      let at=0;
      for(let j=i-1;j>=0;j--){const k=out.indexOf(defaultIds[j]); if(k>=0){at=k+1;break;}}
      out.splice(at,0,id);
    });
    return out;
  }

  // ---- global preferences (per browser, not per model) ----
  // schema: {key: [min,max,default] | ['bool',default] | ['enum',[...],default]}
  function prefs(value, schema) {
    const out={};
    const src=value&&typeof value==='object'?value:{};
    for(const [key,spec] of Object.entries(schema)) {
      const v=src[key];
      if(spec[0]==='bool') out[key]=typeof v==='boolean'?v:spec[1];
      else if(spec[0]==='enum') out[key]=spec[1].includes(v)?v:spec[2];
      else if(spec[0]==='any') out[key]=v===undefined?spec[1]:v;
      else out[key]=isNum(v)?clamp(v,spec[0],spec[1]):spec[2];
    }
    return out;
  }

  // ---- undo / redo over serialized snapshots ----
  function createHistory(limit) {
    const max=Math.max(2,limit||100);
    let stack=[], index=-1;
    return {
      reset(snap){stack=[snap];index=0;},
      push(snap){
        if(index>=0&&stack[index]===snap)return false;
        stack=stack.slice(0,index+1);stack.push(snap);
        if(stack.length>max)stack.shift();
        index=stack.length-1;return true;
      },
      undo(){return index>0?stack[--index]:null;},
      redo(){return index<stack.length-1?stack[++index]:null;},
      current(){return index>=0?stack[index]:null;},
      get canUndo(){return index>0;},
      get canRedo(){return index<stack.length-1;},
      get size(){return stack.length;}
    };
  }

  // ---- misc ----
  // Relative same-origin file reference for ?model= / ?settings= parameters.
  function safeRelativePath(p, ext) {
    if(typeof p!=='string' || !p || p.length>260) return null;
    if(/[\u0000-\u001f\\:?#%]/.test(p) || p.startsWith('/') || p.split('/').some(seg=>seg==='..'||seg==='.'||seg==='')) return null;
    if(ext && !p.toLowerCase().endsWith(ext)) return null;
    return p;
  }
  function safeFileName(name, fallback) {
    const base=String(name||'').replace(/\.[a-z0-9]{1,5}$/i,'').replace(/[\u0000-\u001f<>:"/\\|?*]+/g,'_').trim().slice(0,80);
    return base||fallback||'model';
  }
  function formatTime(seconds) {
    const s=Math.max(0,seconds);
    return (s<10?s.toFixed(1):Math.round(s))+'秒';
  }

  return {MAX_FILE_BYTES,SETTINGS_FORMAT,SETTINGS_VERSION,PRESETS,AUTO_KEYS,BACKGROUNDS,ANCHOR_KEYS,
    validateHeader,fingerprint,meshSize,spring,tracking,settings,anchors,mergeLayerOrder,prefs,createHistory,
    safeRelativePath,safeFileName,formatTime,clamp};
});
