'use strict';
const assert = require('node:assert/strict');
const F = require('../lib/face-features.js');

// Synthetic landmarks in a 4:3 video (x normalised by width, y by height).
// Coordinates are given in "square" units and converted with the aspect ratio.
const ASPECT = 4 / 3;
function face(opts = {}) {
  const o = Object.assign({ yaw: 0, eye: 0.30, eyeR: null, mouth: 0.02, smile: 0, brow: 0.085, gaze: 0 }, opts);
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i, x, y) => { lm[i] = { x: x / ASPECT, y, z: 0 }; };
  const cx = 0.5 * ASPECT, top = 0.2, chin = 0.8, fh = chin - top;
  set(10, cx, top); set(152, cx, chin);
  set(234, cx - 0.25, 0.5); set(454, cx + 0.25, 0.5);
  set(1, cx + o.yaw * 0.5, top + fh * 0.6);   // nose: pitch ≈ 0.10 at rest
  const eye = (outer, inner, topI, botI, x0, x1, ratio) => {
    const w = Math.abs(x1 - x0), y = 0.42;
    set(outer, x0, y); set(inner, x1, y);
    set(topI, (x0 + x1) / 2, y - w * ratio / 2); set(botI, (x0 + x1) / 2, y + w * ratio / 2);
    return { y, w };
  };
  const r = eye(33, 133, 159, 145, cx - 0.16, cx - 0.05, o.eye);
  eye(263, 362, 386, 374, cx + 0.16, cx + 0.05, o.eyeR == null ? o.eye : o.eyeR);
  for (const i of [70, 63, 105, 66, 107]) set(i, cx - 0.1, (r.y - r.w * o.eye / 2) - o.brow * fh);
  for (const i of [300, 293, 334, 296, 336]) set(i, cx + 0.1, (r.y - r.w * o.eye / 2) - o.brow * fh);
  const mw = 0.16, my = 0.66;
  set(61, cx - mw / 2, my - o.smile * mw); set(291, cx + mw / 2, my - o.smile * mw);
  set(13, cx, my); set(14, cx, my + o.mouth * mw);
  set(468, cx - 0.105 + o.gaze * 0.02, 0.42); set(473, cx + 0.105 + o.gaze * 0.02, 0.42);
  return lm;
}

const neutral = F.measure(face(), ASPECT);
assert.ok(Math.abs(neutral.yaw) < 1e-9 && Math.abs(neutral.pitch - 0.1) < 1e-6, 'neutral head pose');
assert.ok(Math.abs(neutral.eyeL - 0.30) < 1e-6 && Math.abs(neutral.browL - 0.085) < 1e-6);
assert.equal(F.measure(face().slice(0, 100), ASPECT), null, 'too few landmarks');

const p0 = F.toParams(neutral);
for (const k of ['ax', 'ay', 'az', 'br', 'mf', 'ex', 'ey']) assert.ok(Math.abs(p0[k]) < 1e-6, 'neutral ' + k);
assert.equal(p0.eL, 1); assert.equal(p0.mo, 0);

// Head turned to the subject's left (image right) → avatar turns screen-left.
assert.ok(F.toParams(F.measure(face({ yaw: 0.2 }), ASPECT)).ax < -0.5);
// Closed eyes, a wink, an open mouth, a smile, raised brows and gaze.
assert.equal(F.toParams(F.measure(face({ eye: 0.02 }), ASPECT)).eL, 0);
const wink = F.measure(face({ eye: 0.30, eyeR: 0.03 }), ASPECT);
const linked = F.toParams(wink), split = F.toParams(wink, null, { linkEyes: false });
assert.equal(linked.eL, 0, 'linked eyes follow the more closed eye');
assert.ok(split.eL === 1 && split.eR === 0, 'wink: subject left eye closes the avatar screen-right eye');
const open = F.toParams(F.measure(face({ mouth: 0.4 }), ASPECT));
assert.ok(open.mo > 0.9 && Math.abs(open.mf) < 1e-6, 'an open mouth is not read as a smile');
assert.ok(F.toParams(F.measure(face({ smile: 0.06 }), ASPECT)).mf > 0.7);
assert.ok(F.toParams(F.measure(face({ smile: 0.06 }), ASPECT), null, { trackSmile: false }).mf === 0);
assert.ok(F.toParams(F.measure(face({ brow: 0.105 }), ASPECT)).br > 0.8);
assert.ok(F.toParams(F.measure(face({ gaze: 1 }), ASPECT)).ex < -0.5);

// Calibration: someone whose relaxed eyes are narrower should still read as open.
const narrow = F.measure(face({ eye: 0.2, brow: 0.07, smile: 0.02 }), ASPECT);
assert.ok(F.toParams(narrow).eL < 1 && F.toParams(narrow).br < -0.5);
const calib = F.calibrate([narrow, narrow, null]);
const calibrated = F.toParams(narrow, calib);
assert.equal(calibrated.eL, 1); assert.ok(Math.abs(calibrated.br) < 1e-6 && Math.abs(calibrated.mf) < 1e-6);
assert.equal(F.calibrate([]), null);
assert.ok(F.calibrate([F.measure(face({ eye: 0.01 }), ASPECT)]).eyeL >= 0.12, 'closed-eye calibration is clamped');
// Sensitivity: a half-closed eye reads as more closed with a higher eye gain.
const half = F.measure(face({ eye: 0.14 }), ASPECT);
assert.ok(F.toParams(half, null, { eyeGain: 2 }).eL < F.toParams(half, null, { eyeGain: 0.5 }).eL);

// One Euro filter: smooths jitter at rest but follows a step change.
const filt = new F.OneEuro(1, 0.5);
let maxDev = 0;
for (let i = 0; i < 120; i++) { const v = filt.filter((i % 2 ? 1 : -1) * 0.05, i / 60); if (i > 30) maxDev = Math.max(maxDev, Math.abs(v)); }
assert.ok(maxDev < 0.02, 'jitter reduced: ' + maxDev);
let v = 0; for (let i = 120; i < 180; i++) v = filt.filter(1, i / 60);
assert.ok(v > 0.95, 'step followed within one second: ' + v);

// Tracker: calibration workflow and blink passthrough.
const tracker = new F.Tracker({ smoothing: 0.8 });
tracker.startCalibration();
for (let i = 0; i < 10; i++) tracker.update(face({ eye: 0.2 }), i / 30, ASPECT);
assert.ok(tracker.finishCalibration());
let out; for (let i = 10; i < 40; i++) out = tracker.update(face({ eye: 0.2 }), i / 30, ASPECT);
assert.ok(out.eL > 0.95, 'calibrated open eye');
out = tracker.update(face({ eye: 0.0 }), 40 / 30, ASPECT);
assert.ok(out.eL <= 0.1, 'blink closes within one frame: ' + out.eL);
assert.equal(tracker.update([], 2, ASPECT), null);
tracker.setOptions({ smoothing: 0 }); tracker.reset();

console.log('face-features tests: measurement, mapping, calibration, filtering passed');
