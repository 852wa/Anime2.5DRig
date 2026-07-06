/*!
 * Anime2.5DRig — rigger.js
 * PSD (parsed by ag-psd, useImageData mode) -> rig definition.
 * Pure typed-array implementation: runs in browser and Node (testable).
 * MIT License
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Rigger = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- layer naming ----------
  function normName(n) {
    n = (n || '').normalize('NFKC').trim().replace(/ のコピー\s*\d*$/,'').toLowerCase();
    if (n === 'eyelash_c') n = 'eye_close';       // legacy aliases
    if (n === 'mouth_c') n = 'mouth_close';
    if (n === 'mouth' || /^mouth[ _-]?\d+$/.test(n)) n = 'mouth_open';   // see-through raw output
    if (n === 'レイヤー 1') n = 'facedetail';
    return n;
  }
  function baseName(n) { return n.replace(/_\d+$/, ''); }

  var SLOTS = {
    'back hair':   { depth: 0.55, group: 'head', phys: 'hair' },
    'bottomwear':  { depth: 0.88, group: 'body' },
    'neck':        { depth: 0.95, group: 'body' },
    'topwear':     { depth: 0.90, group: 'body' },
    'handwear':    { depth: 0.86, group: 'body' },
    'earwear':     { depth: 0.97, group: 'head' },
    'ears':        { depth: 0.96, group: 'head' },
    'face':        { depth: 1.00, group: 'head' },
    'facedetail':  { depth: 1.02, group: 'head' },
    'headwear':    { depth: 1.20, group: 'head' },
    'mouth_close': { depth: 1.08, group: 'head', fade: 'mouthClose' },
    'mouth_open':  { depth: 1.08, group: 'head', fade: 'mouthOpen' },
    'nose':        { depth: 1.15, group: 'head' },
    'eyewhite':    { depth: 1.06, group: 'head', split: true, fade: 'eyeOpen' },
    'eyebrow':     { depth: 1.14, group: 'head', split: true },
    'irides':      { depth: 1.08, group: 'head', split: true, fade: 'eyeOpen' },
    'eyelash':     { depth: 1.12, group: 'head', split: true, fade: 'eyeOpen' },
    'eye_close':   { depth: 1.12, group: 'head', split: true, fade: 'eyeClose' },
    'front hair':  { depth: 1.28, group: 'head', phys: 'hair' }
  };

  // ---------- image ops (full-canvas alpha as Uint8Array) ----------
  function fullAlphaOf(layer, W, H) {
    var a = new Uint8Array(W * H);
    var img = layer.imageData, lw = img.width, lh = img.height;
    var lx = layer.left | 0, ly = layer.top | 0, d = img.data;
    for (var y = 0; y < lh; y++) {
      var cy = y + ly; if (cy < 0 || cy >= H) continue;
      var ro = cy * W, lo = y * lw;
      for (var x = 0; x < lw; x++) {
        var cx = x + lx; if (cx < 0 || cx >= W) continue;
        a[ro + cx] = d[(lo + x) * 4 + 3];
      }
    }
    return a;
  }

  function labelComponents(alpha, W, H, thr) {
    var lab = new Int32Array(W * H), sizes = [0], sumX = [0], cnt = 0;
    var stack = new Int32Array(W * H);
    for (var s = 0; s < W * H; s++) {
      if (lab[s] || alpha[s] <= thr) continue;
      cnt++; var sp = 0; stack[sp++] = s; lab[s] = cnt;
      var size = 0, sx = 0;
      while (sp) {
        var q = stack[--sp]; size++; sx += q % W;
        var x = q % W, y = (q / W) | 0;
        if (x > 0        && !lab[q - 1] && alpha[q - 1] > thr) { lab[q - 1] = cnt; stack[sp++] = q - 1; }
        if (x < W - 1    && !lab[q + 1] && alpha[q + 1] > thr) { lab[q + 1] = cnt; stack[sp++] = q + 1; }
        if (y > 0        && !lab[q - W] && alpha[q - W] > thr) { lab[q - W] = cnt; stack[sp++] = q - W; }
        if (y < H - 1    && !lab[q + W] && alpha[q + W] > thr) { lab[q + W] = cnt; stack[sp++] = q + W; }
      }
      sizes.push(size); sumX.push(sx);
    }
    return { lab: lab, count: cnt, sizes: sizes, sumX: sumX };
  }

  function dilate(mask, W, H, r) {
    var tmp = new Uint8Array(W * H), out = new Uint8Array(W * H), x, y, k;
    for (y = 0; y < H; y++) {
      var o = y * W;
      for (x = 0; x < W; x++) {
        var v = 0;
        for (k = -r; k <= r; k++) { var xx = x + k; if (xx >= 0 && xx < W && mask[o + xx]) { v = 1; break; } }
        tmp[o + x] = v;
      }
    }
    for (x = 0; x < W; x++) for (y = 0; y < H; y++) {
      var v2 = 0;
      for (k = -r; k <= r; k++) { var yy = y + k; if (yy >= 0 && yy < H && tmp[yy * W + x]) { v2 = 1; break; } }
      out[y * W + x] = v2;
    }
    return out;
  }

  // kill stray dust: keep components >= minPx (on alpha>16), dilate, zero the rest
  function cleanAlpha(alpha, W, H, minPx) {
    var L = labelComponents(alpha, W, H, 16);
    if (!L.count) return alpha;
    var keepComp = new Uint8Array(L.count + 1), any = false, i;
    for (i = 1; i <= L.count; i++) if (L.sizes[i] >= minPx) { keepComp[i] = 1; any = true; }
    if (!any) return alpha;
    var mask = new Uint8Array(W * H);
    for (i = 0; i < W * H; i++) if (keepComp[L.lab[i]]) mask[i] = 1;
    mask = dilate(mask, W, H, 3);
    for (i = 0; i < W * H; i++) if (!mask[i]) alpha[i] = 0;
    return alpha;
  }

  // split into left/right masks by component centroid vs face center x
  function splitSides(alpha, W, H, faceCx) {
    var L = labelComponents(alpha, W, H, 16);
    var side = new Uint8Array(L.count + 1); // 1=left 2=right
    for (var c = 1; c <= L.count; c++) {
      if (L.sizes[c] < 20) continue;
      side[c] = (L.sumX[c] / L.sizes[c]) < faceCx ? 1 : 2;
    }
    var ml = new Uint8Array(W * H), mr = new Uint8Array(W * H), i;
    for (i = 0; i < W * H; i++) {
      if (side[L.lab[i]] === 1) ml[i] = 1; else if (side[L.lab[i]] === 2) mr[i] = 1;
    }
    var out = {};
    var nl = 0, nr = 0;
    for (i = 0; i < W * H; i++) { nl += ml[i]; nr += mr[i]; }
    if (nl) out.l = dilate(ml, W, H, 3);
    if (nr) out.r = dilate(mr, W, H, 3);
    return out;
  }

  function bboxOf(alpha, W, H, thr) {
    var x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (var y = 0; y < H; y++) {
      var o = y * W;
      for (var x = 0; x < W; x++) if (alpha[o + x] > thr) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  function centroidOf(alpha, W, H) {
    var sx = 0, sy = 0, s = 0;
    for (var y = 0; y < H; y++) {
      var o = y * W;
      for (var x = 0; x < W; x++) { var a = alpha[o + x]; if (a) { sx += x * a; sy += y * a; s += a; } }
    }
    return s ? { cx: sx / s, cy: sy / s } : null;
  }

  // ---------- generic close-diff synthesis ----------
  function resampleRGBA(src, tw, th) {   // bilinear
    var out = new Uint8ClampedArray(tw * th * 4);
    var sw = src.width, sh = src.height, d = src.data;
    for (var y = 0; y < th; y++) {
      var sy = (y + 0.5) * sh / th - 0.5;
      var y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
      for (var x = 0; x < tw; x++) {
        var sx = (x + 0.5) * sw / tw - 0.5;
        var x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
        var o = (y * tw + x) * 4;
        for (var c = 0; c < 4; c++) {
          var v00 = d[(y0 * sw + x0) * 4 + c], v01 = d[(y0 * sw + x1) * 4 + c];
          var v10 = d[(y1 * sw + x0) * 4 + c], v11 = d[(y1 * sw + x1) * 4 + c];
          out[o + c] = v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy;
        }
      }
    }
    return out;
  }
  function meanColorOfImg(img, darkWeight) {   // alpha-weighted mean RGB
    var d = img.data, r = 0, g = 0, b = 0, s = 0;
    for (var i = 0; i < d.length; i += 4) {
      var a = d[i + 3]; if (a < 24) continue;
      var w = a;
      if (darkWeight) { var lum = (d[i] + d[i + 1] + d[i + 2]) / 3; w = a * Math.pow(1 - lum / 255, 2); }
      r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; s += w;
    }
    return s ? [r / s, g / s, b / s] : null;
  }
  function recolorTo(data, target) {   // flat recolor preserving relative luminance
    var lumSum = 0, n = 0, i;
    for (i = 0; i < data.length; i += 4) if (data[i + 3] > 24) { lumSum += (data[i] + data[i + 1] + data[i + 2]) / 3; n++; }
    if (!n) return;
    var mean = Math.max(8, lumSum / n);
    for (i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      var f = Math.min(2.2, ((data[i] + data[i + 1] + data[i + 2]) / 3) / mean);
      data[i] = target[0] * f; data[i + 1] = target[1] * f; data[i + 2] = target[2] * f;
    }
  }
  function synthPart(name, gimg, targetW, cx, anchorY, vAlign, tint, slot, side) {
    var scale = targetW / gimg.width;
    var tw = Math.max(2, Math.round(targetW)), th = Math.max(2, Math.round(gimg.height * scale));
    var data = resampleRGBA(gimg, tw, th);
    if (tint) recolorTo(data, tint);
    return { name: name, x: Math.round(cx - tw / 2), y: Math.round(anchorY - vAlign * th),
             w: tw, h: th, z: 0, depth: slot.depth, group: 'head', phys: null,
             fade: slot.fade || null, side: side || null, strands: null, synthetic: true,
             img: { width: tw, height: th, data: data } };
  }
  function lastIndexWhere(arr, pred) {
    for (var i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
    return -1;
  }

  // ---------- flat-image utilities (custom generic-diff PSDs) ----------
  function trimImg(img, thr) {
    thr = thr || 8;
    var W = img.width, H = img.height, d = img.data;
    var x0 = W, y0 = H, x1 = -1, y1 = -1, x, y;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++)
      if (d[(y * W + x) * 4 + 3] > thr) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    if (x1 < 0) return null;
    var w = x1 - x0 + 1, h = y1 - y0 + 1;
    var out = new Uint8ClampedArray(w * h * 4);
    for (y = 0; y < h; y++) out.set(d.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x0 + w) * 4), y * w * 4);
    return { width: w, height: h, data: out };
  }
  // alpha-over composite of all layers, trimmed
  function flattenPsdToImg(psd) {
    var W = psd.width, H = psd.height;
    var buf = new Uint8ClampedArray(W * H * 4);
    (psd.children || []).forEach(function (c) {
      if (!c.imageData) return;
      var img = c.imageData, lw = img.width, lh = img.height, lx = c.left | 0, ly = c.top | 0, d = img.data;
      for (var y = 0; y < lh; y++) {
        var cy = y + ly; if (cy < 0 || cy >= H) continue;
        for (var x = 0; x < lw; x++) {
          var cx = x + lx; if (cx < 0 || cx >= W) continue;
          var si = (y * lw + x) * 4, di = (cy * W + cx) * 4, a = d[si + 3] / 255;
          if (!a) continue;
          for (var k = 0; k < 3; k++) buf[di + k] = d[si + k] * a + buf[di + k] * (1 - a);
          buf[di + 3] = Math.min(255, d[si + 3] + buf[di + 3] * (1 - a));
        }
      }
    });
    return trimImg({ width: W, height: H, data: buf });
  }
  // split a both-eyes image into L/R at the widest interior empty-column gap
  function splitImgLR(img) {
    var W = img.width, H = img.height, d = img.data;
    var col = new Uint8Array(W), x, y;
    for (x = 0; x < W; x++) for (y = 0; y < H; y++) if (d[(y * W + x) * 4 + 3] > 16) { col[x] = 1; break; }
    var best = null, start = -1;
    for (x = 0; x < W; x++) {
      if (!col[x]) { if (start < 0) start = x; }
      else { if (start > 0 && (!best || x - start > best[1] - best[0])) best = [start, x]; start = -1; }
    }
    if (!best) return null;
    var mid = (best[0] + best[1]) >> 1;
    function cut(a, b) {
      var w = b - a, out = new Uint8ClampedArray(w * H * 4);
      for (var yy = 0; yy < H; yy++) out.set(d.subarray((yy * W + a) * 4, (yy * W + b) * 4), yy * w * 4);
      return trimImg({ width: w, height: H, data: out });
    }
    var l = cut(0, mid), r = cut(mid, W);
    return (l && r) ? { l: l, r: r } : null;
  }

  // ---------- strand detection ----------
  function findPeaks(a, minDist, minProm) {
    var n = a.length, cand = [], i;
    for (i = 1; i < n - 1; i++) if (a[i] > a[i - 1] && a[i] >= a[i + 1]) cand.push(i);
    var peaks = [];
    for (var ci = 0; ci < cand.length; ci++) {
      var p = cand[ci], lmin = a[p], rmin = a[p], j;
      for (j = p - 1; j >= 0; j--) { if (a[j] > a[p]) break; if (a[j] < lmin) lmin = a[j]; }
      for (j = p + 1; j < n; j++) { if (a[j] > a[p]) break; if (a[j] < rmin) rmin = a[j]; }
      var prom = a[p] - Math.max(lmin, rmin);
      if (prom >= minProm) peaks.push({ x: p, prom: prom });
    }
    peaks.sort(function (u, v) { return v.prom - u.prom; });
    var kept = [];
    for (var k = 0; k < peaks.length; k++) {
      var pk = peaks[k], ok = true;
      for (var m = 0; m < kept.length; m++) if (Math.abs(kept[m].x - pk.x) < minDist) { ok = false; break; }
      if (ok) kept.push(pk);
    }
    return kept; // prominence-ordered
  }

  function detectStrands(alpha, W, H, minSep, want) {
    var bottom = new Float32Array(W), top = new Float32Array(W);
    var minX = W, maxX = -1, x, y;
    for (x = 0; x < W; x++) {
      top[x] = -1; bottom[x] = 0;
      for (y = 0; y < H; y++) if (alpha[y * W + x] > 16) { top[x] = y; break; }
      if (top[x] < 0) continue;
      for (y = H - 1; y >= 0; y--) if (alpha[y * W + x] > 16) { bottom[x] = y; break; }
      if (x < minX) minX = x; if (x > maxX) maxX = x;
    }
    if (maxX < 0) return [];
    // box smooth k=41, zero-padded 'same'
    var k = 41, hk = 20, sm = new Float32Array(W);
    var pre = new Float32Array(W + 1);
    for (x = 0; x < W; x++) pre[x + 1] = pre[x] + bottom[x];
    for (x = 0; x < W; x++) {
      var a0 = Math.max(0, x - hk), a1 = Math.min(W - 1, x + hk);
      sm[x] = (pre[a1 + 1] - pre[a0]) / k;
    }
    var pk = findPeaks(sm, minSep, 10);
    var xs = [];
    for (var i = 0; i < pk.length && xs.length < want; i++) xs.push(pk[i].x);
    // fill up: farthest-from-existing candidates with content
    var guard = 0;
    while (xs.length < want && guard++ < 50) {
      var best = -1, bestD = -1;
      for (var t = 0; t < 40; t++) {
        var cx = Math.round(minX + 30 + (maxX - minX - 60) * t / 39);
        if (cx < 0 || cx >= W || top[cx] < 0) continue;
        var dmin = 1e9;
        for (var m = 0; m < xs.length; m++) dmin = Math.min(dmin, Math.abs(cx - xs[m]));
        if (xs.length === 0) dmin = 1e9 - t;
        if (dmin > bestD) { bestD = dmin; best = cx; }
      }
      if (best < 0) break;
      xs.push(best);
    }
    xs.sort(function (a, b) { return a - b; });
    var strands = [];
    for (var s = 0; s < xs.length; s++) {
      var sx = xs[s];
      if (top[sx] < 0) continue;
      strands.push({ x: sx, tipY: bottom[sx], rootY: top[sx] });
    }
    return strands;
  }

  // ---------- part record ----------
  // mask: optional Uint8 side mask multiplied onto alpha
  function makePart(name, layer, fullAlpha, mask, W, H, slot, z, side, strands) {
    var eff = fullAlpha;
    if (mask) {
      eff = new Uint8Array(W * H);
      for (var i = 0; i < W * H; i++) eff[i] = mask[i] ? fullAlpha[i] : 0;
    }
    var bb = bboxOf(eff, W, H, 8);
    if (!bb) return null;
    var pad = 2;
    var x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
    var x1 = Math.min(W, bb.x1 + 1 + pad), y1 = Math.min(H, bb.y1 + 1 + pad);
    var w = x1 - x0, h = y1 - y0;
    var data = new Uint8ClampedArray(w * h * 4);
    var img = layer.imageData, lw = img.width, lh = img.height;
    var lx = layer.left | 0, ly = layer.top | 0, ld = img.data;
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var di = ((y - y0) * w + (x - x0)) * 4;
        var yy = y - ly, xx = x - lx;
        if (yy >= 0 && yy < lh && xx >= 0 && xx < lw) {
          var li = (yy * lw + xx) * 4;
          data[di] = ld[li]; data[di + 1] = ld[li + 1]; data[di + 2] = ld[li + 2];
        }
        data[di + 3] = eff[y * W + x];
      }
    }
    return {
      name: name, x: x0, y: y0, w: w, h: h, z: z,
      depth: slot.depth, group: slot.group, phys: slot.phys || null,
      fade: slot.fade || null, side: side || null, strands: strands || null,
      img: { width: w, height: h, data: data }
    };
  }

  // ---------- main ----------
  function buildRig(psd, opts) {
    opts = opts || {};
    var W = psd.width, H = psd.height;
    var warnings = [];
    var kids = (psd.children || []).filter(function (c) { return c.imageData; });
    if (!kids.length) throw new Error('レイヤーが見つかりません（グループは未対応・フラット構成にしてください）');

    // full alphas, cleaned
    var entries = [];
    for (var i = 0; i < kids.length; i++) {
      var name = normName(kids[i].name);
      var fa = cleanAlpha(fullAlphaOf(kids[i], W, H), W, H, 40);
      entries.push({ name: name, layer: kids[i], alpha: fa });
    }
    var byName = {};
    entries.forEach(function (e) { byName[e.name] = e; });

    // face anchor (required-ish)
    var faceE = byName['face'];
    var FACE;
    if (faceE) {
      var fb = bboxOf(faceE.alpha, W, H, 8), fc = centroidOf(faceE.alpha, W, H);
      FACE = { cx: fc.cx, cy: fc.cy, x0: fb.x0, x1: fb.x1, y0: fb.y0, y1: fb.y1 };
    } else {
      warnings.push('face レイヤーがありません — キャンバス中央を顔とみなします');
      FACE = { cx: W / 2, cy: H * 0.3, x0: W * 0.35, x1: W * 0.65, y0: H * 0.1, y1: H * 0.5 };
    }

    // build parts
    var parts = [], z = 0, sided = {};
    for (var ei = 0; ei < entries.length; ei++) {
      var e = entries[ei];
      var bn = baseName(e.name);
      var slot = SLOTS[bn];
      if (!slot) {
        var c0 = centroidOf(e.alpha, W, H);
        slot = { depth: 1.0, group: (c0 && c0.cy < FACE.y1) ? 'head' : 'body' };
        warnings.push('未知のレイヤー名 "' + e.name + '" — ' + slot.group + ' として扱います');
      }
      if (slot.split) {
        var masks = splitSides(e.alpha, W, H, FACE.cx);
        var got = false;
        ['l', 'r'].forEach(function (s) {
          if (!masks[s]) return;
          var rec = makePart(e.name + '_' + s, e.layer, e.alpha, masks[s], W, H, slot, z, s.toUpperCase(), null);
          if (rec) {
            parts.push(rec); z++;
            var ma = new Uint8Array(W * H);
            for (var q = 0; q < W * H; q++) ma[q] = masks[s][q] ? e.alpha[q] : 0;
            sided[e.name + '|' + s] = ma;
            got = true;
          }
        });
        if (!got) warnings.push('"' + e.name + '" の左右分離に失敗（空レイヤー？）');
      } else if (slot.phys === 'hair') {
        var isPart = /_\d+$/.test(e.name);
        var bb2 = bboxOf(e.alpha, W, H, 16);
        var wpx = bb2 ? (bb2.x1 - bb2.x0) : 0;
        var want = isPart ? Math.max(2, Math.min(6, Math.round(wpx / 110))) : 6;
        var minSep = Math.max(30, Math.round(wpx / (want * 1.6)));
        var strands = detectStrands(e.alpha, W, H, minSep, want);
        var rec2 = makePart(e.name, e.layer, e.alpha, null, W, H, slot, z, null, strands);
        if (rec2) { parts.push(rec2); z++; }
      } else {
        var rec3 = makePart(e.name, e.layer, e.alpha, null, W, H, slot, z, null, null);
        if (rec3) { parts.push(rec3); z++; }
      }
    }

    // anchors
    var anchors = { face: FACE };
    ['l', 'r'].forEach(function (s) {
      var ew = sided['eyewhite|' + s], ir = sided['irides|' + s], ec = sided['eye_close|' + s];
      var K = 'eye' + s.toUpperCase();
      if (ew) {
        var b = bboxOf(ew, W, H, 8);
        var a = { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 };
        var ic = ir ? centroidOf(ir, W, H) : centroidOf(ew, W, H);
        a.icx = ic.cx; a.icy = ic.cy;
        var cc = ec ? centroidOf(ec, W, H) : null;
        a.closeY = cc ? cc.cy : (b.y0 + (b.y1 - b.y0) * 0.62);
        anchors[K] = a;
      }
    });
    if (!anchors.eyeL || !anchors.eyeR) warnings.push('目のアンカーが不完全です（eyewhite/irides を確認）');

    var mSrc = byName['mouth_open'] || byName['mouth_close'];
    if (mSrc) {
      var mb = bboxOf(mSrc.alpha, W, H, 8), mc = centroidOf(mSrc.alpha, W, H);
      anchors.mouth = { x0: mb.x0, x1: mb.x1, y0: mb.y0, y1: mb.y1, cx: mc.cx, cy: mc.cy };
    } else {
      warnings.push('mouth_open / mouth_close がありません');
      anchors.mouth = { x0: FACE.cx - 20, x1: FACE.cx + 20, y0: FACE.cy + 40, y1: FACE.cy + 60, cx: FACE.cx, cy: FACE.cy + 50 };
    }

    var nE = byName['neck'];
    if (nE) {
      var nb = bboxOf(nE.alpha, W, H, 8), nc = centroidOf(nE.alpha, W, H);
      anchors.neckPivot = { cx: nc.cx, cy: nb.y0 + (nb.y1 - nb.y0) * 0.85 };
      anchors.neckTop = nb.y0; anchors.neckBottom = nb.y1;
    } else {
      anchors.neckPivot = { cx: FACE.cx, cy: FACE.y1 + 20 };
      anchors.neckTop = FACE.y1; anchors.neckBottom = FACE.y1 + 60;
    }
    anchors.bodyPivot = { cx: anchors.neckPivot.cx, cy: H };
    anchors.faceScale = (FACE.x1 - FACE.x0) / 333.0;
    anchors.hairRootY = FACE.y0 + 60;

    // ---------- synthesize missing close diffs from generic parts ----------
    var synth = { eye: false, mouth: false };
    var G = opts.generic;
    if (G) {
      var findPart = function (pref) { return parts.filter(function (p) { return p.name.indexOf(pref) === 0; }); };
      // eyes
      if (G.eyeL && G.eyeR && !findPart('eye_close').length && anchors.eyeL && anchors.eyeR) {
        var slotEC = SLOTS['eye_close'];
        var mk = function (S, gimg, side) {
          var lash = findPart('eyelash_' + side.toLowerCase())[0] || findPart('eyebrow_' + side.toLowerCase())[0];
          var tint = lash ? meanColorOfImg(lash.img || { data: new Uint8ClampedArray(0) }, false) : null;
          return synthPart('eye_close_' + side.toLowerCase(), gimg,
            (S.x1 - S.x0) * 1.1, (S.x0 + S.x1) / 2, S.closeY, 0.55, tint, slotEC, side);
        };
        var eL = mk(anchors.eyeL, G.eyeL, 'L');
        var eR = mk(anchors.eyeR, G.eyeR, 'R');
        var idxE = lastIndexWhere(parts, function (p) { return p.name.indexOf('eyelash') === 0; });
        if (idxE < 0) idxE = lastIndexWhere(parts, function (p) { return p.name.indexOf('irides') === 0; });
        if (idxE < 0) idxE = lastIndexWhere(parts, function (p) { return p.name === 'face'; });
        parts.splice(idxE + 1, 0, eL, eR);
        synth.eye = true;
        warnings.push('eye_close が無いため汎用閉じ目を自動配置しました（「目」の差分バーで調整可）');
      }
      // mouth
      if (G.mouth && !findPart('mouth_close').length && byName['mouth_open']) {
        var m = anchors.mouth;
        var mc = synthPart('mouth_close', G.mouth,
          (m.x1 - m.x0) * 1.1, m.cx, m.y0 + 0.30 * (m.y1 - m.y0), 0.5,
          (function () { var mo = parts.filter(function (p) { return p.name === 'mouth_open'; })[0];
                         return mo ? meanColorOfImg(mo.img, true) : null; })(),
          SLOTS['mouth_close'], null);
        var idxM = lastIndexWhere(parts, function (p) { return p.name === 'mouth_open'; });
        if (idxM < 0) idxM = lastIndexWhere(parts, function (p) { return p.name === 'face'; });
        parts.splice(idxM + 1, 0, mc);
        synth.mouth = true;
        warnings.push('mouth_close が無いため汎用閉じ口を自動配置しました（「口」のバーで調整可）');
      }
    }
    for (var zi = 0; zi < parts.length; zi++) parts[zi].z = zi;

    return { canvas: { w: W, h: H }, layers: parts, anchors: anchors, warnings: warnings, synth: synth };
  }

  // in-place preprocessing: denoise every layer (connected components >= 40px)
  // and trim to content bbox. Fixes PSDs with low-alpha noise across the canvas.
  function cleanPsdLayers(psd) {
    var stats = { noisy: 0, layers: 0 };
    var kids = (psd.children || []).filter(function (c) { return c.imageData; });
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i], img = c.imageData, W = img.width, H = img.height, d = img.data;
      stats.layers++;
      var a = new Uint8Array(W * H), j, before = 0, after = 0;
      for (j = 0; j < W * H; j++) { a[j] = d[j * 4 + 3]; if (a[j]) before++; }
      cleanAlpha(a, W, H, 40);
      for (j = 0; j < W * H; j++) { if (a[j]) after++; d[j * 4 + 3] = a[j]; }
      if (after < before) stats.noisy++;
      var bb = bboxOf(a, W, H, 0);
      if (!bb) continue;
      var pad = 4;
      var x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
      var x1 = Math.min(W - 1, bb.x1 + pad), y1 = Math.min(H - 1, bb.y1 + pad);
      var w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w >= W && h >= H) continue;
      var nd = new Uint8ClampedArray(w * h * 4);
      for (var y = 0; y < h; y++) {
        var so = ((y + y0) * W + x0) * 4;
        nd.set(d.subarray(so, so + w * 4), y * w * 4);
      }
      c.imageData = { width: w, height: h, data: nd };
      c.left = (c.left | 0) + x0; c.top = (c.top | 0) + y0;
      c.right = c.left + w; c.bottom = c.top + h;
      if (c.canvas) c.canvas = undefined;
    }
    return stats;
  }

  return { buildRig: buildRig, normName: normName, baseName: baseName, cleanPsdLayers: cleanPsdLayers,
           flattenPsdToImg: flattenPsdToImg, splitImgLR: splitImgLR,
           _internals: { findPeaks: findPeaks, detectStrands: detectStrands,
                         labelComponents: labelComponents, cleanAlpha: cleanAlpha } };
});
