'use strict';
importScripts('ag-psd.min.js','rigger.js','runtime.js');
agPsd.initializeCanvas(undefined,(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));
onmessage = function(ev) {
  try {
    const {buffer,generic}=ev.data;
    RigRuntime.validateHeader(buffer);
    postMessage({progress:'レイヤー構成を確認中…'});
    const options={useImageData:true,skipThumbnail:true,skipCompositeImageData:true};
    Rigger.validatePsd(agPsd.readPsd(new Uint8Array(buffer),{...options,skipLayerImageData:true}));
    postMessage({progress:'画像を展開中…'});
    const psd=agPsd.readPsd(new Uint8Array(buffer),{...options,skipCompositeImageData:false});
    postMessage({progress:'ノイズを除去中…'});
    const pre=Rigger.cleanPsdLayers(psd);
    postMessage({progress:'パーツ・アンカーを生成中…'});
    const rig=Rigger.buildRig(psd,{generic});
    const transfers=new Set();
    function collect(v) {
      if(!v || typeof v!=='object')return;
      if(ArrayBuffer.isView(v)){transfers.add(v.buffer);return;}
      for(const x of Object.values(v))collect(x);
    }
    collect(psd); collect(rig);
    postMessage({psd,pre,rig},[...transfers]);
  } catch(err) { postMessage({error:err.message || String(err)}); }
};
