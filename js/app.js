/* ==========================================================================
   Choithrams · Short Expiry Tracker — application layer
   ========================================================================== */
(function () {
  'use strict';

  var DB = window.DB;
  var Rules = window.Rules;
  var Catalog = window.Catalog;
  var XlsxReader = window.XlsxReader;
  var XlsxWriter = window.XlsxWriter;
  var ProductImages = window.ProductImages;
  var ExpiryScanner = window.ExpiryScanner;

  var AUTO_SOURCES = ['all.xlsx', 'list all.xlsx', 'data/all.xlsx'];
  var BATCH_SIZE = 3000;

  /* ---------------------------------------------------------------- state */

  var state = {
    catalog: Catalog.create(),
    records: [],
    recordMap: new Map(),
    images: new Map(),
    view: 'all',
    returnFilter: 'all',
    query: '',
    draft: null,
    editing: null,
    scanner: null,
    imageToken: 0,
    importing: false,
  };

  /* ------------------------------------------------------------------ dom */

  function $(id) { return document.getElementById(id); }

  var el = {
    nav: $('nav'),
    catalogCount: $('catalogCount'),
    catalogMeta: $('catalogMeta'),
    importBtn: $('importBtn'),
    importFile: $('importFile'),
    storageNote: $('storageNote'),

    pageTitle: $('pageTitle'),
    pageSub: $('pageSub'),
    searchInput: $('searchInput'),
    exportShortBtn: $('exportShortBtn'),
    exportAllBtn: $('exportAllBtn'),

    stats: document.querySelectorAll('.stat'),

    cameraBtn: $('cameraBtn'),
    cameraBtnText: $('cameraBtnText'),
    torchBtn: $('torchBtn'),
    flipBtn: $('flipBtn'),
    scanner: $('scanner'),
    video: $('video'),
    scanGuide: $('scanGuide'),
    scannerStatus: $('scannerStatus'),

    barcodeForm: $('barcodeForm'),
    barcodeInput: $('barcodeInput'),

    product: $('product'),
    productImage: $('productImage'),
    productMediaEmpty: $('productMediaEmpty'),
    productMediaText: $('productMediaText'),
    productImageBadge: $('productImageBadge'),
    photoBtn: $('photoBtn'),
    uploadBtn: $('uploadBtn'),
    refetchBtn: $('refetchBtn'),
    photoInput: $('photoInput'),
    uploadInput: $('uploadInput'),

    lookupFlag: $('lookupFlag'),
    nameInput: $('nameInput'),
    barcodeDisplay: $('barcodeDisplay'),
    expiryInput: $('expiryInput'),
    categoryInput: $('categoryInput'),
    categoryOptions: $('categoryOptions'),
    editCategoryOptions: $('editCategoryOptions'),
    leadInput: $('leadInput'),
    returnableInput: $('returnableInput'),
    returnableHint: $('returnableHint'),
    previewShort: $('previewShort'),
    previewDays: $('previewDays'),
    previewRule: $('previewRule'),
    previewStatus: $('previewStatus'),
    saveBtn: $('saveBtn'),
    cancelBtn: $('cancelBtn'),

    recordsTitle: $('recordsTitle'),
    recordsCount: $('recordsCount'),
    filterChips: $('filterChips'),
    returnFilter: $('returnFilter'),
    recordsTable: $('recordsTable'),
    recordsBody: $('recordsBody'),
    recordsEmpty: $('recordsEmpty'),
    emptyText: $('emptyText'),

    editModal: $('editModal'),
    editImage: $('editImage'),
    editName: $('editName'),
    editBarcode: $('editBarcode'),
    editCategory: $('editCategory'),
    editExpiry: $('editExpiry'),
    editLead: $('editLead'),
    editReturnable: $('editReturnable'),
    editShort: $('editShort'),
    editDays: $('editDays'),
    editStatus: $('editStatus'),
    editSave: $('editSave'),
    editDelete: $('editDelete'),

    importOverlay: $('importOverlay'),
    importTitle: $('importTitle'),
    importText: $('importText'),
    importBar: $('importBar'),
    importMeta: $('importMeta'),
    importCancel: $('importCancel'),

    toasts: $('toasts'),
  };

  /* --------------------------------------------------------------- helpers */

  function toast(message, tone) {
    var node = document.createElement('div');
    node.className = 'toast';
    if (tone) node.dataset.tone = tone;
    node.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .25s ease, transform .25s ease';
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      setTimeout(function () { node.remove(); }, 260);
    }, 2800);
  }

  function number(value) {
    return Number(value || 0).toLocaleString();
  }

  function formatDays(days) {
    if (days == null) return '—';
    if (days < 0) return '−' + Math.abs(days) + ' d';
    return days + ' d';
  }

  /**
   * Offer the categories that exist in the imported list as suggestions.
   * The field stays free text, so a category can still be typed by hand.
   */
  function fillCategoryOptions() {
    var names = state.catalog.categories();
    [el.categoryOptions, el.editCategoryOptions].forEach(function (list) {
      if (!list) return;
      list.replaceChildren();
      names.forEach(function (name) {
        var option = document.createElement('option');
        option.value = name;
        list.appendChild(option);
      });
    });
  }

  /** Category text shown next to the rule, e.g. "BABY FOOD & MILK · 3 months". */
  function categoryLabel(category) {
    var name = String(category == null ? '' : category).trim();
    if (!name) return 'Uncategorised';
    var meta = Rules.categoryById(name);
    return meta ? meta.label : name;
  }

  /* ------------------------------------------------------------ boot / db */

  async function boot() {
    renderAll();

    try {
      await DB.open();
    } catch (err) {
      toast('Storage is unavailable — changes will not persist.', 'error');
      el.storageNote.textContent = 'Storage unavailable';
    }

    await loadRecords();
    await ProductImages.warm();
    await refreshImageCache();

    var count = await DB.countCatalog();
    if (count > 0) {
      el.catalogMeta.textContent = 'Loading index…';
      await loadCatalogFromDb();
      fillCategoryOptions();
      var meta = await DB.getMeta('catalog', {});
      el.catalogMeta.textContent = meta.importedAt
        ? 'Updated ' + new Date(meta.importedAt).toLocaleDateString()
        : 'Ready';
    } else {
      await tryAutoImport();
    }

    renderAll();
  }

  async function loadRecords() {
    try {
      state.records = await DB.listRecords();
    } catch (err) {
      state.records = [];
    }
    state.recordMap = new Map();
    state.records.forEach(function (record) { state.recordMap.set(record.barcode, record); });
  }

  async function loadCatalogFromDb() {
    try {
      var rows = await DB.getAll('catalog');
      state.catalog.load(rows);
      el.catalogCount.textContent = number(state.catalog.size);
    } catch (err) {
      el.catalogMeta.textContent = 'Load failed';
    }
  }

  async function refreshImageCache() {
    state.images = new Map();
    try {
      var rows = await DB.listImages();
      rows.forEach(function (row) {
        // Reuse the object URL ProductImages already created in warm().
        var url = ProductImages.cachedUrl(row.barcode);
        if (url) state.images.set(row.barcode, url);
      });
    } catch (err) { /* ignore */ }
  }

  /* -------------------------------------------------------------- importing */

  async function tryAutoImport() {
    el.catalogMeta.textContent = 'Looking for the workbook…';
    for (var i = 0; i < AUTO_SOURCES.length; i++) {
      var url = AUTO_SOURCES[i];
      try {
        var res = await fetch(encodeURI(url), { cache: 'no-store' });
        if (!res.ok) continue;
        var blob = await res.blob();
        if (blob.size < 512) continue;
        await importWorkbook(blob, url);
        return true;
      } catch (err) { /* try the next candidate */ }
    }
    el.catalogMeta.textContent = 'No workbook found';
    el.catalogCount.textContent = '—';
    toast('Import the Excel file to build the product database.', 'error');
    return false;
  }

  /**
   * Parse a workbook and rebuild the catalog. Expiry records, images and
   * manually typed product names live in other stores and are never touched.
   */
  async function importWorkbook(blob, label) {
    if (state.importing) return;
    state.importing = true;
    showImportOverlay(label || 'workbook');

    var started = Date.now();
    var batch = [];
    var seen = 0;

    try {
      await DB.clearCatalog();
      state.catalog.load([]);

      var buffer = await blob.arrayBuffer();
      var result = await XlsxReader.read(buffer, {
        onHeader: function (columns) {
          setImportMeta({ columns: columns });
        },
        onRow: async function (record) {
          seen++;
          var item = {
            barcode: record.barcode,
            name: record.name,
            brand: record.brand || '',
            category: record.category || '',
            returnable: !!record.returnable,
          };
          if (state.catalog.add(item)) batch.push(item);
          if (batch.length >= BATCH_SIZE) {
            var chunk = batch.splice(0, batch.length);
            await DB.putCatalogBatch(chunk);
          }
        },
        onProgress: function (info) {
          setImportProgress(info);
        },
      });

      if (batch.length) await DB.putCatalogBatch(batch);

      var now = Date.now();
      await DB.setMeta('catalog', {
        importedAt: now,
        rows: result.rows,
        count: state.catalog.size,
        source: label || '',
        columns: result.columns,
      });

      el.catalogCount.textContent = number(state.catalog.size);
      el.catalogMeta.textContent = 'Updated ' + new Date(now).toLocaleDateString();
      el.storageNote.textContent = number(result.rows) + ' rows read in ' +
        ((now - started) / 1000).toFixed(1) + 's';

      finishImportOverlay(
        'Database ready',
        number(state.catalog.size) + ' products indexed.',
        'Columns: ' + describeColumns(result.columns)
      );
      toast(number(state.catalog.size) + ' products imported', 'ok');
      fillCategoryOptions();
      renderAll();
    } catch (err) {
      console.error('[import]', err);
      finishImportOverlay('Import failed', (err && err.message) || 'The workbook could not be read.', '');
      toast('Import failed: ' + (err && err.message ? err.message : 'unknown error'), 'error');
      el.catalogMeta.textContent = 'Import failed';
    } finally {
      state.importing = false;
      if (batch.length) {
        try { await DB.putCatalogBatch(batch); } catch (err) { /* ignore */ }
      }
    }
  }

  function describeColumns(columns) {
    if (!columns) return 'unknown';
    var parts = [];
    if (columns.barcode) parts.push('barcode ' + columns.barcode);
    if (columns.name) parts.push('name ' + columns.name);
    if (columns.category) parts.push('category ' + columns.category);
    return parts.join(' · ') || 'unknown';
  }

  function showImportOverlay(label) {
    el.importOverlay.hidden = false;
    el.importTitle.textContent = 'Importing product database';
    el.importText.textContent = 'Reading ' + label + '…';
    el.importBar.style.width = '0%';
    el.importMeta.textContent = '—';
    el.importCancel.hidden = true;
  }

  function setImportProgress(info) {
    if (!info || !info.total) return;
    var pct = Math.min(100, Math.round((info.loaded / info.total) * 100));
    if (info.phase === 'strings') {
      el.importText.textContent = 'Reading the shared string table…';
      el.importBar.style.width = Math.round(pct * 0.18) + '%';
      el.importMeta.textContent = pct + '%';
    } else {
      el.importText.textContent = 'Indexing products…';
      el.importBar.style.width = Math.round(18 + pct * 0.82) + '%';
      el.importMeta.textContent = number(info.rows || 0) + ' rows · ' + pct + '%';
    }
  }

  function setImportMeta(info) {
    if (info && info.columns) {
      el.importText.textContent = 'Columns detected: ' + describeColumns(info.columns);
    }
  }

  function finishImportOverlay(title, text, meta) {
    el.importTitle.textContent = title;
    el.importText.textContent = text;
    el.importMeta.textContent = meta || '';
    el.importBar.style.width = '100%';
    el.importCancel.hidden = false;
    setTimeout(function () {
      if (!state.importing) el.importOverlay.hidden = true;
    }, 1400);
  }

  /* --------------------------------------------------------------- lookup */

  async function lookup(rawBarcode) {
    var barcode = String(rawBarcode || '').trim();
    if (!barcode) return;
    el.barcodeInput.value = barcode;

    var product = state.catalog.get(barcode);
    var existing = state.recordMap.get(barcode);

    state.draft = existing
      ? Object.assign({}, existing)
      : {
          barcode: barcode,
          name: product ? product.name : '',
          category: product ? product.category : '',
          returnable: product ? product.returnable : false,
          expiry: '',
          leadOverride: null,
        };

    el.product.hidden = false;
    el.barcodeDisplay.value = barcode;

    if (product) {
      el.lookupFlag.dataset.tone = 'found';
      el.lookupFlag.textContent = 'Found in database · ' + product.name;
    } else if (existing) {
      el.lookupFlag.dataset.tone = 'info';
      el.lookupFlag.textContent = 'Saved record · not in the current database';
    } else {
      el.lookupFlag.dataset.tone = 'missing';
      el.lookupFlag.textContent = 'BARCODE NOT FOUND — enter the product name below';
    }

    el.nameInput.value = state.draft.name || '';
    el.categoryInput.value = state.draft.category || '';
    el.returnableInput.checked = !!state.draft.returnable;
    el.expiryInput.value = state.draft.expiry || '';
    el.leadInput.value = state.draft.leadOverride || '';
    el.saveBtn.textContent = existing ? 'Update record' : 'Save to short expiry list';

    updatePreview();
    await resolveImage(barcode, product, false);

    // Only steal focus when the camera is not in the way.
    if (!state.draft.expiry && (!state.scanner || !state.scanner.isRunning)) {
      el.expiryInput.focus();
    }
  }

  async function resolveImage(barcode, product, force) {
    if (!force) {
      var cached = state.images.get(barcode);
      if (cached) {
        setProductImage(cached, 'Saved');
        return;
      }
      var local = await ProductImages.local(barcode);
      if (local) {
        state.images.set(barcode, local.url);
        setProductImage(local.url, 'Saved');
        return;
      }
    }

    var token = ++state.imageToken;
    el.productMediaText.textContent = 'Searching…';
    el.productImageBadge.hidden = true;
    // Keep the "Searching…" text visible only while no image is on screen.
    if (el.productImage.hidden) el.productMediaEmpty.hidden = false;

    var found = await ProductImages.resolve(barcode);
    if (token !== state.imageToken) return;

    if (found) {
      state.images.set(barcode, found.url);
      setProductImage(found.url, 'Online');
    } else {
      el.productMediaText.textContent = product ? 'No image found' : 'No image found';
      setProductImage(null);
    }
  }

  function setProductImage(url, badge) {
    if (url) {
      el.productImage.src = url;
      el.productImage.hidden = false;
      el.productMediaEmpty.hidden = true;
      el.productImageBadge.hidden = !badge;
      el.productImageBadge.textContent = badge || '';
    } else {
      el.productImage.hidden = true;
      el.productImage.removeAttribute('src');
      el.productMediaEmpty.hidden = false;
      el.productImageBadge.hidden = true;
    }
  }

  function readDraftFromForm() {
    if (!state.draft) return null;
    var lead = parseFloat(el.leadInput.value);
    return {
      barcode: state.draft.barcode,
      name: el.nameInput.value.trim(),
      category: el.categoryInput.value.trim(),
      returnable: el.returnableInput.checked,
      expiry: el.expiryInput.value || '',
      leadOverride: isFinite(lead) && lead > 0 ? Math.round(lead) : null,
    };
  }

  function updatePreview() {
    var draft = readDraftFromForm();
    if (!draft) return;

    var result = Rules.evaluate(draft);
    el.previewShort.textContent = result.shortDate ? Rules.toISODate(result.shortDate) : '—';
    el.previewDays.textContent = result.daysLeft == null ? '—' : formatDays(result.daysLeft);

    if (draft.leadOverride) {
      el.previewRule.textContent = 'Manual · ' + draft.leadOverride + ' days';
    } else if (result.rule && result.rule.source === 'returnable') {
      el.previewRule.textContent = 'Returnable · 30 days';
    } else {
      el.previewRule.textContent = categoryLabel(draft.category) + ' · ' +
        result.rule.summary.replace(' before expiry', '');
    }

    el.returnableHint.textContent = draft.returnable
      ? 'Applies the 30-day rule (overrides category)'
      : 'Applies the ' + result.rule.summary;

    if (!draft.expiry) {
      el.previewStatus.dataset.tone = 'muted';
      el.previewStatus.textContent = 'Set an expiry date';
    } else {
      el.previewStatus.dataset.tone = result.statusMeta.tone;
      el.previewStatus.textContent = result.statusMeta.label +
        (result.daysLeft != null ? ' · ' + formatDays(result.daysLeft) + ' remaining' : '');
    }
  }

  async function saveDraft() {
    var draft = readDraftFromForm();
    if (!draft) return;

    if (!draft.name) {
      toast('Enter a product name before saving.', 'error');
      el.nameInput.focus();
      return;
    }
    if (!draft.expiry) {
      toast('Choose the expiry date.', 'error');
      el.expiryInput.focus();
      return;
    }

    var existing = state.recordMap.get(draft.barcode);
    var record = Object.assign({}, draft, {
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
      imageSource: state.images.has(draft.barcode) ? 'stored' : '',
    });

    try {
      await DB.saveRecord(record);
    } catch (err) {
      toast('Could not save the record.', 'error');
      return;
    }

    upsertRecord(record);
    renderAll();

    var evaluation = Rules.evaluate(record);
    toast(
      existing ? 'Record updated' : 'Added to the short expiry list',
      evaluation.status === 'expired' ? 'error' : 'ok'
    );

    el.product.hidden = true;
    state.draft = null;
    el.barcodeInput.value = '';
    el.barcodeInput.focus();
  }

  function upsertRecord(record) {
    var index = -1;
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].barcode === record.barcode) { index = i; break; }
    }
    if (index >= 0) state.records[index] = record;
    else state.records.push(record);
    state.recordMap.set(record.barcode, record);
  }

  async function removeRecord(barcode) {
    try {
      await DB.deleteRecord(barcode);
    } catch (err) {
      toast('Could not remove the record.', 'error');
      return;
    }
    state.records = state.records.filter(function (r) { return r.barcode !== barcode; });
    state.recordMap.delete(barcode);
    if (state.draft && state.draft.barcode === barcode) {
      el.product.hidden = true;
      state.draft = null;
    }
    renderAll();
    toast('Record removed');
  }

  /* ------------------------------------------------------------- rendering */

  function decorated() {
    return state.records.map(function (record) {
      return { record: record, result: Rules.evaluate(record) };
    });
  }

  function visibleRows() {
    var query = state.query.toLowerCase();
    return decorated()
      .filter(function (row) {
        if (state.view !== 'all' && row.result.status !== state.view) return false;
        if (state.returnFilter === 'returnable' && !row.record.returnable) return false;
        if (state.returnFilter === 'nonreturnable' && row.record.returnable) return false;
        if (query) {
          var hay = (row.record.name + ' ' + row.record.barcode).toLowerCase();
          if (hay.indexOf(query) === -1) return false;
        }
        return true;
      })
      .sort(function (a, b) {
        var da = a.result.daysLeft == null ? 1e9 : a.result.daysLeft;
        var db = b.result.daysLeft == null ? 1e9 : b.result.daysLeft;
        if (da !== db) return da - db;
        return String(a.record.name).localeCompare(String(b.record.name));
      });
  }

  function renderAll() {
    var rows = decorated();
    var counts = { tracked: rows.length, short: 0, expired: 0, soon: 0, safe: 0, returnable: 0, nonreturnable: 0 };
    rows.forEach(function (row) {
      counts[row.result.status] = (counts[row.result.status] || 0) + 1;
      if (row.record.returnable) counts.returnable++;
      else counts.nonreturnable++;
    });

    var stats = {
      catalog: state.catalog.size,
      tracked: counts.tracked,
      short: counts.short,
      expired: counts.expired,
      returnable: counts.returnable,
      nonreturnable: counts.nonreturnable,
    };
    Object.keys(stats).forEach(function (key) {
      var nodes = document.querySelectorAll('[data-stat="' + key + '"]');
      nodes.forEach(function (node) { node.textContent = number(stats[key]); });
    });

    document.querySelectorAll('[data-count]').forEach(function (node) {
      node.textContent = number(counts[node.dataset.count] || 0);
    });

    el.catalogCount.textContent = state.catalog.size ? number(state.catalog.size) : '—';

    renderTable();
    syncViewUi();
  }

  function syncViewUi() {
    document.querySelectorAll('.nav__item').forEach(function (node) {
      node.classList.toggle('is-active', node.dataset.view === state.view);
    });
    document.querySelectorAll('.chip[data-view]').forEach(function (node) {
      node.classList.toggle('is-active', node.dataset.view === state.view);
    });
    el.stats.forEach(function (node) {
      var metric = node.dataset.metric;
      var active = (metric === state.view) ||
        (metric === 'returnable' && state.returnFilter === 'returnable') ||
        (metric === 'nonreturnable' && state.returnFilter === 'nonreturnable');
      node.classList.toggle('is-active', active);
    });

    var titles = {
      all: ['Overview', 'Every saved record, most urgent first.'],
      short: ['Short Expiry', 'Products that have reached their short-expiry threshold.'],
      expired: ['Expired', 'Products past their expiry date.'],
      soon: ['Expiring Soon', 'Products approaching their short-expiry threshold.'],
      safe: ['Safe', 'Products with plenty of shelf life left.'],
    };
    var title = titles[state.view] || titles.all;
    el.pageTitle.textContent = title[0];
    el.pageSub.textContent = title[1];
    el.recordsTitle.textContent = state.view === 'all' ? 'Short expiry list' : title[0];
  }

  function renderTable() {
    var rows = visibleRows();
    var fragment = document.createDocumentFragment();

    rows.forEach(function (row) {
      var record = row.record;
      var result = row.result;

      var tr = document.createElement('tr');
      if (result.status === 'expired') tr.className = 'is-expired';

      // product
      var tdProduct = document.createElement('td');
      var wrap = document.createElement('div');
      wrap.className = 'cell-product';

      var url = state.images.get(record.barcode);
      if (url) {
        var img = document.createElement('img');
        img.className = 'cell-product__img';
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        wrap.appendChild(img);
      } else {
        var ph = document.createElement('div');
        ph.className = 'cell-product__img';
        ph.textContent = 'no img';
        wrap.appendChild(ph);
      }

      var text = document.createElement('div');
      text.className = 'cell-product__text';
      var nameNode = document.createElement('span');
      nameNode.className = 'cell-product__name';
      nameNode.textContent = record.name || '(no name)';
      nameNode.title = record.name || '';
      var codeNode = document.createElement('span');
      codeNode.className = 'cell-product__code';
      codeNode.textContent = record.barcode;
      text.appendChild(nameNode);
      text.appendChild(codeNode);
      wrap.appendChild(text);
      tdProduct.appendChild(wrap);
      tr.appendChild(tdProduct);

      // category
      var tdCategory = document.createElement('td');
      var categoryName = categoryLabel(record.category);
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = categoryName;
      tag.title = categoryName + ' · ' + Rules.ruleFor(record.category, record.returnable).summary;
      tdCategory.appendChild(tag);
      tr.appendChild(tdCategory);

      // returnable
      var tdReturn = document.createElement('td');
      var returnTag = document.createElement('span');
      returnTag.className = 'tag ' + (record.returnable ? 'tag--yes' : 'tag--no');
      returnTag.textContent = record.returnable ? 'Yes' : 'No';
      returnTag.title = record.returnable ? 'Returnable (30-day rule)' : 'Non-returnable (category rule)';
      tdReturn.appendChild(returnTag);
      tr.appendChild(tdReturn);

      // expiry
      var tdExpiry = document.createElement('td');
      tdExpiry.className = 'date';
      tdExpiry.textContent = result.expiry ? Rules.formatDate(result.expiry) : '—';
      tr.appendChild(tdExpiry);

      // days
      var tdDays = document.createElement('td');
      tdDays.className = 'days';
      tdDays.dataset.tone = result.statusMeta.tone;
      tdDays.textContent = formatDays(result.daysLeft);
      tr.appendChild(tdDays);

      // status
      var tdStatus = document.createElement('td');
      var status = document.createElement('span');
      status.className = 'status';
      status.dataset.tone = result.statusMeta.tone;
      status.textContent = result.statusMeta.label;
      tdStatus.appendChild(status);
      tr.appendChild(tdStatus);

      // actions
      var tdActions = document.createElement('td');
      tdActions.className = 'col-actions';
      var actions = document.createElement('div');
      actions.className = 'row-actions';

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.title = 'Edit';
      editBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m14 6 4 4"/></svg>';
      editBtn.addEventListener('click', function () { openEditor(record.barcode); });

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger';
      delBtn.title = 'Remove';
      delBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7"/><path d="M6 7l1 12.2A1.8 1.8 0 0 0 8.8 21h6.4a1.8 1.8 0 0 0 1.8-1.8L18 7"/></svg>';
      delBtn.addEventListener('click', function () {
        if (window.confirm('Remove ' + (record.name || record.barcode) + ' from the short expiry list?')) {
          removeRecord(record.barcode);
        }
      });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      tdActions.appendChild(actions);
      tr.appendChild(tdActions);

      fragment.appendChild(tr);
    });

    el.recordsBody.replaceChildren(fragment);
    el.recordsCount.textContent = rows.length + (rows.length === 1 ? ' item' : ' items');
    el.recordsEmpty.hidden = rows.length > 0;
    el.recordsTable.tBodies[0].hidden = rows.length === 0;

    if (!rows.length) {
      el.emptyText.textContent = state.records.length
        ? 'Nothing matches this filter.'
        : 'No records yet. Scan a product to add it to the list.';
    }
  }

  /* ------------------------------------------------------------ edit modal */

  function openEditor(barcode) {
    var record = state.recordMap.get(barcode);
    if (!record) return;
    state.editing = barcode;

    el.editName.textContent = record.name || '(no name)';
    el.editBarcode.textContent = record.barcode;
    el.editCategory.value = record.category || '';
    el.editExpiry.value = record.expiry || '';
    el.editLead.value = record.leadOverride || '';
    el.editReturnable.value = record.returnable ? 'yes' : 'no';

    var url = state.images.get(barcode);
    if (url) {
      el.editImage.src = url;
      el.editImage.hidden = false;
    } else {
      el.editImage.hidden = true;
      el.editImage.removeAttribute('src');
    }

    el.editModal.hidden = false;
    updateEditorPreview();
  }

  function updateEditorPreview() {
    var lead = parseFloat(el.editLead.value);
    var draft = {
      category: el.editCategory.value,
      returnable: el.editReturnable.value === 'yes',
      expiry: el.editExpiry.value,
      leadOverride: isFinite(lead) && lead > 0 ? Math.round(lead) : null,
    };
    var result = Rules.evaluate(draft);
    el.editShort.textContent = result.shortDate ? Rules.toISODate(result.shortDate) : '—';
    el.editDays.textContent = formatDays(result.daysLeft);
    el.editStatus.dataset.tone = result.statusMeta.tone;
    el.editStatus.textContent = result.expiry
      ? result.statusMeta.label + ' · ' + formatDays(result.daysLeft) + ' remaining'
      : 'No expiry date';
  }

  async function saveEditor() {
    var record = state.recordMap.get(state.editing);
    if (!record) return;
    var lead = parseFloat(el.editLead.value);
    var updated = Object.assign({}, record, {
      category: el.editCategory.value,
      expiry: el.editExpiry.value || '',
      leadOverride: isFinite(lead) && lead > 0 ? Math.round(lead) : null,
      returnable: el.editReturnable.value === 'yes',
      updatedAt: Date.now(),
    });
    try {
      await DB.saveRecord(updated);
    } catch (err) {
      toast('Could not save changes.', 'error');
      return;
    }
    upsertRecord(updated);
    el.editModal.hidden = true;
    state.editing = null;
    renderAll();
    toast('Changes saved', 'ok');
  }

  /* --------------------------------------------------------------- exports */

  function buildRows(list, title) {
    var header = ['Barcode', 'Product Name', 'Category', 'Returnable', 'Expiry Date',
      'Short Expiry Date', 'Days Remaining', 'Status', 'Lead Days'];
    var rows = [header];
    list.forEach(function (row) {
      var record = row.record;
      var result = row.result;
      var category = Rules.categoryById(record.category) || Rules.categoryById('food');
      rows.push([
        record.barcode,
        record.name,
        category.label,
        record.returnable ? 'Returnable' : 'Non-returnable',
        record.expiry || '',
        result.shortDate ? Rules.toISODate(result.shortDate) : '',
        result.daysLeft == null ? '' : result.daysLeft,
        result.statusMeta.label,
        result.leadDays,
      ]);
    });
    return { name: title, rows: rows };
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 10);
  }

  function exportShortExpiry() {
    var list = decorated().filter(function (row) {
      return row.result.status === 'short' || row.result.status === 'expired';
    });
    if (!list.length) {
      toast('Nothing at or past the short-expiry threshold.', 'error');
      return;
    }
    download(XlsxWriter.build(buildRows(list, 'Short Expiry')), 'short-expiry-' + stamp() + '.xlsx');
    toast('Exported ' + list.length + ' short-expiry records', 'ok');
  }

  function exportAll() {
    var list = decorated();
    if (!list.length) {
      toast('No records to export.', 'error');
      return;
    }
    download(XlsxWriter.build(buildRows(list, 'All Records')), 'expiry-records-' + stamp() + '.xlsx');
    toast('Exported ' + list.length + ' records', 'ok');
  }

  /* --------------------------------------------------------------- camera */

  async function toggleCamera() {
    if (!state.scanner) {
      state.scanner = ExpiryScanner.create({
        video: el.video,
        guide: el.scanGuide,
        onDetect: function (code) {
          // The camera keeps running: ignore a repeat of the product already
          // on screen so it cannot overwrite a name being typed.
          if (state.draft && state.draft.barcode === code && !el.product.hidden) return;
          el.barcodeInput.value = code;
          lookup(code);
          toast('Scanned ' + code);
        },
        onStatus: onScannerStatus,
      });
    }

    if (state.scanner.isRunning) {
      state.scanner.stop();
      return;
    }

    el.cameraBtn.disabled = true;
    try {
      await state.scanner.start();
    } catch (err) {
      console.warn('[camera]', err);
      el.scanner.dataset.state = 'idle';
      el.cameraBtnText.textContent = 'Start camera';
      toast(cameraErrorText(err), 'error');
    } finally {
      el.cameraBtn.disabled = false;
    }
  }

  function cameraErrorText(err) {
    switch (err && err.name) {
      case 'NotAllowedError': return 'Camera access was blocked. Allow it in the browser, then retry.';
      case 'NotFoundError': return 'No camera found on this device.';
      case 'NotReadableError': return 'The camera is being used by another app.';
      default: return 'The camera could not start. Use manual entry instead.';
    }
  }

  function onScannerStatus(status) {
    if (status.state === 'running') {
      el.scanner.dataset.state = 'running';
      el.cameraBtnText.textContent = 'Stop camera';
      el.torchBtn.hidden = !status.torch;
      el.flipBtn.hidden = false;
      el.scannerStatus.textContent = status.engine + ' · ' + status.width + '×' + status.height;
    } else if (status.state === 'idle') {
      el.scanner.dataset.state = 'idle';
      el.cameraBtnText.textContent = 'Start camera';
      el.torchBtn.hidden = true;
      el.flipBtn.hidden = true;
      el.scannerStatus.textContent = '';
    } else {
      el.cameraBtnText.textContent = 'Starting…';
    }
  }

  /* --------------------------------------------------------------- events */

  function bindEvents() {
    el.barcodeForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      lookup(el.barcodeInput.value);
    });

    el.cameraBtn.addEventListener('click', toggleCamera);

    el.torchBtn.addEventListener('click', async function () {
      if (!state.scanner) return;
      var on = await state.scanner.toggleTorch();
      el.torchBtn.setAttribute('aria-pressed', String(on));
    });

    el.flipBtn.addEventListener('click', async function () {
      if (!state.scanner) return;
      var info = await state.scanner.switchCamera();
      el.torchBtn.hidden = !info.torch;
      el.scannerStatus.textContent = info.width + '×' + info.height;
    });

    // product form
    [el.nameInput, el.expiryInput, el.categoryInput, el.leadInput].forEach(function (node) {
      node.addEventListener('input', updatePreview);
      node.addEventListener('change', updatePreview);
    });
    el.returnableInput.addEventListener('change', updatePreview);

    el.saveBtn.addEventListener('click', saveDraft);
    el.cancelBtn.addEventListener('click', function () {
      el.product.hidden = true;
      state.draft = null;
      el.barcodeInput.value = '';
      el.barcodeInput.focus();
    });

    el.refetchBtn.addEventListener('click', function () {
      if (!state.draft) return;
      resolveImage(state.draft.barcode, state.catalog.get(state.draft.barcode), true);
    });

    el.photoBtn.addEventListener('click', function () { el.photoInput.click(); });
    el.uploadBtn.addEventListener('click', function () { el.uploadInput.click(); });

    el.photoInput.addEventListener('change', handleImageFile);
    el.uploadInput.addEventListener('change', handleImageFile);

    // filters
    el.nav.addEventListener('click', function (ev) {
      var button = ev.target.closest('[data-view]');
      if (!button) return;
      state.view = button.dataset.view;
      renderAll();
    });

    el.filterChips.addEventListener('click', function (ev) {
      var button = ev.target.closest('[data-view]');
      if (!button) return;
      state.view = button.dataset.view;
      renderAll();
    });

    el.returnFilter.addEventListener('change', function () {
      state.returnFilter = el.returnFilter.value;
      renderAll();
    });

    el.stats.forEach(function (node) {
      node.addEventListener('click', function () {
        var metric = node.dataset.metric;
        if (metric === 'catalog') {
          el.searchInput.focus();
          return;
        }
        if (metric === 'returnable' || metric === 'nonreturnable') {
          state.returnFilter = state.returnFilter === metric ? 'all' : metric;
          el.returnFilter.value = state.returnFilter;
          renderAll();
          return;
        }
        // "Tracked items" simply clears the status filter.
        state.view = metric === 'tracked' ? 'all' : metric;
        renderAll();
      });
    });

    var searchTimer = 0;
    el.searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.query = el.searchInput.value.trim();
        renderTable();
      }, 120);
    });

    // import / export
    el.importBtn.addEventListener('click', function () { el.importFile.click(); });
    el.importFile.addEventListener('change', async function () {
      var file = el.importFile.files && el.importFile.files[0];
      el.importFile.value = '';
      if (!file) return;
      await importWorkbook(file, file.name);
    });
    el.importCancel.addEventListener('click', function () { el.importOverlay.hidden = true; });
    el.exportShortBtn.addEventListener('click', exportShortExpiry);
    el.exportAllBtn.addEventListener('click', exportAll);

    // modal
    el.editModal.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-close]')) {
        el.editModal.hidden = true;
        state.editing = null;
      }
    });
    el.editSave.addEventListener('click', saveEditor);
    el.editDelete.addEventListener('click', function () {
      if (!state.editing) return;
      if (window.confirm('Remove this record from the short expiry list?')) {
        removeRecord(state.editing);
        el.editModal.hidden = true;
        state.editing = null;
      }
    });
    [el.editCategory, el.editExpiry, el.editLead, el.editReturnable].forEach(function (node) {
      node.addEventListener('input', updateEditorPreview);
      node.addEventListener('change', updateEditorPreview);
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        el.editModal.hidden = true;
        state.editing = null;
      }
    });

    // re-evaluate statuses at midnight-ish / on focus
    window.addEventListener('focus', function () { renderAll(); });
  }

  async function handleImageFile(ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file || !state.draft) return;
    if (!/^image\//.test(file.type)) {
      toast('Choose an image file.', 'error');
      return;
    }

    var stored = await ProductImages.store(state.draft.barcode, file, 'user');
    state.images.set(state.draft.barcode, stored.url);
    setProductImage(stored.url, 'Saved');

    var record = state.recordMap.get(state.draft.barcode);
    if (record) {
      record.imageSource = 'user';
      try { await DB.saveRecord(record); } catch (err) { /* ignore */ }
    }
    renderTable();
    toast('Image saved', 'ok');
  }

  /* ----------------------------------------------------------------- boot */

  // Wire the UI before any async work so a submit during the long first
  // import is handled instead of reloading the page.
  bindEvents();
  boot();
})();
