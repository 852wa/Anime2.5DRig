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
  // Aliases are keyed by a "squashed" form (NFKC, lower case, no spaces,
  // underscores, hyphens or middle dots) so that "Front_Hair", "front-hair",
  // "前髪" and "bangs" all resolve to the same semantic slot.
  var ALIAS_GROUPS = {
    'front hair':  'fronthair hairfront bangs fringe 前髪 まえがみ',
    'back hair':   'backhair hairback 後ろ髪 後髪 うしろがみ',
    'side hair':   'sidehair hairside sidelock sidelocks 横髪 サイド髪 もみあげ',
    'ahoge':       'ahoge アホ毛 あほ毛',
    'hair':        'hair 髪 髪の毛 かみ',
    'face':        'face 顔 かお 輪郭 facebase',
    'facedetail':  'facedetail blush cheek cheeks 頬 頬染め チーク',
    'eyewhite':    'eyewhite eyewhites sclera 白目',
    'irides':      'irides iris irises pupil pupils 瞳 黒目 虹彩',
    'eyelash':     'eyelash eyelashes lash lashes eyeline まつ毛 まつげ 睫毛 アイライン',
    'eyebrow':     'eyebrow eyebrows brow brows 眉 眉毛 まゆ まゆげ',
    'eye_close':   'eyeclose eyeclosed eyesclosed closedeye closedeyes 閉じ目 目閉じ 閉眼',
    'mouth_open':  'mouthopen openmouth 口 開き口 口開き 開口',
    'mouth_close': 'mouthclose mouthclosed closedmouth 閉じ口 口閉じ',
    'nose':        'nose 鼻 はな',
    'ears':        'ears ear 耳',
    'earwear':     'earwear earring earrings イヤリング ピアス 耳飾り',
    'neck':        'neck 首',
    'neckwear':    'neckwear necktie tie necklace choker ネクタイ ネックレス チョーカー 首飾り',
    'topwear':     'topwear top tops shirt body torso clothes 服 上着 体 胴体 上半身 トップス',
    'bottomwear':  'bottomwear bottom bottoms skirt pants スカート ズボン ボトムス 下半身',
    'handwear':    'handwear hand hands arm arms gloves 手 腕 手袋',
    'legwear':     'legwear leg legs socks tights 脚 足 靴下 ソックス タイツ',
    'footwear':    'footwear shoes shoe boots 靴 ブーツ',
    'headwear':    'headwear hat cap hairpin hairband 帽子 カチューシャ 髪飾り ヘアピン',
    'eyewear':     'eyewear glasses 眼鏡 メガネ めがね',
    'tail':        'tail しっぽ 尻尾 シッポ',
    'wings':       'wings wing 羽 翼 羽根',
    'objects':     'objects object 小物 持ち物'
  };
  var ALIASES = Object.create(null);
  Object.keys(ALIAS_GROUPS).forEach(function (canon) {
    ALIAS_GROUPS[canon].split(' ').forEach(function (a) { ALIASES[squash(a)] = canon; });
  });
  function squash(s) { return String(s).replace(/[\s_\-・･.]+/g, ''); }
  function canonical(base) { return ALIASES[squash(base)] || null; }

  function normName(n) {
    n = String(n || '').normalize('NFKC').trim()
      .replace(/\s*のコピー\s*\d*$/, '').replace(/\s+copy(\s*\d+)?$/i, '')
      .toLowerCase().replace(/\s+/g, ' ');
    // Legacy and special names first.
    if (n === 'eyelash_c') return 'eye_close';
    if (n === 'mouth_c') return 'mouth_close';
    if (n === 'レイヤー 1') return 'facedetail';
    if (n === 'mouth' || /^mouth[ _-]?\d+$/.test(n)) return 'mouth_open';   // see-through raw output
    // "eye_close2" / "eyeclose2" / "閉じ目2" select the long closed-eye variant.
    // A separator before the number ("eye_close_2") is a numbered part instead.
    if (/^(eye_?close|eye close|閉じ目)2$/.test(n)) return 'eye_close2';
    var direct = canonical(n);
    if (direct) return direct;
    var m = /^(.+?)[ _-]?(\d+)$/.exec(n);
    if (m) {
      var base = canonical(m[1].trim()) || (SLOTS[m[1].trim()] ? m[1].trim() : null);
      if (base) return base + '_' + m[2];
    }
    return n;
  }
  function baseName(n) { return n === 'eye_close2' ? n : n.replace(/_\d+$/, ''); }

  // PSD folders are only an authoring convenience.  Leaf coordinates emitted by
  // ag-psd are canvas-relative, so flattening the tree does not alter placement.
  function imageLayersOf(psd) {
    var out = [];
    function visit(nodes, parentVisible) {
      (nodes || []).forEach(function (c) {
        var visible = parentVisible && c.hidden !== true;
        if (!visible) return;
        if (c.children) visit(c.children, visible);
        else if (c.imageData) out.push(c);
      });
    }
    visit(psd.children, true);
    return out;
  }

  function validatePsd(psd) {
    if (!psd || !Number.isInteger(psd.width) || !Number.isInteger(psd.height) || psd.width < 2 || psd.height < 2)
      throw new Error('PSDのキャンバスサイズが不正です');
    if (psd.width * psd.height > 24000000 || Math.max(psd.width, psd.height) > 16384)
      throw new Error('キャンバスが大きすぎます（最大2400万画素・一辺16384px）');
    var pixels = 0, count = 0;
    function visit(nodes, depth) {
      if (depth > 64) throw new Error('フォルダの階層が深すぎます');
      (nodes || []).forEach(function (c) {
        if (++count > 1000) throw new Error('レイヤー数が多すぎます（最大1000）');
        if (c.children) visit(c.children, depth + 1);
        var w = c.imageData ? c.imageData.width : Math.max(0, (c.right || 0) - (c.left || 0));
        var h = c.imageData ? c.imageData.height : Math.max(0, (c.bottom || 0) - (c.top || 0));
        if (!Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0 || w * h > 24000000)
          throw new Error('画像レイヤーのサイズが不正または過大です');
        pixels += w * h;
        if (c.imageData && (!c.imageData.data || c.imageData.data.length !== w * h * 4))
          throw new Error('画像レイヤーの画素データが不正です');
      });
    }
    visit(psd.children, 0);
    if (pixels > 96000000) throw new Error('レイヤー画像の合計が大きすぎます（最大9600万画素）');
    return psd;
  }

  var SLOTS = {
    'wings':       { depth: 0.48, group: 'body' },
    'tail':        { depth: 0.50, group: 'body', phys: 'sway' },
    'back hair':   { depth: 0.55, group: 'head', phys: 'hair' },
    'footwear':    { depth: 0.83, group: 'body' },
    'legwear':     { depth: 0.84, group: 'body' },
    'bottomwear':  { depth: 0.88, group: 'body' },
    'neck':        { depth: 0.95, group: 'body' },
    'topwear':     { depth: 0.90, group: 'body' },
    'neckwear':    { depth: 0.98, group: 'body' },
    'handwear':    { depth: 0.86, group: 'body' },
    'objects':     { depth: 1.00, group: 'auto' },
    'earwear':     { depth: 0.97, group: 'head', phys: 'sway' },
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
    'eye_close2':  { depth: 1.12, group: 'head', split: true, fade: 'eyeClose2' },
    'eyewear':     { depth: 1.18, group: 'head' },
    'side hair':   { depth: 1.22, group: 'head', phys: 'hair' },
    'front hair':  { depth: 1.28, group: 'head', phys: 'hair' },
    'ahoge':       { depth: 1.30, group: 'head', phys: 'hair' }
  };
  // Human readable role names used by the editor and diagnostics.
  var ROLE_LABELS = {
    'wings': '翼', 'tail': '尻尾', 'back hair': '後髪', 'footwear': '靴', 'legwear': '脚',
    'bottomwear': '下半身の服', 'neck': '首', 'topwear': '上半身の服', 'neckwear': '首元',
    'handwear': '腕・手', 'objects': '小物', 'earwear': '耳飾り', 'ears': '耳', 'face': '顔',
    'facedetail': '顔の細部', 'headwear': '頭の飾り', 'mouth_close': '閉じ口', 'mouth_open': '開き口',
    'nose': '鼻', 'eyewhite': '白目', 'eyebrow': '眉', 'irides': '瞳', 'eyelash': 'まつ毛',
    'eye_close': '閉じ目', 'eye_close2': '長い閉じ目', 'eyewear': '眼鏡', 'side hair': '横髪',
    'front hair': '前髪', 'ahoge': 'アホ毛'
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

  function mergeAlphas(entries, W, H) {
    if (!entries || !entries.length) return null;
    var out = new Uint8Array(W * H);
    for (var e = 0; e < entries.length; e++) {
      var a = entries[e].alpha;
      for (var i = 0; i < out.length; i++) if (a[i] > out[i]) out[i] = a[i];
    }
    return out;
  }

  // ---------- generic close-diff synthesis ----------
  function resampleRGBA(src, tw, th) {   // bilinear
    var out = new Uint8ClampedArray(tw * th * 4);
    var sw = src.width, sh = src.height, d = src.data;
    for (var y = 0; y < th; y++) {
      var sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * sh / th - 0.5));
      var y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
      for (var x = 0; x < tw; x++) {
        var sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * sw / tw - 0.5));
        var x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
        var o = (y * tw + x) * 4;
        var ids = [(y0 * sw + x0) * 4, (y0 * sw + x1) * 4, (y1 * sw + x0) * 4, (y1 * sw + x1) * 4];
        var ws = [(1-fx)*(1-fy), fx*(1-fy), (1-fx)*fy, fx*fy], a = 0;
        for (var k = 0; k < 4; k++) a += d[ids[k]+3] * ws[k];
        out[o+3] = a;
        for (var c = 0; c < 3; c++) {
          var value = 0;
          for (var q = 0; q < 4; q++) value += d[ids[q]+c] * d[ids[q]+3] * ws[q];
          out[o+c] = a ? value/a : 0;
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
    return { name: name, source: '', x: Math.round(cx - tw / 2), y: Math.round(anchorY - vAlign * th),
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
    validatePsd(psd);
    var W = psd.width, H = psd.height;
    var buf = new Uint8ClampedArray(W * H * 4);
    imageLayersOf(psd).forEach(function (c) {
      if (!c.imageData) return;
      var img = c.imageData, lw = img.width, lh = img.height, lx = c.left | 0, ly = c.top | 0, d = img.data;
      for (var y = 0; y < lh; y++) {
        var cy = y + ly; if (cy < 0 || cy >= H) continue;
        for (var x = 0; x < lw; x++) {
          var cx = x + lx; if (cx < 0 || cx >= W) continue;
          var si = (y * lw + x) * 4, di = (cy * W + cx) * 4, a = d[si + 3] / 255 * (c.opacity == null ? 1 : c.opacity);
          if (!a) continue;
          var da = buf[di+3]/255, oa = a + da*(1-a);
          for (var k = 0; k < 3; k++) buf[di + k] = (d[si+k]*a + buf[di+k]*da*(1-a))/oa;
          buf[di + 3] = oa * 255;
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
    for (i = 1; i < n - 1; i++) {
      if (!(a[i] > a[i - 1] && a[i] >= a[i + 1])) continue;
      // A flat top (common after box smoothing of narrow parts) peaks at its centre.
      var e = i; while (e + 1 < n && a[e + 1] === a[i]) e++;
      if (e + 1 < n && a[e + 1] > a[i]) continue;
      cand.push((i + e) >> 1); i = e;
    }
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
        var inset = Math.min(30, (maxX - minX) / 4);
        var cx = Math.round(minX + inset + (maxX - minX - 2 * inset) * t / 39);
        if (cx < 0 || cx >= W || top[cx] < 0) continue;
        var dmin = 1e9;
        for (var m = 0; m < xs.length; m++) dmin = Math.min(dmin, Math.abs(cx - xs[m]));
        if (xs.length === 0) dmin = 1e9 - t;
        if (dmin > bestD) { bestD = dmin; best = cx; }
      }
      if (best < 0 || (xs.length && bestD < Math.max(1, minSep))) break;
      xs.push(best);
    }
    xs.sort(function (a, b) { return a - b; });
    var strands = [], used = Object.create(null);
    for (var s = 0; s < xs.length; s++) {
      var sx = xs[s];
      // Smoothing can move a peak off the painted columns; snap to the nearest one.
      for (var r = 0; top[sx] < 0 && r < W; r++) {
        if (xs[s] - r >= 0 && top[xs[s] - r] >= 0) sx = xs[s] - r;
        else if (xs[s] + r < W && top[xs[s] + r] >= 0) sx = xs[s] + r;
      }
      if (top[sx] < 0 || used[sx]) continue;
      used[sx] = true;
      strands.push({ x: sx, tipY: bottom[sx], rootY: top[sx] });
    }
    strands.sort(function (a, b) { return a.x - b.x; });
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
      name: name, source: String(layer.name == null ? '' : layer.name), x: x0, y: y0, w: w, h: h, z: z,
      depth: slot.depth, group: slot.group, phys: slot.phys || null,
      opacity: layer.opacity == null ? 1 : Math.max(0, Math.min(1, layer.opacity)),
      fade: slot.fade || null, side: side || null, strands: strands || null,
      img: { width: w, height: h, data: data }
    };
  }

  // ---------- main ----------
  function buildRig(psd, opts) {
    opts = opts || {};
    validatePsd(psd);
    var W = psd.width, H = psd.height;
    var warnings = [];
    var kids = imageLayersOf(psd);
    if (!kids.length) throw new Error('表示可能な画像レイヤーが見つかりません');
    if (kids.length * W * H > 128000000) throw new Error('リグ解析に必要なメモリが大きすぎます。レイヤー数または解像度を減らしてください');

    // full alphas, cleaned
    var entries = [];
    for (var i = 0; i < kids.length; i++) {
      var name = normName(kids[i].name);
      var fa = cleanAlpha(fullAlphaOf(kids[i], W, H), W, H, 40);
      if (!bboxOf(fa, W, H, 8)) { warnings.push('空のレイヤー "' + name + '" をスキップしました'); continue; }
      entries.push({ name: name, layer: kids[i], alpha: fa });
    }
    if (!entries.length) throw new Error('キャンバス内に表示可能な画素がありません');
    // A plain "hair" layer is split by the painter's order: above the face it
    // is front hair, below it back hair (see-through emits both as "hair").
    var faceIndex = -1;
    for (var fi = 0; fi < entries.length; fi++) if (baseName(entries[fi].name) === 'face') { faceIndex = fi; break; }
    entries.forEach(function (e, idx) {
      if (baseName(e.name) !== 'hair') return;
      var suffix = e.name.slice(4);
      e.name = (faceIndex >= 0 && idx > faceIndex ? 'front hair' : 'back hair') + suffix;
    });
    var byBase = Object.create(null);
    entries.forEach(function (e) {
      var bn = baseName(e.name);
      (byBase[bn] || (byBase[bn] = [])).push(e);
    });
    function merged(name) { return mergeAlphas(byBase[name], W, H); }

    // face anchor (required-ish)
    var faceAlpha = merged('face');
    var FACE;
    if (faceAlpha) {
      var fb = bboxOf(faceAlpha, W, H, 8), fc = centroidOf(faceAlpha, W, H);
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
      var slot = Object.prototype.hasOwnProperty.call(SLOTS, bn) ? SLOTS[bn] : null;
      if (!slot || slot.group === 'auto') {
        var c0 = centroidOf(e.alpha, W, H);
        var guessed = (c0 && c0.cy < FACE.y1) ? 'head' : 'body';
        if (!slot) warnings.push('未知のレイヤー名 "' + e.name + '" — ' + (guessed === 'head' ? '頭' : '体') + 'に追従させます');
        slot = { depth: slot ? slot.depth : 1.0, group: guessed, unknown: !slot };
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
            var sideKey = bn + '|' + s;
            if (!sided[sideKey]) sided[sideKey] = ma;
            else for (var mq = 0; mq < ma.length; mq++) if (ma[mq] > sided[sideKey][mq]) sided[sideKey][mq] = ma[mq];
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
      } else if (slot.phys === 'sway') {
        // Earrings, tails: a few pendulums hanging from the top of the part.
        var bb3 = bboxOf(e.alpha, W, H, 16);
        var wpx3 = bb3 ? (bb3.x1 - bb3.x0) : 0;
        var want3 = Math.max(1, Math.min(4, Math.round(wpx3 / 140)));
        var sway = detectStrands(e.alpha, W, H, Math.max(20, Math.round(wpx3 / (want3 * 1.6))), want3);
        var rec4 = makePart(e.name, e.layer, e.alpha, null, W, H, slot, z, null, sway);
        if (rec4) { parts.push(rec4); z++; }
      } else {
        var rec3 = makePart(e.name, e.layer, e.alpha, null, W, H, slot, z, null, null);
        if (rec3) { if (slot.unknown) rec3.unknown = true; parts.push(rec3); z++; }
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

    var mouthAlpha = merged('mouth_open') || merged('mouth_close');
    if (mouthAlpha) {
      var mb = bboxOf(mouthAlpha, W, H, 8), mc = centroidOf(mouthAlpha, W, H);
      anchors.mouth = { x0: mb.x0, x1: mb.x1, y0: mb.y0, y1: mb.y1, cx: mc.cx, cy: mc.cy };
    } else {
      warnings.push('mouth_open / mouth_close がありません');
      anchors.mouth = { x0: FACE.cx - 20, x1: FACE.cx + 20, y0: FACE.cy + 40, y1: FACE.cy + 60, cx: FACE.cx, cy: FACE.cy + 50 };
    }

    var neckAlpha = merged('neck');
    if (neckAlpha) {
      var nb = bboxOf(neckAlpha, W, H, 8), nc = centroidOf(neckAlpha, W, H);
      anchors.neckPivot = { cx: nc.cx, cy: nb.y0 + (nb.y1 - nb.y0) * 0.85 };
      anchors.neckTop = nb.y0; anchors.neckBottom = nb.y1;
    } else {
      anchors.neckPivot = { cx: FACE.cx, cy: FACE.y1 + 20 };
      anchors.neckTop = FACE.y1; anchors.neckBottom = FACE.y1 + 60;
    }
    anchors.bodyPivot = { cx: anchors.neckPivot.cx, cy: H };
    anchors.faceScale = Math.max(1, FACE.x1 - FACE.x0) / 333.0;
    anchors.hairRootY = FACE.y0 + 60;

    // ---------- synthesize missing close diffs from generic parts ----------
    var synth = { eye: false, mouth: false };
    var G = opts.generic;
    if (G) {
      var partBase = function (p) { return baseName(p.name.replace(/_(l|r)$/, '')); };
      var findPart = function (name) { return parts.filter(function (p) { return partBase(p) === name; }); };
      // eyes
      if (G.eyeL || G.eyeR) {
        var slotEC = SLOTS['eye_close'];
        var mk = function (S, gimg, side) {
          var lash = findPart('eyelash').find(function(p){return p.side === side;}) || findPart('eyebrow').find(function(p){return p.side === side;});
          var tint = lash ? meanColorOfImg(lash.img || { data: new Uint8ClampedArray(0) }, false) : null;
          return synthPart('eye_close_' + side.toLowerCase(), gimg,
            (S.x1 - S.x0) * 1.1, (S.x0 + S.x1) / 2, S.closeY, 0.55, tint, slotEC, side);
        };
        var idxE = lastIndexWhere(parts, function (p) { return p.name.indexOf('eyelash') === 0; });
        if (idxE < 0) idxE = lastIndexWhere(parts, function (p) { return p.name.indexOf('irides') === 0; });
        if (idxE < 0) idxE = lastIndexWhere(parts, function (p) { return p.name === 'face'; });
        ['L', 'R'].forEach(function(side) {
          if (G['eye'+side] && anchors['eye'+side] && !findPart('eye_close').some(function(p){return p.side===side;})) {
            parts.splice(++idxE, 0, mk(anchors['eye'+side], G['eye'+side], side));
            synth.eye = true;
          }
        });
        if (synth.eye) warnings.push('不足する閉じ目を自動配置しました（「目」の差分バーで調整可）');
      }
      // mouth
      if (G.mouth && !findPart('mouth_close').length && merged('mouth_open')) {
        var m = anchors.mouth;
        var mc = synthPart('mouth_close', G.mouth,
          (m.x1 - m.x0) * 1.1, m.cx, m.y0 + 0.30 * (m.y1 - m.y0), 0.5,
          (function () { var mo = findPart('mouth_open')[0];
                         return mo ? meanColorOfImg(mo.img, true) : null; })(),
          SLOTS['mouth_close'], null);
        var idxM = lastIndexWhere(parts, function (p) { return partBase(p) === 'mouth_open'; });
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
    validatePsd(psd);
    var stats = { noisy: 0, layers: 0 };
    var kids = imageLayersOf(psd);
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

  function roleLabel(bn) { return ROLE_LABELS[bn] || null; }

  return { buildRig: buildRig, normName: normName, baseName: baseName, cleanPsdLayers: cleanPsdLayers, validatePsd: validatePsd,
           flattenPsdToImg: flattenPsdToImg, splitImgLR: splitImgLR, roleLabel: roleLabel,
           SLOT_NAMES: Object.keys(SLOTS),
           _internals: { findPeaks: findPeaks, detectStrands: detectStrands,
                         labelComponents: labelComponents, cleanAlpha: cleanAlpha,
                         imageLayersOf: imageLayersOf, mergeAlphas: mergeAlphas, resampleRGBA: resampleRGBA } };
});
