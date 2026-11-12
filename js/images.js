/* ==========================================================================
   Images — product image lookup and local caching.

   Lookup uses the public Open Food Facts API (no key, CORS enabled). The
   downloaded bytes are stored in IndexedDB so an image is fetched once and
   then available offline. When nothing is found the UI offers a photo/upload.
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProductImages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var API = 'https://world.openfoodfacts.org/api/v2/product/';
  var TIMEOUT_MS = 9000;

  var objectUrls = new Map();

  function fetchJson(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    return fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) return null;
      return res.json();
    }).catch(function () {
      clearTimeout(timer);
      return null;
    });
  }

  /** @returns {Promise<{imageUrl:string, name:string, brand:string}|null>} */
  async function lookupOnline(barcode) {
    var code = String(barcode || '').replace(/[^0-9]/g, '');
    if (code.length < 6) return null;
    var json = await fetchJson(API + encodeURIComponent(code) + '.json?fields=product_name,brands,image_front_url,image_url');
    if (!json || json.status !== 1 || !json.product) return null;
    var product = json.product;
    var imageUrl = product.image_front_url || product.image_url || null;
    if (!imageUrl) return null;
    return { imageUrl: imageUrl, name: product.product_name || '', brand: product.brands || '' };
  }

  async function download(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    try {
      var res = await fetch(url, { mode: 'cors', signal: controller.signal });
      if (!res.ok) return null;
      var blob = await res.blob();
      if (!blob || !/^image\//.test(blob.type)) return null;
      return blob;
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function toObjectUrl(barcode, blob) {
    var previous = objectUrls.get(barcode);
    if (previous) URL.revokeObjectURL(previous);
    var url = URL.createObjectURL(blob);
    objectUrls.set(barcode, url);
    return url;
  }

  function cachedUrl(barcode, blob) {
    var existing = objectUrls.get(barcode);
    if (existing) return existing;
    return toObjectUrl(barcode, blob);
  }

  function forget(barcode) {
    var url = objectUrls.get(barcode);
    if (url) {
      URL.revokeObjectURL(url);
      objectUrls.delete(barcode);
    }
  }

  function getDb() {
    return root.DB;
  }

  /** Stored image already in IndexedDB, or null. */
  async function local(barcode) {
    try {
      var row = await getDb().getImage(barcode);
      if (!row || !row.blob) return null;
      return { url: cachedUrl(barcode, row.blob), source: row.source, stored: true };
    } catch (err) {
      return null;
    }
  }

  /**
   * Resolve an image for a barcode: local first, then online (and store it).
   * @returns {Promise<{url:string, source:string, stored:boolean}|null>}
   */
  async function resolve(barcode) {
    var hit = await local(barcode);
    if (hit) return hit;

    var found = await lookupOnline(barcode);
    if (!found || !found.imageUrl) return null;

    var blob = await download(found.imageUrl);
    if (!blob) return null;

    try {
      await getDb().saveImage(barcode, blob, { type: blob.type, source: 'openfoodfacts' });
    } catch (err) { /* still display it */ }

    return { url: toObjectUrl(barcode, blob), source: 'openfoodfacts', stored: true };
  }

  /** Persist a user-supplied photo/upload. */
  async function store(barcode, blob, source) {
    await getDb().saveImage(barcode, blob, { type: blob.type, source: source || 'upload' });
    return { url: toObjectUrl(barcode, blob), source: source || 'upload', stored: true };
  }

  async function remove(barcode) {
    forget(barcode);
    try { await getDb().deleteImage(barcode); } catch (err) { /* ignore */ }
  }

  /** Warm the object-URL cache for every stored image (call once at boot). */
  async function warm() {
    try {
      var rows = await getDb().listImages();
      rows.forEach(function (row) {
        if (row.blob) cachedUrl(row.barcode, row.blob);
      });
      return rows.length;
    } catch (err) {
      return 0;
    }
  }

  return {
    lookupOnline: lookupOnline,
    download: download,
    resolve: resolve,
    local: local,
    store: store,
    remove: remove,
    warm: warm,
    cachedUrl: function (barcode) { return objectUrls.get(barcode) || null; },
  };
});
