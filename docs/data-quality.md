# What was wrong with the data, and what we did about it

Established by reading all eleven files before writing any import code. Every count below
is reproducible: `pnpm import` prints them, and the portal shows them per brand on the
**Data health** page.

## The three dialects

The same three entities arrived in three mutually incompatible shapes.

| | Kilele | Karoo | Marrakech |
|---|---|---|---|
| Delimiter | comma | comma | **semicolon** |
| Encoding | UTF-8 **with a byte-order mark** | **Windows-1252** | UTF-8 |
| Contact columns | `external_id, full_name, email, phone, country, …` | **Title Case, different order**: `Full Name, Email, External Id, Phone, Country, Status, City, …` | `external_id, full_name, **e_mail**, **mobile**, **pays**, …` |
| Decimals | `640.00` | `210.00` | **`221,09`** |
| Volume | 84,000 contacts, 312,000 events | 13,050 / 74,000 | 960 / 940 |

The largest brand is about ninety times the smallest, which is the point: everything that
touches contacts pages by cursor rather than by offset.

Karoo's file is not valid UTF-8. One contact's name contains an en dash written as a
single Windows-1252 byte, at which a strict reader throws and a lenient one silently
corrupts the name.

## Faults that would have broken the import

| Count | What | What we do |
|---|---|---|
| 131 | rows with the wrong number of fields (9 or 7 instead of 13) | rejected; Karoo's shift `City` into `Status`, so padding them would have corrupted a column |
| 1 | a copy of the header line at data row 40,000 of the Kilele export | rejected; it parses as a valid record and would have become a contact named `full_name` |
| 3 | contacts named `Nul<NUL>Byte` | the NUL is stripped and the row kept; Postgres text cannot hold one, and left alone it aborts the whole 84,000-row import |
| 12 | rows with a newline inside a quoted `notes` field | handled; `wc -l` reports 84,013 lines for 84,000 records, so any line-splitting reader shreds them |

## Faults that would have produced wrong numbers

| Count | What | What we do |
|---|---|---|
| 23,450 | Kilele contacts whose consent is not explicitly true, of which ~10,000 are **blank** | blank is not consent; they are not contactable |
| 11 | spellings of the same boolean (`true`, `TRUE`, `1`, `yes`, `Y`, `false`, `f`, `0`, `no`, …) | folded to true/false/unstated |
| 112 | contacts whose status is the **singular** `unsubscribe` | folded to `unsubscribed`; missing this mails 112 people who opted out |
| ~2,046 | status values differing only in case or trailing space | folded |
| 92 | signups dated in the future, as late as June 2027 | date dropped, row kept, counted |
| 1,237 | signups with a date but no time | midnight in the brand's timezone, recorded as an assumption |
| ~1,200 | signups written `DD/MM/YYYY HH:MM` | day-first assumed, recorded as an assumption |
| 2,342 | countries written as `NULL`, `\N`, `-`, `N/A`, `none`, or whitespace | six spellings of "no value", all folded to empty |
| 13,312 | duplicate events | dropped on `(brand_id, event_id)`; every one is byte-identical |
| 2 | duplicate campaign rows, one of them the 70,000-send `Grand Broadcast` | stored once; summing the file double-counts 89,000 sends |
| 2 | duplicate send-log rows for `BATCH-0003` | counted once; summing inflates by 62,410 recipients |

## Traps with more than one defensible answer

**Identifiers collide across brands.** 12,406 contact references are shared by Kilele and
Karoo, and every Marrakech reference also exists in Kilele. `CT-000050` is three different
people. Every key is `(brand_id, external_id)`. There is a test for this: R11 asserts that
a shared reference resolves to your own brand's person and no one else's.

**Email is not a key either.** It looks like the safe alternative until you notice that
`john doe@vg-eval.test` is shared by 240 distinct Kilele contacts, and that 1,817 have no
address at all. Invalid addresses are stored as empty with the original kept beside them,
because a contact with a bad email may still have a good phone number — and 15 of Kilele's
46 campaigns are SMS.

**Phone numbers in four formats, and the brand's country is no guide.** The South African
export is full of Kenyan numbers. Around 23,000 numbers are twelve digits beginning
`0257`: read one way a mangled Kenyan number, read another a valid Burundi number. They
are kept raw and marked unusable. Guessing would text a stranger.

**400 rows carry another brand's code.** Three signals disagree — the filename, the
`brand_code` column, and the slug inside the email address. The filename is the only one
that is unambiguous and always present, so it wins, the disagreement is recorded, and the
customers are kept. Rejecting 400 people to enforce a column would be losing a client's
data.

**633 Marrakech events name campaigns that exist in no export.** They carry 138
unsubscribes, 138 complaints and 145 bounces, covering 274 people the export still calls
active. They are imported with no campaign attached: they count towards suppression and
are excluded from per-campaign figures, and the gap is stated on the data page. Rejecting
them for failing a foreign key would have quietly made those 274 contactable again.

**The September delta re-activates people who opted out.** It overlaps 2,500 Kilele
contacts, changes the email and phone on every one of them, and moves 202 from
unsubscribed and 90 from bounced back to active. Status is applied; suppression is not
reversed. Those 292 are shown as active and remain uncontactable. Consent itself moves in
both directions, so the 198 genuine re-opt-ins in the same file are honoured.

**The engagement log and the status column disagree completely.** Not one contact with an
unsubscribe event has a status of `unsubscribed` — in any brand. Neither source alone is
sufficient, so contactability is the union of both.

**The reported campaign metrics are not evidence.** Across every brand they over-report
opens roughly threefold and under-report bounces roughly twofold. Kilele's reported sends
total nine times its entire contact base, and several campaigns claim more opens than
sends. They are displayed as what the source system claimed, beside what the log recorded,
and never reconciled.
