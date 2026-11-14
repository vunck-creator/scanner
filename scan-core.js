/* scan-core.js — document edge finding + CamScanner-style enhance, built on OpenCV.js.
   API (global ScanCore):
     load()                  -> Promise, resolves when OpenCV is ready (rejects if it can't load)
     ready()                 -> bool
     detect(canvas)          -> {quad:[{x,y}×4] | null, conf:0..100}   quad order TL,TR,BR,BL in canvas pixels
     warp(canvas, quad, max) -> canvas (perspective-corrected, long side ≤ max)
     filter(canvas, mode)    -> canvas  mode: enhance | bw | gray | none
     encode(canvas)          -> Promise<Blob> JPEG, quality tuned for ~150–200 KB per page
*/
(function (g) {
  'use strict';
  let cv = null, loading = null;
  const SC = {};

  SC.ready = () => !!(cv && cv.Mat);
  SC.load = function (url) {
    if (SC.ready()) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const done = m => { cv = m; g.cv = m; res(); };
      const hook = () => {
        const c = g.cv;
        if (!c) return rej(new Error('no cv'));
        if (c instanceof Promise || typeof c.then === 'function') c.then(done, rej);
        else if (c.Mat) done(c);
        else {
          c.onRuntimeInitialized = () => done(c);
          // the runtime may already have started before we hooked in — poll as a backup
          let n = 0; const t = setInterval(() => { if (c.Mat) { clearInterval(t); done(c); } else if (++n > 600) { clearInterval(t); rej(new Error('cv timeout')); } }, 100);
        }
      };
      if (g.cv && g.cv.Mat) return done(g.cv); // note: an element with id="cv" also shows up as window.cv, so check for Mat
      const s = document.createElement('script');
      s.src = url || 'opencv.js'; s.async = true;
      s.onload = hook; s.onerror = () => { loading = null; rej(new Error('opencv load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  };

  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  function scaled(canvas, maxSide) {
    const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const c = mk(Math.max(8, Math.round(canvas.width * s)), Math.max(8, Math.round(canvas.height * s)));
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(canvas, 0, 0, c.width, c.height);
    return { c, s: c.width / canvas.width };
  }
  // Mat bookkeeping: everything allocated through M() is freed by free()
  let pool = [];
  const M = m => (pool.push(m), m);
  const free = () => { pool.forEach(m => { try { m.delete(); } catch (e) {} }); pool = []; };

  /* ======================= edge finding ======================= */
  // Lab image (true units: L 0..100, a/b ±) as Float32 arrays, lightly blurred
  function labOf(rgba) {
    const rgb = M(new cv.Mat()), bl = M(new cv.Mat()), lab = M(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.GaussianBlur(rgb, bl, new cv.Size(5, 5), 0);
    cv.cvtColor(bl, lab, cv.COLOR_RGB2Lab);
    return { lab, w: lab.cols, h: lab.rows, d: new Uint8Array(lab.data) };
  }
  // ΔE between pixel at (x1,y1) and (x2,y2); -1 if out of bounds
  function dE(L, x1, y1, x2, y2) {
    x1 = x1 | 0; y1 = y1 | 0; x2 = x2 | 0; y2 = y2 | 0;
    if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0 || x1 >= L.w || x2 >= L.w || y1 >= L.h || y2 >= L.h) return -1;
    const i = (y1 * L.w + x1) * 3, j = (y2 * L.w + x2) * 3, d = L.d;
    const dl = (d[i] - d[j]) * 0.392, da = d[i + 1] - d[j + 1], db = d[i + 2] - d[j + 2];
    return Math.sqrt(dl * dl + da * da + db * db);
  }
  function lum(L, x, y) { x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= L.w || y >= L.h) return -1; return L.d[(y * L.w + x) * 3] * 0.392; }
  // How well each side of quad sits on a real "step" (paper vs background) — 0..1
  function sideSupport(L, P, Q, cx, cy, off) {
    const vx = Q.x - P.x, vy = Q.y - P.y, len = Math.hypot(vx, vy); if (len < 8) return 0;
    // side lying on the photo's border: the sheet runs out of the frame there. Can't be measured → neutral score.
    const bx = L.w * 0.015, by = L.h * 0.015;
    if ((P.x < bx && Q.x < bx) || (P.x > L.w - bx && Q.x > L.w - bx) || (P.y < by && Q.y < by) || (P.y > L.h - by && Q.y > L.h - by)) {
      // only believable if what touches the border looks like paper (light, colourless) — not keyboard, desk or a yellow sheet
      let ok = 0; const n = 24, cx2 = (cx - (P.x + Q.x) / 2), cy2 = (cy - (P.y + Q.y) / 2), cl = Math.hypot(cx2, cy2) || 1, ix = cx2 / cl * 6, iy = cy2 / cl * 6;
      for (let k = 0; k < n; k++) {
        const t = 0.05 + 0.9 * k / (n - 1), x = (P.x + vx * t + ix) | 0, y = (P.y + vy * t + iy) | 0;
        if (x < 0 || y < 0 || x >= L.w || y >= L.h) continue;
        const i = (y * L.w + x) * 3, l = L.d[i] * 0.392, ch = Math.hypot(L.d[i + 1] - 128, L.d[i + 2] - 128);
        if (l > 68 && ch < 14) ok++;
      }
      return 0.3 * ok / n;
    }
    let nx = -vy / len, ny = vx / len;
    const mx = (P.x + Q.x) / 2, my = (P.y + Q.y) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // outward
    const N = Math.max(16, Math.min(60, Math.round(len / 4)));
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const t = 0.06 + 0.88 * k / (N - 1), px = P.x + vx * t, py = P.y + vy * t;
      // a real paper edge is a step: colour differs at every offset. A printed line only differs close in → take the min.
      let best = 1e9;
      for (const o of off) {
        const e = dE(L, px - nx * o, py - ny * o, px + nx * o, py + ny * o);
        if (e < best) best = e;
      }
      if (best < 0) best = 0;
      let sup = Math.max(0, Math.min(1, (best - 3) / 9));
      // paper is (almost always) lighter than what's around it. If the inside is darker, this is probably a dark
      // printed block / keyboard / shadow edge, not the sheet's edge → count it only a little.
      const o2 = off[off.length - 1], li = lum(L, px - nx * o2, py - ny * o2), lo = lum(L, px + nx * o2, py + ny * o2);
      if (li >= 0 && lo >= 0 && li < lo - 12) sup *= 0.3;
      sum += sup;
    }
    return sum / N;
  }
  function quadScore(L, q, off) {
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    const s = [0, 1, 2, 3].map(i => sideSupport(L, q[i], q[(i + 1) % 4], cx, cy, off));
    const mean = (s[0] + s[1] + s[2] + s[3]) / 4, min = Math.min(...s);
    return { v: 0.65 * mean + 0.35 * min, sides: s };
  }
  function inside(q, p, tol) { // p inside convex quad q (clockwise), with tolerance in px
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey) || 1;
      if ((ex * (p.y - a.y) - ey * (p.x - a.x)) / len < -tol) return false;
    }
    return true;
  }
  function area(q) { let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p.x * r.y - r.x * p.y; } return Math.abs(a) / 2; }
  function order(pts) { // -> TL,TR,BR,BL
    const cx = pts.reduce((a, p) => a + p.x, 0) / 4, cy = pts.reduce((a, p) => a + p.y, 0) / 4;
    const s = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)); // clockwise from left
    let tl = 0, best = 1e9; s.forEach((p, i) => { if (p.x + p.y < best) { best = p.x + p.y; tl = i; } });
    return [0, 1, 2, 3].map(k => s[(tl + k) % 4]);
  }
  function plausible(q, w, h) {
    const a = area(q); if (a < w * h * 0.10) return false;
    for (let i = 0; i < 4; i++) {
      const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      const ax = p.x - c.x, ay = p.y - c.y, bx = n.x - c.x, by = n.y - c.y;
      const cr = ax * by - ay * bx; if (cr > 0) return false; // must stay convex (clockwise)
      const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) + 1e-9)))) * 180 / Math.PI;
      if (ang < 45 || ang > 135) return false;
      if (c.x < -w * 0.08 || c.y < -h * 0.08 || c.x > w * 1.08 || c.y > h * 1.08) return false;
    }
    return true;
  }
  function contourQuads(edges, out, w, h) {
    const cs = M(new cv.MatVector()), hi = M(new cv.Mat());
    cv.findContours(edges, cs, hi, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < cs.size(); i++) {
      const c = cs.get(i);
      if (cv.contourArea(c) < w * h * 0.08 && cv.arcLength(c, true) < (w + h) * 0.6) { c.delete(); continue; }
      const hull = new cv.Mat(); cv.convexHull(c, hull, false, true);
      const per = cv.arcLength(hull, true);
      for (const e of [0.02, 0.035, 0.05, 0.08]) {
        const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, e * per, true);
        if (ap.rows === 4) {
          const d = ap.data32S; const q = order([{ x: d[0], y: d[1] }, { x: d[2], y: d[3] }, { x: d[4], y: d[5] }, { x: d[6], y: d[7] }]);
          if (plausible(q, w, h)) out.push(q);
          ap.delete(); break;
        }
        ap.delete();
      }
      hull.delete(); c.delete();
    }
  }
  function lineX(a, b) { // intersect lines in (rho,theta)
    const c1 = Math.cos(a.t), s1 = Math.sin(a.t), c2 = Math.cos(b.t), s2 = Math.sin(b.t), den = c1 * s2 - s1 * c2;
    if (Math.abs(den) < 1e-6) return null;
    return { x: (a.r * s2 - b.r * s1) / den, y: (b.r * c1 - a.r * c2) / den };
  }
  function houghQuads(edges, out, w, h) {
    const lines = M(new cv.Mat());
    cv.HoughLines(edges, lines, 1, Math.PI / 180, Math.round(Math.min(w, h) * 0.18));
    const ls = [];
    for (let i = 0; i < lines.rows && ls.length < 48; i++) {
      let r = lines.data32F[i * 2], t = lines.data32F[i * 2 + 1];
      if (r < 0) { r = -r; t -= Math.PI; }
      if (ls.some(l => Math.abs(l.r - r) < 12 && Math.min(Math.abs(l.t - t), Math.PI * 2 - Math.abs(l.t - t)) < 0.09)) continue;
      ls.push({ r, t });
    }
    const isH = l => Math.abs(Math.sin(l.t)) > 0.7071;
    // the photo's own borders count as possible sides (sheet bigger than the frame)
    const H = ls.filter(isH).slice(0, 16).concat([{ r: 0, t: Math.PI / 2 }, { r: h - 1, t: Math.PI / 2 }]);
    const V = ls.filter(l => !isH(l)).slice(0, 16).concat([{ r: 0, t: 0 }, { r: w - 1, t: 0 }]);
    for (let a = 0; a < H.length; a++) for (let b = a + 1; b < H.length; b++)
      for (let c = 0; c < V.length; c++) for (let d = c + 1; d < V.length; d++) {
        const p = [lineX(H[a], V[c]), lineX(H[a], V[d]), lineX(H[b], V[d]), lineX(H[b], V[c])];
        if (p.some(x => !x)) continue;
        const q = order(p); if (plausible(q, w, h)) out.push(q);
      }
  }
  // nudge corners to sit exactly on the paper edge
  function refine(L, q, step, rad, off) {
    q = q.map(p => ({ ...p }));
    let cur = quadScore(L, q, off).v;
    for (let it = 0; it < 3; it++) {
      let moved = false;
      for (let i = 0; i < 4; i++) {
        const o = q[i]; let bx = o.x, by = o.y;
        for (let dy = -rad; dy <= rad; dy += step) for (let dx = -rad; dx <= rad; dx += step) {
          if (!dx && !dy) continue;
          q[i] = { x: o.x + dx, y: o.y + dy };
          const s = quadScore(L, q, off).v; if (s > cur + 1e-4) { cur = s; bx = q[i].x; by = q[i].y; moved = true; }
        }
        q[i] = { x: bx, y: by };
      }
      if (!moved) break;
    }
    return { q, v: cur };
  }

  SC.detect = function (canvas) {
    if (!SC.ready()) return null;
    try {
      const sm = scaled(canvas, 420), w = sm.c.width, h = sm.c.height;
      const rgba = M(cv.matFromImageData(sm.c.getContext('2d').getImageData(0, 0, w, h)));
      const L = labOf(rgba);
      const ch = M(new cv.MatVector()); cv.split(L.lab, ch);
      const l = M(ch.get(0)), A = M(ch.get(1)), B = M(ch.get(2));
      const e1 = M(new cv.Mat()), e2 = M(new cv.Mat()), e3 = M(new cv.Mat()), all = M(new cv.Mat()), dil = M(new cv.Mat());
      cv.Canny(l, e1, 25, 75); cv.Canny(A, e2, 12, 36); cv.Canny(B, e3, 12, 36);
      cv.bitwise_or(e1, e2, all); cv.bitwise_or(all, e3, all);
      const k = M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
      cv.dilate(all, dil, k);
      const cands = [];
      contourQuads(dil, cands, w, h);
      // bright-region candidate (paper brighter than desk)
      const th = M(new cv.Mat()); cv.threshold(l, th, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      cv.morphologyEx(th, th, cv.MORPH_OPEN, M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))));
      contourQuads(th, cands, w, h);
      houghQuads(all, cands, w, h);
      const off = [3, 6];
      let best = null, bv = -1, braw = 0;
      const scored = cands.map(q => { const v = quadScore(L, q, off).v, a = area(q); return { q, v, a, s: v * (0.6 + 0.4 * Math.sqrt(a / (w * h))) }; });
      for (const c of scored) if (c.s > bv) { bv = c.s; best = c.q; braw = c.v; }
      if (!best) { free(); return { quad: null, conf: 0 }; }
      let r = refine(L, best, 1, 2, off);
      free();
      // second pass at higher resolution for pixel-accurate corners
      const sm2 = scaled(canvas, 1000), f = sm2.s / sm.s;
      const rgba2 = M(cv.matFromImageData(sm2.c.getContext('2d').getImageData(0, 0, sm2.c.width, sm2.c.height)));
      const L2 = labOf(rgba2);
      const r2 = refine(L2, r.q.map(p => ({ x: p.x * f, y: p.y * f })), 1, 3, [4, 8]);
      free();
      const conf = Math.round(Math.max(0, Math.min(1, (r.v - 0.15) / 0.6)) * 100);
      const W = canvas.width, Hh = canvas.height;
      const quad = r2.q.map(p => ({ x: Math.max(0, Math.min(W, p.x / sm2.s)), y: Math.max(0, Math.min(Hh, p.y / sm2.s)) }));
      return { quad, conf };
    } catch (e) { free(); console.warn('detect', e); return { quad: null, conf: 0 }; }
  };

  /* ======================= warp ======================= */
  SC.warp = function (canvas, q, maxSide) {
    maxSide = maxSide || 1850;
    // pull corners ~0.5% inward so no sliver of desk survives along the edges
    const mx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, my = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    q = q.map(p => ({ x: p.x + (mx - p.x) * 0.008, y: p.y + (my - p.y) * 0.008 }));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const s = Math.min(maxSide / Math.max(W, H), 1.25); W = Math.max(1, Math.round(W * s)); H = Math.max(1, Math.round(H * s));
    const src = M(cv.imread(canvas)), dst = M(new cv.Mat());
    const a = M(cv.matFromArray(4, 1, cv.CV_32FC2, [q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y]));
    const b = M(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]));
    const T = M(cv.getPerspectiveTransform(a, b));
    cv.warpPerspective(src, dst, T, new cv.Size(W, H), cv.INTER_AREA, cv.BORDER_REPLICATE);
    const o = mk(W, H); cv.imshow(o, dst); free(); return o;
  };

  /* ======================= enhance ======================= */
  // paper/illumination estimate per channel: shrink, max-filter away the ink, smooth, grow back
  function background(rgb) {
    const W = rgb.cols, H = rgb.rows, s = 360 / Math.max(W, H);
    const sm = M(new cv.Mat()), bg = M(new cv.Mat());
    cv.resize(rgb, sm, new cv.Size(Math.round(W * s), Math.round(H * s)), 0, 0, cv.INTER_AREA);
    const k = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9)));
    cv.dilate(sm, sm, k);
    cv.medianBlur(sm, sm, 9);
    cv.erode(sm, sm, M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5))));
    cv.GaussianBlur(sm, sm, new cv.Size(9, 9), 0);
    cv.resize(sm, bg, new cv.Size(W, H), 0, 0, cv.INTER_CUBIC);
    return bg;
  }
  SC.filter = function (canvas, mode) {
    if (mode === 'none') return canvas;
    const src = M(cv.imread(canvas)), rgb = M(new cv.Mat());
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const bg = background(rgb);
    // divide by background → paper becomes white whatever its colour, shadows gone
    const f = M(new cv.Mat()), fb = M(new cv.Mat()), n = M(new cv.Mat());
    rgb.convertTo(f, cv.CV_32F); bg.convertTo(fb, cv.CV_32F, 1, 1);
    cv.divide(f, fb, n, 255);
    // sharpen (unsharp mask)
    const bl = M(new cv.Mat()); cv.GaussianBlur(n, bl, new cv.Size(0, 0), 1.3);
    cv.addWeighted(n, 1.7, bl, -0.7, 0, n);
    const W = n.cols, H = n.rows, d = n.data32F, out = new Uint8ClampedArray(W * H * 4);
    const lo = 80, hi = 226, span = hi - lo;
    const curve = new Uint8Array(512); // index = value+128 clamp
    for (let i = 0; i < 512; i++) { const v = i - 128; let t = (v - lo) / span; t = t < 0 ? 0 : t > 1 ? 1 : t; curve[i] = Math.round(255 * Math.pow(t, 1.75)); }
    const cl = v => curve[v < -128 ? 0 : v > 383 ? 511 : (v + 128) | 0];
    const ink = v => { let t = (v - 60) / 190; t = t < 0 ? 0 : t > 1 ? 1 : t; return 255 * Math.pow(t, 2.4); };
    if (mode === 'gray' || mode === 'bw') {
      for (let i = 0, j = 0; i < W * H; i++, j += 3) {
        let v = cl(0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]);
        if (mode === 'bw') v = v > 170 ? 255 : v < 110 ? 0 : (v - 110) * 4.25;
        const k = i * 4; out[k] = out[k + 1] = out[k + 2] = v; out[k + 3] = 255;
      }
    } else {
      for (let i = 0, j = 0; i < W * H; i++, j += 3) {
        // tone curve on brightness only, then put the colour back on top → dark blue pen stays blue instead of turning black
        const R = d[j], G = d[j + 1], B = d[j + 2], Y = 0.299 * R + 0.587 * G + 0.114 * B, Yc = cl(Y);
        const c = Math.max(R, G, B) - Math.min(R, G, B);
        // near-neutral → pure gray (kills paper tint & colour noise); real colour (ink, stamps, highlighter) kept & boosted
        // coloured strokes (pen, stamps) get their own, darker curve and richer colour, so faint ballpoint reads like CamScanner
        const w = c < 14 ? 0 : c > 34 ? 1 : (c - 14) / 20;
        const Yi = w ? ink(Y) : 0, Yo = Yc + (Yi - Yc) * w, keep = w * 2.0;
        const k = i * 4; out[k] = Yo + (R - Y) * keep; out[k + 1] = Yo + (G - Y) * keep; out[k + 2] = Yo + (B - Y) * keep; out[k + 3] = 255;
      }
    }
    free();
    const t = trimBox(out, W, H);
    const o = mk(t.w, t.h); o.getContext('2d').putImageData(new ImageData(out, W, H), -t.x, -t.y); return o;
  };
  // after cropping, a thin strip of desk or of the sheets underneath can survive along an edge.
  // Walk in from each side while the line is mostly "not paper"; cut it if it ends within 3.5%.
  function trimBox(px, W, H) {
    const dirty = (x0, y0, dx, dy, n) => { let c = 0, m = 0;
      for (let k = 0; k < n; k += 2) { const i = ((y0 + dy * k) * W + (x0 + dx * k)) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
        m++; if (r + g + b < 600 || Math.max(r, g, b) - Math.min(r, g, b) > 50) c++; }
      return c / m; };
    const walk = (len, f) => { const mx = Math.round(len * 0.035); let i = 0; while (i < mx && f(i) > 0.12) i++; return (i === 0 || i >= mx) ? 0 : Math.min(mx, i + 2); };
    const l = walk(W, i => dirty(i, 0, 0, 1, H)), r = walk(W, i => dirty(W - 1 - i, 0, 0, 1, H));
    const t = walk(H, i => dirty(0, i, 1, 0, W)), b = walk(H, i => dirty(0, H - 1 - i, 1, 0, W));
    return { x: l, y: t, w: W - l - r, h: H - t - b };
  }

  /* ======================= encode ======================= */
  const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
  SC.encode = async function (c) {
    let q = 0.8, b = await toBlob(c, q);
    for (let i = 0; i < 3 && b.size > 210000 && q > 0.45; i++) { q -= 0.1; b = await toBlob(c, q); }
    if (b.size < 110000 && q < 0.9) { const b2 = await toBlob(c, 0.9); if (b2.size <= 210000) b = b2; }
    return b;
  };

  g.ScanCore = SC;
})(window);
