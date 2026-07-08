# Tasks — aiden-mcp

## Now
- _(nothing in flight — set the next focus here)_

## Next
- **Refresh-token flow for OAuth** so clients don't re-auth every ~1hr when the Fellow JWT expires (called out in README Contributing + Caveats).
- **More roaster parsers** for `fetch_coffee_details` — Sey, Heart, Tim Wendelboe pages are untested and may not parse cleanly.
- Confirm the **Brew Talks 145-profile dataset** (latest harvest) is fully wired into `brewing_guidelines` temperature priors, not just the older 69 Fellow Drops set the README still cites.

## Someday
- **Multi-device Aiden support** — currently picks the first device the account returns.
- Revisit brewing heuristics in `brewing_guidelines` as real-world brews disagree with tool output.
- Broaden `fetch_coffee_details` beyond Shopify-shaped product pages.
