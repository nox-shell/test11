/* ==========================================================================
   Enhance — per-frame image conditioning for the software decoder.
   Produces a conditioned luminance plane: percentile contrast stretch plus an
   optional unsharp pass that makes faint print readable without destroying
   bar edges. Also used to write a normalised frame back for the native path.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Enhance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var cache = { a: null, b: null };

  function buffer(slot, size) {
    var buf = cache[slot];
    if (!buf || buf.length !== size) {
      buf = new Uint8ClampedArray(size);
      cache[slot] = buf;
    }
    return buf;
  }

  /**
   * Conditioned luminance plane (one byte per pixel).
   *
   * @param {{data:Uint8ClampedArray, width:number, height:number}} imageData
   * @param {{clip?:number, sharpen?:number, gain?:number, normalize?:boolean}} [options]
   *        clip      fraction of pixels trimmed at each end of the histogram
   *        sharpen   0..1 unsharp-mask strength (0 disables the pass)
   *        gain      extra multiplicative contrast after the stretch
   *        normalize false to only convert to grayscale
   * @returns {Uint8ClampedArray} length === width * height
   */
  function luminance(imageData, options) {
    var opts = options || {};
    var data = imageData.data;
    var w = imageData.width;
    var h = imageData.height;
    var n = w * h;
    if (!n) return new Uint8ClampedArray(0);

    var luma = buffer('a', n);
    var i, p, l;

    for (i = 0, p = 0; i < n; i++, p += 4) {
      luma[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }

    if (opts.normalize === false) return luma;

    var clip = opts.clip == null ? 0.012 : opts.clip;
    var gain = opts.gain == null ? 1 : opts.gain;

    var hist = new Uint32Array(256);
    for (i = 0; i < n; i++) hist[luma[i]]++;

    // Percentile window: ignores specular highlights and deep shadow.
    var loCut = n * clip;
    var hiCut = n * clip;
    var acc = 0;
    var lo = 0;
    var hi = 255;
    for (i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= loCut) { lo = i; break; }
    }
    acc = 0;
    for (i = 255; i >= 0; i--) {
      acc += hist[i];
      if (acc >= hiCut) { hi = i; break; }
    }

    var span = hi - lo;
    if (span < 24) {
      // Flat or near-flat frame: stretching would only amplify sensor noise.
      lo = 0;
      span = 255;
    } else if (span < 64) {
      // Low contrast but usable: soften the stretch so noise stays bounded.
      var mid = (lo + hi) / 2;
      lo = Math.max(0, mid - span * 0.8);
      span = Math.min(255, span * 1.6);
    }

    var scale = (255 / span) * gain;
    var lut = new Uint8ClampedArray(256);
    for (i = 0; i < 256; i++) lut[i] = (i - lo) * scale;

    for (i = 0; i < n; i++) luma[i] = lut[luma[i]];

    var sharpen = opts.sharpen || 0;
    if (sharpen > 0) {
      var out = buffer('b', n);
      var amount = Math.min(1, sharpen) * 0.85;
      for (var y = 0; y < h; y++) {
        var base = y * w;
        var up = y > 0 ? base - w : base;
        var dn = y < h - 1 ? base + w : base;
        for (var x = 0; x < w; x++) {
          var c = luma[base + x];
          var lft = x > 0 ? luma[base + x - 1] : c;
          var rgt = x < w - 1 ? luma[base + x + 1] : c;
          // Unsharp mask: centre minus the 4-neighbour mean.
          out[base + x] = c + amount * (4 * c - lft - rgt - luma[up + x] - luma[dn + x]) * 0.5;
        }
      }
      luma = out;
    }

    return luma;
  }

  /** Condition the frame and write it back as a grey RGBA image (native path). */
  function apply(imageData, options) {
    var luma = luminance(imageData, options);
    var data = imageData.data;
    for (var i = 0, p = 0; i < luma.length; i++, p += 4) {
      var v = luma[i];
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
    return imageData;
  }

  /** Mean / standard deviation of the luminance — used to flag a dark frame. */
  function stats(imageData) {
    var data = imageData.data;
    var n = data.length >> 2;
    if (!n) return { mean: 0, contrast: 0 };
    var sum = 0;
    var sumSq = 0;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var l = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
      sum += l;
      sumSq += l * l;
    }
    var mean = sum / n;
    return { mean: mean, contrast: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
  }

  return { luminance: luminance, apply: apply, stats: stats };
});
