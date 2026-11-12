/* ==========================================================================
   Geometry — maps the on-screen viewfinder onto video pixels.
   Pure functions, no DOM: shared by the app and the test harness.

   The <video> element is `object-fit: cover`, so it is uniformly scaled to
   fill its stage and centre-cropped. A CSS transform (digital zoom) scales it
   further about its centre. Both are centred, so a point maps as:

     stageX = centreX + (videoX - videoWidth/2) * coverScale * zoom
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Geometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function coverScale(stageWidth, stageHeight, videoWidth, videoHeight) {
    if (!videoWidth || !videoHeight) return 0;
    return Math.max(stageWidth / videoWidth, stageHeight / videoHeight);
  }

  /**
   * @param {{stage:{left:number,top:number,width:number,height:number},
   *          viewfinder:{left:number,top:number,width:number,height:number},
   *          videoWidth:number, videoHeight:number,
   *          zoom?:number, padX?:number, padY?:number}} input
   * @returns {{sx:number, sy:number, sw:number, sh:number}|null}
   */
  function toVideoRect(input) {
    var vw = input.videoWidth;
    var vh = input.videoHeight;
    if (!vw || !vh) return null;

    var stage = input.stage;
    var vf = input.viewfinder;
    if (!stage || !vf || !stage.width || !stage.height || !vf.width || !vf.height) return null;

    var zoom = input.zoom > 0 ? input.zoom : 1;
    var scale = coverScale(stage.width, stage.height, vw, vh) * zoom;
    if (!scale) return null;

    var cx = stage.left + stage.width / 2;
    var cy = stage.top + stage.height / 2;

    // A little breathing room so a barcode straddling the edge still lands.
    var padX = vf.width * (input.padX == null ? 0.05 : input.padX);
    var padY = vf.height * (input.padY == null ? 0.14 : input.padY);

    var left = vf.left - padX;
    var right = vf.left + vf.width + padX;
    var top = vf.top - padY;
    var bottom = vf.top + vf.height + padY;

    var sw = (right - left) / scale;
    var sh = (bottom - top) / scale;
    var sx = (left - cx) / scale + vw / 2;
    var sy = (top - cy) / scale + vh / 2;

    if (sw > vw) {
      sx -= (sw - vw) / 2;
      sw = vw;
    }
    if (sh > vh) {
      sy -= (sh - vh) / 2;
      sh = vh;
    }

    sx = Math.max(0, Math.min(vw - sw, sx));
    sy = Math.max(0, Math.min(vh - sh, sy));

    return { sx: sx, sy: sy, sw: sw, sh: sh };
  }

  /** Scale a crop down to `targetWidth`; never upscale (adds no information). */
  function fitScale(sourceWidth, targetWidth) {
    return Math.min(1, targetWidth / sourceWidth);
  }

  return { coverScale: coverScale, toVideoRect: toVideoRect, fitScale: fitScale };
});
