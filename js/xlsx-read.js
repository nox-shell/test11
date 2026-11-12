/* ==========================================================================
   XlsxReader — dependency-free .xlsx reader for the browser.

   Reads a workbook straight from its ZIP container, resolves the shared
   string table, and streams the sheet so a large file never has to exist as
   one giant string. Only the columns the tracker needs are kept.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XlsxReader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var utf8 = new TextDecoder('utf-8');

  /* ---------- XML helpers ---------- */

  var NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

  function unescapeXml(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (all, body) {
      if (body.charCodeAt(0) === 35) {
        var code = body.charCodeAt(1) === 120 ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        try { return String.fromCodePoint(code); } catch (e) { return all; }
      }
      return NAMED[body] != null ? NAMED[body] : all;
    });
  }

  /* ---------- ZIP ---------- */

  function readEntries(buffer) {
    var view = new DataView(buffer);
    var size = buffer.byteLength;
    var eocd = -1;
    var floor = Math.max(0, size - 22 - 65535);
    for (var i = size - 22; i >= floor; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .xlsx file: no ZIP directory found.');

    var count = view.getUint16(eocd + 10, true);
    var offset = view.getUint32(eocd + 16, true);
    var entries = new Map();

    for (var n = 0; n < count; n++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      var nameLen = view.getUint16(offset + 28, true);
      var extraLen = view.getUint16(offset + 30, true);
      var commentLen = view.getUint16(offset + 32, true);
      var name = utf8.decode(new Uint8Array(buffer, offset + 46, nameLen));
      entries.set(name, {
        method: view.getUint16(offset + 10, true),
        compressedSize: view.getUint32(offset + 20, true),
        uncompressedSize: view.getUint32(offset + 24, true),
        localOffset: view.getUint32(offset + 42, true),
      });
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function localDataRange(buffer, entry) {
    var view = new DataView(buffer);
    var o = entry.localOffset;
    if (view.getUint32(o, true) !== 0x04034b50) throw new Error('Corrupt ZIP entry.');
    var nameLen = view.getUint16(o + 26, true);
    var extraLen = view.getUint16(o + 28, true);
    var start = o + 30 + nameLen + extraLen;
    return { start: start, end: start + entry.compressedSize };
  }

  /* Streams one ZIP entry as decoded text chunks. */
  async function streamEntry(buffer, entry, onText, totalHint) {
    var range = localDataRange(buffer, entry);
    var raw = new Uint8Array(buffer, range.start, range.end - range.start);
    var total = entry.uncompressedSize || totalHint || raw.length;
    var loaded = 0;

    if (entry.method === 0) {
      var text = utf8.decode(raw);
      await onText(text, raw.length, total);
      return;
    }
    if (entry.method !== 8) throw new Error('Unsupported ZIP compression method ' + entry.method + '.');
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot decompress .xlsx files (DecompressionStream is missing).');
    }

    // A Blob keeps the whole compressed entry from being copied into the stream.
    var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    var reader = stream.getReader();
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      loaded += step.value.length;
      await onText(utf8.decode(step.value, { stream: true }), loaded, total);
    }
    var tail = utf8.decode();
    if (tail) await onText(tail, loaded, total);
  }

  /* ---------- sheet selection ---------- */

  function findSheetPath(buffer, entries) {
    if (!entries.has('xl/workbook.xml') || !entries.has('xl/_rels/workbook.xml.rels')) {
      var first = null;
      entries.forEach(function (_, name) {
        if (!first && /^xl\/worksheets\/[^/]+\.xml$/.test(name)) first = name;
      });
      return first;
    }
    return 'xl/worksheets/sheet1.xml';
  }

  /* ---------- shared strings ---------- */

  async function readSharedStrings(buffer, entry, onProgress) {
    var strings = [];
    var carry = '';
    var re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;

    function pushRange(text) {
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        var inner = m[1];
        if (!inner) { strings.push(''); continue; }
        var value = '';
        var tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        var t;
        while ((t = tRe.exec(inner))) value += t[1];
        strings.push(unescapeXml(value));
      }
    }

    await streamEntry(buffer, entry, async function (chunk, loaded, total) {
      carry += chunk;
      var cut = carry.lastIndexOf('</si>');
      if (cut === -1) {
        if (carry.length > 1 << 20) { pushRange(carry); carry = ''; }
        return;
      }
      var ready = carry.slice(0, cut + 5);
      carry = carry.slice(cut + 5);
      pushRange(ready);
      if (onProgress) onProgress(loaded, total);
    }, entry.uncompressedSize);

    if (carry) pushRange(carry);
    return strings;
  }

  /* ---------- cells ---------- */

  function columnOf(attrs) {
    var i = attrs.indexOf('r="');
    if (i === -1) return '';
    var s = i + 3;
    var e = attrs.indexOf('"', s);
    if (e === -1) return '';
    return attrs.slice(s, e).replace(/[0-9]+$/, '');
  }

  function typeOf(attrs) {
    var i = attrs.indexOf('t="');
    if (i === -1) return '';
    var s = i + 3;
    var e = attrs.indexOf('"', s);
    return e === -1 ? '' : attrs.slice(s, e);
  }

  function cellValue(inner, type, strings) {
    if (!inner) return '';
    if (type === 'inlineStr') {
      var value = '';
      var tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      var t;
      while ((t = tRe.exec(inner))) value += t[1];
      return unescapeXml(value);
    }
    var vi = inner.indexOf('<v>');
    if (vi === -1) return '';
    var vj = inner.indexOf('</v>', vi);
    if (vj === -1) return '';
    var raw = inner.slice(vi + 3, vj);
    if (type === 's') {
      var idx = parseInt(raw, 10);
      return strings[idx] == null ? '' : strings[idx];
    }
    return unescapeXml(raw);
  }

  /* ---------- header mapping ---------- */

  function matchHeader(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function resolveColumns(headerCells) {
    var byName = new Map();
    headerCells.forEach(function (cell, col) {
      var key = matchHeader(cell);
      if (key && !byName.has(key)) byName.set(key, col);
    });

    function pick(tests, exclude) {
      for (var i = 0; i < tests.length; i++) {
        var found = null;
        byName.forEach(function (col, key) {
          if (found !== null || col === exclude) return;
          if (tests[i].test(key)) found = col;
        });
        if (found !== null) return found;
      }
      return null;
    }

    var columns = {};
    columns.barcode = pick([/base uom barcode/, /barcode/, /ean/, /gtin/, /upc/]);
    columns.name = pick([/article description/, /product name/, /item description/, /^description$/, /description/, /product/, /name/]);
    columns.brand = pick([/brand name/, /brand/]);
    columns.returnable = pick([/returnable/]);

    // Category, in order of authority:
    //   1. an explicit category column, if the workbook carries one
    //   2. the value beside an "MC Level1" code column (older Choithrams export)
    //   3. the "Description" column, which holds SPREADS / HOUSEWARE / BABY FOOD
    var catCol = pick([/^item category$/, /^item cat$/, /^category$/, /^cat$/, /category/, /department/, /^dept$/], columns.name);
    if (catCol === null) {
      var codeCol = pick([/^mc level ?1$/, /^mc level 1$/]);
      if (codeCol !== null) catCol = nextColumn(codeCol);
    }
    if (catCol === null) catCol = pick([/^description$/, /description/], columns.name);
    columns.category = catCol;

    return columns;
  }

  function nextColumn(col) {
    if (!col) return null;
    var letters = col.split('');
    var i = letters.length - 1;
    while (i >= 0) {
      if (letters[i] !== 'Z') { letters[i] = String.fromCharCode(letters[i].charCodeAt(0) + 1); return letters.join(''); }
      letters[i] = 'A';
      i--;
    }
    return 'A' + letters.join('');
  }

  /* ---------- main ---------- */

  var ROW_RE = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  var CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

  /**
   * @param {ArrayBuffer} buffer
   * @param {{onHeader?:Function, onRow?:Function, onProgress?:Function}} [options]
   * @returns {Promise<{rows:number, skipped:number, columns:object}>}
   */
  async function read(buffer, options) {
    var opts = options || {};
    var onHeader = opts.onHeader || function () {};
    var onRow = opts.onRow || function () {};
    var onProgress = opts.onProgress || function () {};

    var entries = readEntries(buffer);
    var sheetPath = findSheetPath(buffer, entries);
    if (!sheetPath || !entries.has(sheetPath)) throw new Error('No worksheet found inside the workbook.');

    var strings = entries.has('xl/sharedStrings.xml')
      ? await readSharedStrings(buffer, entries.get('xl/sharedStrings.xml'), function (loaded, total) {
          onProgress({ phase: 'strings', loaded: loaded, total: total });
        })
      : [];

    var columns = null;
    var headerScanned = 0;
    var rows = 0;
    var skipped = 0;
    var lastReport = 0;

    var carry = '';
    var done = false;

    async function handleRow(rowXml) {
      if (!rowXml) return;

      if (!columns) {
        headerScanned++;
        var cells = new Map();
        CELL_RE.lastIndex = 0;
        var m;
        while ((m = CELL_RE.exec(rowXml))) {
          var col = columnOf(m[1]);
          cells.set(col, cellValue(m[2], typeOf(m[1]), strings));
        }
        var looksLikeHeader = false;
        cells.forEach(function (value) {
          var key = matchHeader(value);
          if (key === 'barcode' || key.indexOf('barcode') !== -1) looksLikeHeader = true;
        });
        if (looksLikeHeader) {
          columns = resolveColumns(cells);
          if (columns.barcode === null) columns.barcode = 'A';
          if (columns.name === null) columns.name = nextColumn(columns.barcode);
          onHeader(columns);
          return;
        }
        if (headerScanned >= 25) {
          // No header: fall back to the documented two-column layout.
          columns = { barcode: 'A', name: 'B', brand: null, category: null, returnable: null };
          onHeader(columns);
        } else {
          return;
        }
      }

      var record = { barcode: '', name: '', brand: '', category: '', returnable: false };
      CELL_RE.lastIndex = 0;
      var c;
      while ((c = CELL_RE.exec(rowXml))) {
        var letter = columnOf(c[1]);
        if (letter === columns.barcode) {
          record.barcode = cellValue(c[2], typeOf(c[1]), strings);
        } else if (letter === columns.name) {
          record.name = cellValue(c[2], typeOf(c[1]), strings);
        } else if (columns.brand && letter === columns.brand) {
          record.brand = cellValue(c[2], typeOf(c[1]), strings);
        } else if (columns.category && letter === columns.category) {
          record.category = cellValue(c[2], typeOf(c[1]), strings);
        } else if (columns.returnable && letter === columns.returnable) {
          record.returnable = cellValue(c[2], typeOf(c[1]), strings);
        }
      }

      record.barcode = normaliseBarcode(record.barcode);
      record.name = clean(record.name);

      if (!record.barcode) { skipped++; return; }

      record.brand = clean(record.brand);
      record.category = clean(record.category);
      record.returnable = isReturnable(record.returnable);

      rows++;
      await onRow(record, rows);
    }

    await streamEntry(buffer, entries.get(sheetPath), async function (chunk, loaded, total) {
      if (done) return;
      carry += chunk;

      var start = 0;
      var idx;
      while (true) {
        idx = carry.indexOf('</row>', start);
        if (idx === -1) break;
        var end = idx + 6;
        var rowXml = carry.slice(start, end);
        start = end;
        var open = rowXml.indexOf('>');
        var body = open === -1 ? '' : rowXml.slice(open + 1, rowXml.length - 6);
        await handleRow(body);
      }
      carry = carry.slice(start);

      var now = Date.now();
      if (now - lastReport > 120) {
        lastReport = now;
        onProgress({ phase: 'rows', loaded: loaded, total: total, rows: rows });
      }
    }, entries.get(sheetPath).uncompressedSize);

    return { rows: rows, skipped: skipped, columns: columns };
  }

  function clean(value) {
    if (value == null) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function normaliseBarcode(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return '';
    if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
    return s.replace(/[\s'’]/g, '');
  }

  function isReturnable(value) {
    var v = clean(value).toLowerCase();
    if (!v) return false;
    if (v === 'n' || v === 'no' || v === 'false' || v === '0') return false;
    return true;
  }

  return {
    read: read,
    readEntries: readEntries,
    resolveColumns: resolveColumns,
    nextColumn: nextColumn,
    unescapeXml: unescapeXml,
    normaliseBarcode: normaliseBarcode,
    isReturnable: isReturnable,
  };
});
