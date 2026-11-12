import { createRequire } from 'node:module';
import { ean13Bits, ean8Bits, upcaBits, renderBits } from './barcode-gen.mjs';

const require = createRequire(import.meta.url);
globalThis.ZXing = require('../vendor/zxing.min.js');
const Barcode = require('../js/barcode.js');
globalThis.Barcode = Barcode;
globalThis.Enhance = require('../js/enhance.js');
const Decoder = require('../js/decoder.js');

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. Check digits and symbology classification                        */
/* ------------------------------------------------------------------ */

console.log('\nCheck digits & classification');

await test('EAN-13 check digit is computed from the right', () => {
  equal(Barcode.checkDigit('501234567890'), 0);
  equal(Barcode.checkDigit('400638133393'), 1);
  equal(Barcode.checkDigit('9638507'), 4);
});

await test('valid EAN-13 classifies with no aliases', () => {
  const r = Barcode.classify('5012345678900');
  ok(r.valid, 'should be valid');
  equal(r.format, 'ean_13');
  equal(r.upc, null);
});

await test('EAN-13 with a leading zero also yields its UPC-A form', () => {
  const r = Barcode.classify('0012345678905');
  ok(r.valid);
  equal(r.format, 'ean_13');
  equal(r.upc, '012345678905');
});

await test('valid UPC-A classifies as upc_a with an EAN-13 alias', () => {
  const r = Barcode.classify('012345678905');
  ok(r.valid);
  equal(r.format, 'upc_a');
  equal(r.ean13, '0012345678905');
});

await test('valid EAN-8 classifies', () => {
  const r = Barcode.classify('96385074');
  ok(r.valid);
  equal(r.format, 'ean_8');
});

await test('a wrong check digit is rejected as a checksum failure', () => {
  const r = Barcode.classify('5012345678901');
  equal(r.valid, false);
  equal(r.reason, 'checksum');
});

await test('UPC-A with a wrong check digit is rejected', () => {
  const r = Barcode.classify('012345678904');
  equal(r.valid, false);
});

await test('UPC-E expands to the correct UPC-A', () => {
  const r = Barcode.classify('01234565', 'upc_e');
  ok(r.valid, 'expected a valid UPC-E');
  equal(r.format, 'upc_e');
  equal(r.upc, '012345000065');
});

await test('an 8-digit symbol is disambiguated as EAN-8, not UPC-E', () => {
  const r = Barcode.classify('96385074');
  equal(r.format, 'ean_8');
});

await test('non-numeric and short payloads are rejected', () => {
  equal(Barcode.classify('').valid, false);
  equal(Barcode.classify('123').valid, false);
  equal(Barcode.classify('hello world').valid, false);
});

await test('an EAN-13 with a 5-digit add-on keeps the primary body', () => {
  const r = Barcode.classify('5012345678900 12345', 'ean_13');
  ok(r.valid);
  equal(r.code, '5012345678900');
});

/* ------------------------------------------------------------------ */
/* 2. Multi-frame confirmation                                         */
/* ------------------------------------------------------------------ */

console.log('\nRead confirmation');

await test('a single frame is never accepted', () => {
  const c = Barcode.createConfirmer({ required: 2, windowMs: 1000, cooldownMs: 1000 });
  equal(c.push('5012345678900', 1, 0), 'pending');
});

await test('the same frame counted twice does not confirm', () => {
  const c = Barcode.createConfirmer({ required: 2, windowMs: 1000, cooldownMs: 1000 });
  equal(c.push('5012345678900', 7, 0), 'pending');
  equal(c.push('5012345678900', 7, 20), 'pending');
});

await test('two distinct frames confirm the read', () => {
  const c = Barcode.createConfirmer({ required: 2, windowMs: 1000, cooldownMs: 1000 });
  equal(c.push('5012345678900', 1, 0), 'pending');
  equal(c.push('5012345678900', 2, 40), 'accepted');
});

await test('reads spread beyond the window do not accumulate', () => {
  const c = Barcode.createConfirmer({ required: 2, windowMs: 200, cooldownMs: 1000 });
  equal(c.push('5012345678900', 1, 0), 'pending');
  equal(c.push('5012345678900', 2, 900), 'pending');
});

await test('an accepted code is suppressed during its cooldown', () => {
  const c = Barcode.createConfirmer({ required: 2, windowMs: 1000, cooldownMs: 1000 });
  c.push('5012345678900', 1, 0);
  equal(c.push('5012345678900', 2, 20), 'accepted');
  equal(c.push('5012345678900', 3, 120), 'suppressed');
  equal(c.push('5012345678900', 4, 150), 'suppressed');
});

await test('a competing code needs its own consensus', () => {
  const c = Barcode.createConfirmer({ required: 2, windowMs: 1000, cooldownMs: 1000 });
  c.push('5012345678900', 1, 0);
  equal(c.push('96385074', 2, 20), 'pending');
  equal(c.push('96385074', 3, 40), 'accepted');
});

/* ------------------------------------------------------------------ */
/* 3. End-to-end decoding of rendered symbols                          */
/* ------------------------------------------------------------------ */

const engine = Decoder.create({ prefer: 'zxing' });
await engine.init();

async function scan(bits, renderOptions, pass) {
  const frame = renderBits(bits, renderOptions);
  const read = await engine.decode(
    { imageData: frame, width: frame.width, height: frame.height },
    pass || { hard: true }
  );
  if (!read) return null;
  return { read, info: Barcode.classify(read.rawValue, read.format) };
}

/* ------------------------------------------------------------------ */
/* 4. Screen → video ROI mapping                                      */
/* ------------------------------------------------------------------ */

console.log('\nViewfinder geometry');

const Geometry = require('../js/geometry.js');

// A phone-shaped stage showing a landscape 1080p camera feed (object-fit: cover).
const stage = { left: 0, top: 0, width: 390, height: 600 };
const viewfinder = { left: 35.1, top: 233, width: 319.8, height: 110.3 };
const base = { stage, viewfinder, videoWidth: 1920, videoHeight: 1080, zoom: 1 };

await test('cover scale fills the stage and crops the long side', () => {
  const s = Geometry.coverScale(390, 600, 1920, 1080);
  ok(Math.abs(s - 600 / 1080) < 1e-9, `expected ${600 / 1080}, got ${s}`);
});

await test('the ROI is centred on the frame', () => {
  const r = Geometry.toVideoRect(base);
  ok(r, 'expected a rect');
  ok(Math.abs(r.sx + r.sw / 2 - 960) < 2, `centre ${r.sx + r.sw / 2}`);
  ok(Math.abs(r.sy + r.sh / 2 - 540) < 60, `vertical centre ${r.sy + r.sh / 2}`);
});

await test('the ROI stays inside the frame', () => {
  const r = Geometry.toVideoRect(base);
  ok(r.sx >= 0 && r.sy >= 0, 'negative origin');
  ok(r.sx + r.sw <= 1920 + 1e-6, 'overflows right');
  ok(r.sy + r.sh <= 1080 + 1e-6, 'overflows bottom');
});

await test('the ROI is a small slice of the frame, not the whole frame', () => {
  const r = Geometry.toVideoRect(base);
  ok(r.sw < 1920 * 0.5, `crop is too wide: ${r.sw}`);
  ok(r.sh < 1080 * 0.4, `crop is too tall: ${r.sh}`);
  ok(r.sw > 200, `crop is too narrow to be useful: ${r.sw}`);
});

await test('digital zoom halves the ROI at 2x', () => {
  const one = Geometry.toVideoRect(base);
  const two = Geometry.toVideoRect(Object.assign({}, base, { zoom: 2 }));
  ok(Math.abs(one.sw / two.sw - 2) < 0.02, `width ratio ${one.sw / two.sw}`);
  ok(Math.abs(one.sh / two.sh - 2) < 0.02, `height ratio ${one.sh / two.sh}`);
  ok(Math.abs(two.sx + two.sw / 2 - 960) < 2, 'zoom must stay centred');
});

await test('macro mode zooms in on the same screen region', () => {
  // Macro shrinks the viewfinder element itself; the mapping follows it.
  const macroVf = { left: 85.8, top: 262, width: 218.4, height: 57.5 };
  const normal = Geometry.toVideoRect(base);
  const macro = Geometry.toVideoRect(Object.assign({}, base, { viewfinder: macroVf, zoom: 1.8 }));
  ok(macro.sw < normal.sw / 2.5, `macro crop ${macro.sw} vs ${normal.sw}`);
  ok(macro.sh < normal.sh / 2, `macro crop height ${macro.sh} vs ${normal.sh}`);
});

await test('a viewfinder against the frame edge is clamped, not overshot', () => {
  const edge = { left: 350, top: 480, width: 300, height: 200 };
  const r = Geometry.toVideoRect(Object.assign({}, base, { viewfinder: edge }));
  ok(r.sx >= 0 && r.sy >= 0, 'negative origin');
  ok(r.sx + r.sw <= 1920 + 1e-6, 'overflows right');
  ok(r.sy + r.sh <= 1080 + 1e-6, 'overflows bottom');
});

await test('a missing video size yields no rect', () => {
  equal(Geometry.toVideoRect(Object.assign({}, base, { videoWidth: 0 })), null);
});

await test('crops are downscaled to the target but never upscaled', () => {
  equal(Geometry.fitScale(4000, 1280), 0.32);
  equal(Geometry.fitScale(500, 1280), 1);
});

console.log('\nDecoding');

await test('clean EAN-13 decodes to the exact digits', async () => {
  const out = await scan(ean13Bits('5012345678900'), { module: 3, height: 96 });
  ok(out, 'no read');
  equal(out.info.code, '5012345678900');
  equal(out.info.format, 'ean_13');
});

await test('small EAN-13 (1px modules) still decodes', async () => {
  const out = await scan(ean13Bits('5012345678900'), { module: 1, height: 48 });
  ok(out, 'no read');
  equal(out.info.code, '5012345678900');
});

await test('EAN-13 under blur, noise and uneven lighting decodes', async () => {
  const out = await scan(ean13Bits('4006381333931'), {
    module: 2,
    height: 72,
    blur: 1,
    noise: 26,
    gradient: 0.4,
    exposure: 0.75,
  });
  ok(out, 'no read');
  equal(out.info.code, '4006381333931');
});

await test('EAN-8 decodes to the exact digits', async () => {
  const out = await scan(ean8Bits('96385074'), { module: 3, height: 72 });
  ok(out, 'no read');
  equal(out.info.code, '96385074');
  equal(out.info.format, 'ean_8');
});

await test('UPC-A decodes as UPC-A', async () => {
  const out = await scan(upcaBits('012345678905'), { module: 3, height: 90 });
  ok(out, 'no read');
  equal(out.info.code, '012345678905');
  equal(out.info.format, 'upc_a');
});

await test('a barcode printed with a bad check digit is never surfaced', async () => {
  // ZXing validates the symbol checksum itself, so this must not decode at all.
  const out = await scan(ean13Bits('5012345678901'), { module: 3, height: 96 });
  ok(!out || !out.info.valid, 'an invalid-checksum symbol must never reach the user');
});

await test('a damaged symbol cannot produce an unverified code', async () => {
  const cases = [
    { module: 2, height: 60, blur: 1, noise: 24, exposure: 0.7 },
    { module: 2, height: 56, blur: 2, noise: 30, gradient: 0.5, exposure: 0.55 },
    { module: 1, height: 40, blur: 1, noise: 18, exposure: 0.65 },
  ];
  for (const opts of cases) {
    const out = await scan(ean13Bits('4006381333931'), opts);
    if (out) {
      equal(out.info.valid, true, 'a surfaced read must pass its checksum');
      equal(out.info.code, '4006381333931');
    }
  }
});

await test('decoding stays exact across exposure levels', async () => {
  let reads = 0;
  for (const exposure of [0.45, 0.6, 0.8, 1.0]) {
    const out = await scan(ean13Bits('5012345678900'), {
      module: 2,
      height: 72,
      blur: 1,
      noise: 22,
      exposure,
    });
    if (out) {
      reads += 1;
      equal(out.info.code, '5012345678900', `wrong digits at exposure ${exposure}`);
    }
  }
  ok(reads >= 3, `only ${reads}/4 exposures decoded`);
});

await test('the software engine reports its own name', () => {
  equal(engine.engineName, 'ZXing');
});

/* ------------------------------------------------------------------ */

const total = passed + failed;
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${total} passed\x1b[0m`);
if (failed) {
  for (const f of failures) {
    console.log(`\n${f.name}\n${f.err.stack}`);
  }
  process.exitCode = 1;
}
