'use strict';

const assert = require('assert');
const Rigger = require('../lib/rigger.js');

function solidLayer(name, left, top, width, height, hidden) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 80;
    data[i * 4 + 3] = 255;
  }
  return { name, left, top, hidden, imageData: { width, height, data } };
}

const psd = {
  width: 300,
  height: 300,
  children: [
    { name: 'face group', children: [
      solidLayer('face', 80, 30, 140, 130),
      solidLayer('eyewhite_1', 100, 75, 30, 12),
      solidLayer('eyewhite_2', 170, 75, 30, 12),
      solidLayer('irides_1', 108, 76, 12, 10),
      solidLayer('irides_2', 180, 76, 12, 10)
    ] },
    solidLayer('mouth_open', 130, 125, 40, 16),
    solidLayer('neck', 130, 155, 40, 80),
    solidLayer('ignored', 0, 0, 300, 300, true)
  ]
};

assert.strictEqual(Rigger._internals.imageLayersOf(psd).length, 7);
assert.strictEqual(Rigger.normName('eyeclose2'), 'eye_close2');
assert.strictEqual(Rigger.baseName('eye_close2'), 'eye_close2');
const rig = Rigger.buildRig(psd);
assert.ok(rig.anchors.eyeL && rig.anchors.eyeR, 'numbered eye layers should produce both anchors');
assert.ok(rig.anchors.eyeL.icx < rig.anchors.eyeR.icx, 'iris anchors should keep left/right order');
assert.strictEqual(rig.layers.some(layer => layer.name === 'ignored'), false);

const stats = Rigger.cleanPsdLayers(psd);
assert.strictEqual(stats.layers, 7);
assert.throws(
  () => Rigger.buildRig({ width: 6000, height: 5000, children: [] }),
  /大きすぎ/
);

// Empty semantic layers must fall back to usable anchors, not dereference null.
const emptyFace = solidLayer('face', 0, 0, 20, 20);
emptyFace.imageData.data.fill(0);
const fallback = Rigger.buildRig({width:100,height:100,children:[emptyFace,solidLayer('mouth_open',35,55,30,12)]});
assert.ok(Number.isFinite(fallback.anchors.face.cx));
assert.ok(fallback.warnings.some(w=>w.includes('空のレイヤー')));
for(const name of ['__proto__','constructor','toString','<img src=x onerror=alert(1)>']) {
  const unusual=Rigger.buildRig({width:100,height:100,children:[solidLayer(name,10,10,40,40)]});
  assert.ok(Number.isFinite(unusual.layers[0].depth),name);
}
assert.throws(()=>Rigger.buildRig({width:100,height:100,children:[emptyFace]}),/画素/);
assert.throws(()=>Rigger.validatePsd({width:2.5,height:100,children:[]}),/サイズ/);

const custom = solidLayer('generic',0,0,30,8).imageData;
const partial=structuredClone(psd);
partial.children.push(solidLayer('eye_close',100,81,30,8),solidLayer('eye_close2',170,81,30,8));
const repaired=Rigger.buildRig(partial,{generic:{eyeL:custom,eyeR:custom}});
assert.equal(repaired.layers.filter(p=>p.synthetic&&p.fade==='eyeClose').length,1);
assert.equal(repaired.layers.find(p=>p.synthetic&&p.fade==='eyeClose').side,'R');
assert.ok(repaired.layers.some(p=>p.fade==='eyeClose2'));

const thin = new Uint8Array(8*100).fill(255);
const strands = Rigger._internals.detectStrands(thin,8,100,30,6);
assert.ok(strands.length>0);
assert.equal(new Set(strands.map(s=>s.x)).size,strands.length);

const translucent = {width:2,height:1,data:new Uint8ClampedArray([255,0,0,128,0,0,255,0])};
const enlarged=Rigger._internals.resampleRGBA(translucent,4,1);
assert.deepEqual([...enlarged.slice(0,4)],[255,0,0,128]);
assert.equal(enlarged[4],255,'transparent blue must not darken or tint red edges');
assert.equal(enlarged[6],0);
const composite=Rigger.flattenPsdToImg({width:2,height:2,children:[{name:'red',left:0,top:0,imageData:{width:1,height:1,data:new Uint8ClampedArray([255,0,0,128])}}]});
assert.deepEqual([...composite.data],[255,0,0,128]);

console.log('rigger tests: 16 scenarios passed');
