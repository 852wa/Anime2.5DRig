/*!
 * Anime2.5DRig — face-features.js
 * Converts MediaPipe FaceMesh landmarks (468/478 points) into avatar
 * parameters: head angles, per-eye openness, gaze, mouth open/smile and brow.
 * Pure functions + a small stateful tracker (calibration and One Euro
 * filtering). Runs in the browser and in Node for tests.
 * MIT License
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaceFeatures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  // ---- One Euro filter (Casiez et al. 2012): little jitter at rest, little lag in motion ----
  function OneEuro(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff || 1;
    this.x = null; this.dx = 0; this.t = null;
  }
  function smoothingFactor(cutoff, dt) { var r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  OneEuro.prototype.filter = function (value, t) {
    if (this.x === null || this.t === null || !(t > this.t)) { this.x = value; this.t = t; this.dx = 0; return value; }
    var dt = Math.min(1, t - this.t); this.t = t;
    var dx = (value - this.x) / dt;
    this.dx += smoothingFactor(this.dCutoff, dt) * (dx - this.dx);
    var cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (value - this.x);
    return this.x;
  };
  OneEuro.prototype.reset = function () { this.x = null; this.t = null; this.dx = 0; };

  // ---- landmark indices (MediaPipe canonical face mesh) ----
  var I = {
    nose: 1, forehead: 10, chin: 152, cheekR: 234, cheekL: 454,
    eyeR: { top: 159, bottom: 145, outer: 33, inner: 133 },
    eyeL: { top: 386, bottom: 374, outer: 263, inner: 362 },
    browR: [70, 63, 105, 66, 107], browL: [300, 293, 334, 296, 336],
    mouth: { top: 13, bottom: 14, right: 61, left: 291 },
    irisR: 468, irisL: 473
  };

  /**
   * Scale-free measurements of one face. `aspect` = video width / height so
   * that x and y distances use the same unit. Subject's right eye is on the
   * image left; it drives the avatar's screen-left eye ("L") like a mirror.
   */
  function measure(lm, aspect) {
    if (!lm || lm.length < 468) return null;
    var ar = aspect > 0 ? aspect : 4 / 3;
    function P(i) { var p = lm[i]; return { x: p.x * ar, y: p.y }; }
    function d(a, b) { var p = P(a), q = P(b); return Math.hypot(p.x - q.x, p.y - q.y); }
    var chL = P(I.cheekL), chR = P(I.cheekR), nose = P(I.nose), top = P(I.forehead), chin = P(I.chin);
    var fw = Math.hypot(chL.x - chR.x, chL.y - chR.y), fh = Math.hypot(top.x - chin.x, top.y - chin.y);
    if (!(fw > 1e-4) || !(fh > 1e-4)) return null;
    var eo = function (e) { return d(e.top, e.bottom) / (d(e.outer, e.inner) || 1e-4); };
    var browDist = function (ids, e) {
      var y = 0; for (var i = 0; i < ids.length; i++) y += P(ids[i]).y;
      return (P(e.top).y - y / ids.length) / fh;
    };
    var mw = d(I.mouth.right, I.mouth.left) || 1e-4;
    // Smile compares the mouth corners with the upper lip, which barely moves
    // when the jaw opens (the lip midpoint would read an open mouth as a smile).
    var mc = P(I.mouth.top).y;
    var out = {
      yaw: (nose.x - (chL.x + chR.x) / 2) / fw,
      pitch: (nose.y - (top.y + chin.y) / 2) / Math.abs(chin.y - top.y || 1e-4),
      roll: Math.atan2(P(I.eyeL.outer).y - P(I.eyeR.outer).y, P(I.eyeL.outer).x - P(I.eyeR.outer).x),
      eyeL: eo(I.eyeR), eyeR: eo(I.eyeL),   // mirrored: subject right → avatar screen-left
      browL: browDist(I.browR, I.eyeR), browR: browDist(I.browL, I.eyeL),
      mouthOpen: d(I.mouth.top, I.mouth.bottom) / mw,
      smile: (mc - (P(I.mouth.right).y + P(I.mouth.left).y) / 2) / mw,
      gazeX: 0, gazeY: 0, hasIris: lm.length >= 478
    };
    if (out.hasIris) {
      var gz = function (ir, e) {
        var a = P(e.outer), b = P(e.inner), w = Math.abs(a.x - b.x) || 1e-4;
        return (P(ir).x - (a.x + b.x) / 2) / w;
      };
      out.gazeX = (gz(I.irisR, I.eyeR) + gz(I.irisL, I.eyeL)) / 2;
      out.gazeY = ((P(I.irisR).y + P(I.irisL).y) / 2 -
        (P(I.eyeR.top).y + P(I.eyeR.bottom).y + P(I.eyeL.top).y + P(I.eyeL.bottom).y) / 4) / fw;
    }
    return out;
  }

  // Typical neutral values for an adult face looking at the camera.
  var DEFAULT_NEUTRAL = { yaw: 0, pitch: 0.10, roll: 0, eyeL: 0.30, eyeR: 0.30, browL: 0.085, browR: 0.085,
    mouthOpen: 0.02, smile: 0.0, gazeX: 0, gazeY: 0 };
  var DEFAULT_OPTIONS = { headGain: 1, eyeGain: 1, mouthGain: 1, browGain: 1, gazeGain: 1, smoothing: 0.5,
    linkEyes: true, trackBrow: true, trackSmile: true };

  // Average a list of measurements into a calibration (neutral pose).
  function calibrate(samples) {
    var valid = (samples || []).filter(Boolean);
    if (!valid.length) return null;
    var out = {};
    Object.keys(DEFAULT_NEUTRAL).forEach(function (k) {
      var s = 0; valid.forEach(function (m) { s += m[k]; }); out[k] = s / valid.length;
    });
    // A calibration taken with eyes half-closed would make blinking impossible.
    out.eyeL = Math.max(out.eyeL, 0.12); out.eyeR = Math.max(out.eyeR, 0.12);
    return out;
  }

  function eyeOpen(r, neutral, gain) {
    var closed = neutral * clamp(0.30 + 0.15 * (gain - 1), 0.1, 0.7), open = neutral * 0.85;
    return clamp((r - closed) / Math.max(1e-4, open - closed), 0, 1);
  }

  /** Map a measurement to avatar parameters (no temporal filtering). */
  function toParams(m, neutral, options) {
    var n = neutral || DEFAULT_NEUTRAL, o = options || DEFAULT_OPTIONS;
    var g = function (k) { return typeof o[k] === 'number' ? o[k] : DEFAULT_OPTIONS[k]; };
    var eL = eyeOpen(m.eyeL, n.eyeL, g('eyeGain')), eR = eyeOpen(m.eyeR, n.eyeR, g('eyeGain'));
    if (o.linkEyes !== false) { var e = Math.min(eL, eR); eL = e; eR = e; }
    var brow = ((m.browL - n.browL) + (m.browR - n.browR)) / 2;
    return {
      ax: clamp(-(m.yaw - n.yaw) * 3.2 * g('headGain'), -1, 1),
      ay: clamp(-(m.pitch - n.pitch) * 3.0 * g('headGain'), -1, 1),
      az: clamp(-(m.roll - n.roll) * 1.4 * g('headGain'), -1, 1),
      eL: eL, eR: eR,
      mo: clamp((m.mouthOpen - n.mouthOpen - 0.02) / (0.30 / g('mouthGain')), 0, 1),
      ex: m.hasIris ? clamp(-(m.gazeX - n.gazeX) * 5 * g('gazeGain'), -1, 1) : 0,
      ey: m.hasIris ? clamp(-(m.gazeY - n.gazeY) * 10 * g('gazeGain'), -1, 1) : 0,
      br: o.trackBrow === false ? 0 : clamp(brow / (0.022 / g('browGain')), -1, 1),
      mf: o.trackSmile === false ? 0 : clamp((m.smile - n.smile) / 0.07, -1, 1)
    };
  }

  // Filter tuning per channel: [min cutoff at smoothing 0, at smoothing 1, beta].
  var CHANNELS = {
    ax: [3.0, 0.4, 0.8], ay: [3.0, 0.4, 0.8], az: [3.0, 0.4, 0.8],
    eL: [12, 3, 2], eR: [12, 3, 2], mo: [8, 2, 1.5],
    ex: [5, 0.8, 1], ey: [5, 0.8, 1], br: [4, 0.8, 1], mf: [4, 0.8, 1]
  };

  function Tracker(options) {
    this.options = Object.assign({}, DEFAULT_OPTIONS, options || {});
    this.neutral = null; this.filters = {}; this.samples = null; this.last = null; this.lastMeasure = null;
    this._rebuild();
  }
  Tracker.prototype._rebuild = function () {
    var s = clamp(this.options.smoothing, 0, 1), self = this;
    Object.keys(CHANNELS).forEach(function (k) {
      var c = CHANNELS[k];
      self.filters[k] = new OneEuro(c[0] + (c[1] - c[0]) * s, c[2]);
    });
  };
  Tracker.prototype.setOptions = function (options) {
    var smoothingChanged = options && options.smoothing !== undefined && options.smoothing !== this.options.smoothing;
    Object.assign(this.options, options || {});
    if (smoothingChanged) this._rebuild();
  };
  Tracker.prototype.setCalibration = function (neutral) { this.neutral = neutral || null; };
  Tracker.prototype.startCalibration = function () { this.samples = []; };
  Tracker.prototype.finishCalibration = function () {
    var c = calibrate(this.samples); this.samples = null;
    if (c) this.neutral = c;
    return c;
  };
  Tracker.prototype.reset = function () { for (var k in this.filters) this.filters[k].reset(); this.last = null; };
  /** landmarks → filtered params, or null when no usable face. `t` in seconds. */
  Tracker.prototype.update = function (lm, t, aspect) {
    var m = measure(lm, aspect);
    if (!m) return null;
    this.lastMeasure = m;
    if (this.samples) this.samples.push(m);
    var raw = toParams(m, this.neutral || DEFAULT_NEUTRAL, this.options), out = {};
    for (var k in raw) out[k] = this.filters[k] ? this.filters[k].filter(raw[k], t) : raw[k];
    // Blinks should close fully even when filtered.
    out.eL = raw.eL < 0.05 ? Math.min(out.eL, raw.eL + 0.1) : out.eL;
    out.eR = raw.eR < 0.05 ? Math.min(out.eR, raw.eR + 0.1) : out.eR;
    this.last = out;
    return out;
  };

  return { OneEuro: OneEuro, measure: measure, calibrate: calibrate, toParams: toParams, Tracker: Tracker,
    DEFAULT_NEUTRAL: DEFAULT_NEUTRAL, DEFAULT_OPTIONS: DEFAULT_OPTIONS, INDEX: I };
});
