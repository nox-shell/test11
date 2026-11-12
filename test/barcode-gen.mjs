/* Synthetic EAN/UPC renderer used by the test harness.
   Produces RGBA frames (plain objects) that mimic a camera capture. */

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13Bits(code) {
  const d = code.split('').map(Number);
  if (d.length !== 13) throw new Error('EAN-13 needs 13 digits');
  const parity = PARITY[d[0]];
  let bits = '101';
  for (let i = 0; i < 6; i++) {
    const n = d[i + 1];
    bits += parity[i] === 'L' ? L[n] : G[n];
  }
  bits += '01010';
  for (let i = 7; i < 13; i++) bits += R[d[i]];
  bits += '101';
  return bits;
}

export function ean8Bits(code) {
  const d = code.split('').map(Number);
  if (d.length !== 8) throw new Error('EAN-8 needs 8 digits');
  let bits = '101';
  for (let i = 0; i < 4; i++) bits += L[d[i]];
  bits += '01010';
  for (let i = 4; i < 8; i++) bits += R[d[i]];
  bits += '101';
  return bits;
}

/** UPC-A is rendered as its zero-padded EAN-13 equivalent. */
export function upcaBits(code) {
  if (code.length !== 12) throw new Error('UPC-A needs 12 digits');
  return ean13Bits('0' + code);
}

function boxBlur(data, width, height, radius) {
  if (radius <= 0) return data;
  const tmp = new Uint8ClampedArray(data.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k));
        sum += data[(y * width + xx) * 4];
      }
      const v = sum / span;
      const p = (y * width + x) * 4;
      tmp[p] = v;
      tmp[p + 1] = v;
      tmp[p + 2] = v;
      tmp[p + 3] = 255;
    }
  }
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        sum += tmp[(yy * width + x) * 4];
      }
      const v = sum / span;
      const p = (y * width + x) * 4;
      out[p] = v;
      out[p + 1] = v;
      out[p + 2] = v;
      out[p + 3] = 255;
    }
  }
  return out;
}

/**
 * @param {string} bits
 * @param {{module?:number,height?:number,quiet?:number,blur?:number,noise?:number,
 *          exposure?:number,gradient?:number,seed?:number}} [opts]
 */
export function renderBits(bits, opts = {}) {
  const module = opts.module ?? 2;
  const height = opts.height ?? 90;
  const quiet = opts.quiet ?? 12;
  const dark = opts.dark ?? 22;
  const light = opts.light ?? 236;

  const modules = bits.length + quiet * 2;
  const width = Math.max(1, Math.round(modules * module));
  let data = new Uint8ClampedArray(width * height * 4);

  for (let x = 0; x < width; x++) {
    const m = Math.floor((x - quiet * module) / module);
    const bit = m >= 0 && m < bits.length ? bits[m] : '0';
    const v = bit === '1' ? dark : light;
    for (let y = 0; y < height; y++) {
      const p = (y * width + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }

  data = boxBlur(data, width, height, opts.blur ?? 0);

  const exposure = opts.exposure ?? 1;
  const gradient = opts.gradient ?? 0;
  const noise = opts.noise ?? 0;
  let seed = opts.seed ?? 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      // Directional falloff, like a phone torch lighting one side.
      const lightFactor = 1 - gradient * (1 - x / width);
      let v = data[p] * exposure * lightFactor;
      if (noise) v += (rand() - 0.5) * noise;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }

  return { data, width, height };
}

export const renderers = { ean13: ean13Bits, ean8: ean8Bits, upca: upcaBits };
