import { z } from "zod";

/**
 * Connect Vercel with the OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * The owner approves on vercel.com from any device: nothing is served on this
 * machine and nothing redirects back to it, so a run on a remote box (an
 * agent's cloud session) can be connected by an owner who never reaches that
 * box. The run prints the verification link and code, polls Vercel's token
 * endpoint, and keeps the token in its trusted vault and the owner's store;
 * the token is never printed.
 *
 * Endpoints are Vercel's published ones
 * (https://vercel.com/.well-known/openid-configuration). The client is a
 * public client: no secret. The default is the client Vercel's own CLI signs
 * in with (`vercel login`); an owner can register their own and name it with
 * HOBO_CD_VERCEL_DEVICE_CLIENT_ID.
 */

// public-contract: Vercel's device authorization endpoint (RFC 8628 §3.1), from its OpenID configuration.
export const VERCEL_DEVICE_AUTHORIZATION_URL =
	"https://api.vercel.com/login/oauth/device-authorization";
// public-contract: Vercel's token endpoint for the device-code grant.
export const VERCEL_DEVICE_TOKEN_URL =
	"https://api.vercel.com/login/oauth/token";
// public-contract: the public client Vercel's CLI uses for its device sign-in; overridable per owner.
export const VERCEL_CLI_DEVICE_CLIENT_ID =
	"cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp";
export const VERCEL_DEVICE_INSTALLATION = "device-grant";
// public-contract: the prefix of the one progress line naming the owner's device sign-in.
export const OWNER_DEVICE_LINE_PREFIX = "HOBO_OWNER_DEVICE";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const DeviceAuthorization = z.object({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.string().url(),
	verification_uri_complete: z.string().url().optional(),
	expires_in: z.number().int().positive(),
	interval: z.number().int().positive().optional(),
});

const TokenReply = z.object({
	access_token: z.string().min(1).max(4096).optional(),
	error: z.string().optional(),
});

const Teams = z.object({
	teams: z.array(z.object({ id: z.string(), slug: z.string() })),
	pagination: z.object({ next: z.number().int().nonnegative().nullable() }),
});

export class VercelDeviceError extends Error {
	readonly code:
		| "HOBO_CD_VERCEL_DEVICE_FAILED"
		| "HOBO_CD_VERCEL_DEVICE_DENIED"
		| "HOBO_CD_VERCEL_DEVICE_EXPIRED"
		| "HOBO_CD_VERCEL_TEAM_AMBIGUOUS";
	constructor(code: VercelDeviceError["code"], message: string) {
		super(message);
		this.name = "VercelDeviceError";
		this.code = code;
	}
}

export interface VercelDeviceOptions {
	readonly fetch?: typeof fetch;
	readonly clientId?: string;
	/** One progress line; the token never goes through it. */
	readonly emit: (line: string) => void;
	readonly onLink?: (link: string, code: string) => void;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
}

/** The device grant's result: the token, for the run's vault and the store only. */
export interface VercelDeviceToken {
	readonly token: string;
}

function form(fields: Readonly<Record<string, string>>): URLSearchParams {
	return new URLSearchParams(fields);
}

/** Ask the owner to approve on vercel.com, then wait for the token. */
export interface VercelDeviceGrant {
	readonly link: string;
	readonly code: string;
	readonly deviceCode: string;
	readonly clientId: string;
	readonly intervalSeconds: number;
	readonly expiresInSeconds: number;
}

export async function startVercelDeviceGrant(options: {
	readonly fetch?: typeof fetch;
	readonly clientId?: string;
}): Promise<VercelDeviceGrant> {
	const http = options.fetch ?? fetch;
	const clientId = options.clientId ?? VERCEL_CLI_DEVICE_CLIENT_ID;
	const started = await http(VERCEL_DEVICE_AUTHORIZATION_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form({ client_id: clientId }),
		redirect: "error",
	}).catch(() => undefined);
	const parsed = DeviceAuthorization.safeParse(
		started?.ok ? await started.json().catch(() => null) : null,
	);
	if (!parsed.success)
		throw new VercelDeviceError(
			"HOBO_CD_VERCEL_DEVICE_FAILED",
			"Vercel did not start a device sign-in.",
		);
	const grant = parsed.data;
	return {
		link: grant.verification_uri_complete ?? grant.verification_uri,
		code: grant.user_code,
		deviceCode: grant.device_code,
		clientId,
		intervalSeconds: grant.interval ?? 5,
		expiresInSeconds: grant.expires_in,
	};
}

export interface DeviceClock {
	readonly now: () => number;
	/** Wait `ms`, or until `signal` aborts. */
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const SYSTEM_CLOCK: DeviceClock = {
	now: Date.now,
	sleep: (ms, signal) =>
		new Promise<void>((resolve) => {
			if (signal?.aborted === true) return resolve();
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		}),
};

/**
 * Poll for the grant's token as RFC 8628 prescribes: every `interval`
 * seconds, five more after `slow_down`, until approved, denied, expired, or
 * `signal` aborts. Polling is the protocol (Vercel has no push); the clock
 * is a port, so it runs off the request path in production and on virtual
 * time in specs.
 */
export async function awaitVercelDeviceToken(
	grant: VercelDeviceGrant,
	options: {
		readonly fetch?: typeof fetch;
		readonly clock?: DeviceClock;
		readonly signal?: AbortSignal;
	} = {},
): Promise<VercelDeviceToken> {
	const http = options.fetch ?? fetch;
	const clock = options.clock ?? SYSTEM_CLOCK;
	let interval = grant.intervalSeconds * 1000;
	const deadline = clock.now() + grant.expiresInSeconds * 1000;
	while (clock.now() < deadline) {
		await clock.sleep(
			Math.max(0, Math.min(interval, deadline - clock.now())),
			options.signal,
		);
		if (options.signal?.aborted === true)
			throw new VercelDeviceError(
				"HOBO_CD_VERCEL_DEVICE_FAILED",
				"The Vercel sign-in was stopped before it was approved.",
			);
		if (clock.now() >= deadline) break;
		const reply = await http(VERCEL_DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			redirect: "error",
			...(options.signal !== undefined
				? { signal: options.signal }
				: undefined),
			body: form({
				grant_type: DEVICE_CODE_GRANT,
				device_code: grant.deviceCode,
				client_id: grant.clientId,
			}),
		}).catch(() => undefined);
		if (reply === undefined) continue;
		const body = TokenReply.safeParse(await reply.json().catch(() => null));
		if (!body.success) continue;
		if (reply.ok && body.data.access_token !== undefined)
			return { token: body.data.access_token };
		switch (body.data.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				interval += 5000;
				continue;
			case "access_denied":
				throw new VercelDeviceError(
					"HOBO_CD_VERCEL_DEVICE_DENIED",
					"The Vercel sign-in was declined.",
				);
			case "expired_token":
				throw new VercelDeviceError(
					"HOBO_CD_VERCEL_DEVICE_EXPIRED",
					"The Vercel sign-in code expired before it was approved.",
				);
			default:
				throw new VercelDeviceError(
					"HOBO_CD_VERCEL_DEVICE_FAILED",
					"Vercel refused the device sign-in.",
				);
		}
	}
	throw new VercelDeviceError(
		"HOBO_CD_VERCEL_DEVICE_EXPIRED",
		"The Vercel sign-in code expired before it was approved.",
	);
}

/** At the owner's terminal: start the grant, print its line, wait for the token. */
export async function vercelDeviceToken(
	options: VercelDeviceOptions,
): Promise<VercelDeviceToken> {
	const grant = await startVercelDeviceGrant({
		...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
		...(options.clientId !== undefined
			? { clientId: options.clientId }
			: undefined),
	});
	options.onLink?.(grant.link, grant.code);
	options.emit(
		`${OWNER_DEVICE_LINE_PREFIX} ${grant.link} code=${grant.code} — Connect Vercel for HoBo CD: open the link on any device, confirm the code and approve; this run waits ${Math.round(grant.expiresInSeconds / 60)} minutes.`,
	);
	return awaitVercelDeviceToken(grant, {
		...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
		clock: {
			now: options.now ?? SYSTEM_CLOCK.now,
			sleep: options.sleep ?? SYSTEM_CLOCK.sleep,
		},
	});
}

/**
 * The team the connection deploys to: the one named (a non-secret setting),
 * or the account's only team. With several and none named, refuse and name
 * them: never guess an account scope.
 */
export async function vercelDeviceTeam(
	token: string,
	named: string | undefined,
	http: typeof fetch = fetch,
): Promise<string> {
	const teams: Array<{ id: string; slug: string }> = [];
	const seen = new Set<number>();
	let cursor: number | undefined;
	let complete = false;
	for (let page = 0; page < 100; page++) {
		const url = new URL("https://api.vercel.com/v2/teams");
		if (cursor !== undefined) url.searchParams.set("until", String(cursor));
		const reply = await http(url, {
			headers: { authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		}).catch(() => undefined);
		const parsed = Teams.safeParse(
			reply?.ok ? await reply.json().catch(() => null) : null,
		);
		if (!parsed.success) break;
		teams.push(...parsed.data.teams);
		if (named !== undefined && named !== "") {
			const match = parsed.data.teams.find(
				(t) => t.id === named || t.slug === named,
			);
			if (match !== undefined) return match.id;
		}
		const next = parsed.data.pagination.next;
		if (next === null) {
			complete = true;
			break;
		}
		if (seen.has(next)) break;
		seen.add(next);
		cursor = next;
	}
	if (!complete)
		throw new VercelDeviceError(
			"HOBO_CD_VERCEL_DEVICE_FAILED",
			"Cannot list all Vercel teams the sign-in can reach.",
		);
	if (named !== undefined && named !== "")
		throw new VercelDeviceError(
			"HOBO_CD_VERCEL_TEAM_AMBIGUOUS",
			`The Vercel sign-in cannot reach team ${named}.`,
		);
	const [only] = teams;
	if (only !== undefined && teams.length === 1) return only.id;
	throw new VercelDeviceError(
		"HOBO_CD_VERCEL_TEAM_AMBIGUOUS",
		`Name the Vercel team to deploy to with HOBO_CD_VERCEL_TEAM_ID (one of: ${
			teams
				.map((t) => t.slug)
				.sort()
				.join(", ") || "none"
		}).`,
	);
}
