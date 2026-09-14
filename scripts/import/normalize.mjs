// Value normalisers.
//
// Every function returns { value, warn } where `warn` is a reason code when the source
// value could not be represented faithfully. The raw string is always kept alongside the
// normalised one, so the portal can show a marketer exactly what we refused and why
// instead of quietly discarding it.
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export const BLANKS = new Set(['', 'null', 'NULL', '\\N', '-', 'N/A', 'n/a', 'none', 'NONE', 'nil']);

export const isBlank = (v) => v == null || BLANKS.has(String(v).trim());

// The export writes the same boolean eleven different ways. A blank is NOT consent:
// 12% of Kilele contacts have no value at all, and treating those as opt-in would mail
// ten thousand people who never agreed to anything.
const TRUTHY = new Set(['true', 't', '1', 'yes', 'y']);
const FALSY = new Set(['false', 'f', '0', 'no', 'n']);

export function normConsent(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return { value: null, warn: 'consent_blank' };
  if (TRUTHY.has(s)) return { value: true };
  if (FALSY.has(s)) return { value: false };
  return { value: null, warn: 'consent_unrecognised' };
}

// Casing varies, and 112 Kilele contacts carry the singular "unsubscribe". Folding it is
// the difference between suppressing those people and mailing them.
const STATUS_MAP = {
  active: 'active', pending: 'pending', bounced: 'bounced', bounce: 'bounced',
  unsubscribed: 'unsubscribed', unsubscribe: 'unsubscribed',
  complained: 'complained', complaint: 'complained', deleted: 'deleted',
};

export function normStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return { value: 'unknown', warn: 'status_blank' };
  const v = STATUS_MAP[s];
  return v ? { value: v } : { value: 'unknown', warn: 'status_unrecognised' };
}

// Deliberately stricter than the RFC: this decides whether we would actually try to send
// to the address. Everything it rejects is kept in email_raw and shown on the data page.
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function normEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return { value: null, warn: 'email_blank' };
  if (!EMAIL_RE.test(s)) return { value: null, warn: 'email_invalid' };
  return { value: s };
}

const COUNTRY_MAP = {
  ke: 'KE', ken: 'KE', kenya: 'KE', 254: 'KE',
  za: 'ZA', zaf: 'ZA', 'south africa': 'ZA', 27: 'ZA',
  ma: 'MA', mar: 'MA', morocco: 'MA', maroc: 'MA', 212: 'MA',
  ug: 'UG', tz: 'TZ', rw: 'RW', et: 'ET', ss: 'SS', zz: null,
};

export function normCountry(raw) {
  const s = String(raw ?? '').trim();
  if (isBlank(s)) return { value: null, warn: s === '' ? null : 'country_blank_marker' };
  const k = s.toLowerCase();
  if (k in COUNTRY_MAP) {
    const v = COUNTRY_MAP[k];
    return v ? { value: v } : { value: null, warn: 'country_placeholder' };
  }
  if (/^[a-z]{2}$/.test(k)) return { value: k.toUpperCase() };
  return { value: null, warn: 'country_unrecognised' };
}

/**
 * Four phone formats coexist, and the brand's own country is not a reliable guide: the
 * South African export is full of Kenyan numbers.
 *
 * Each shape is tried as its own hypothesis, most explicit first, and a number is only
 * accepted if libphonenumber says it is genuinely valid. What remains is kept raw and
 * marked unusable rather than guessed at. That matters most for the 12-digit "0257..."
 * strings: read one way they are a mangled Kenyan number, read another they are a valid
 * Burundi number, and a wrong guess is a message to a stranger.
 */
export function normPhone(raw, region) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null, warn: 'phone_blank' };
  const digits = s.replace(/[\s()-]/g, '');

  const candidates = [];
  if (digits.startsWith('+')) candidates.push([digits, undefined]);
  else if (digits.startsWith('00')) candidates.push(['+' + digits.slice(2), undefined]);
  // "254-731-694774": a country code written without its plus.
  else if (/^\d{1,3}-/.test(s)) candidates.push(['+' + digits, undefined]);
  candidates.push([digits, region]);

  for (const [candidate, r] of candidates) {
    try {
      const p = parsePhoneNumberFromString(candidate, r);
      if (p?.isValid()) return { value: p.number };
    } catch { /* try the next hypothesis */ }
  }
  return { value: null, warn: 'phone_unparseable' };
}

/**
 * Timestamps arrive in three shapes. Day-first is assumed for the slash format because
 * every brand here is outside North America, and the assumption is recorded as a warning
 * on each affected row rather than buried in a comment.
 */
export function normTimestamp(raw, { timezone, now = new Date() } = {}) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null, warn: 'date_blank' };

  let iso = null;
  let warn;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) {
    iso = s;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // A bare date has no time. Midnight in the brand's own timezone is the honest reading.
    iso = zonedMidnight(s, timezone);
    warn = 'date_only_assumed_midnight_local';
  } else {
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/);
    if (m) {
      const [, d, mo, y, hh = '0', mm = '0'] = m;
      if (Number(mo) > 12) return { value: null, warn: 'date_unparseable' };
      iso = zonedMidnight(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, timezone, +hh, +mm);
      warn = 'date_day_first_assumed';
    }
  }
  if (!iso) return { value: null, warn: 'date_unparseable' };

  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return { value: null, warn: 'date_unparseable' };
  // 92 Kilele contacts claim to have signed up as late as June 2027. A signup that has
  // not happened yet cannot be counted, so it is dropped and reported.
  if (t.getTime() > now.getTime()) return { value: null, warn: 'date_in_future' };
  return { value: t.toISOString(), warn };
}

/** Midnight (or a given local time) on a calendar date, in a named timezone, as UTC. */
function zonedMidnight(ymd, timezone, hh = 0, mm = 0) {
  if (!timezone) return `${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
  const guess = new Date(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  // Offset of that instant in the target zone, then subtract it to land on local wall time.
  const tzDate = new Date(guess.toLocaleString('en-US', { timeZone: timezone }));
  const utcDate = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = tzDate.getTime() - utcDate.getTime();
  return new Date(guess.getTime() - offsetMs).toISOString();
}

export const EVENT_TYPE_MAP = {
  delivered: 'delivered', delivery: 'delivered', sent: 'delivered',
  open: 'opened', opened: 'opened',
  click: 'clicked', clicked: 'clicked',
  bounce: 'bounced', bounced: 'bounced',
  complaint: 'complained', complained: 'complained', spam: 'complained',
  unsubscribe: 'unsubscribed', unsubscribed: 'unsubscribed',
  failed: 'failed', rejected: 'failed',
};

export function normEventType(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  const v = EVENT_TYPE_MAP[s];
  return v ? { value: v } : { value: s || 'unknown', warn: 'event_type_unrecognised' };
}

export function normNumber(raw, { decimalComma = false } = {}) {
  let s = String(raw ?? '').trim();
  if (s === '') return { value: null };
  if (decimalComma) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? { value: n } : { value: null, warn: 'number_unparseable' };
}
