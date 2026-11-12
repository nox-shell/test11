/* ==========================================================================
   Catalog — in-memory product index built from the imported workbook.

   Lookup is a single Map hit, so barcode search is O(1) no matter how large
   the imported list is. Name search runs over a pre-lowercased array.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Catalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create() {
    var items = [];
    var haystack = [];
    var index = new Map();
    var meta = { importedAt: 0, source: '' };

    function add(record) {
      if (!record || !record.barcode) return false;
      if (index.has(record.barcode)) {
        index.set(record.barcode, record);
        return false;
      }
      items.push(record);
      haystack.push(haystackOf(record));
      index.set(record.barcode, record);
      return true;
    }

    function haystackOf(record) {
      return (record.name + ' ' + (record.brand || '') + ' ' + record.barcode).toLowerCase();
    }

    function load(records) {
      items = [];
      haystack = [];
      index = new Map();
      for (var i = 0; i < records.length; i++) add(records[i]);
      return items.length;
    }

    function get(barcode) {
      return index.get(String(barcode || '').trim()) || null;
    }

    function has(barcode) {
      return index.has(String(barcode || '').trim());
    }

    /** @returns {Array} up to `limit` products matching the query. */
    function search(query, limit) {
      var q = String(query || '').trim().toLowerCase();
      if (!q) return [];
      var cap = limit || 50;
      var exact = index.get(q);
      var out = [];
      if (exact) out.push(exact);
      for (var i = 0; i < items.length && out.length < cap; i++) {
        if (exact && items[i] === exact) continue;
        if (haystack[i].indexOf(q) !== -1) out.push(items[i]);
      }
      return out;
    }

    /** Distinct category names carried by the imported products, sorted. */
    function categories() {
      var seen = new Set();
      for (var i = 0; i < items.length; i++) {
        var name = String(items[i].category || '').trim();
        if (name) seen.add(name);
      }
      return Array.from(seen).sort(function (a, b) { return a.localeCompare(b); });
    }

    return {
      add: add,
      load: load,
      get: get,
      has: has,
      search: search,
      categories: categories,
      all: function () { return items; },
      get size() { return items.length; },
      get meta() { return meta; },
      setMeta: function (value) { meta = Object.assign({}, meta, value); },
    };
  }

  return { create: create };
});
