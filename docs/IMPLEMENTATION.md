# Implementation notes (English)

> The exhaustive, round-by-round engineering log is **[实现文档.md](实现文档.md)** (Chinese, ~190 KB).
> This file is the English map: architecture, protocol findings, and where to look when it breaks.
> Those findings are the expensive part of this project — they were all measured against the real
> service, not guessed.

## Architecture

Two halves, in one package, zero dependencies, no bundler:

| Half | File | Runs in | Owns |
|---|---|---|---|
| Host | `index.js` | DSH's Node process | proof-of-work, upstream calls, SSE parsing, all HTTP routes |
| Client | `client.js` | the DSH web page | the panel UI (hand-rolled React, no JSX) |

- The panel registers into the slots `sidebar.panellist` (entry icon) and `main` (the panel body).
- The client calls its host half over **document-relative** URLs (`api/deepseek-web/...`) via
  `ctx.webServer.register({ kind: 'exact', path, handler })`.
- **The token never reaches the browser.** `/config` returns only `configured` and a masked phone
  number. Refresh the page for client changes; **restart DSH for host changes** — that split is
  measured, not assumed.

### Trust guard

The routes are for the local DSH page only. A request is accepted when the socket is loopback, the
`Host` header is loopback, and it carries a browser marker (`sec-fetch-site: same-origin`, or any
`Origin`, or a `dsh-auth-` cookie — the Desktop shell serves the page from `dsh-app://app/` and
forwards only that cookie). `cross-site` requests, non-loopback sockets/hosts and a mismatched
`Origin` are rejected. The 403 body includes a `reason` and a `seen` snapshot, so a failure can be
diagnosed without a debugger.

## Endpoint map (all measured)

| Purpose | Endpoint |
|---|---|
| PoW challenge | `POST /api/v0/chat/create_pow_challenge` |
| Send a message | `POST /api/v0/chat/completion` (SSE) |
| Session list | `GET /api/v0/chat_session/fetch_page?count=N` |
| Session history | `GET /api/v0/chat/history_messages?chat_session_id=X` |
| Rename / pin / delete | `chat_session/update_title`, `batch_update_pinned`, `delete`, `delete_all` |
| Login | `users/create_guest_challenge` → `create_sms_verification_code` → `login_by_mobile_sms` |

## Protocol findings

**Proof of work.** The challenge bundle is discovered at runtime: homepage → `main.*.js` → the wasm
filename. The wasm has **zero imports**, so `WebAssembly.instantiate(bytes, {})` works in Node.
The solver writes to `i32@+0` (status) and `f64@+8` (answer). Two header names, paired with the
challenge type: `x-ds-guest-pow-response` for guest challenges, `x-ds-pow-response` for
authenticated ones — with **different payload shapes**.

**SSE frames.** Four shapes appear, and the interesting ones are *nested patch batches*:

```
{v:{response:{fragments:[…]}}}                      snapshot
{v:[fragment, …]}                                   array of fragments
{v:[{p:'content',…},{p:'references',…}]}            bare patches, relative to the CURRENT fragment
{p:'response', o:'BATCH', v:[{p:'fragments', …}]}   nested batch — sub-paths are RELATIVE
{v:'text'}                                          target-less delta for the current fragment
```

> Dropping the nested shapes silently loses whole features: `TOOL_SEARCH` / `TOOL_OPEN` fragments
> were never created, so search cards and sources were missing **while streaming** but correct after
> switching conversations (which reloads from history). Replaying captured real frames through the
> real parser is what proved it.

**Fragment types** inside a message: `REQUEST`, `THINK` (with `elapsed_secs`), `TOOL_SEARCH`
(`content: "Found 25 web pages"`, `queries[]`, `results[]`), `TOOL_OPEN` (the opened page:
`url/title/snippet/site_name`), `RESPONSE`.

**Citations.** The answer text contains literal `[reference:N]`, and `RESPONSE.references[N]` maps
positionally to a fragment id — which resolves to a `TOOL_OPEN` (a page) or the `TOOL_SEARCH` card.

**Threading.** `parent_message_id` must point at the previous message. Sending `null` every turn
makes each user message a new root, and the **web UI renders those as parallel branches** ("1/2/3"
paging) while a flat panel view looks fine. This was found by sending two controlled requests and
reading the resulting `parent_id` chain back.

**Sessions.** `count` works up to 100; **passing 200 returns zero items**. Cursor parameters were
tried six ways and are all **ignored**, so only the most recent ≤100 sessions are listable — the UI
says so rather than pretending to paginate.

## Testing

`test/harness-host.mjs` and `test/harness-client.mjs` are dependency-free integration tests that read
the **real package files**. There is no `react` on disk (it is bundled inside the app), so the client
harness ships a minimal React shim with stateful hooks and an effect drain. The host harness stubs
only `/api/v0/*`; PoW, the guest challenge and the wasm hit the real site.

Convention: every bug fix adds an assertion **plus a negative control** — e.g. "the answer must not
contain reasoning text" for the real captured SSE sequence, and "blocks must render in exactly this
order: `think>search>think>browse>answer`".

## When it breaks

Interface changes are expected. The ordered procedure for re-discovery:

1. Capture a real SSE stream and dump every frame shape you do not recognise (an unhandled frame
   currently fails silently — the symptom is a missing UI element, not an error).
2. Diff the fragment types and patch paths against the tables above.
3. Re-check the PoW header name and payload shape for the challenge type in use.
4. Re-run both harnesses; if the real frame sequence changed, update the embedded regression fixture.

The code comments and the Chinese log are written for exactly this situation: they record what was
measured, what failed, and why the current shape was chosen.
