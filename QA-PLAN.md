# QA Plan — crm.ssbpgc.com

Manual browser pass against production, 2026-08-24. Two personas, run in order.
Every record created is prefixed `QA` so it can be found and removed afterwards.

**Not doing:** deleting real locations/medicines/users, changing passwords on real
accounts, or anything else that destroys existing data.

## Persona 1 — Admin (`aarav.sharma@medicrm.in`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Login | Valid creds land on dashboard; wrong password shows a *useful* error, not "unable to reach server" |
| 2 | Dashboard | All stat cards populate; Total Customers opens the customer-only modal; unique-only; converted today/week/month; Calls Done Today |
| 3 | Sidebar | Badge counts on Orders / Leads / Renewals match the pages they link to |
| 4 | Leads — read | List loads, search, filters, pagination |
| 5 | Leads — create | Pincode **optional**; lead source defaults to Social Media; assigned caller defaults to logged-in user |
| 6 | Leads — edit | Changes persist and appear without a manual refresh |
| 7 | Follow-up | Can set date **and** 2-hour time slot (10-12 … 16-18) |
| 8 | Convert (CLO) | Medicine picker; tenure dropdown 15/30/60/90; price auto-calculates; stock checked against the caller's location; payment mode online (screenshot required) vs offline (not required) |
| 9 | Orders | List, stage advance, **reverse to previous stage**, detail view |
| 10 | Renewals | One renewal per order (not per medicine); reorder with tenure + payment mode |
| 11 | Calendar | Opens on **daily**; slot shown beside status; call button opens dialer |
| 12 | Stock | Location picker; per-location quantities visible with location **names**; Set updates; Manage Locations add/delete |
| 13 | Medicines | List, add, edit, price |
| 14 | Users | List, create, edit role/location |
| 15 | Profile | Opens; name/phone/email editable; employeeId/role/location read-only |
| 16 | Notifications | Bell renders, items load |
| 17 | Logout | Clears session; protected routes bounce to /login |

## Persona 2 — Caller (`sneha.iyer@medicrm.in`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Login | Lands on dashboard |
| 2 | Nav hiding | **Stock and Users must not appear** in the sidebar |
| 3 | Route guard | Typing `/stock` and `/users` directly must not render the page |
| 4 | Scoping | Dashboard and Leads show only this caller's records, not everyone's |
| 5 | Leads — create | Assigned caller locks to self; cannot assign to another caller |
| 6 | Convert | Stock is checked against *this caller's* location |
| 7 | Calendar | Own follow-ups only; slot + call button work |
| 8 | Orders / Renewals | Scoped to own records |
| 9 | Profile | Editable |
| 10 | Logout | Clean |

## Known going in

- Wrong-password returns IIS's HTML 500 instead of a real 401 (server config, already reported)
- 5 Prisma migrations may still be pending on the production DB
- 6 callers sit on Delhi / Main Store, which hold zero stock — conversions by those callers should fail
