/* ==========================================================================
   Decoder — decoding engine with a native fast path and a ZXing fallback.
   Returns raw reads; validation happens in Barcode.classify().
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Decoder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var WANTED = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

  function zxing() {
    return root.ZXing || null;
  }

  function blankCanvas() {
    var doc = root.document;
    if (!doc) return null;
    var c = doc.createElement('canvas');
    c.width = 48;
    c.height = 48;
    return c;
  }

  function toLuma(img) {
    var n = img.width * img.height;
    var out = new Uint8ClampedArray(n);
    var d = img.data;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      out[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    return out;
  }

  function pickLargest(results) {
    var best = null;
    var bestArea = -1;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!r || !r.rawValue) continue;
      var box = r.boundingBox;
      var area = box ? box.width * box.height : 0;
      if (area > bestArea) {
        bestArea = area;
        best = r;
      }
    }
    if (!best) return null;
    return {
      rawValue: best.rawValue,
      format: (best.format || '').toLowerCase() || null,
      engine: 'native',
      points: best.cornerPoints || null,
    };
  }

  /**
   * @param {{prefer?: 'native'|'zxing'|'auto'}} [options]
   */
  function create(options) {
    var opts = options || {};
    var prefer = opts.prefer || 'auto';
    var detector = null;
    var readers = null;
    var formatMap = null;
    var engineName = 'ZXing';

    function initZXing() {
      var z = zxing();
      if (!z) return false;

      var base = new Map();
      base.set(z.DecodeHintType.POSSIBLE_FORMATS, [
        z.BarcodeFormat.EAN_13,
        z.BarcodeFormat.EAN_8,
        z.BarcodeFormat.UPC_A,
        z.BarcodeFormat.UPC_E,
      ]);
      base.set(z.DecodeHintType.ASSUME_GS1, false);

      var hard = new Map(base);
      hard.set(z.DecodeHintType.TRY_HARDER, true);

      var mk = function (hints) {
        var r = new z.MultiFormatReader();
        r.setHints(hints);
        return r;
      };

      readers = { fast: mk(base), hard: mk(hard) };
      formatMap = {};
      formatMap[z.BarcodeFormat.EAN_13] = 'ean_13';
      formatMap[z.BarcodeFormat.EAN_8] = 'ean_8';
      formatMap[z.BarcodeFormat.UPC_A] = 'upc_a';
      formatMap[z.BarcodeFormat.UPC_E] = 'upc_e';
      return true;
    }

    async function initNative() {
      var Detector = root.BarcodeDetector;
      if (!Detector) return false;
      var supported;
      try {
        supported = await Detector.getSupportedFormats();
      } catch (err) {
        return false;
      }
      if (!supported || supported.indexOf('ean_13') === -1) return false;

      // Only register formats the platform actually lists. Chrome reports a
      // UPC-A symbol as EAN-13 with a leading zero when upc_a is unavailable,
      // which Barcode.classify() maps back to UPC-A.
      var formats = WANTED.filter(function (f) {
        return supported.indexOf(f) !== -1;
      });

      try {
        detector = new Detector({ formats: formats, tryHarder: true });
      } catch (err) {
        detector = null;
        return false;
      }

      // A platform can advertise the API and still fail at runtime.
      var probe = blankCanvas();
      if (probe) {
        try {
          await detector.detect(probe);
        } catch (err) {
          detector = null;
          return false;
        }
      }
      return !!detector;
    }

    var engine = {
      engineName: engineName,

      async init() {
        if (prefer !== 'zxing' && (await initNative())) {
          engineName = 'Native';
          try {
            initZXing(); // kept warm for the software fallback and for macro passes
          } catch (err) {
            readers = null;
          }
          engine.engineName = engineName;
          return { engine: engineName, native: true };
        }
        if (!initZXing()) {
          throw new Error('Barcode engine unavailable: vendor/zxing.min.js did not load.');
        }
        engineName = 'ZXing';
        engine.engineName = engineName;
        return { engine: engineName, native: false };
      },

      get native() {
        return !!detector;
      },

      /**
       * Decode one prepared frame.
       *
       * @param {{canvas?:HTMLCanvasElement, ctx:CanvasRenderingContext2D,
       *          width:number, height:number}} input
       * @param {{hard?:boolean, soft?:boolean, enhance?:boolean, sharpen?:number}} [pass]
       * @returns {Promise<{rawValue:string, format:string|null, engine:string}|null>}
       */
      async decode(input, pass) {
        var p = pass || {};
        if (detector) {
          var hit = await engine._native(input, p);
          if (hit) return hit;
          // Software retry is opt-in: it costs far more than the native path.
          if (p.soft && readers) return engine._zxing(input, p);
          return null;
        }
        return engine._zxing(input, p);
      },

      async _native(input, p) {
        if (!input.canvas) return null;
        var results;
        try {
          results = await detector.detect(input.canvas);
        } catch (err) {
          detector = null; // Stop trusting the native path for this session.
          return null;
        }
        if (results && results.length) return pickLargest(results);
        // Skip the extra canvas round-trip when the software engine will
        // condition and rescan this frame anyway.
        if (p.enhance === false || p.soft) return null;
        return engine._nativeEnhanced(input, p);
      },

      async _nativeEnhanced(input, p) {
        var enhance = root.Enhance;
        if (!enhance || !input.ctx) return null;
        var img;
        try {
          img = input.ctx.getImageData(0, 0, input.width, input.height);
        } catch (err) {
          return null;
        }
        enhance.apply(img, { sharpen: p.sharpen || 0 });
        input.ctx.putImageData(img, 0, 0);
        try {
          var results = await detector.detect(input.canvas);
          if (results && results.length) return pickLargest(results);
        } catch (err) {
          detector = null;
        }
        return null;
      },

      _zxing(input, p) {
        if (!readers) return null;
        var z = zxing();
        if (!z) return null;

        var img = input.imageData;
        if (!img) {
          if (!input.ctx) return null;
          try {
            img = input.ctx.getImageData(0, 0, input.width, input.height);
          } catch (err) {
            return null;
          }
        }

        // ZXing's RGBLuminanceSource treats a byte array as a pre-computed
        // luminance plane, so hand it exactly that — no extra conversion.
        var enhance = root.Enhance;
        var luma = enhance
          ? enhance.luminance(img, { sharpen: p.sharpen || 0, normalize: p.enhance !== false })
          : toLuma(img);

        var reader = p.hard ? readers.hard : readers.fast;
        try {
          var source = new z.RGBLuminanceSource(luma, img.width, img.height);
          var bitmap = new z.BinaryBitmap(new z.HybridBinarizer(source));
          var res = reader.decodeWithState(bitmap);
          var text = res.getText();
          if (!text) return null;
          return {
            rawValue: text,
            format: formatMap[res.getBarcodeFormat()] || null,
            engine: 'zxing',
          };
        } catch (err) {
          reader.reset();
          return null;
        }
      },

      reset() {
        if (readers) {
          readers.fast.reset();
          readers.hard.reset();
        }
      },
    };

    return engine;
  }

  return { create: create, WANTED: WANTED };
});
