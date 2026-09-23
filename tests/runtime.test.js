'use strict';
const assert=require('node:assert/strict');
const RT=require('../lib/runtime.js');
const b=new ArrayBuffer(26),v=new DataView(b);
v.setUint32(0,0x38425053);v.setUint16(4,1);v.setUint32(14,768);v.setUint32(18,768);v.setUint16(22,8);v.setUint16(24,3);
assert.deepEqual(RT.validateHeader(b),{w:768,h:768});
assert.throws(()=>RT.validateHeader(new ArrayBuffer(10)),/短すぎ/);
v.setUint16(22,16);assert.throws(()=>RT.validateHeader(b),/8bit/);v.setUint16(22,8);
v.setUint32(14,30000);assert.throws(()=>RT.validateHeader(b),/サイズ/);
for(const [w,h] of [[100,100],[500,30000],[2,3000000],[3000000,2]]){
  const {nx,ny}=RT.meshSize(w,h,18);assert.ok((nx+1)*(ny+1)<=65536);assert.ok(nx>=2&&ny>=2);
}
function simulate(fps){const s={x:0,v:0};for(let i=0;i<fps*10;i++)RT.spring(s,20,140,4.2,1/fps);return s;}
for(const fps of [10,20,30,60,144]){const s=simulate(fps);assert.ok(Math.abs(s.x-20)<0.01);assert.ok(Math.abs(s.v)<0.01);}
const camera={live:false,ax:4,ay:0,az:0,eL:1,eR:1,mo:0,ex:0,ey:0};
assert.equal(RT.tracking(camera).live,false);assert.equal(RT.tracking(camera).ax,1);
assert.equal(RT.tracking({...camera,mo:NaN}),null);assert.equal(RT.tracking({...camera,mo:'0'}),null);
const settings={format:'anime25d-settings',version:1,modelId:'test',params:{angleX:0.4},auto:{idle:true,blink:true,rand:false,talk:false,mouse:false,phys:true},background:'green',layers:[{id:'a',visible:false,opacity:0.6,depth:1.4}]};
const cleaned=RT.settings(settings,'test',{angleX:[-1,1]},['a']);assert.equal(cleaned.layers[0].opacity,0.6);assert.equal(cleaned.background,'green');
assert.throws(()=>RT.settings(settings,'other',{angleX:[-1,1]},['a']),/別のPSD/);
assert.throws(()=>RT.settings({...settings,params:{angleX:Infinity}},'test',{angleX:[-1,1]},['a']),/数値/);
assert.throws(()=>RT.settings({...settings,layers:[settings.layers[0],settings.layers[0]]},'test',{angleX:[-1,1]},['a','b']),/レイヤー/);
// Optional tracking channels (brow, mouth form, microphone) are validated when present.
assert.equal(RT.tracking({...camera,br:3}).br,1);assert.equal(RT.tracking({...camera,mic:'x'}),null);
assert.equal(RT.tracking({...camera}).br,undefined);assert.equal(RT.tracking(null),null);
// Version 1 files still load; missing parameters fall back to defaults; unknown layers are skipped.
const lenient=RT.settings({...settings,params:{}},'test',{angleX:[-1,1],bust:[0,4]},['a','b'],{angleX:0,bust:2.5});
assert.equal(lenient.params.bust,2.5);assert.equal(lenient.missingLayers,1);
const v2=RT.settings({...settings,version:2,layers:[...settings.layers,{id:'gone',visible:true,opacity:1,depth:1}],anchors:{eyeL:{dx:3,dy:-2},eyeLClose:{dx:9,dy:4},mouth:{dy:1e9},bogus:{dx:1}}},'test',{angleX:[-1,1]},['a'],{},{anchorLimit:500});
assert.equal(v2.unknownLayers,1);assert.deepEqual(v2.anchors,{eyeL:{dx:3,dy:-2},eyeLClose:{dy:4},mouth:{dy:500}});
assert.throws(()=>RT.anchors({eyeL:{dx:NaN}}),/アンカー/);assert.throws(()=>RT.anchors([1]),/アンカー/);
assert.throws(()=>RT.settings({...settings,version:3},'test',{},['a']),/対応/);
assert.equal(RT.settings(settings,'other',{angleX:[-1,1]},['a'],{}, {anyModel:true}).params.angleX,0.4);
assert.deepEqual(RT.mergeLayerOrder(['a','b','c','d'],['c','a','x']),['c','d','a','b']);
assert.deepEqual(RT.mergeLayerOrder(['a','b','c'],['c','a']),['c','a','b']);
assert.deepEqual(RT.mergeLayerOrder(['a','b','c'],['c','b']),['a','c','b']);
// Preferences: unknown keys dropped, numbers clamped, enums checked.
assert.deepEqual(RT.prefs({gain:9,link:'x',mode:'b',junk:1},{gain:[0,2,1],link:['bool',true],mode:['enum',['a','b'],'a']}),{gain:2,link:true,mode:'b'});
// Undo history.
const h=RT.createHistory(3);h.reset('0');h.push('1');h.push('1');h.push('2');h.push('3');
assert.equal(h.size,3);assert.equal(h.undo(),'2');assert.equal(h.undo(),'1');assert.equal(h.undo(),null);
assert.equal(h.redo(),'2');h.push('x');assert.equal(h.canRedo,false);assert.equal(h.current(),'x');
// Relative paths for ?model= must stay inside the served folder.
assert.equal(RT.safeRelativePath('models/my model.psd','.psd'),'models/my model.psd');
for(const bad of ['../x.psd','/etc/x.psd','https://evil/x.psd','a//b.psd','x.json','C:\\x.psd','./x.psd'])assert.equal(RT.safeRelativePath(bad,'.psd'),null,bad);
assert.equal(RT.safeFileName('キャラ<1>.psd'),'キャラ_1_');
console.log('runtime tests: validation, settings v1/v2, anchors, history, prefs, mesh limits, physics passed');
