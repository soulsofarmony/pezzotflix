// S2 (throwaway): wraps the unmodified libpgs worker and reports every canvas update.
// For each batch of 2D-context calls (one libpgs render) it posts
// {op:'probe', t0, t1, puts, clears, canvasPixels, w, h}; times are absolute ms (timeOrigin + now).
// canvasPixels = non-transparent pixels actually on the OffscreenCanvas after the render (sampled 1 px in 4).
(() => {
'use strict';
const abs = () => performance.timeOrigin + performance.now();
const P = OffscreenCanvasRenderingContext2D.prototype;
let cur = null;
function batch(ctx) {
  if (!cur) {
    cur = { op: 'probe', t0: abs(), puts: 0, clears: 0, canvasPixels: 0, w: 0, h: 0 };
    const b = cur;
    setTimeout(() => {
      const c = ctx.canvas; b.w = c.width; b.h = c.height;
      try {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++;
        b.canvasPixels = n * 4;
      } catch (e) { b.canvasPixels = -1; b.err = String(e); }
      b.t1 = abs(); cur = null; postMessage(b);
    }, 0);
  }
  return cur;
}
const put = P.putImageData;
P.putImageData = function (...a) { batch(this).puts++; return put.apply(this, a); };
const clr = P.clearRect;
P.clearRect = function (...a) { batch(this).clears++; return clr.apply(this, a); };
})(); // own scope: libpgs.worker.js declares top-level names too
importScripts('out/vendor/libpgs.worker.js');
