/**
 * How every number in this portal is counted.
 *
 * These strings are rendered on the screens themselves, next to the figures they
 * describe. The point is that a reader should never have to guess which of two
 * reasonable readings we used, and should be able to disagree with a specific rule
 * rather than distrust the number.
 */

export const DEFINITIONS = {
  totalCustomers: {
    label: 'Total customers',
    rule: 'Every contact imported for this brand, except those the source export marked as removed.',
    note: 'Duplicate rows sharing an identifier are one customer, not two. Rows that could not be read at all are excluded and listed on the data page.',
  },
  contactable: {
    label: 'Contactable',
    rule: 'Customers we could lawfully and technically message today.',
    note: 'All of: not removed, marketing consent explicitly recorded as true, status active, no unsubscribe, spam complaint or hard bounce on record, not under a temporary suppression, and holding at least one usable email address or mobile number.',
  },
  consentBlank: {
    label: 'Consent left blank',
    rule: 'A blank consent field is not consent.',
    note: 'About one in eight Kilele contacts has no consent value at all. Those people are not contactable here. Reading blank as opt-in would add roughly ten thousand recipients who never agreed to anything.',
  },
  signupsPerDay: {
    label: 'Signups per day',
    rule: 'Counted by signup date in the brand’s own timezone, over the last 30 days.',
    note: 'A signup just before midnight in Nairobi belongs to that day in Nairobi, not to the previous day in UTC. Signups dated in the future were not counted and appear on the data page.',
  },
  reportedMetrics: {
    label: 'Reported by source system',
    rule: 'Copied verbatim from the campaign export. Not verified.',
    note: 'These figures disagree with the engagement log in every brand: opens run roughly three times higher, bounces roughly half. Some campaigns report more opens than sends. They are shown because they are what the client’s previous system claimed, not because they are right.',
  },
  observedMetrics: {
    label: 'Observed in engagement log',
    rule: 'Distinct customers with that event in the imported engagement log.',
    note: 'Counted per person, not per event, so one customer opening four times counts once. Events naming a campaign that is missing from the export still count towards suppression but cannot be attributed to a campaign.',
  },
  portalMetrics: {
    label: 'Sent from this portal',
    rule: 'What the messaging provider confirmed for a send made here.',
    note: 'Delivery reports arrive over minutes and out of order, so these figures move after a send. Each screen shows when the provider was last polled.',
  },
  openRate: {
    label: 'Open rate',
    rule: 'Distinct customers who opened, divided by those the provider confirmed delivered.',
    note: 'Not divided by the number approved: a message that bounced was never an opportunity to open. SMS has no open tracking, so SMS campaigns show no open rate.',
  },
  audience: {
    label: 'Who this goes to',
    rule: 'Contactable customers of this brand holding the channel the campaign uses.',
    note: 'An email campaign needs a valid email address, an SMS campaign a valid mobile number, so the audience is smaller than the contactable figure on the dashboard. Where a campaign names a target country, only that country is included.',
  },
  sendsOnce: {
    label: 'A campaign sends once',
    rule: 'Once a send has been approved for a campaign, that campaign cannot be sent again.',
    note: 'Real money and real inboxes are on the other side of the button. To send similar content again, create a new campaign.',
  },
} as const;

export type DefinitionKey = keyof typeof DEFINITIONS;

/** Why a customer is not contactable, in the order the waterfall applies the rules. */
export const EXCLUSION_LABELS: Record<string, string> = {
  total: 'Customers on record',
  deleted: 'Removed from the customer list at source',
  no_consent: 'Marketing consent not explicitly given',
  not_active: 'Account status is not active',
  unsubscribed: 'Unsubscribed',
  complained: 'Reported a message as spam',
  bounced: 'Hard bounced',
  suppressed: 'Under a temporary suppression',
  no_channel: 'No usable email address or mobile number',
  contactable: 'Contactable today',
};

/** What the importer does with a row it cannot fully represent. */
export const IMPORT_RULES = {
  reject: {
    label: 'Rejected',
    rule: 'The row could not be represented at all, so it was not stored.',
    note: 'A row with no identifier, a row with the wrong number of fields, a header line repeated inside the data, or an event naming a person who is not in this brand.',
  },
  warn: {
    label: 'Imported with a note',
    rule: 'The row was stored, but something in it could not be taken at face value.',
    note: 'The unusable field was left empty and the original kept beside it, or an assumption was recorded. Nothing was discarded silently.',
  },
} as const;

export const REJECT_REASONS: Record<string, string> = {
  wrong_field_count: 'The row had the wrong number of fields, so its values could not be matched to columns with any confidence.',
  embedded_header_row: 'A copy of the header line appeared inside the data and would otherwise have been imported as a customer.',
  missing_external_id: 'No identifier, so the row cannot be merged with its earlier or later versions.',
  missing_event_id: 'No event identifier, so the event cannot be de-duplicated.',
  unknown_contact: 'The event names a person who does not exist in this brand.',
  unknown_channel: 'The campaign channel was neither email nor SMS.',
  bad_timestamp: 'The event timestamp could not be read.',
  missing_batch_key: 'The send-log row had no batch key.',
};

export const WARNING_REASONS: Record<string, string> = {
  email_invalid: 'The email address is not usable (a space, a missing @, two @s, or no domain ending). Kept for reference; the customer cannot receive email.',
  phone_unparseable: 'The number could not be resolved to a real phone number in any plausible reading, so it was not kept as a number. Guessing could text a stranger.',
  country_blank_marker: 'The country field held a placeholder such as NULL, N/A or a dash rather than a country.',
  country_unrecognised: 'The country value did not match any country we recognise.',
  country_placeholder: 'The country was recorded as ZZ, which is not a country.',
  status_unrecognised: 'The status value was not one we recognise, so it is treated as unknown and the customer is not contactable.',
  consent_unrecognised: 'The consent value was neither a yes nor a no in any spelling we recognise, so it is treated as no consent.',
  date_only_assumed_midnight_local: 'The signup had a date but no time, so midnight in the brand’s timezone was assumed.',
  date_day_first_assumed: 'The date was written with slashes. Day-first was assumed, as every brand here is outside North America.',
  date_in_future: 'The signup date has not happened yet, so it was not counted.',
  date_unparseable: 'The date could not be read in any known format.',
  brand_code_mismatch: 'The row carries another brand’s code. The file it arrived in is treated as the brand of record and the row was kept.',
  brand_code_blank: 'The row carries no brand code. The file it arrived in is treated as the brand of record.',
  duplicate_contact_row: 'The same identifier appeared more than once in the file. The later row wins, exactly as a re-import would behave.',
  duplicate_campaign_row: 'The same campaign appeared more than once in the file and was stored once.',
  duplicate_batch_key: 'The same send-log batch appeared more than once and was counted once.',
  unknown_campaign: 'The event names a campaign missing from the campaign export. It still counts towards suppression, but cannot be attributed to a campaign.',
  event_type_unrecognised: 'The event type was not one we recognise.',
  nul_byte_removed: 'The row contained a NUL byte, which a text database cannot store. It was removed and the rest of the row kept.',
};
