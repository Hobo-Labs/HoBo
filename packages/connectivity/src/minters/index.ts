/**
 * Overlay credential minters (L39). Signatures frozen by the fleet contract
 * commit (ADR-0182). The authority composes them and enrollment calls them;
 * they make their own provider API calls through `fetch` and do not use or
 * change the existing overlay API clients.
 *
 * Each `mint` asks the provider for exactly one single-use join credential
 * with the requested expiry and tags and returns it as an `OverlayJoin`. A
 * provider error is an `unavailable` outcome. Nothing here logs, and no
 * failure carries the credential or the operator's API token.
 */
import type {
	FleetFailure,
	Outcome,
	OverlayCredentialMinter,
	OverlayJoin,
} from "@hobo/fleet";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json.js";

/** `organisation` is the tailnet for Tailscale and unused by NetBird; `credential` returns the operator's API token from the secret store. */
export type OverlayMinterOptions = Readonly<{
	apiBase: string;
	organisation: string;
	credential: () => Promise<string>;
	fetch: typeof fetch;
}>;

type MintInput = Parameters<OverlayCredentialMinter["mint"]>[0];

const REQUEST_TIMEOUT_MS = 10_000;
/** NetBird refuses a setup key that expires in under a day (A13). */
const NETBIRD_MIN_EXPIRY_SECONDS = 86_400;
const TAILSCALE_TAG = /^tag:[a-z0-9][a-z0-9-]*$/iu;
const NETBIRD_GROUP = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,127}$/u;

/** Mints a single-use, pre-authorised Tailscale auth key that expires after `ttlMs` and carries exactly the given tags. */
export function createTailscaleCredentialMinter(
	options: OverlayMinterOptions,
): OverlayCredentialMinter {
	return {
		provider: "tailscale",
		async mint(input) {
			const expirySeconds = expirySecondsOf(input.ttlMs);
			if (expirySeconds === undefined)
				return invalid("ttlMs must be a positive number");
			const tags = tailscaleTags(input.tags);
			if (!tags.ok) return tags;

			const token = await apiToken(options);
			if (!token.ok) return token;
			const reply = await call(options, "tailscale", {
				method: "POST",
				path: `/api/v2/tailnet/${encodeURIComponent(options.organisation)}/keys`,
				auth: `Bearer ${token.value}`,
				body: {
					capabilities: {
						devices: {
							create: {
								reusable: false,
								ephemeral: false,
								preauthorized: true,
								tags: tags.value,
							},
						},
					},
					expirySeconds,
					description:
						`hobo fleet ${input.memberId.replaceAll("_", "-")}`.slice(0, 50),
				},
			});
			if (!reply.ok) return reply;
			return overlayJoin("tailscale", reply.value, tags.value);
		},
	};
}

/** Mints a one-off NetBird setup key (usage limit 1) whose auto-groups are the groups named by the given tags. */
export function createNetbirdCredentialMinter(
	options: OverlayMinterOptions,
): OverlayCredentialMinter {
	return {
		provider: "netbird",
		async mint(input) {
			const ttlSeconds = expirySecondsOf(input.ttlMs);
			if (ttlSeconds === undefined)
				return invalid("ttlMs must be a positive number");
			const tags = unique(input.tags);
			const badTag = tags.find((tag) => !NETBIRD_GROUP.test(tag));
			if (badTag !== undefined)
				return invalid("tag is not a NetBird group name", { tag: badTag });

			const token = await apiToken(options);
			if (!token.ok) return token;
			const auth = `Token ${token.value}`;

			let autoGroups: string[] = [];
			if (tags.length > 0) {
				const listed = await call(options, "netbird", {
					method: "GET",
					path: "/api/groups",
					auth,
				});
				if (!listed.ok) return listed;
				const resolved = groupIds(listed.value, tags);
				if (!resolved.ok) return resolved;
				autoGroups = resolved.value;
			}

			const reply = await call(options, "netbird", {
				method: "POST",
				path: "/api/setup-keys",
				auth,
				body: {
					name: `hobo-fleet ${input.tenant} ${input.memberId}`,
					type: "one-off",
					usage_limit: 1,
					expires_in: Math.max(ttlSeconds, NETBIRD_MIN_EXPIRY_SECONDS),
					auto_groups: autoGroups,
					ephemeral: false,
				},
			});
			if (!reply.ok) return reply;
			return overlayJoin("netbird", reply.value, tags);
		},
	};
}

function expirySecondsOf(ttlMs: MintInput["ttlMs"]): number | undefined {
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
	return Math.ceil(ttlMs / 1000);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function tailscaleTags(tags: readonly string[]): Outcome<string[]> {
	const prefixed = unique(
		tags.map((tag) => (tag.startsWith("tag:") ? tag : `tag:${tag}`)),
	);
	const bad = prefixed.find((tag) => !TAILSCALE_TAG.test(tag));
	if (bad !== undefined)
		return invalid("tag is not a Tailscale ACL tag", { tag: bad });
	return { ok: true, value: prefixed };
}

function groupIds(
	listed: JsonValue,
	tags: readonly string[],
): Outcome<string[]> {
	if (!isJsonArray(listed))
		return unavailable("netbird", "group list is not an array");
	const byName = new Map<string, string>();
	for (const group of listed) {
		if (!isJsonObject(group)) continue;
		const { id, name } = group;
		if (isJsonString(id) && isJsonString(name) && !byName.has(name))
			byName.set(name, id);
	}
	const ids: string[] = [];
	for (const tag of tags) {
		const id = byName.get(tag);
		if (id === undefined)
			return invalid("no NetBird group is named by the tag", { tag });
		ids.push(id);
	}
	return { ok: true, value: ids };
}

function overlayJoin(
	provider: OverlayCredentialMinter["provider"],
	reply: JsonValue,
	tags: readonly string[],
): Outcome<OverlayJoin> {
	if (!isJsonObject(reply))
		return unavailable(provider, "reply is not an object");
	const { key, expires } = reply;
	if (!isJsonString(key) || key.length === 0)
		return unavailable(provider, "reply carries no key");
	if (!isJsonString(expires) || Number.isNaN(Date.parse(expires)))
		return unavailable(provider, "reply carries no expiry");
	return {
		ok: true,
		value: {
			$typeName: "hobo.fleet.v1.OverlayJoin",
			provider,
			credential: key,
			expiresAt: expires,
			tags: [...tags],
		},
	};
}

async function apiToken(
	options: OverlayMinterOptions,
): Promise<Outcome<string>> {
	try {
		const token = await options.credential();
		if (token.length === 0)
			return unavailable("secret-store", "operator API token is empty");
		return { ok: true, value: token };
	} catch {
		return unavailable("secret-store", "operator API token could not be read");
	}
}

/** The failing arm of `Outcome`, whatever the success type. */
type Failed = Readonly<{ ok: false; error: FleetFailure }>;

type Call = Readonly<{
	method: "GET" | "POST";
	path: string;
	auth: string;
	body?: Readonly<Record<string, JsonValue>>;
}>;

async function call(
	options: OverlayMinterOptions,
	provider: string,
	request: Call,
): Promise<Outcome<JsonValue>> {
	const headers = new Headers({
		accept: "application/json",
		authorization: request.auth,
	});
	if (request.body !== undefined)
		headers.set("content-type", "application/json");
	let response: Response;
	try {
		response = await options.fetch(
			`${options.apiBase.replace(/\/+$/u, "")}${request.path}`,
			{
				method: request.method,
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				body: request.body === undefined ? null : JSON.stringify(request.body),
			},
		);
	} catch {
		return unavailable(
			provider,
			`${request.method} ${request.path} failed to connect`,
		);
	}
	if (!response.ok)
		return unavailable(
			provider,
			`${request.method} ${request.path} answered ${response.status}`,
			{
				status: String(response.status),
			},
		);
	let text: string;
	try {
		text = await response.text();
	} catch {
		return unavailable(provider, "reply could not be read");
	}
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this provider boundary.
		parsed = JSON.parse(text) as JsonValue;
	} catch {
		return unavailable(provider, "reply is not JSON");
	}
	return { ok: true, value: parsed };
}

function unavailable(
	provider: string,
	message: string,
	detail: Readonly<Record<string, string>> = {},
): Failed {
	return {
		ok: false,
		error: {
			code: "unavailable",
			message: `${provider}: ${message}`,
			detail: { provider, ...detail },
		},
	};
}

function invalid(
	message: string,
	detail: Readonly<Record<string, string>> = {},
): Failed {
	return { ok: false, error: { code: "invalid-request", message, detail } };
}
