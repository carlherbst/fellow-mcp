# fellow-mcp — project map

Unofficial **MCP server for Fellow's connected coffee machines** — the **Aiden** (drip) and the **Espresso Series 1**. Push/list/update/delete/share profiles over Fellow's private API, scrape coffee details from roaster product pages, and apply brewing heuristics to design a recipe. TypeScript, runs as a **Cloudflare Worker** (Streamable-HTTP MCP transport + OAuth 2.0).

> **This is `carlherbst/fellow-mcp`, a fork of `ravenintheforrest/aiden-mcp`** (still `upstream`). Upstream is Aiden-only; the fork adds Series 1 support on branch `feat/series-1-espresso`. Renamed from `aiden-mcp` 2026-08-07.
>
> `TASKS.md` and `SESSIONS.md` are **upstream's working notes** — another developer's machine, vault paths, and history. They are deliberately left unedited; don't treat them as describing this deployment.

## Two machines, two route shapes

Same host, same Bearer JWT, different product path segment and different profile schema:

| Machine | Route | Client | Profile kind |
|---|---|---|---|
| Aiden | `/v1/devices/{id}/…` | `FellowClient` (`fellow-api.ts`) | brew — bloom, pulses, temps, ratio |
| Espresso Series 1 | `/v2/solo/devices/{FS_id}/…` | `SoloClient` (`solo-api.ts`) | **pressure** — pre-infusion, `infusion[]` stages, ramp-down |

`getDevice()` selects the Aiden by *excluding* `deviceType == "solo"`; `getSoloDevice()` selects the ES1. Schemas share no fields, hence separate tool surfaces rather than a mode flag.

Espresso write rules that are easy to get wrong (all learned from live 400s — see `notes/fellow-api-series-1-findings.md` in the coffee repo):
- Build write bodies by **allowlist** — Fellow validates with `forbidNonWhitelisted`, so an unanticipated field is a 400, and read responses carry fields (`device`, `synced`, Drops metadata) that must not be echoed back.
- `folder` is required on writes even though it is read-only in practice.
- Every write is echo-checked (`diffSoloEcho`) — a 200 that saved different values is reported, not treated as success.

## Where things live
- **This fork is not deployed to Cloudflare.** It runs `wrangler dev` in **local mode (workerd)** as a LAN-only container: Komodo stack `aiden-mcp` on server `infra-lxc` (10.0.1.149), port 8787. The upstream Cloudflare deploy path still works but is unused here.
- **Deploying a change:** push to the branch, then Komodo **deploy** (recreates on a compose change) or **restart** (re-fetches the branch). The start command hard-resets to `origin/$REPO_REF`, so local edits in the `app` volume are discarded.
- **State:** none persistent. KV (`AIDEN_OAUTH`) holds only short-lived records — auth codes ≤10min, access tokens ≤1hr, client regs ≤90d. **Only Fellow-issued JWTs are stored, never the Fellow password.**
- **Secrets:** canary account creds + webhook. Local dev vars in `.dev.vars` (untracked). Never in-repo.
- **Auth model:** OAuth 2.0 auth-code + PKCE, or `X-Fellow-Email`/`X-Fellow-Password` headers. Password reaches server once at `/oauth/authorize`, exchanged for a Fellow JWT, then discarded.
- **Profile data** (temperature/ratio priors) is harvested, not folk wisdom — see `data/`. Aiden-oriented; the Series 1 has no equivalent dataset.

## Folder map
- `src/index.ts` — Worker entry: HTTP routing, MCP server, tool registration, header auth.
- `src/fellow-api.ts` — **Aiden** client (list/create/update/delete/share, device info) + shared device discovery and `apiPrefix()`/`isSolo()`.
- `src/solo-api.ts` — **Espresso Series 1** client for `/v2/solo/…`: allowlist write bodies, `settingsVersion` stamping, DELETE-with-body, forbidden-property retry, `diffSoloEcho`.
- `src/solo-validation.ts` — zod contract for espresso pressure profiles + cross-field consistency checks.
- `src/auth.ts` — Fellow `/auth/login` → JWT.
- `src/fellow-schemas.ts` — zod contracts for Fellow API responses (drift detection).
- `src/validation.ts` — client-side profile validation before write (clear errors, not 400s).
- `src/coffee-fetcher.ts` — `fetch_coffee_details`: scrape Shopify roaster pages → structured coffee data.
- `src/brewing-guidelines.ts` — `brewing_guidelines`: Aiden brewing heuristics + starting recipe.
- `src/grinders.ts` — grind-setting conversions across grinder models.
- `src/flash-brew.ts` — `flash_brew`: Japanese iced coffee plan + dose workaround.
- `src/canary.ts` — hourly cron probe of Fellow API for drift; fingerprinted alerts to webhook.
- `src/oauth/` — OAuth flow: `authorize.ts`, `token.ts`, `register.ts` (dynamic client reg), `discovery.ts` (well-known metadata), `kv.ts` (KV helpers).
- `data/` — profile datasets (`brew-talks-profiles.csv` = primary 145, `fellow-drops-profiles.csv`) + `README.md`.
- `scripts/` — `fetch-brew-talks.py`, `drops-stats.py` — regenerate/analyze the datasets.
- `wrangler.toml` — Worker config: KV binding, hourly cron trigger, custom domain notes.

## Naming / never-commit
- **Never commit:** `.dev.vars`, `.env*` (except `.env.example`), `node_modules/`, `.wrangler/`, `dist/`, `*.log`. No Fellow passwords, JWTs, or KV ids-as-secrets in source.
- Tool logic files are named after the tool they back (`flash-brew.ts` → `flash_brew`).

## Routing table
| Working on… | Read | Skip |
|---|---|---|
| A tool's behavior / MCP registration | `src/index.ts` + the tool's file | `oauth/`, `canary.ts` |
| Fellow API call broke / new endpoint | `src/fellow-api.ts`, `src/auth.ts`, `src/fellow-schemas.ts` | `coffee-fetcher.ts`, brewing files |
| Anything Espresso Series 1 | `src/solo-api.ts`, `src/solo-validation.ts` | `brewing-guidelines.ts`, `flash-brew.ts`, `data/` (all Aiden-only) |
| Espresso write rejected (400) | `src/solo-api.ts` (allowlist + retry), `src/solo-validation.ts` | `validation.ts` (Aiden only) |
| Profile rejected / validation errors | `src/validation.ts`, `README.md` (schema table) | `oauth/`, scraping |
| Roaster page won't parse | `src/coffee-fetcher.ts` | Fellow API, oauth |
| Brewing heuristics / recipe output | `src/brewing-guidelines.ts`, `src/grinders.ts`, `data/README.md` | `oauth/`, `fellow-api.ts` |
| Flash / iced brew math | `src/flash-brew.ts` | oauth, api |
| OAuth / connector sign-in | `src/oauth/*`, `src/index.ts` (routing) | brewing/scraping |
| API drift alerts | `src/canary.ts`, `src/fellow-schemas.ts`, `wrangler.toml` (cron) | tool files |
| Dataset refresh | `scripts/*.py`, `data/` | `src/` |
| Deploy / KV / domain / cron config | `wrangler.toml`, `README.md` (self-hosting) | `src/` logic |

## Commands
`npm run dev` (local Worker at :8787) · `npm run deploy` (ship to Cloudflare) · `npm run tail` (live logs) · `npm run types` (regen Worker types) · `npx wrangler secret put <NAME>` (set a secret).

## Files that ARE the memory
`TASKS.md` (current focus) · `SESSIONS.md` (distilled past chats, if present). Read both at session start; run `end-session` to update + push.
