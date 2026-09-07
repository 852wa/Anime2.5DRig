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
console.log('runtime tests: validation, settings, mesh limits, physics passed');
