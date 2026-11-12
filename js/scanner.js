/* ==========================================================================
   ExpiryScanner — camera barcode capture for the tracker.
   Wraps the camera controller and decoding engine into a small state machine:
   start/stop, torch, camera switch, and a confirmed barcode callback.
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExpiryScanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var FRAME_BUDGET_MS = 34;
  var FULL_FRAME_EVERY = 4;
  var ROI_TARGET_W = 1280;

  function surface() {
    var canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    return {
      canvas: canvas,
      ctx: canvas.getContext('2d', { willReadFrequently: true, alpha: false }),
    };
  }

  /**
   * @param {{video:HTMLVideoElement, guide:HTMLElement,
   *          onDetect:(code:string)=>void,
   *          onStatus?:(status:{state:string, message?:string, engine?:string})=>void}} options
   */
  function create(options) {
    var video = options.video;
    var guide = options.guide;
    var onDetect = options.onDetect || function () {};
    var onStatus = options.onStatus || function () {};

    var camera = root.Camera.create(video);
    var engine = null;
    var confirmer = root.Barcode.createConfirmer({ required: 2, windowMs: 1600, cooldownMs: 2000 });
    var scanning = false;
    var busy = false;
    var frameId = 0;
    var rafId = 0;
    var nextAllowed = 0;
    var pausedUntil = 0;
    var roi = surface();
    var full = surface();
    var torchOn = false;

    function stageRect() {
      var parent = video.parentElement;
      return parent ? parent.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    }

    function guideRect() {
      if (!guide) return null;
      return root.Geometry.toVideoRect({
        stage: stageRect(),
        viewfinder: guide.getBoundingClientRect(),
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        zoom: 1,
      });
    }

    function drawCrop(work, crop, targetW) {
      var vw = video.videoWidth;
      var vh = video.videoHeight;
      var sw = Math.max(8, Math.min(vw, Math.round(crop.sw)));
      var sh = Math.max(8, Math.min(vh, Math.round(crop.sh)));
      var sx = Math.max(0, Math.min(vw - sw, Math.round(crop.sx)));
      var sy = Math.max(0, Math.min(vh - sh, Math.round(crop.sy)));
      var scale = root.Geometry.fitScale(sw, targetW);
      var w = Math.max(8, Math.round(sw * scale));
      var h = Math.max(8, Math.round(sh * scale));

      if (work.canvas.width !== w || work.canvas.height !== h) {
        work.canvas.width = w;
        work.canvas.height = h;
      }
      var ctx = work.ctx;
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
      return { canvas: work.canvas, ctx: ctx, width: w, height: h };
    }

    async function scanOnce() {
      var vw = video.videoWidth;
      var vh = video.videoHeight;
      var frame = ++frameId;
      var g = guideRect();
      var passes = [];

      if (g && g.sw > 32 && g.sh > 20) {
        passes.push({ work: roi, crop: g, targetW: ROI_TARGET_W, hard: true, soft: frame % 3 === 0 });
      }
      if (!g || frame % FULL_FRAME_EVERY === 0) {
        passes.push({
          work: full,
          crop: { sx: 0, sy: 0, sw: vw, sh: vh },
          targetW: ROI_TARGET_W,
          hard: false,
          soft: false,
        });
      }

      for (var i = 0; i < passes.length; i++) {
        var p = passes[i];
        var input = drawCrop(p.work, p.crop, p.targetW);
        var hit = await engine.decode(input, { hard: p.hard, soft: p.soft, enhance: true });
        if (hit) return { hit: hit, frame: frame };
      }
      return null;
    }

    async function tick() {
      if (!scanning || busy) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      if (performance.now() < pausedUntil) return;

      busy = true;
      var started = performance.now();
      var found = null;
      try {
        found = await scanOnce();
      } catch (err) {
        console.warn('[scanner] decode error', err);
      } finally {
        busy = false;
      }

      if (found && scanning) {
        var info = root.Barcode.classify(found.hit.rawValue, found.hit.format);
        if (info.valid) {
          var verdict = confirmer.push(info.code, found.frame);
          if (verdict === 'accepted') {
            pausedUntil = performance.now() + 1400;
            onDetect(info.code, info);
          }
        }
      }

      var cost = performance.now() - started;
      nextAllowed = performance.now() + Math.max(0, FRAME_BUDGET_MS - cost);
    }

    function loop() {
      if (!scanning) return;
      rafId = requestAnimationFrame(loop);
      if (performance.now() < nextAllowed) return;
      tick();
    }

    return {
      get isRunning() { return scanning; },
      get hasTorch() { return camera.hasTorch; },
      get torchOn() { return torchOn; },

      async start() {
        if (scanning) return true;
        onStatus({ state: 'starting' });
        await camera.start();
        if (!engine) {
          engine = root.Decoder.create({ prefer: 'auto' });
          await engine.init();
        }
        confirmer.reset();
        scanning = true;
        frameId = 0;
        nextAllowed = 0;
        pausedUntil = 0;
        rafId = requestAnimationFrame(loop);
        onStatus({
          state: 'running',
          engine: engine.engineName,
          width: video.videoWidth,
          height: video.videoHeight,
          torch: camera.hasTorch,
        });
        return true;
      },

      stop() {
        scanning = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        camera.stop();
        onStatus({ state: 'idle' });
      },

      async toggleTorch() {
        if (!camera.hasTorch) return false;
        torchOn = !torchOn;
        var ok = await camera.setTorch(torchOn);
        if (!ok) torchOn = false;
        return ok;
      },

      async switchCamera() {
        var wasRunning = scanning;
        scanning = false;
        if (rafId) cancelAnimationFrame(rafId);
        await camera.switchTo();
        torchOn = false;
        if (wasRunning) {
          scanning = true;
          nextAllowed = 0;
          rafId = requestAnimationFrame(loop);
        }
        return { torch: camera.hasTorch, width: video.videoWidth, height: video.videoHeight };
      },
    };
  }

  return { create: create };
});
