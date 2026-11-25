/**
 * The credentialed HTTPS boundary every provider resolver runs over.
 *
 * HoBo's default deployment path talks to provider REST APIs directly — no IaC
 * engine sits in the middle — so this is the single place a deploy leaves the
 * process. Nothing here reaches for a global `fetch`: a host supplies an
 * `HttpTransport`, and `guardTransport` is what makes any supplied transport
 * safe to hand a credential. The request headers on this path carry the
 * sponsoring provider token, so a driver that trusts its transport can be
 * pointed at an attacker's origin by one bad config value.
 *
 * The guard generalizes the hardened Vercel boundary: HTTPS only, allowlisted
 * hosts — exact by default, optionally plus a dot-anchored parent domain for a
 * provider whose per-tenant origin is minted at deploy time — allowlisted path
 * prefixes, no redirect chasing, bounded body, bounded time. Every violation is
 * a `TransportGuardError` carrying its own code — the guard never clamps, never
 * falls back, and never silently downgrades a request into a weaker one,
 * because a downgrade that still reaches the network has already spent the
 * credential.
 *
 * Two normalization rules are deliberate and load-bearing:
 *
 * - Host comparison is **exact** against the policy strings. WHATWG URL
 *   parsing already lowercases an ASCII authority and punycodes a non-ASCII
 *   one, so `https://API.Example.com` and `https://api.example.com` are the
 *   same host and both match an `api.example.com` entry. What the guard will
 *   not do is case-fold the *policy*: a mixed-case allowlist entry matches
 *   nothing. Repairing a policy typo is widening reach on a guess, and this
 *   guard fails closed instead.
 * - Percent-encoded path separators are refused rather than decoded. Be precise
 *   about which forms actually survive, because the obvious example does not:
 *   WHATWG resolves dot segments during parsing, and it treats `%2e` as a dot
 *   while doing so, so `/v1/../admin` *and* `/v1/%2e%2e/admin` both arrive at
 *   the prefix check already collapsed to `/admin` — and are refused by the
 *   prefix check on their own merits.
 *
 *   What survives is an encoded *separator*: `%2f` and `%5c` are not separators
 *   to the parser, so `/v1/projects/%2f%2e%2e%2fadmin` and
 *   `/v1/projects/..%5cadmin` reach the prefix check with the prefix intact,
 *   pass it, and are decoded only by the origin — after every check here. Their
 *   presence is the refusal. `%2e` stays in the pattern because it still
 *   appears in those composite forms.
 *
 * Purity: no clock, no randomness, no ambient environment reads. The guard is
 * a pure function of the request, the policy, and the inner transport's reply.
 */

// public-contract: the closed HTTP method vocabulary a resolver may issue.
import { isJsonNumber, isJsonString, type JsonValue } from "../json.js";

export const TRANSPORT_METHODS = Object.freeze([
	"GET",
	// HEAD is a GET that stops before the body, and two independent surfaces
	// need exactly that. The OCI distribution spec uses it to ask whether a
	// manifest exists without transferring it, so a registry transport cannot
	// be expressed without it — `provider-ttl-sh` kept its own method list for
	// that reason. S3 uses it the same way: `HeadBucket` is the documented
	// existence check, which the S3-compatible providers (DigitalOcean Spaces,
	// Hetzner Object Storage) inherit, and a resolver forced to probe with a
	// bodied GET would transfer a listing it does not want to learn one bit.
	// It is also the safest method here: nothing is sent and nothing comes
	// back but headers.
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
] as const);
export type TransportMethod = (typeof TRANSPORT_METHODS)[number];

/** One outbound call. `timeoutMs` and `maxResponseBytes` are never optional:
 *  an unbounded provider call is an outage waiting for a slow origin. */
export interface TransportRequest {
	readonly method: TransportMethod;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
}

export interface TransportResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/**
 * Implementations MUST NOT follow redirects and MUST abort at `timeoutMs`.
 * The guard re-checks both, but a transport that silently follows a 302 has
 * already sent the credentialed request to the redirect target.
 */
export type HttpTransport = (
	request: TransportRequest,
) => Promise<TransportResponse>;

/** What a guarded transport is allowed to reach. Exact hosts, no wildcards:
 *  a wildcard entry turns one compromised subdomain into every subdomain. */
export interface TransportGuardPolicy {
	readonly allowedHosts: readonly string[];
	readonly allowedPathPrefixes: readonly string[];
	readonly maxTimeoutMs: number;
	readonly maxResponseBytes: number;
	/**
	 * Dot-anchored parent domains, for providers whose per-tenant origins are
	 * minted at deploy time and therefore cannot be written down in advance.
	 * Upstash is the case that forced it: the data plane lives at
	 * `<name>-<id>.upstash.io`, a host nobody knows until the database exists.
	 *
	 * Optional and empty by default, so every policy that does not set it is
	 * evaluated exactly as before — the host must still match `allowedHosts`
	 * exactly. When it is set the two are a union, never a replacement: an
	 * entry here widens reach to one parent domain and nothing else.
	 *
	 * Each entry must start with `.` and carry at least one further dot, and an
	 * entry that does not is refused before any URL is judged rather than
	 * quietly narrowing or widening the policy. That check is the whole point
	 * of the field being separate from `allowedHosts`: written as
	 * `"upstash.io"`, the same `endsWith` test admits `evilupstash.io`, and
	 * written as `".com"` it admits the registry. Both were reachable in the
	 * hand-rolled copy this field replaces.
	 */
	readonly allowedHostSuffixes?: readonly string[];
	/**
	 * Ports the policy admits, as strings, alongside the implicit default.
	 * Omitted means 443 only, which is what every SaaS provider wants and what
	 * this guard enforced before the field existed.
	 *
	 * It exists for the self-hosted case, and the Kubernetes apiserver is the
	 * one that forced it: a cluster's control plane listens on 6443, not 443,
	 * so without this a provider talking to an operator's own control plane
	 * would have to re-implement the whole guard to change one number — and a
	 * second copy of a security rule set drifts from the first. Widening is
	 * explicit, per policy, and visible in review; the default stays closed.
	 */
	readonly allowedPorts?: readonly string[];
}

// public-contract: every refusal a guarded transport can report.
export const TRANSPORT_GUARD_ERROR_CODES = Object.freeze([
	"TRANSPORT_SCHEME_FORBIDDEN",
	"TRANSPORT_HOST_FORBIDDEN",
	"TRANSPORT_PATH_FORBIDDEN",
	"TRANSPORT_TIMEOUT_EXCEEDED",
	"TRANSPORT_BODY_TOO_LARGE",
	"TRANSPORT_REDIRECT_REFUSED",
] as const);
export type TransportGuardErrorCode =
	(typeof TRANSPORT_GUARD_ERROR_CODES)[number];

/** Refusal from the transport guard. Always carries a code so a caller can
 *  branch on the reason rather than matching on a message. */
export class TransportGuardError extends Error {
	readonly code: TransportGuardErrorCode;
	/**
	 * Structured context for the refusal, when there is any worth carrying.
	 *
	 * "Refused a redirect" is a much weaker diagnostic than "refused a redirect
	 * to mirror.example.com", and the second is what a human debugging a
	 * hijacked or misconfigured endpoint actually needs. Values here can be
	 * attacker-influenced — a `Location` header is chosen by the peer — so
	 * anything echoed in is length-bounded and stripped of control characters
	 * before it lands.
	 */
	readonly detail: Readonly<Record<string, string>>;

	constructor(
		code: TransportGuardErrorCode,
		message: string,
		detail: Readonly<Record<string, string>> = {},
	) {
		super(message);
		this.name = "TransportGuardError";
		this.code = code;
		this.detail = Object.freeze({ ...detail });
	}
}

/**
 * Bound a peer-supplied string before it is carried in an error.
 *
 * Control characters are dropped rather than escaped: this text reaches logs
 * and terminals, where a stray CR or ESC rewrites what the reader sees.
 */
function boundedPeerText(value: string, max = 120): string {
	let clean = "";
	for (const ch of value) {
		const code = ch.charCodeAt(0);
		if (code < 32 || code === 127) continue;
		clean += ch;
	}
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Wrap any transport so a bad config value cannot point it at an attacker
 * origin. The request headers on this path carry provider credentials.
 */
export function guardTransport(
	inner: HttpTransport,
	policy: TransportGuardPolicy,
): HttpTransport {
	return async (request: TransportRequest): Promise<TransportResponse> => {
		const url = assertAllowedEndpoint(request.url, policy);
		assertBoundedTimeout(request.timeoutMs, policy.maxTimeoutMs);
		const maxResponseBytes = assertBoundedResponseCap(
			request.maxResponseBytes,
			policy.maxResponseBytes,
		);

		const response = await inner({ ...request, url: url.toString() });

		assertNotRedirect(response);
		assertBoundedBody(response, maxResponseBytes);
		return response;
	};
}

/** Ports this policy admits. 443 is always in the set; the rest are declared. */
function allowedPorts(policy: TransportGuardPolicy): readonly string[] {
	const declared = policy.allowedPorts ?? [];
	return declared.includes("443") ? declared : ["443", ...declared];
}

/**
 * Parse an outbound URL against the policy. Returns the parsed URL so the
 * caller cannot accidentally reuse the unchecked string.
 *
 * Exported because every provider transport needs exactly this check and they
 * had each written their own. The copies drifted in the direction that matters:
 * none of them rejected percent-encoded path traversal, so a policy allowing
 * `/v9/projects/` also allowed `/v9/projects/%2e%2e/user/tokens`. One
 * implementation with one set of tests is the point.
 */
export function assertAllowedEndpoint(
	url: JsonValue,
	policy: TransportGuardPolicy,
): URL {
	if (!isJsonString(url) || url.trim().length === 0) {
		throw new TransportGuardError(
			"TRANSPORT_SCHEME_FORBIDDEN",
			"request url must be a non-empty https URL string",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// An unparseable URL has no scheme this guard has verified, so it is
		// refused on the scheme rather than guessed at.
		throw new TransportGuardError(
			"TRANSPORT_SCHEME_FORBIDDEN",
			"request url is not a valid absolute URL",
		);
	}
	if (parsed.protocol !== "https:") {
		throw new TransportGuardError(
			"TRANSPORT_SCHEME_FORBIDDEN",
			`request url must use https, got ${parsed.protocol.replace(":", "")}`,
		);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new TransportGuardError(
			"TRANSPORT_HOST_FORBIDDEN",
			"request url must not embed userinfo: credentials belong in headers a host injected, and userinfo hides the real host from a casual read",
		);
	}
	// An empty port is the URL's way of saying 443, so it always passes; any
	// other port must be named by the policy. Naming it is the whole check —
	// the guard never infers a port from the host or repairs a mismatch.
	if (parsed.port !== "" && !allowedPorts(policy).includes(parsed.port)) {
		throw new TransportGuardError(
			"TRANSPORT_HOST_FORBIDDEN",
			`request url must use the default https port or one this policy allows (${allowedPorts(policy).join(", ")}), got ${parsed.port}`,
			{ port: parsed.port, allowed: allowedPorts(policy).join(",") },
		);
	}
	assertAllowedHost(parsed, policy);
	assertAllowedPath(parsed, policy);
	return parsed;
}

/**
 * An entry in `allowedHostSuffixes` is usable only if it is dot-anchored and
 * names something below a registry level: `.upstash.io` yes, `.com` no,
 * `upstash.io` no.
 *
 * This runs before any host is compared, so an unusable entry refuses every
 * request rather than silently changing what the policy reaches. The two
 * rejected forms are not hypothetical — `endsWith("upstash.io")` matches
 * `evilupstash.io`, and `endsWith(".com")` matches the whole registry — and
 * both were expressible in the per-provider copies that predate this field.
 */
function assertUsableHostSuffixes(suffixes: readonly string[]): void {
	for (const suffix of suffixes) {
		const labels = suffix.split(".");
		const usable =
			labels.length >= 3 &&
			labels[0] === "" &&
			labels.slice(1).every((label) => label.length > 0);
		if (!usable) {
			throw new TransportGuardError(
				"TRANSPORT_HOST_FORBIDDEN",
				`policy allowedHostSuffixes entry ${JSON.stringify(suffix)} must start with "." and carry at least one further dot: "upstash.io" would also match evilupstash.io, and ".com" would match the registry`,
			);
		}
	}
}

/**
 * True when `host` sits under `suffix` as a real child label.
 *
 * `endsWith` on its own is not that test, and the gap is reachable: WHATWG
 * parses `https://.upstash.io/` to the hostname `.upstash.io` and
 * `https://..upstash.io/` to `..upstash.io`, both of which end with
 * `.upstash.io`. Neither names a child of the parent domain — they carry an
 * empty label where the child should be — so what is required is that the part
 * in front of the suffix exists and does not itself end in a dot.
 *
 * (The bare `upstash.io` never reaches this: it does not end with the
 * dot-anchored suffix at all.)
 */
function isUnderParentDomain(host: string, suffix: string): boolean {
	if (!host.endsWith(suffix)) return false;
	const child = host.slice(0, host.length - suffix.length);
	return child.length > 0 && !child.endsWith(".");
}

/**
 * Exact match against `allowedHosts`, or a dot-anchored match against
 * `allowedHostSuffixes`. The suffix arm requires a real child label, so
 * `.upstash.io` admits neither the bare `upstash.io` nor the empty-label
 * `.upstash.io`.
 *
 * The refusal message stays byte-identical to the pre-suffix one whenever no
 * suffixes are configured; provider suites pin it anchored.
 */
function assertAllowedHost(parsed: URL, policy: TransportGuardPolicy): void {
	const suffixes = policy.allowedHostSuffixes ?? [];
	assertUsableHostSuffixes(suffixes);
	const host = parsed.hostname;
	if (policy.allowedHosts.includes(host)) return;
	if (suffixes.some((suffix) => isUnderParentDomain(host, suffix))) return;
	const exact = `host ${host} is not exactly one of the allowlisted provider hosts (${policy.allowedHosts.join(", ") || "none"})`;
	throw new TransportGuardError(
		"TRANSPORT_HOST_FORBIDDEN",
		suffixes.length === 0
			? exact
			: `${exact} and is not under an allowlisted parent domain (${suffixes.join(", ")})`,
	);
}

/**
 * True when a pathname percent-encodes a separator or dot segment.
 *
 * `parsed.pathname` has already had literal dot segments resolved by WHATWG
 * parsing, so a prefix check sees the path the origin will route on — with one
 * exception: percent-encoded separators survive parsing and are decoded only by
 * the provider, past every check. Their presence is the refusal.
 *
 * Exported as a predicate rather than folded into `assertAllowedEndpoint`
 * because two transports still cannot use `assertAllowedEndpoint` at all, but
 * both need *this*. Sharing the rule is what keeps the copies from drifting
 * again.
 *
 * The two, and what actually blocks them — measured, because an earlier
 * version of this comment named the wrong reasons:
 *
 * - `provider-kubernetes` talks to the operator's own apiserver, so it has no
 *   host allowlist to write down at all and reaches it on the cluster's port
 *   (`:6443`, or `:8001` through `kubectl proxy`). `assertAllowedEndpoint`
 *   refuses a non-443 port before it ever consults a host rule. Giving it an
 *   `allowAnyHost` and an `allowedPorts` escape would delete the two checks
 *   this guard exists for, for the benefit of one caller.
 * - `provider-browser-wasm` fetches WebAssembly, so its response body is a
 *   `Uint8Array`. `TransportResponse.body` here is a `string`, and routing
 *   bundle bytes through it corrupts them: `0xff 0xfe 0x80` decodes to three
 *   U+FFFD and re-encodes as nine bytes, which is also what the byte cap would
 *   then be measuring.
 *
 * `provider-upstash` was the third and is no longer: `allowedHostSuffixes`
 * expresses its data plane, and its URL check now runs here. Its response half
 * stays local because it clamps an over-asking caller down to the policy where
 * this guard refuses — a difference its own suite pins.
 */
export function encodesPathSeparator(pathname: string): boolean {
	return /%2e|%2f|%5c/iu.test(pathname);
}

function assertAllowedPath(parsed: URL, policy: TransportGuardPolicy): void {
	const path = parsed.pathname;
	if (encodesPathSeparator(path)) {
		throw new TransportGuardError(
			"TRANSPORT_PATH_FORBIDDEN",
			`path ${path} percent-encodes a path separator or dot segment, which this guard refuses rather than decodes: only the origin would resolve it, after every check here has passed`,
		);
	}
	if (!policy.allowedPathPrefixes.some((prefix) => path.startsWith(prefix))) {
		throw new TransportGuardError(
			"TRANSPORT_PATH_FORBIDDEN",
			`path ${path} is outside the allowlisted prefixes (${policy.allowedPathPrefixes.join(", ") || "none"})`,
		);
	}
}

/** A request over the policy cap is refused, never clamped: a clamp turns an
 *  authoring mistake into a mystery timeout instead of a named refusal. */
function assertBoundedTimeout(
	timeoutMs: JsonValue,
	maxTimeoutMs: number,
): void {
	if (
		!isJsonNumber(timeoutMs) ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	) {
		throw new TransportGuardError(
			"TRANSPORT_TIMEOUT_EXCEEDED",
			`request timeoutMs must be a positive finite number, received ${String(timeoutMs)}`,
		);
	}
	if (!Number.isFinite(maxTimeoutMs) || maxTimeoutMs <= 0) {
		throw new TransportGuardError(
			"TRANSPORT_TIMEOUT_EXCEEDED",
			`policy maxTimeoutMs must be a positive finite number, received ${String(maxTimeoutMs)}`,
		);
	}
	if (timeoutMs > maxTimeoutMs) {
		throw new TransportGuardError(
			"TRANSPORT_TIMEOUT_EXCEEDED",
			`request timeoutMs ${timeoutMs} exceeds the policy cap of ${maxTimeoutMs}`,
		);
	}
}

function assertBoundedResponseCap(
	maxResponseBytes: JsonValue,
	policyCap: number,
): number {
	if (
		!isJsonNumber(maxResponseBytes) ||
		!Number.isFinite(maxResponseBytes) ||
		maxResponseBytes <= 0
	) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`request maxResponseBytes must be a positive finite number, received ${String(maxResponseBytes)}`,
		);
	}
	if (!Number.isFinite(policyCap) || policyCap <= 0) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`policy maxResponseBytes must be a positive finite number, received ${String(policyCap)}`,
		);
	}
	if (maxResponseBytes > policyCap) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`request maxResponseBytes ${maxResponseBytes} exceeds the policy cap of ${policyCap}`,
		);
	}
	return maxResponseBytes;
}

/**
 * A 3xx carrying a Location is rejected outright rather than followed: the
 * provider APIs on this path document no redirects, so one is either a
 * contract change or a hijack, and neither should silently resolve with the
 * credential attached. A 3xx without a Location (a 304, say) is a normal
 * cache answer and passes through.
 */
function assertNotRedirect(response: TransportResponse): void {
	if (response.status < 300 || response.status >= 400) return;
	const location = headerValue(response.headers, "location");
	if (location === undefined) return;
	throw new TransportGuardError(
		"TRANSPORT_REDIRECT_REFUSED",
		`provider returned a ${response.status} redirect, which this transport never follows`,
		{ location: boundedPeerText(location) },
	);
}

function assertBoundedBody(
	response: TransportResponse,
	maxResponseBytes: number,
): void {
	const declared = Number(
		headerValue(response.headers, "content-length") ?? Number.NaN,
	);
	if (Number.isFinite(declared) && declared > maxResponseBytes) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`provider declared a ${declared} byte response, over the ${maxResponseBytes} byte cap`,
		);
	}
	if (utf8ByteLength(response.body) > maxResponseBytes) {
		throw new TransportGuardError(
			"TRANSPORT_BODY_TOO_LARGE",
			`provider response exceeded the ${maxResponseBytes} byte cap`,
		);
	}
}

/** Case-insensitive header lookup: header names are not case-significant, and
 *  a guard that only matched one casing would be trivially bypassed. */
function headerValue(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

/**
 * UTF-8 byte length without allocating an encoded copy. A `TextEncoder` round
 * trip would materialize a second buffer the size of a body the guard is about
 * to refuse for being too large, which is the wrong way round.
 */
function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				// A lone surrogate encodes as U+FFFD, which is three bytes.
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}
