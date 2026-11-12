/* ==========================================================================
   Rules — short-expiry calculation and status classification.

   Category and returnable status are independent inputs:
     Baby Milk ............ 3 months before expiry
     Food & Beverages ..... 15 days before expiry
     Other / Non-Food ..... 15 days before expiry
     Returnable ........... 30 days before expiry  (overrides the category)
   A per-record manual lead (in days) always wins.

   Categories are the names carried by the workbook ("BABY FOOD & MILK",
   "SPREADS", "HOUSEWARE", …), so a category is classified by its words
   rather than by a fixed dropdown.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAY_MS = 86400000;

  var CATEGORIES = [
    { id: 'baby_milk', label: 'Baby Milk', rule: { months: 3 }, summary: '3 months before expiry' },
    { id: 'food', label: 'Food & Beverages', rule: { days: 15 }, summary: '15 days before expiry' },
    { id: 'other', label: 'Other / Non-Food', rule: { days: 15 }, summary: '15 days before expiry' },
  ];

  var RETURNABLE_RULE = { days: 30, summary: '30 days before expiry' };

  /** Days before the short-expiry date that count as "expiring soon". */
  var SOON_MARGIN_DAYS = 15;

  var STATUS = {
    expired: { id: 'expired', label: 'Expired', tone: 'danger', order: 0 },
    short: { id: 'short', label: 'Short Expiry', tone: 'warn', order: 1 },
    soon: { id: 'soon', label: 'Expiring Soon', tone: 'soon', order: 2 },
    safe: { id: 'safe', label: 'Safe', tone: 'ok', order: 3 },
    none: { id: 'none', label: 'No expiry', tone: 'muted', order: 4 },
  };

  /* ---------- dates ---------- */

  function startOfDay(value) {
    var d = value instanceof Date ? value : new Date(value);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function parseISODate(value) {
    if (!value) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
    return d;
  }

  function toISODate(date) {
    if (!date) return '';
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function addMonths(date, months) {
    var day = date.getDate();
    var d = new Date(date.getFullYear(), date.getMonth(), 1);
    d.setMonth(d.getMonth() + months);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
  }

  function daysBetween(from, to) {
    return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
  }

  function formatDate(date) {
    if (!date) return '—';
    return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /* ---------- rules ---------- */

  function categoryById(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    return null;
  }

  /* A baby *product* is a baby category that is also milk or food; "BABY CARE"
     (wipes, shampoo) stays on the normal rule. */
  var BABY_WORDS = /BABY|INFANT|FORMULA/;
  var BABY_PRODUCT_WORDS = /MILK|FOOD|FORMULA|INFANT|CEREAL|PUREE/;

  /** @returns {'baby_milk'|'food'|'other'} the rule class for a category name. */
  function classify(category) {
    var raw = String(category == null ? '' : category).trim();
    if (!raw) return 'other';
    if (raw === 'baby_milk' || raw === 'food' || raw === 'other') return raw;
    var upper = raw.toUpperCase();
    if (BABY_WORDS.test(upper) && BABY_PRODUCT_WORDS.test(upper)) return 'baby_milk';
    return 'food';
  }

  /** @returns {{days?:number, months?:number, source:'returnable'|'category', summary:string}} */
  function ruleFor(category, returnable) {
    if (returnable) {
      return { days: RETURNABLE_RULE.days, source: 'returnable', summary: RETURNABLE_RULE.summary, category: 'returnable' };
    }
    var meta = categoryById(classify(category)) || categoryById('food');
    return {
      days: meta.rule.days,
      months: meta.rule.months,
      source: 'category',
      summary: meta.summary,
      category: meta.id,
    };
  }

  function leadDaysFor(category, returnable) {
    var rule = ruleFor(category, returnable);
    return rule.months ? rule.months * 30 : rule.days;
  }

  /**
   * @param {Date|string} expiry
   * @param {{category?:string, returnable?:boolean, leadOverride?:number}} options
   */
  function shortExpiryDate(expiry, options) {
    // options: {category, returnable, leadOverride}
    var date = expiry instanceof Date ? expiry : parseISODate(expiry);
    if (!date) return null;
    var opts = options || {};
    var override = Number(opts.leadOverride);
    if (isFinite(override) && override > 0) return addDays(date, -Math.round(override));
    var rule = ruleFor(opts.category, opts.returnable);
    if (rule.months) return addMonths(date, -rule.months);
    return addDays(date, -(rule.days || 15));
  }

  /**
   * Full evaluation of one record.
   * @param {{category?:string, returnable?:boolean, expiry?:string, leadOverride?:number}} record
   * @param {Date} [today]
   */
  function evaluate(record, today) {
    var now = startOfDay(today || new Date());
    var expiry = parseISODate(record && record.expiry);

    if (!expiry) {
      return {
        expiry: null,
        shortDate: null,
        daysLeft: null,
        leadDays: leadDaysFor(record && record.category, record && record.returnable),
        rule: ruleFor(record && record.category, record && record.returnable),
        status: 'none',
        statusMeta: STATUS.none,
      };
    }

    var rule = ruleFor(record.category, record.returnable);
    var override = Number(record.leadOverride);
    var hasOverride = isFinite(override) && override > 0;
    var shortDate = shortExpiryDate(expiry, record);
    var daysLeft = daysBetween(now, expiry);

    var status;
    if (daysLeft < 0) status = 'expired';
    else if (now >= shortDate) status = 'short';
    else if (now >= addDays(shortDate, -SOON_MARGIN_DAYS)) status = 'soon';
    else status = 'safe';

    return {
      expiry: expiry,
      shortDate: shortDate,
      daysLeft: daysLeft,
      leadDays: hasOverride ? Math.round(override) : leadDaysFor(record.category, record.returnable),
      rule: rule,
      override: hasOverride,
      status: status,
      statusMeta: STATUS[status],
    };
  }

  return {
    CATEGORIES: CATEGORIES,
    STATUS: STATUS,
    SOON_MARGIN_DAYS: SOON_MARGIN_DAYS,
    RETURNABLE_DAYS: RETURNABLE_RULE.days,
    categoryById: categoryById,
    classify: classify,
    ruleFor: ruleFor,
    leadDaysFor: leadDaysFor,
    shortExpiryDate: shortExpiryDate,
    evaluate: evaluate,
    parseISODate: parseISODate,
    toISODate: toISODate,
    addDays: addDays,
    addMonths: addMonths,
    daysBetween: daysBetween,
    formatDate: formatDate,
    startOfDay: startOfDay,
  };
});
