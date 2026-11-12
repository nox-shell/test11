/* ==========================================================================
   DB — IndexedDB persistence.

   Stores
     catalog : barcode -> { barcode, name, brand, category, returnable }
     records : barcode -> short-expiry record  (keying on barcode prevents dupes)
     images  : barcode -> { barcode, blob, type, source, updatedAt }
     meta    : key     -> value
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DB = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DB_NAME = 'choithrams-expiry';
  var DB_VERSION = 1;
  var STORES = ['catalog', 'records', 'images', 'meta'];

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = root.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        STORES.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'barcode' });
          }
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB unavailable.')); };
      req.onblocked = function () { reject(new Error('Database is blocked by another tab.')); };
    });
    return dbPromise;
  }

  function run(storeName, mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var result;
        try {
          result = work(store, tx);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = function () { resolve(result && result.__request ? result.value : result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transaction aborted.')); };
      });
    });
  }

  function request(store, method, args) {
    var req = store[method].apply(store, args || []);
    var box = { __request: true, value: undefined };
    req.onsuccess = function () { box.value = req.result; };
    return box;
  }

  function get(storeName, key) {
    return run(storeName, 'readonly', function (store) {
      return request(store, 'get', [key]);
    });
  }

  function getAll(storeName) {
    return run(storeName, 'readonly', function (store) {
      return request(store, 'getAll');
    });
  }

  function put(storeName, value) {
    return run(storeName, 'readwrite', function (store) {
      store.put(value);
    });
  }

  function del(storeName, key) {
    return run(storeName, 'readwrite', function (store) {
      store.delete(key);
    });
  }

  /* ---------- catalog ---------- */

  async function putCatalogBatch(items) {
    if (!items.length) return;
    await run('catalog', 'readwrite', function (store) {
      for (var i = 0; i < items.length; i++) store.put(items[i]);
    });
  }

  async function clearCatalog() {
    await run('catalog', 'readwrite', function (store) { store.clear(); });
  }

  function countCatalog() {
    return run('catalog', 'readonly', function (store) {
      return request(store, 'count');
    });
  }

  /* ---------- records ---------- */

  function listRecords() {
    return getAll('records');
  }

  function saveRecord(record) {
    return put('records', record);
  }

  function deleteRecord(barcode) {
    return del('records', barcode);
  }

  /* ---------- images ---------- */

  function saveImage(barcode, blob, meta) {
    return put('images', {
      barcode: barcode,
      blob: blob,
      type: (meta && meta.type) || blob.type || 'image/jpeg',
      source: (meta && meta.source) || 'upload',
      updatedAt: Date.now(),
    });
  }

  function getImage(barcode) {
    return get('images', barcode);
  }

  function deleteImage(barcode) {
    return del('images', barcode);
  }

  function listImages() {
    return getAll('images');
  }

  /* ---------- meta ---------- */

  async function getMeta(key, fallback) {
    var row = await get('meta', key);
    return row ? row.value : fallback;
  }

  function setMeta(key, value) {
    return put('meta', { key: key, value: value });
  }

  function clearAll() {
    return Promise.all(STORES.map(function (name) {
      return run(name, 'readwrite', function (store) { store.clear(); });
    }));
  }

  return {
    open: open,
    get: get,
    getAll: getAll,
    put: put,
    del: del,
    putCatalogBatch: putCatalogBatch,
    clearCatalog: clearCatalog,
    countCatalog: countCatalog,
    listRecords: listRecords,
    saveRecord: saveRecord,
    deleteRecord: deleteRecord,
    saveImage: saveImage,
    getImage: getImage,
    deleteImage: deleteImage,
    listImages: listImages,
    getMeta: getMeta,
    setMeta: setMeta,
    clearAll: clearAll,
  };
});
