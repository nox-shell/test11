/* Tracker test suite: short-expiry rules, catalog index, Excel round-trip
   and a full parse of the real workbook. */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Rules = require('../js/rules.js');
const Catalog = require('../js/catalog.js');
const XlsxWriter = require('../js/xlsx-write.js');
const XlsxReader = require('../js/xlsx-read.js');

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, message) { if (!cond) throw new Error(message || 'assertion failed'); }
function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
}

const TODAY = new Date(2026, 2, 15); // 15 Mar 2026
const iso = (offsetDays) => Rules.toISODate(Rules.addDays(TODAY, offsetDays));

/* ---------------------------------------------------------------- rules */

console.log('\nShort-expiry rules');

await test('food & beverages use a 15-day threshold', () => {
  const lead = Rules.leadDaysFor('food', false);
  eq(lead, 15);
});

await test('baby milk uses three calendar months', () => {
  const shortDate = Rules.shortExpiryDate('2026-06-15', { category: 'baby_milk', returnable: false });
  eq(Rules.toISODate(shortDate), '2026-03-15');
});

await test('returnable overrides the category rule with 30 days', () => {
  eq(Rules.leadDaysFor('food', true), 30);
  eq(Rules.leadDaysFor('baby_milk', true), 30);
  const shortDate = Rules.shortExpiryDate('2026-04-14', { category: 'food', returnable: true });
  eq(Rules.toISODate(shortDate), '2026-03-15');
});

await test('a manual lead overrides every rule', () => {
  const shortDate = Rules.shortExpiryDate('2026-05-01', { category: 'baby_milk', returnable: true, leadOverride: 7 });
  eq(Rules.toISODate(shortDate), '2026-04-24');
});

await test('month subtraction clamps to the last valid day', () => {
  eq(Rules.toISODate(Rules.addMonths(new Date(2026, 4, 31), -3)), '2026-02-28');
  eq(Rules.toISODate(Rules.addMonths(new Date(2026, 0, 31), -1)), '2025-12-31');
});

await test('categories from the workbook pick the right rule class', () => {
  eq(Rules.classify('BABY FOOD & MILK'), 'baby_milk');
  eq(Rules.classify('BABY CARE'), 'food', 'baby care is not milk');
  eq(Rules.classify('HOUSEWARE'), 'food');
  eq(Rules.classify(''), 'other');
  eq(Rules.leadDaysFor('BABY FOOD & MILK', false), 90);
  eq(Rules.leadDaysFor('SPREADS', false), 15);
  eq(Rules.leadDaysFor('BABY FOOD & MILK', true), 30, 'returnable wins');
});

await test('category and returnable are independent inputs', () => {
  const a = Rules.evaluate({ category: 'baby_milk', returnable: false, expiry: iso(120) }, TODAY);
  const b = Rules.evaluate({ category: 'baby_milk', returnable: true, expiry: iso(120) }, TODAY);
  eq(a.leadDays, 90);
  eq(b.leadDays, 30);
  ok(a.shortDate.getTime() !== b.shortDate.getTime(), 'short-expiry dates must differ');
});

console.log('\nStatus classification');

await test('a past expiry date is expired', () => {
  const r = Rules.evaluate({ category: 'food', returnable: false, expiry: iso(-1) }, TODAY);
  eq(r.status, 'expired');
  eq(r.daysLeft, -1);
});

await test('inside the threshold is short expiry', () => {
  const r = Rules.evaluate({ category: 'food', returnable: false, expiry: iso(10) }, TODAY);
  eq(r.status, 'short');
  eq(r.daysLeft, 10);
});

await test('approaching the threshold is expiring soon', () => {
  const r = Rules.evaluate({ category: 'food', returnable: false, expiry: iso(22) }, TODAY);
  eq(r.status, 'soon');
});

await test('well inside shelf life is safe', () => {
  const r = Rules.evaluate({ category: 'food', returnable: false, expiry: iso(60) }, TODAY);
  eq(r.status, 'safe');
});

await test('returnable pushes an item into short expiry sooner', () => {
  const food = Rules.evaluate({ category: 'food', returnable: false, expiry: iso(20) }, TODAY);
  const ret = Rules.evaluate({ category: 'food', returnable: true, expiry: iso(20) }, TODAY);
  eq(food.status, 'soon');
  eq(ret.status, 'short');
});

await test('the expiry date itself counts as day zero', () => {
  const r = Rules.evaluate({ category: 'food', returnable: false, expiry: iso(0) }, TODAY);
  eq(r.daysLeft, 0);
  eq(r.status, 'short');
});

await test('a missing expiry date is not classified', () => {
  const r = Rules.evaluate({ category: 'food', expiry: '' }, TODAY);
  eq(r.status, 'none');
  eq(r.daysLeft, null);
});

/* -------------------------------------------------------------- catalog */

console.log('\nCatalog index');

await test('barcode lookup is exact and duplicate-safe', () => {
  const catalog = Catalog.create();
  catalog.load([
    { barcode: '111', name: 'Alpha Milk', brand: 'A', category: 'food' },
    { barcode: '222', name: 'Beta Bread', brand: 'B', category: 'food' },
    { barcode: '111', name: 'Alpha Milk (dup)', brand: 'A', category: 'food' },
  ]);
  eq(catalog.size, 2, 'duplicates must collapse');
  eq(catalog.get('111').name, 'Alpha Milk (dup)', 'last write wins');
  eq(catalog.get('999'), null);
});

await test('name search matches brands and barcodes', () => {
  const catalog = Catalog.create();
  catalog.load([
    { barcode: '111', name: 'Alpha Milk', brand: 'Nestle', category: 'food' },
    { barcode: '222', name: 'Beta Bread', brand: 'Almarai', category: 'food' },
  ]);
  eq(catalog.search('milk').length, 1);
  eq(catalog.search('almarai').length, 1);
  eq(catalog.search('222').length, 1);
  eq(catalog.search('nothing').length, 0);
});

/* ------------------------------------------------------------ excel write */

console.log('\nExcel writer');

await test('written workbooks read back with the same values', async () => {
  const blob = XlsxWriter.build({
    name: 'Short Expiry',
    rows: [
      ['Barcode', 'Product Name', 'Days'],
      ['0123456789012', 'Leading zero product', 12],
      ['8710812712511', 'Ampersand & <brackets> "quotes"', 3],
    ],
  });
  const buffer = await blob.arrayBuffer();
  const rows = [];
  await XlsxReader.read(buffer, { onRow: (row) => rows.push(row) });

  eq(rows.length, 2);
  eq(rows[0].barcode, '0123456789012', 'leading zeros must survive');
  eq(rows[0].name, 'Leading zero product');
  eq(rows[1].name, 'Ampersand & <brackets> "quotes"');
});

await test('column names beyond Z are generated correctly', () => {
  eq(XlsxWriter.colName(0), 'A');
  eq(XlsxWriter.colName(25), 'Z');
  eq(XlsxWriter.colName(26), 'AA');
  eq(XlsxWriter.colName(51), 'AZ');
  eq(XlsxWriter.colName(52), 'BA');
});

/* ------------------------------------------------------------- real file */

console.log('\nReal workbook');

const file = 'list all.xlsx';
const exists = fs.existsSync(file);

await test('the workbook parses into the expected row count', async () => {
  ok(exists, 'list all.xlsx not found in the project folder');
  const buffer = fs.readFileSync(file);
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  let columns = null;
  let count = 0;
  const sample = [];
  const t0 = Date.now();

  const result = await XlsxReader.read(ab, {
    onHeader: (c) => { columns = c; },
    onRow: (row) => {
      count++;
      if (sample.length < 3) sample.push(row);
    },
  });

  const seconds = (Date.now() - t0) / 1000;
  eq(result.rows, 72279, 'unexpected product count');
  eq(count, 72279);
  ok(seconds < 30, `parse took ${seconds.toFixed(1)}s`);

  eq(columns.barcode, 'C', 'barcode column (Base Uom Barcode)');
  eq(columns.name, 'B', 'name column (Article Description)');
  eq(columns.category, 'D', 'category column (Description)');
  eq(columns.returnable, 'F', 'returnable column');

  console.log(`      parsed 72,279 products in ${seconds.toFixed(1)}s`);
});

await test('products from the workbook carry real names and categories', async () => {
  ok(exists, 'list all.xlsx not found');
  const buffer = fs.readFileSync(file);
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const found = [];
  let baby = null;
  await XlsxReader.read(ab, {
    onRow: (row) => {
      if (row.barcode === '8710812712511') found.push(row);
      if (!baby && /BABY FOOD/.test(row.category)) baby = row;
    },
  });
  eq(found.length, 1);
  eq(found[0].name, 'NATCO JAM APRICOT 450GM');
  eq(found[0].category, 'SPREADS');
  ok(baby, 'no baby food rows in the workbook');
  eq(Rules.classify(baby.category), 'baby_milk');
  eq(Rules.leadDaysFor(baby.category, false), 90);
});

await test('a Category column added to the workbook outranks Description', () => {
  const withCategory = XlsxReader.resolveColumns(new Map([
    ['A', 'Base Uom Barcode'], ['B', 'Article Description'],
    ['C', 'Description'], ['D', 'Item Category'],
  ]));
  eq(withCategory.category, 'D');
  eq(withCategory.name, 'B');

  const descriptionOnly = XlsxReader.resolveColumns(new Map([
    ['A', 'Base Uom Barcode'], ['B', 'Article Description'], ['C', 'Description'],
  ]));
  eq(descriptionOnly.category, 'C', 'Description is the category');
  eq(descriptionOnly.name, 'B');
});

/* --------------------------------------------------------------- summary */

const total = passed + failed;
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${total} passed\x1b[0m`);
if (failed) {
  failures.forEach((f) => console.log(`\n${f.name}\n${f.err.stack}`));
  process.exitCode = 1;
}
