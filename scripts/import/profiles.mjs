// One profile per file in the seed bundle.
//
// The three brands exported the same entities in three different dialects: different
// column names, a different column order, two delimiters, and two text encodings. The
// differences live here so that nothing downstream has to know which brand it is looking
// at. Header names are matched exactly and asserted before a single row is imported.
export const CONTACT_FIELDS = [
  'external_id', 'full_name', 'email', 'phone', 'country', 'city', 'signup_at',
  'status', 'consent_marketing', 'deleted_at', 'suppressed_until', 'brand_code', 'notes',
];
export const CAMPAIGN_FIELDS = [
  'external_id', 'campaign_name', 'channel', 'target_country', 'reported_sent',
  'reported_delivered', 'reported_bounced', 'reported_opens', 'reported_clicks',
  'spend', 'sent_at_utc', 'send_local_time', 'parent_campaign_id',
];
export const EVENT_FIELDS = [
  'event_id', 'external_contact_id', 'campaign_external_id', 'event_type', 'channel', 'occurred_at_utc',
];
export const SEND_LOG_FIELDS = [
  'batch_key', 'campaign_external_id', 'queued_at_utc', 'recipient_count', 'status',
];

const std = (fields) => Object.fromEntries(fields.map((f) => [f, f]));

export const PROFILES = [
  // --- Kilele: comma separated, UTF-8 with a byte-order mark on the contact exports ---
  { file: 'kilele-campaigns.csv', brand: 'kilele', entity: 'campaigns',
    delimiter: ',', encoding: 'utf-8', header: CAMPAIGN_FIELDS, map: std(CAMPAIGN_FIELDS) },
  { file: 'kilele-contacts.csv', brand: 'kilele', entity: 'contacts',
    delimiter: ',', encoding: 'utf-8', header: CONTACT_FIELDS, map: std(CONTACT_FIELDS) },
  // Applied as a second run against the same brand, so the portal shows two distinct
  // imports and what the later one changed.
  { file: 'kilele-contacts-delta-2026-09-01.csv', brand: 'kilele', entity: 'contacts',
    delimiter: ',', encoding: 'utf-8', header: CONTACT_FIELDS, map: std(CONTACT_FIELDS) },
  { file: 'kilele-events.csv', brand: 'kilele', entity: 'events',
    delimiter: ',', encoding: 'utf-8', header: EVENT_FIELDS, map: std(EVENT_FIELDS) },
  { file: 'kilele-send-log.csv', brand: 'kilele', entity: 'send_log',
    delimiter: ',', encoding: 'utf-8', header: SEND_LOG_FIELDS, map: std(SEND_LOG_FIELDS) },

  // --- Karoo: title-case headers in a different column order, and Windows-1252 text.
  //     One contact name contains an en dash encoded as 0x96, which is not valid UTF-8;
  //     decoding this file as UTF-8 corrupts the name or throws, depending on the reader.
  { file: 'karoo-campaigns.csv', brand: 'karoo', entity: 'campaigns',
    delimiter: ',', encoding: 'utf-8', header: CAMPAIGN_FIELDS, map: std(CAMPAIGN_FIELDS) },
  { file: 'karoo-contacts.csv', brand: 'karoo', entity: 'contacts',
    delimiter: ',', encoding: 'windows-1252',
    header: ['Full Name', 'Email', 'External Id', 'Phone', 'Country', 'Status', 'City',
             'Signup At', 'Consent Marketing', 'Brand Code', 'Deleted At', 'Suppressed Until', 'Notes'],
    map: { external_id: 'External Id', full_name: 'Full Name', email: 'Email', phone: 'Phone',
           country: 'Country', city: 'City', signup_at: 'Signup At', status: 'Status',
           consent_marketing: 'Consent Marketing', deleted_at: 'Deleted At',
           suppressed_until: 'Suppressed Until', brand_code: 'Brand Code', notes: 'Notes' } },
  { file: 'karoo-events.csv', brand: 'karoo', entity: 'events',
    delimiter: ',', encoding: 'utf-8', header: EVENT_FIELDS, map: std(EVENT_FIELDS) },

  // --- Marrakech: a European-locale export. Semicolon separated, comma decimal
  //     separator in `spend`, and French column names for three fields.
  { file: 'marrakech-campaigns.csv', brand: 'marrakech', entity: 'campaigns',
    delimiter: ';', encoding: 'utf-8', decimalComma: true,
    header: CAMPAIGN_FIELDS, map: std(CAMPAIGN_FIELDS) },
  { file: 'marrakech-contacts.csv', brand: 'marrakech', entity: 'contacts',
    delimiter: ';', encoding: 'utf-8',
    header: ['external_id', 'full_name', 'e_mail', 'mobile', 'pays', 'city', 'signup_at',
             'status', 'consent_marketing', 'deleted_at', 'suppressed_until', 'brand_code', 'notes'],
    map: { ...std(CONTACT_FIELDS), email: 'e_mail', phone: 'mobile', country: 'pays' } },
  { file: 'marrakech-events.csv', brand: 'marrakech', entity: 'events',
    delimiter: ';', encoding: 'utf-8', header: EVENT_FIELDS, map: std(EVENT_FIELDS) },
];

export const BRAND_REGION = { kilele: 'KE', karoo: 'ZA', marrakech: 'MA' };
