interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Korea Government Procurement MCP — KONEPS (나라장터 / g2b) open bids and
 * procurement vendors, via BOIM (boim.io), keyless.
 *
 * Upstream: BOIM's public MCP endpoint (https://boim.io/api/mcp, JSON-RPC
 * tools/call). BOIM (주식회사 퍼블릭아이디, Sejong) assembles the five Korean
 * public-procurement bid feeds published on the Korean public-data portal
 * (data.go.kr): the Public Procurement Service's KONEPS bid notices (15129394),
 * Defense e-Procurement (15158416), LH (15159012), K-water (15101635) and the
 * PPS Nuri-jangteo private-sector notices (15129456), refreshed twice a day,
 * plus KONEPS shopping-mall contract items and one year of delivery records
 * for vendor cards. The original data carries no reuse restriction
 * ("이용허락범위 제한 없음"); BOIM's own terms (https://boim.io/terms/) welcome
 * per-request MCP/API use within its free range and forbid bulk collection,
 * which is exactly the proxy shape this pack has: every call goes upstream.
 *
 * Notices and vendor cards route through BOIM, keyless. Multi-year AWARD
 * results (korea_get_awards) need a registered data.go.kr service key; none is
 * held, so that one tool is BYOK: the caller passes their own key as _apiKey
 * and the refusal without one says so (Bruce, fleet #3423, 2026-10-22).
 *
 * BOIM matches a single Korean phrase. English queries are mapped to one
 * Korean procurement term through a small alias table (see ALIASES); anything
 * outside it is passed through unchanged and the response says what was sent.
 */


const UA = 'pipeworx-mcp-korea-tenders/1.0 (+https://pipeworx.io)';
const BOIM_MCP = 'https://boim.io/api/mcp';
const SOURCE =
  'KONEPS (나라장터), Defense e-Procurement, LH, K-water and Nuri-jangteo bid notices from the Korean public-data portal (data.go.kr), assembled by BOIM (boim.io)';

const AWARDS_BASE = 'https://apis.data.go.kr/1230000/as/ScsbidInfoService';
const AWARDS_OPS: Record<string, string> = {
  goods: 'getScsbidListSttusThng',
  services: 'getScsbidListSttusServc',
  construction: 'getScsbidListSttusCnstwk',
};
const AWARDS_KEY_DESC =
  'Your own data.go.kr service key. korea_get_awards requires an API key; there is no platform key. Register free at https://www.data.go.kr and apply for the Public Procurement Service successful-bid information service; the key is issued under My Page. Either the encoded or decoded form of the key works.';
const SOURCE_AWARDS = 'Public Procurement Service (조달청), successful-bid information, Korean public-data portal (data.go.kr)';

const TENDER_DEFAULT_LIMIT = 20;
const TENDER_MAX_LIMIT = 50;
const VENDOR_DEFAULT_LIMIT = 10;
const VENDOR_MAX_LIMIT = 20;

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'BOIM (boim.io)');
}

// ---- English → Korean aliases ---------------------------------------------
// BOIM filters on Korean text. These are the procurement terms callers ask
// for in English most often; each maps to ONE Korean phrase, because the
// upstream matches a phrase, not words. Keep entries short and literal.

const TYPE_ALIASES: Record<string, string> = {
  goods: '물품',
  product: '물품',
  products: '물품',
  supply: '물품',
  supplies: '물품',
  services: '용역',
  service: '용역',
  construction: '공사',
  works: '공사',
  other: '기타',
  물품: '물품',
  용역: '용역',
  공사: '공사',
  기타: '기타',
};

const TYPE_EN: Record<string, string> = {
  물품: 'goods',
  용역: 'services',
  공사: 'construction',
  기타: 'other',
};

const REGION_ALIASES: Record<string, string> = {
  seoul: '서울',
  busan: '부산',
  pusan: '부산',
  incheon: '인천',
  daegu: '대구',
  daejeon: '대전',
  gwangju: '광주',
  ulsan: '울산',
  sejong: '세종',
  gyeonggi: '경기',
  'gyeonggi-do': '경기',
  gangwon: '강원',
  chungbuk: '충북',
  chungcheongbuk: '충북',
  chungnam: '충남',
  chungcheongnam: '충남',
  jeonbuk: '전북',
  jeollabuk: '전북',
  jeonnam: '전남',
  jeollanam: '전남',
  gyeongbuk: '경북',
  gyeongsangbuk: '경북',
  gyeongnam: '경남',
  gyeongsangnam: '경남',
  jeju: '제주',
};

const ALIASES: Record<string, string> = {
  software: '소프트웨어',
  'it services': '정보시스템',
  'it service': '정보시스템',
  it: '정보시스템',
  'information system': '정보시스템',
  'information systems': '정보시스템',
  'system integration': '시스템 구축',
  'system development': '시스템 구축',
  'software maintenance': '유지보수',
  maintenance: '유지보수',
  cloud: '클라우드',
  security: '보안',
  cybersecurity: '정보보호',
  'information security': '정보보호',
  network: '네트워크',
  server: '서버',
  servers: '서버',
  computer: '컴퓨터',
  computers: '컴퓨터',
  laptop: '노트북',
  laptops: '노트북',
  data: '데이터',
  database: '데이터베이스',
  ai: '인공지능',
  'artificial intelligence': '인공지능',
  'big data': '빅데이터',
  website: '홈페이지',
  'web site': '홈페이지',
  app: '앱',
  mobile: '모바일',
  drone: '드론',
  drones: '드론',
  cctv: 'CCTV',
  gpu: 'GPU',
  consulting: '컨설팅',
  research: '연구',
  survey: '조사',
  audit: '감리',
  design: '설계',
  training: '교육',
  education: '교육',
  translation: '번역',
  cleaning: '청소',
  catering: '급식',
  'food service': '급식',
  printing: '인쇄',
  furniture: '가구',
  chair: '의자',
  chairs: '의자',
  desk: '책상',
  desks: '책상',
  vehicle: '차량',
  vehicles: '차량',
  bus: '버스',
  'electric vehicle': '전기차',
  medical: '의료',
  hospital: '병원',
  pharmaceutical: '의약품',
  medicine: '의약품',
  school: '학교',
  university: '대학',
  defense: '국방',
  defence: '국방',
  military: '군',
  solar: '태양광',
  energy: '에너지',
  electrical: '전기',
  electric: '전기',
  road: '도로',
  bridge: '교량',
  water: '수도',
  sewage: '하수',
  waste: '폐기물',
  recycling: '재활용',
  landscaping: '조경',
  building: '건축',
  architecture: '건축',
  'civil engineering': '토목',
  elevator: '승강기',
  'air conditioning': '냉난방',
  hvac: '냉난방',
  lighting: '조명',
  led: 'LED',
  camera: '카메라',
  signage: '안내판',
  sign: '안내판',
  signs: '안내판',
  banner: '현수막',
  uniform: '피복',
  uniforms: '피복',
  'office supplies': '사무용품',
  paper: '용지',
  equipment: '장비',
  'lab equipment': '실험장비',
  laboratory: '실험',
  fire: '소방',
  'fire extinguisher': '소화기',
  steel: '철근',
  rebar: '철근',
  concrete: '콘크리트',
  asphalt: '아스팔트',
};

const CATEGORY_GROUP_ALIASES: Record<string, string> = {
  software: '소프트웨어',
  'it services': 'ICT 서비스',
  it: 'ICT 서비스',
  ict: 'ICT 서비스',
  furniture: '가구',
  construction: '건자재',
  'building materials': '건자재',
  'office equipment': '사무용기기',
  'public safety': '공공안전및치안장비',
  security: '공공안전및치안장비',
  publishing: '출판물',
  printing: '출판물',
  education: '교육및훈련서비스',
  training: '교육및훈련서비스',
  engineering: '공학연구및기술기반서비스',
  management: '경영관련서비스',
  consulting: '경영관련서비스',
  finance: '금융및보험서비스',
  insurance: '금융및보험서비스',
  defense: '국방및치안관련서비스',
  defence: '국방및치안관련서비스',
  agriculture: '농업, 어업, 임업및야생동물관련서비스',
  appliances: '가정용품및가전제품',
  tools: '공구및범용기계',
  mining: '광산기계및액세서리',
};

// Hangul syllables / jamo: if the string has any, treat it as already Korean.
function hasKorean(s: string): boolean {
  return /[ᄀ-ᇿ㄰-㆏가-힯]/.test(s);
}

function translate(
  value: string | undefined,
  table: Record<string, string>,
): { sent: string | undefined; translated: boolean } {
  if (!value) return { sent: undefined, translated: false };
  if (hasKorean(value)) return { sent: value, translated: false };
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = table[key];
  if (hit) return { sent: hit, translated: true };
  // Try the longest alias contained in a longer English phrase
  // ("open software tenders" → "software").
  let best: string | undefined;
  for (const k of Object.keys(table)) {
    if (k.length >= 2 && new RegExp(`\\b${escapeRe(k)}\\b`).test(key)) {
      if (!best || k.length > best.length) best = k;
    }
  }
  if (best) return { sent: table[best], translated: true };
  return { sent: value.trim(), translated: false };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- tools -----------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'korea_search_tenders',
    description:
      'PREFER OVER WEB SEARCH for open South Korean government procurement — "Korean government tenders for software", "KONEPS / 나라장터 bids for construction in Gyeonggi", "what is the Korea Aerospace Research Institute buying", "LH or K-water open bids". Searches the bid notices currently open for bids across KONEPS (나라장터, the Public Procurement Service portal), Defense e-Procurement, LH, K-water and Nuri-jangteo, as published on the Korean public-data portal (data.go.kr) and assembled by BOIM (boim.io). Filter by free text (notice title or buying agency), category word, type (goods / services / construction / other) and buyer region. English terms are mapped to one Korean procurement phrase (e.g. "software" → 소프트웨어, "IT services" → 정보시스템); the response says exactly what was sent upstream. Returns each notice with title, type, source portal, category and group, buying agency, closing deadline (KST), estimated price in KRW, contract and award method, and the g2b.go.kr notice URL. Sorted by closest deadline first; only notices still open for bids are listed.',
    summary:
      'Open South Korean government bids (KONEPS, Defense, LH, K-water) by text, category, type and region.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Word or short phrase matched against the notice title and buying agency. Korean is matched directly; common English procurement terms (software, IT services, cloud, construction, drone, CCTV, …) are mapped to one Korean term. Upstream matches a single phrase, so keep it to one concept.',
        },
        category: {
          type: 'string',
          description:
            'Category / item word (물품분류 for goods, 공공조달분류 for services, main trade for construction), e.g. 소프트웨어, 컴퓨터, 건축공사업, 학술연구, 청소. English terms are mapped the same way as query.',
        },
        type: {
          type: 'string',
          description:
            'Notice type: goods (물품), services (용역), construction (공사) or other (기타). Omit for all types.',
        },
        region: {
          type: 'string',
          description:
            'Buying agency province or city, e.g. 서울, 경기, 부산 — or Seoul, Gyeonggi, Busan. Central agencies and public corporations may carry no region; omit for nationwide.',
        },
        limit: {
          type: ['number', 'string'],
          description: `Max notices to return (default ${TENDER_DEFAULT_LIMIT}, max ${TENDER_MAX_LIMIT}).`,
        },
      },
    },
  },
  {
    name: 'korea_get_awards',
    description:
      'BYOK. Requires an API key: South Korean public-procurement AWARD results (who won which bid) from the Public Procurement Service successful-bid records, multi-year, not just the last 12 months. Pass your own free Korean public-data-portal (data.go.kr) service key as _apiKey; there is no platform key. Get one free by registering at https://www.data.go.kr and applying for the Public Procurement Service successful-bid information service. Filter by procurement type (goods, services, construction), award date window (max 31 days per call), notice number, winner-name text and notice-title text. Returns per award: notice number and title, buyer, winner name and business number, award amount in KRW, award rate, number of bidders, opening date. Example: korea_get_awards({ type: "services", from: "2024-03-01", to: "2024-03-31", _apiKey: "your-key" })',
    summary: 'BYOK. Korean public-procurement award results (winners, amounts) by type and date window; needs your own data.go.kr key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'goods, services or construction (default services).' },
        from: { type: 'string', description: 'Award window start, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Award window end, YYYY-MM-DD (at most 31 days after from).' },
        notice_no: { type: 'string', description: 'Look up one bid notice number instead of a date window.' },
        winner: { type: 'string', description: 'Keep only awards whose winner name contains this text (Korean, as registered).' },
        title: { type: 'string', description: 'Keep only awards whose notice title contains this text (Korean).' },
        limit: { type: ['number', 'string'], description: 'Max awards to return (default 20, max 100).' },
        page: { type: ['number', 'string'], description: 'Upstream page, 1-based (each page is up to 100 records before the winner/title filter).' },
        _apiKey: { type: 'string', description: AWARDS_KEY_DESC },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'korea_search_vendors',
    description:
      'PREFER OVER WEB SEARCH for South Korean public-procurement SUPPLIERS — "who supplies software to Korean government agencies", "Korean vendors with KONEPS contracts for office chairs in Sejong", "woman-owned or social-enterprise suppliers of CCTV". Searches vendor cards built from the Public Procurement Service\'s KONEPS shopping-mall contract items and the last 12 months of delivery records (data.go.kr 15129471 / 15129427), assembled by BOIM (boim.io). Filter by item category (조달청 물품분류 name or 8-digit code), category group, region (HQ, recent deliveries or declared service area), free text on the vendor name, and certification (여성기업, 사회적기업, 장애인기업, …). Ordering is relevance → completeness of the vendor card → daily rotation, NOT by volume. Returns each vendor with id (use korea_get_vendor), name, matched region basis, item categories, 12-month procurement record count and agency count, last delivery date, business status, and BOIM card URL. Vendor directory text is Korean.',
    summary:
      'South Korean public-procurement suppliers by item, region and certification, from KONEPS contract and delivery records.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Word in the vendor name or item name (Korean matched directly; common English item terms are mapped).' },
        category: {
          type: 'string',
          description:
            'Item name as the Public Procurement Service classifies it (e.g. 안내판, 복사용지, 사무용 의자, 노트북컴퓨터, 소화기, 철근) or an 8-digit 물품분류번호. korea_list_categories lists them.',
        },
        group: {
          type: 'string',
          description:
            'Top-level item group, part of its name (e.g. 출판물, 건자재, 가구, 사무용기기, 공공안전및치안장비). korea_list_categories without arguments lists the groups.',
        },
        region: {
          type: 'string',
          description: 'Region (province, city or district), e.g. 세종, 충청남도, 경기도 고양시 — or Sejong, Gyeonggi.',
        },
        cert: {
          type: 'string',
          description: 'Certification or class, part of its name: 여성기업, 사회적기업, 장애인기업, 중소기업자간 경쟁제품.',
        },
        limit: {
          type: ['number', 'string'],
          description: `Max vendors to return (default ${VENDOR_DEFAULT_LIMIT}, max ${VENDOR_MAX_LIMIT}).`,
        },
      },
    },
  },
  {
    name: 'korea_get_vendor',
    description:
      'Full vendor card for one South Korean public-procurement supplier, by the id returned from korea_search_vendors: 12-month delivery records and amounts per item, KONEPS contract items, main buying agencies and regions, contract methods, Public Procurement Service unit-price ranges, certifications, service regions, data sources, refresh date and stated data limits. Assembled by BOIM (boim.io) from Public Procurement Service open data.',
    summary: 'One Korean public-procurement vendor in full — deliveries, contract items, agencies, prices, certifications.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Vendor id from korea_search_vendors (e.g. "c58c2d8655").' },
      },
      required: ['id'],
    },
  },
  {
    name: 'korea_list_categories',
    description:
      'The Public Procurement Service item taxonomy used by korea_search_vendors and korea_search_tenders: without arguments, every top-level group (물품분류 대분류) with its category count and the five categories with the most vendors; with a group name (or part of one), every item category in that group with its display name, procurement name, 8-digit 물품분류번호 and vendor count. Use it to find the exact Korean category string before filtering. From BOIM (boim.io), built on Public Procurement Service open data.',
    summary: 'Korean Public Procurement Service item groups and categories, with vendor counts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        group: {
          type: 'string',
          description:
            'Group name or part of it (e.g. 가구, 사무용기기, 공학연구). Omit for the list of all groups. Common English group names (furniture, software, IT services, …) are mapped.',
        },
      },
    },
  },
];

// ---- upstream call -----------------------------------------------------------

interface BoimResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function boimCall(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await pwFetch(BOIM_MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  if (!res.ok) throw await httpError(res, `BOIM (boim.io) ${tool}`);
  let payload: { result?: BoimResult; error?: { code?: number; message?: string } };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new Error(`BOIM (boim.io) returned a non-JSON body for ${tool} (HTTP ${res.status})`);
  }
  if (payload.error) {
    throw new Error(`BOIM (boim.io) JSON-RPC error for ${tool}: ${payload.error.message ?? payload.error.code}`);
  }
  const result = payload.result;
  if (!result) throw new Error(`BOIM (boim.io) returned no result for ${tool} (HTTP ${res.status})`);
  if (result.isError) {
    const text = result.content?.find((c) => c.type === 'text')?.text ?? 'unknown error';
    throw new Error(`BOIM (boim.io) tool error for ${tool}: ${text.slice(0, 300)}`);
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (text) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`BOIM (boim.io) returned unparseable text for ${tool}`);
    }
  }
  throw new Error(`BOIM (boim.io) returned an empty result for ${tool} (HTTP ${res.status})`);
}

// ---- tool implementations ------------------------------------------------------

type Row = Record<string, unknown>;

async function searchTenders(args: Record<string, unknown>): Promise<unknown> {
  const q = translate(strArg(args.query), ALIASES);
  const cat = translate(strArg(args.category), ALIASES);
  const rawType = strArg(args.type);
  const typeKo = rawType ? TYPE_ALIASES[rawType.trim().toLowerCase()] : undefined;
  if (rawType && !typeKo) {
    throw new Error(
      `korea_search_tenders: type must be one of goods, services, construction, other (or 물품, 용역, 공사, 기타); got ${JSON.stringify(rawType)}`,
    );
  }
  const region = translate(strArg(args.region), REGION_ALIASES);
  const limit = clampLimit(args.limit, TENDER_DEFAULT_LIMIT, TENDER_MAX_LIMIT);

  const upstreamArgs: Record<string, unknown> = { limit };
  if (q.sent) upstreamArgs.query = q.sent;
  if (cat.sent) upstreamArgs.category = cat.sent;
  if (typeKo) upstreamArgs.type = typeKo;
  if (region.sent) upstreamArgs.region = region.sent;

  const data = await boimCall('find_public_bids', upstreamArgs);
  const results = Array.isArray(data.results) ? (data.results as Row[]) : [];

  const tenders = results.map((r) => ({
    title: str(r.title),
    type: str(r.type),
    type_en: TYPE_EN[str(r.type) ?? ''] ?? null,
    portal: str(r.origin),
    category: str(r.category),
    group: str(r.group),
    buyer: str(r.agency),
    closing_date: str(r.deadline),
    estimated_price_krw: num(r.estimated_price_krw),
    contract_method: str(r.contract_method),
    award_method: str(r.award_method)?.trim() ?? null,
    url: str(r.url),
  }));

  return {
    source: SOURCE,
    source_url: 'https://boim.io/public-bids/',
    data_as_of: new Date().toISOString(),
    freshness: 'BOIM refreshes the five bid feeds twice daily; only notices still open for bids are listed.',
    query_sent: {
      query: q.sent ?? null,
      category: cat.sent ?? null,
      type: typeKo ?? null,
      region: region.sent ?? null,
      translated_from_english: q.translated || cat.translated || region.translated,
    },
    total_matching: num(data.total),
    count: tenders.length,
    order: 'closing_date ascending (closest deadline first)',
    tenders,
    note:
      tenders.length === 0
        ? 'No open notice matched. BOIM matches ONE Korean phrase against title/agency; try a single Korean word (e.g. 소프트웨어), a category word, or drop the region.'
        : 'Eligibility (regional restriction, direct-production proof, etc.) is in the original notice at url.',
  };
}

async function searchVendors(args: Record<string, unknown>): Promise<unknown> {
  const q = translate(strArg(args.query), ALIASES);
  const cat = translate(strArg(args.category), ALIASES);
  const group = translate(strArg(args.group), CATEGORY_GROUP_ALIASES);
  const region = translate(strArg(args.region), REGION_ALIASES);
  const cert = strArg(args.cert);
  const limit = clampLimit(args.limit, VENDOR_DEFAULT_LIMIT, VENDOR_MAX_LIMIT);

  const upstreamArgs: Record<string, unknown> = { limit };
  if (q.sent) upstreamArgs.query = q.sent;
  if (cat.sent) upstreamArgs.category = cat.sent;
  if (group.sent) upstreamArgs.group = group.sent;
  if (region.sent) upstreamArgs.region = region.sent;
  if (cert) upstreamArgs.cert = cert;

  const data = await boimCall('search_vendors', upstreamArgs);
  const results = Array.isArray(data.results) ? (data.results as Row[]) : [];
  const period = (data.period ?? {}) as Row;

  const vendors = results.map((r) => {
    const p = (r.procurement_1y ?? {}) as Row;
    const ai = (r.ai_ready ?? {}) as Row;
    return {
      id: str(r.id),
      name: str(r.name),
      region: str(r.region),
      region_match_basis: str(r.match),
      categories: Array.isArray(r.categories) ? r.categories : [],
      procurement_12m: {
        delivery_records: num(p.records),
        agencies: num(p.agencies),
        last_delivery: yyyymmdd(str(p.last_delivery)),
        top_regions: Array.isArray(p.top_regions) ? p.top_regions : [],
      },
      contract_items: num(r.contract_items),
      business_status: str(r.business_status),
      card_completeness: { band: str(ai.band), score: num(ai.score) },
      tags: Array.isArray(r.tags) ? r.tags : [],
      url: str(r.url),
    };
  });

  return {
    source:
      'Public Procurement Service KONEPS shopping-mall item records (data.go.kr 15129471) and contract records (15129427), assembled by BOIM (boim.io)',
    source_url: 'https://boim.io/vendors/',
    data_as_of: str(data.updated) ?? new Date().toISOString(),
    record_period: { from: yyyymmdd(str(period.from)), to: yyyymmdd(str(period.to)) },
    query_sent: {
      query: q.sent ?? null,
      category: cat.sent ?? null,
      group: group.sent ?? null,
      region: region.sent ?? null,
      cert: cert ?? null,
      translated_from_english: q.translated || cat.translated || group.translated || region.translated,
    },
    total_matching: num(data.total),
    count: vendors.length,
    order: str(data.order),
    vendors,
    note:
      vendors.length === 0
        ? 'No vendor matched. Use korea_list_categories to find the exact Korean category string, or drop filters.'
        : 'Ordering is relevance and card completeness, not procurement volume. Call korea_get_vendor with id for the full card.',
  };
}

async function getVendor(args: Record<string, unknown>): Promise<unknown> {
  const id = strArg(args.id);
  if (!id) throw new Error('korea_get_vendor: id is required (from korea_search_vendors)');
  const data = await boimCall('get_vendor', { id });
  if (!data || Object.keys(data).length === 0) {
    throw new Error(`BOIM (boim.io) returned an empty vendor card for id ${id}`);
  }
  return {
    source: 'Public Procurement Service open data via BOIM (boim.io)',
    data_as_of: str(data.updated) ?? new Date().toISOString(),
    vendor_id: id,
    vendor: data,
  };
}

async function listCategories(args: Record<string, unknown>): Promise<unknown> {
  const group = translate(strArg(args.group), CATEGORY_GROUP_ALIASES);
  const upstreamArgs: Record<string, unknown> = {};
  if (group.sent) upstreamArgs.group = group.sent;
  const data = await boimCall('list_categories', upstreamArgs);
  const groups = Array.isArray(data.groups) ? (data.groups as Row[]) : null;
  const categories = Array.isArray(data.categories) ? (data.categories as Row[]) : null;
  if (!groups && !categories) {
    throw new Error(
      `BOIM (boim.io) list_categories returned neither groups nor categories (keys: ${Object.keys(data).join(', ') || 'none'})`,
    );
  }
  return {
    source: 'Public Procurement Service item classification (물품분류) via BOIM (boim.io)',
    data_as_of: str(data.updated) ?? new Date().toISOString(),
    group_sent: group.sent ?? null,
    ...(groups ? { group_count: groups.length, groups } : {}),
    ...(categories ? { category_count: categories.length, categories } : {}),
    upstream_source: str(data.source),
    ...Object.fromEntries(
      Object.entries(data).filter(([k]) => !['groups', 'categories', 'updated', 'source'].includes(k)),
    ),
  };
}


function kstDate(v: string, label: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) throw new Error(`korea_get_awards: ${label} must be YYYY-MM-DD, got ${JSON.stringify(v)}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

async function getAwards(args: Record<string, unknown>, apiKey: string): Promise<unknown> {
  const rawType = (strArg(args.type) ?? 'services').toLowerCase();
  const op = AWARDS_OPS[rawType];
  if (!op) throw new Error(`korea_get_awards: type must be goods, services or construction; got ${JSON.stringify(rawType)}`);
  const noticeNo = strArg(args.notice_no);
  const from = strArg(args.from);
  const to = strArg(args.to);
  const limit = clampLimit(args.limit, 20, 100);
  const page = clampLimit(args.page, 1, 1000);

  const params = new URLSearchParams();
  let key = apiKey.trim();
  if (key.includes('%')) {
    try { key = decodeURIComponent(key); } catch { /* use as given */ }
  }
  params.set('serviceKey', key);
  params.set('type', 'json');
  params.set('pageNo', String(page));
  params.set('numOfRows', '100');
  if (noticeNo) {
    params.set('inqryDiv', '2');
    params.set('bidNtceNo', noticeNo);
  } else {
    if (!from || !to) throw new Error('korea_get_awards: pass from and to (YYYY-MM-DD), or notice_no');
    const f = kstDate(from, 'from');
    const t = kstDate(to, 'to');
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (!(days >= 0)) throw new Error('korea_get_awards: to must not be before from');
    if (days > 31) throw new Error('korea_get_awards: the award window is at most 31 days per call; split the range');
    params.set('inqryDiv', '1');
    params.set('inqryBgnDt', `${f}0000`);
    params.set('inqryEndDt', `${t}2359`);
  }

  const res = await pwFetch(`${AWARDS_BASE}/${op}?${params.toString()}`);
  const text = await res.text();
  let body: Record<string, any>;
  try {
    body = JSON.parse(text);
  } catch {
    if (!res.ok) throw new Error(`data.go.kr successful-bid information HTTP ${res.status}: ${summarizeErrorBody(text)}`);
    throw new Error(`data.go.kr returned a non-JSON body (HTTP ${res.status}): ${summarizeErrorBody(text)}`);
  }
  const fault = body.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (fault) {
    const msg = String(fault.errMsg ?? '');
    if (/SERVICE_KEY/i.test(msg) || /KEY/i.test(msg)) {
      throw new Error(
        `korea_get_awards requires an API key that data.go.kr accepts; it answered ${msg}. Register a free key at https://www.data.go.kr, apply for the Public Procurement Service successful-bid information service, and pass it as _apiKey (a new key can take up to an hour to activate).`,
      );
    }
    throw new Error(`data.go.kr refused the request: ${msg} (${fault.returnAuthMsg ?? ''})`);
  }
  const resp = body.response ?? body;
  const header = resp.header ?? {};
  if (header.resultCode && String(header.resultCode) !== '00') {
    throw new Error(`data.go.kr successful-bid information error ${header.resultCode}: ${header.resultMsg ?? ''}`);
  }
  const b = resp.body ?? {};
  let items: Row[] = [];
  if (Array.isArray(b.items)) items = b.items as Row[];
  else if (b.items && Array.isArray(b.items.item)) items = b.items.item as Row[];
  else if (b.items && typeof b.items.item === 'object') items = [b.items.item as Row];
  const total = num(b.totalCount);

  const w = strArg(args.winner);
  const ti = strArg(args.title);
  const awards = items
    .map((r) => ({
      notice_no: str(r.bidNtceNo),
      notice_order: str(r.bidNtceOrd),
      title: str(r.bidNtceNm),
      buyer: str(r.ntceInsttNm) ?? str(r.dminsttNm),
      winner: str(r.bidwinnrNm),
      winner_business_no: str(r.bidwinnrBizno),
      winner_representative: str(r.bidwinnrCeoNm),
      award_amount_krw: num(r.sucsfbidAmt),
      award_rate_pct: num(r.sucsfbidRate),
      bidders: num(r.prtcptCnum),
      opened_at: str(r.rlOpengDt),
      award_date: str(r.fnlSucsfDate),
    }))
    .filter((a) => (!w || (a.winner ?? '').includes(w)) && (!ti || (a.title ?? '').includes(ti)));
  const shown = awards.slice(0, limit);

  return {
    source: SOURCE_AWARDS,
    data_as_of: new Date().toISOString(),
    type: rawType,
    window: noticeNo ? { notice_no: noticeNo } : { from, to },
    page,
    upstream_total: total,
    upstream_page_records: items.length,
    count: shown.length,
    awards: shown,
    note:
      shown.length === 0
        ? 'No award matched on this upstream page. The winner/title filters apply to the 100 records of the page only; try page 2 or drop the filters.'
        : (total ?? 0) > page * 100
          ? 'More records exist upstream; pass page to read on. Filters apply per page.'
          : undefined,
  };
}

// ---- helpers -------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() ? v : null;
  if (typeof v === 'number') return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// BOIM dates come as YYYYMMDD; return ISO YYYY-MM-DD.
function yyyymmdd(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  return undefined;
}

function clampLimit(v: unknown, def: number, max: number): number {
  let n: number | undefined;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Number(v);
  if (n === undefined) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  delete args._apiKey;
  switch (name) {
    case 'korea_get_awards':
      if (!apiKey) {
        throw new Error(
          'korea_get_awards requires an API key. This tool is BYOK: there is no platform key. Pass your own free data.go.kr service key as _apiKey (register at https://www.data.go.kr and apply for the Public Procurement Service successful-bid information service). The other korea tools need no key.',
        );
      }
      return getAwards(args, apiKey);
    case 'korea_search_tenders':
      return searchTenders(args);
    case 'korea_search_vendors':
      return searchVendors(args);
    case 'korea_get_vendor':
      return getVendor(args);
    case 'korea_list_categories':
      return listCategories(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
