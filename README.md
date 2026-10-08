# @pipeworx/korea-tenders

Open South Korean government procurement: bid notices currently open on KONEPS
(나라장터, the Public Procurement Service portal), Defense e-Procurement, LH,
K-water and Nuri-jangteo, plus the suppliers that hold KONEPS contracts, all
from Korean public-data-portal (data.go.kr) feeds as assembled by BOIM
(boim.io). Keyless, live per request.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1721+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `korea_search_tenders(query?, category?, type?, region?, limit?)` — open bid
  notices by free text (title / buying agency), category word, type
  (goods / services / construction / other) and buyer region. Each notice
  carries title, type, source portal, category and group, buyer, closing
  deadline (KST), estimated price in KRW, contract and award method, and the
  g2b.go.kr notice URL. Closest deadline first; only notices still open.
- `korea_search_vendors(query?, category?, group?, region?, cert?, limit?)` —
  suppliers with KONEPS shopping-mall contract items or deliveries in the last
  12 months, by item category, group, region, name and certification
  (여성기업, 사회적기업, 장애인기업, …). Returns the vendor id for the next tool.
- `korea_get_vendor(id)` — one vendor in full: per-item 12-month records and
  amounts, contract items, top agencies, contract methods, PPS price ranges,
  certifications, supply regions, business-registration status, data limits.
- `korea_list_categories(group?)` — the Public Procurement Service item
  taxonomy (물품분류): all groups with their top categories, or every category
  in one group with its 8-digit code and vendor count.

## Auth

Keyless.

## Data sources

- <https://boim.io/api/mcp> — BOIM's public MCP endpoint (JSON-RPC
  `tools/call`); this pack calls `find_public_bids`, `search_vendors`,
  `get_vendor` and `list_categories` and reshapes the results.
- BOIM assembles, twice daily, five bid feeds from the Korean public-data portal
  (data.go.kr): PPS KONEPS bid notices (15129394), Defense e-Procurement
  (15158416), LH (15159012), K-water (15101635), PPS Nuri-jangteo (15129456);
  vendor cards come from the KONEPS shopping-mall item service (15129471) and
  contract-information service (15129427). The portal lists all of them with no
  reuse restriction (이용허락범위 제한 없음).
- BOIM's terms (<https://boim.io/terms/>, effective 2026-10-06) welcome
  per-request MCP/API use within the free range and forbid bulk collection or
  redistribution — this pack only proxies per call and stores nothing.

## Things the next person would otherwise rediscover

- **BOIM matches ONE Korean phrase.** `query: "소프트웨어 유지보수"` returns 0;
  `"소프트웨어"` returns rows. English is not matched at all. The pack maps
  common English terms (software, IT services, cloud, construction, drone,
  CCTV, Seoul, Gyeonggi, …) to a single Korean term and reports what it sent
  in `query_sent`; anything outside the alias table passes through unchanged,
  so an untranslated English word yields an honest zero with a note.
- `type` must be Korean upstream (물품 / 용역 / 공사 / 기타); the pack accepts
  English and rejects anything else loudly rather than silently returning all.
- `list_categories` with a `group` still answers under a `groups` key (one
  group, with its `categories` nested); there is no top-level `categories`.
- Vendor ordering is relevance → card completeness → daily rotation
  (`rotation_seed`), explicitly not by procurement volume; the same search
  returns a different page tomorrow. Vendor ids are stable.
- Dates: bid `deadline` is ISO with a +09:00 offset; vendor dates arrive as
  `YYYYMMDD` and are reshaped to `YYYY-MM-DD` in the search tool (the full
  vendor card is passed through as received).
- The official KONEPS open API on data.go.kr needs a registered service key
  (`SERVICE_KEY_IS_NULL` without one). None is held, so BOIM is the route; if a
  key is ever funded the same tool shape can be re-pointed at
  `apis.data.go.kr/1230000/ad/BidPublicInfoService`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "korea-tenders": {
      "url": "https://gateway.pipeworx.io/korea-tenders/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/korea-tenders/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1721+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/korea_search_tenders \
  -H 'Content-Type: application/json' \
  -d '{"query":"software","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/korea_search_tenders`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "korea-tenders": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-korea-tenders"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-korea-tenders
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Korea Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
