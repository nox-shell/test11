/* ==========================================================================
   Barcode — retail symbology validation, normalisation and read confirmation.
   Pure logic, no DOM: shared by the app and the test harness.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Barcode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EAN13 = 'ean_13';
  var EAN8 = 'ean_8';
  var UPCA = 'upc_a';
  var UPCE = 'upc_e';

  var LABELS = {
    ean_13: 'EAN-13',
    ean_8: 'EAN-8',
    upc_a: 'UPC-A',
    upc_e: 'UPC-E',
  };

  /* Modulo-10 check digit: from the right, body digits alternate 3, 1, 3, 1…
     Works for EAN-13, EAN-8, UPC-A and GTIN-14. UPC-E uses its UPC-A expansion. */
  function checkDigit(body) {
    var sum = 0;
    for (var i = 0, n = body.length; i < n; i++) {
      var d = body.charCodeAt(n - 1 - i) - 48;
      sum += (i & 1) === 0 ? d * 3 : d;
    }
    return (10 - (sum % 10)) % 10;
  }

  function checksumOk(code) {
    if (code.length < 2) return false;
    return checkDigit(code.slice(0, -1)) === code.charCodeAt(code.length - 1) - 48;
  }

  /* UPC-E (8 digits: number system + 6 payload digits + check) → UPC-A (12). */
  function expandUPCE(code) {
    if (!/^[01]\d{7}$/.test(code)) return null;
    var ns = code[0];
    var d = code.slice(1, 7);
    var last = d[5];
    var body;
    if (last === '0' || last === '1' || last === '2') {
      body = ns + d[0] + d[1] + last + '0000' + d[2] + d[3] + d[4];
    } else if (last === '3') {
      body = ns + d[0] + d[1] + d[2] + '00000' + d[3] + d[4];
    } else if (last === '4') {
      body = ns + d[0] + d[1] + d[2] + d[3] + '00000' + d[4];
    } else {
      body = ns + d[0] + d[1] + d[2] + d[3] + d[4] + '0000' + last;
    }
    if (body.length !== 11) return null;
    return body + checkDigit(body);
  }

  function normaliseFormat(name) {
    if (!name) return null;
    var key = String(name).toLowerCase().replace(/[\s-]+/g, '_');
    if (key === 'ean13' || key === 'ean_13') return EAN13;
    if (key === 'ean8' || key === 'ean_8') return EAN8;
    if (key === 'upca' || key === 'upc_a' || key === 'upc') return UPCA;
    if (key === 'upce' || key === 'upc_e') return UPCE;
    return null;
  }

  function result(code, format, extra) {
    var out = {
      valid: true,
      code: code,
      format: format,
      label: LABELS[format],
      checksum: true,
      upc: null,
      ean13: null,
    };
    if (extra) {
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    }
    if (format === EAN13) {
      out.ean13 = code;
      if (code[0] === '0') out.upc = code.slice(1);
    } else if (format === UPCA) {
      out.ean13 = '0' + code;
      out.upc = code;
    } else if (format === UPCE) {
      var upca = expandUPCE(code);
      if (upca) {
        out.upc = upca;
        out.ean13 = '0' + upca;
      }
    }
    return out;
  }

  function reject(reason, digits) {
    return { valid: false, reason: reason, digits: digits || '' };
  }

  function validateAtLength(digits, len, prefer) {
    var slice = digits.slice(0, len);

    if (len === 13) {
      if (!checksumOk(slice)) return null;
      // A leading zero means the same symbol is a UPC-A in the GS1 system.
      return prefer === UPCA ? result(slice.slice(1), UPCA) : result(slice, EAN13);
    }

    if (len === 12) {
      if (!checksumOk(slice)) return null;
      return result(slice, UPCA);
    }

    if (len === 8) {
      var ean8Ok = checksumOk(slice);
      var upca = expandUPCE(slice);
      // expandUPCE() appends the *computed* check digit, so compare it with
      // the digit actually printed rather than re-validating the expansion.
      var upcOk = !!(upca && upca.charAt(11) === slice.charAt(7));

      if (prefer === UPCE) {
        if (upcOk) return result(slice, UPCE);
        if (ean8Ok) return result(slice, EAN8);
        return null;
      }
      if (prefer === EAN8) {
        if (ean8Ok) return result(slice, EAN8);
        if (upcOk) return result(slice, UPCE);
        return null;
      }
      if (ean8Ok && !upcOk) return result(slice, EAN8);
      if (upcOk && !ean8Ok) return result(slice, UPCE);
      if (ean8Ok && upcOk) return result(slice, EAN8); // ambiguous: EAN-8 wins
      return null;
    }

    return null;
  }

  /**
   * Turn a raw decoder string into a verified retail code.
   * @param {string} rawValue     whatever the decoder reported
   * @param {string} reportedType symbology id from the decoder (optional)
   */
  /* Expected digit count per symbology. A decoder that names the symbology is
     trusted, so a failed checksum rejects the read instead of being retried
     as a different length (which can turn a bad EAN-13 into a "valid" UPC-A). */
  var LENGTH = {
    ean_13: 13,
    upc_a: 12,
    ean_8: 8,
    upc_e: 8,
  };

  function classify(rawValue, reportedType) {
    var digits = String(rawValue == null ? '' : rawValue).replace(/\D/g, '');
    if (!digits) return reject('empty', digits);
    if (digits.length < 8) return reject('length', digits);

    var fmt = normaliseFormat(reportedType);
    var candidates;

    if (fmt) {
      candidates = [LENGTH[fmt]];
    } else if (digits.length === 13) {
      candidates = [13];
    } else if (digits.length === 12) {
      candidates = [12];
    } else if (digits.length === 8) {
      candidates = [8];
    } else if (digits.length > 13) {
      candidates = [13, 12]; // EAN-13 or UPC-A carrying a printed add-on
    } else if (digits.length > 12) {
      candidates = [12];
    } else {
      return reject('length', digits);
    }

    for (var i = 0; i < candidates.length; i++) {
      var len = candidates[i];
      if (digits.length < len) continue;
      if (digits.length > len && digits.length - len > 5) continue;
      var hit = validateAtLength(digits, len, fmt);
      if (hit) return hit;
    }
    return reject('checksum', digits);
  }

  /**
   * Multi-frame confirmation. A single frame can produce a false positive on a
   * damaged or partially occluded symbol, so a code is only accepted once the
   * same value is read `required` times across distinct frames inside `windowMs`.
   */
  function createConfirmer(options) {
    var opts = options || {};
    var required = Math.max(1, opts.required || 2);
    var windowMs = opts.windowMs || 1600;
    var cooldownMs = opts.cooldownMs == null ? 1800 : opts.cooldownMs;

    var candidates = new Map();
    var acceptedAt = new Map();

    function sweep(now) {
      candidates.forEach(function (c, code) {
        if (now - c.last > windowMs) candidates.delete(code);
      });
    }

    return {
      /** @returns {'accepted'|'pending'|'suppressed'} */
      push: function (code, frame, now) {
        var t = now == null ? Date.now() : now;

        var last = acceptedAt.get(code);
        if (last != null && t - last < cooldownMs) return 'suppressed';

        var c = candidates.get(code);
        if (c && (t - c.first > windowMs || c.frame === frame)) {
          // Stale, or the same frame counted twice: restart the tally.
          c = null;
        }
        if (!c) {
          c = { count: 0, first: t, last: t, frame: -1 };
          candidates.set(code, c);
        }
        c.count += 1;
        c.last = t;
        c.frame = frame;

        if (c.count >= required) {
          candidates.delete(code);
          acceptedAt.set(code, t);
          sweep(t);
          return 'accepted';
        }
        return 'pending';
      },

      /** Force a code into cooldown (e.g. after a manual accept). */
      markAccepted: function (code, now) {
        acceptedAt.set(code, now == null ? Date.now() : now);
      },

      reset: function () {
        candidates.clear();
        acceptedAt.clear();
      },

      stats: function () {
        return { candidates: candidates.size, accepted: acceptedAt.size };
      },
    };
  }

  return {
    EAN13: EAN13,
    EAN8: EAN8,
    UPCA: UPCA,
    UPCE: UPCE,
    LABELS: LABELS,
    checkDigit: checkDigit,
    checksumOk: checksumOk,
    expandUPCE: expandUPCE,
    classify: classify,
    createConfirmer: createConfirmer,
  };
});
