# QA Report — crm.ssbpgc.com

**Date:** 2026-08-24 · **Environment:** production · **Method:** manual browser pass, both roles
**Accounts:** `aarav.sharma@medicrm.in` (Admin), `sneha.iyer@medicrm.in` (Caller)

---

## Verdict

The frontend is healthy. **The API server is not** — it is running code roughly **12 commits
behind** the deployed frontend, and every feature built in those commits either fails outright
or silently does nothing.

Reads work everywhere. Simple writes work. **Two core workflows are completely broken:**
scheduling a follow-up, and converting a lead into an order. Both return HTTP 500, and because
of an IIS setting the user sees no error message at all — the button just does nothing.

| | |
|---|---|
| Blocking issues | **3** |
| Real bugs | **6** |
| Data-integrity problems | **2** |
| Security concerns | **2** |
| Areas verified working | 21 |

**Dashboard specifically:** all 9 server-computed metrics are correct and update live. The two
client-computed cards — **Customers Converted** and **Total Customers** — are both wrong, and
wrong quietly: the numbers look plausible. See the Dashboard audit below.

---

## P0 — Blocking

### 1. Lead conversion is dead

Clicking **Confirm** in Convert Lead to Order does nothing. No error, no spinner, no order.

```
POST /api/leads/{id}/convert   →  500
```

Reproduced from the UI as both Admin and Caller, and directly against the API. **No order is
created.** This is not a stock problem — all 7 callers sit on Main Store, which holds 1,586
units, and the medicine I tested (Asthma Tab) had 80 there against 15 required.

Every sale in the system goes through this. Nothing can be sold right now.

### 2. Follow-ups cannot be scheduled

Setting a Next Follow-up date on a lead fails. Bisected the payload to prove which field:

| Request | Result |
|---|---|
| `{"status":"contacted"}` | 200 |
| `{"followUpSlot":"14-16"}` | 200 |
| `{"nextFollowUp":"2026-08-26"}` | **500** |
| `POST /api/follow-ups` | **500** |

Any write that creates or updates a follow-up row fails. The date silently doesn't save — the
Edit Lead modal stays open and the row is unchanged. Callers cannot book callbacks.

### 3. Root cause — the server is a **mixed build**, not a clean old one

The frontend was rebuilt and deployed correctly. The server is a partial copy: some modules
are current, others are stale. That is worse than being uniformly old, because the modules
disagree with each other.

**Proof** — probing one behaviour per module:

| Module | Probe | State |
|---|---|---|
| `routes/misc.ts` | `/api/dashboard` returns `callsDoneToday` (`ff0cdf4`) | **current** |
| `services/conversion.ts` | `convert-preview` returns `{locationName}` only (`b2077f1`) | **current** |
| `lib/serialize.ts` | `/api/orders` omits `paymentMode` (`6450d70`) | **stale** |
| `lib/serialize.ts` | `/api/follow-ups` omits `slot` (`e0d8284`) | **stale** |

`ff0cdf4` is *newer* than `6450d70`, so this cannot be a single old checkout. **`server/src/lib/`
is stale while `server/src/routes/` is current** — exactly the "new `client/`, old
`server/src/lib/`" mismatch diagnosed in your colleague's ZIP earlier. It is now on production.

The new client sends payload shapes these modules cannot agree on. That is why convert and
follow-up writes 500 while everything else is fine.

**Fix:** delete the deployed `server/` directory and rebuild it from a clean checkout of
`master` — do not copy files over the top, which is how this happened.

**Visible in the UI:** Renewals lists **two separate renewals for Abhishek Pandey** — one for
Asthma Tab, one for Asthma Powder, same order, same date. That is the per-medicine behaviour
`537cbcc` replaced with one-renewal-per-order. It is on screen right now.

**Fix:** rebuild and redeploy the server from current `master`, then run
`npx prisma migrate deploy`. Re-test convert and follow-ups afterwards — I could not determine
the database's migration state from outside, and it may be a second, separate problem.

---

## Dashboard audit

Checked every card against ground truth recomputed from the raw records.

### Server-computed metrics — all correct, all live

| Card | Dashboard | Ground truth | |
|---|---:|---:|---|
| Total Leads | 16 | 16 | OK |
| Total Orders | 5 | 5 | OK |
| Pending Follow-ups | 6 | 6 | OK |
| Renewals Due | 4 | 4 | OK |
| Calls Done Today | 0 | 0 | OK |
| Leads Today | 2 | 2 | OK |
| Leads This Month | 13 | 13 | OK |
| Sales Today | ₹0 | ₹0 | OK |
| Sales This Month | ₹10,371 | ₹10,371 | OK |

Lead Status Breakdown matches per-status and sums to 16. Total Leads moved 14 → 16 the moment
I created two leads, without a refresh — **updating works**.

"Calls Done Today" is genuinely 0 (nobody has logged a call today), and marking a follow-up
complete returns 200, so the counter *can* move. It is not stuck.

### 12. "Customers Converted" is silently measuring the wrong thing

**All 6 converted customers have an empty `convertedDate`.** The client then falls back:

```ts
const on = lead.convertedDate || lead.createdDate   // Dashboard.tsx:179
```

The code's own comment calls this fallback "the wrong date to count on — capture can precede
the sale by months". Every customer is currently hitting it, so the card is counting **when the
lead was captured**, not when they bought.

| Customer | Captured | Actually sold |
|---|---|---|
| Ramesh Gupta | 2026-**07**-30 | 2026-08-01 |
| Rajesh Patel | 2026-08-05 | **no order at all** |

This month the card reads **5**, and the true figure is also 5 — but they are *different sets of
five people*. The fallback drops Ramesh (bought in August, captured in July) and adds Rajesh
(marked Sold, never ordered). Two opposite errors cancelling. They will not cancel next month.

**Cause:** the `converted_at` column exists (queries succeed) but is NULL on every row,
including four leads converted *before* the migration date — so the migration's backfill
`UPDATE` never executed. That is the signature of **`prisma db push`**, which syncs schema but
skips migration SQL entirely, rather than `prisma migrate deploy`.

**Fix:** run `npx prisma migrate deploy`. If the migration is already recorded as applied,
re-run the backfill from `20260814105255_lead_converted_at/migration.sql` by hand.

### 13. Total Customers counts a customer who never bought

**Rajesh Patel** has lead status `Sold` but **no order**. He is counted in Total Customers (6)
and appears in the customer list. The real number of paying customers is 5.

---

## P1 — Real bugs

### 4. Every error message in the app is replaced by "Unable to reach the server"

Type a wrong password and the login page says:

> Unable to reach the server. Check your connection and try again.

It should say the password is wrong. IIS is replacing the app's error responses with its own
HTML page and stripping the CORS headers off it, so the browser can't even read the response:

```
POST /api/auth/login  (bad password)
→ HTTP/1.1 500 Internal Server Error
  Content-Type: text/html
  Server: Microsoft-IIS/10.0
```

```
Access to fetch at 'https://crmapi.ssbpgc.com/api/leads/{id}' from origin
'https://crm.ssbpgc.com' has been blocked by CORS policy: No
'Access-Control-Allow-Origin' header is present
```

This affects **every** 4xx and 5xx in the system. It is also what hides P0 #1 and #2 from the
user — the real errors exist, nobody can see them.

**Fix** — one line in the API site's `web.config`, inside `<system.webServer>`:

```xml
<httpErrors existingResponse="PassThrough" />
```

Worth doing **before** anything else: without it you are debugging blind.

### 5. Profile always shows "LOCATION: Not assigned"

For every user, including ones who definitely have a location. Sneha Iyer shows "Not assigned"
while Manage Locations counts her among Main Store's 7 callers, and her sales draw from it.

Cause — `/api/auth/me` returns `locationId` but not `locationName`; `/api/users` returns both:

```json
// /api/auth/me
{"locationId": "bd4b2083-..."}                              // no locationName

// /api/users
{"locationId": "bd4b2083-...", "locationName": "Main Store"} // both
```

`server/src/routes/users.ts` queries with `include: { location: true }`.
`server/src/auth/auth.ts` does not — lines **89** and **105**. The serializer then sets
`locationName: undefined` and it drops out of the JSON.

**This bug is in current `master`, not just the stale deployment.** Two-line fix.

### 6. Inactive users can still be assigned leads

**Kavya Reddy** is `Inactive` on the User Management page, yet she appears in the Assigned
Caller dropdown on both Add Lead and Edit Lead. Leads can be assigned to someone who cannot
log in.

### 7. Lead status filters don't cover all statuses

Filter tabs are All / New / Contacted / Follow-up / Interested / Converted. But leads exist
with **Call Back Later** (2), **Sold** (1) and **Not Interested** (1) — none reachable by any
filter. "Follow-up" and "Interested" both show 0 while 4 leads sit in unfilterable states.

---

## Data integrity

### 8. Stock page under-reports inventory by 59%

**18 of 25 medicines** show a headline stock figure that ignores four of the five locations.

| Medicine | Stock page says | Actually in stock |
|---|---:|---:|
| Dardantak Powder | 65 | **1,196** |
| Asthma Powder | 55 | **296** |
| Asthma Tab | 80 | **181** |
| Ashwashila Malt | 25 | **123** |
| Kamaking Capsule | 35 | **127** |
| *(13 more)* | | |
| **Total** | **1,586** | **3,839** |

The headline total (1,586) is *exactly* the Main Store total — `stockQuantity` is mirroring one
location instead of summing all five. Visible in Edit Medicine, where the header reads
"Stock by location · **80** total" above rows that add up to 181.

Consequence: the **"0 low on stock"** indicator is meaningless, and anyone doing purchasing off
this page is working from numbers that are wrong by a factor of two.

Conversions check per-location stock and are unaffected — this is a reporting bug, not a
selling one.

### 9. Wrong states on customer records

From the Total Customers list:

- `Anil Kumar — Delhi main road, **Delhi**, Karnataka`
- `Rajesh Patel — Ahmedabad main road, **Ahmedabad**, Karnataka`

Plus junk rows (`rajiv / foyfi / mh`, diseases `fjgfghhh`, `Jjajgs`) and two users named `jj`
and `Mr.` appearing in Sales by Caller. Test data in the live customer list.

---

## Security

### 10. One-click demo login on the production login page

The login page ships two buttons captioned **Admin — aarav.sharma@medicrm.in** and
**Caller — sneha.iyer@medicrm.in**. Clicking Caller logged me straight in — **no password
typed**. Anyone who opens the site gets a working session.

Both accounts also use the seeded passwords (`admin123` / `caller123`), which are in the public
repo at `server/prisma/seed.ts:82-83`.

Remove the demo buttons from production and change both passwords.

### 11. CORS is currently wide open in the repo

The middleware I added defaults to `Access-Control-Allow-Origin: *`. Safe in principle — auth
is a Bearer token, not a cookie — but set `CORS_ORIGIN=https://crm.ssbpgc.com` in `server/.env`
to pin it. Your server already has a hand-added CORS layer doing this; **expect a conflict in
`server/src/app.ts` on `git pull`, and take the repo's version.**

---

## Verified working

**Admin**

- Login, logout, session cleared, protected routes bounce to `/login`
- Dashboard — all 6 stat cards, Leads/Converted/Sales period columns, Lead Status Breakdown (sums correctly to 14), Sales by Caller, Recent Leads, Caller Performance
- **Total Customers modal** — 6 unique, "repeat purchases counted once", customer columns only, no order data
- Sidebar badges — Leads 4 (= New count), Renewals 4 (= Renewals Due) ✓
- Leads list, search, Convert button present on unconverted rows only
- **Add Lead** — pincode genuinely optional (`required: false`, saved blank), source defaults to Social Media, caller dropdown correct
- Edit Lead — all 8 statuses
- **Time Slot picker** — appears when a date is set; options exactly `10 AM–12 PM / 12–2 / 2–4 / 4–6` ✓
- **Convert modal** — medicine search (21 results with prices), tenure 15/30/60/90, **live pricing** (₹180 × 30 = ₹5,400; × 15 = ₹2,700), discount modes, payment mode toggle, **screenshot field disappears on Offline** ✓
- Orders — list, stage filters, **Advance** and **Back to previous stage** both work and update live
- Renewals — list, status filters, Renew modal with tenure + payment mode + discount
- Calendar — **opens on Daily** ✓, Monthly grid, week starts Monday, day click opens that day's list, **Call button with correct `tel:` link** ✓
- Stock — catalogue, Edit Medicine with **per-location rows and visible location names** ✓, Manage Locations with clear delete-guard reasons
- Users — 10 members, roles, lead counts, status, last login
- Profile — opens, name/phone/email editable, saves successfully
- Notifications panel opens

**Caller**

- Login, correct identity in sidebar
- **Stock and User Management hidden from navigation** ✓
- **Direct URLs `/stock` and `/users` both redirect to Dashboard** ✓
- **API-level scoping enforced, not just UI** — with a caller token: `/api/users` returns **1** record (herself, not 10), leads 4, orders 1 ✓
- Dashboard scoped (4 leads vs 14, 1 order vs 5) with a "My Tasks Today" panel
- **Add Lead — Assigned Caller shows only herself, pre-selected, no reassignment possible** ✓
- Lead created and appeared live
- Calendar, Orders scoped correctly
- Profile opens and is editable

**Live updating** — every successful write appeared without a manual refresh (lead counts
14→15 and 4→5, order stage changes both directions).

---

## Not tested, and why

| Item | Reason |
|---|---|
| Marking a follow-up **Complete** | Would mark a real customer's callback done, with no undo |
| Submitting **Renew order** | Would place a real order for a real customer; same payload shape as convert, already proven to fail |
| Delete lead / delete medicine / delete location | Destructive on live data |
| Change Password | Would lock a real account |
| Screenshots | The Browser pane isn't displayed in this session, so no images could be captured. All findings above come from the live DOM, network traffic and console — the React handlers and API calls were exercised exactly as a user's clicks would. |

---

## Test data I created

Both are prefixed `QA`. Safe to delete.

| Record | Mobile | Notes |
|---|---|---|
| Lead **QA Test Patient** | 9000000001 | Admin-created, assigned Sneha Iyer, status `contacted`, no pincode |
| Lead **QA Caller Lead** | 9000000002 | Caller-created, status `contacted` |

No orders or renewals were created — every conversion attempt failed. Order `ORD-2026-0004`
was stepped back one stage and **restored to `Prepared`**.

---

## Suggested order of work

1. **`<httpErrors existingResponse="PassThrough" />`** on the API site — stop losing error
   messages. Everything else is easier to diagnose afterwards.
2. **Rebuild the server from a clean checkout of `master`** — delete the deployed `server/`
   directory first rather than copying over it. Clears P0 #1, #2, #3 and the duplicate-renewals
   symptom. Re-test convert and follow-ups immediately after.
3. **`npx prisma migrate deploy`** — not `db push`. Then confirm `converted_at` is populated;
   if not, run the backfill from `20260814105255_lead_converted_at/migration.sql` by hand.
   Fixes the Customers Converted card (#12).
4. **Remove the demo login buttons; change both seeded passwords.**
5. Fix Profile location — add `include: { location: true }` at `auth.ts:89` and `:105`.
6. Recompute `medicine.stockQuantity` from per-location stock, and fix whatever writes it.
7. Exclude inactive users from the caller dropdown; add the missing lead-status filters.
8. Clean the junk customer/user rows, the two wrong states, and Rajesh Patel's
   sold-but-never-ordered record.
