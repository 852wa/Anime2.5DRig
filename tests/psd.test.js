'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),ag=require('../lib/ag-psd.min.js'),R=require('../lib/rigger.js'),GP=require('../lib/genericparts.js');
ag.initializeCanvas(undefined,(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));
const messages=[];
const scope={agPsd:ag,Rigger:R,RigRuntime:require('../lib/runtime.js'),Uint8Array,Uint8ClampedArray,ArrayBuffer,Set,importScripts(){},postMessage(msg){messages.push(msg);}};
vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(root,'lib/psd-worker.js'),'utf8'),scope);
for(const file of ['sample.psd','sample2.psd']){
  const bytes=fs.readFileSync(path.join(root,file));messages.length=0;
  scope.onmessage({data:{buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),generic:{eyeL:GP.get('eyeL'),eyeR:GP.get('eyeR'),mouth:GP.get('mouth')}}});
  const result=messages.at(-1);assert.ok(!result.error,result.error);assert.ok(messages.some(m=>m.progress));
  const {rig,psd}=result;assert.ok(rig.layers.length>=14);assert.ok(rig.anchors.eyeL&&rig.anchors.eyeR);
  for(const layer of rig.layers)assert.equal(layer.img.data.length,layer.w*layer.h*4);
  const exported=ag.writePsd(psd,{generateThumbnail:false});
  const reread=ag.readPsd(new Uint8Array(exported),{useImageData:true,skipThumbnail:true});
  const preview=reread.imageData.data;
  assert.equal(reread.imageData.width,psd.width);
  assert.equal(reread.imageData.height,psd.height);
  let visible=0;for(let i=3;i<preview.length;i+=4)if(preview[i]>0)visible++;
  assert.ok(visible>100,'the merged preview must not become empty after export');
  assert.equal(R.buildRig(reread).layers.length,R.buildRig(psd).layers.length);
  console.log(file+': worker import, finite anchors, cleaned PSD round-trip passed ('+rig.layers.length+' parts)');
}
messages.length=0;scope.onmessage({data:{buffer:new ArrayBuffer(1)}});assert.ok(messages.at(-1).error);
