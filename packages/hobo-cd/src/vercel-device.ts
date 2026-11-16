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
// public-contract: the installation marker stored for a connection made by the device grant (no Integration).
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
export async function vercelDeviceToken(
	options: VercelDeviceOptions,
): Promise<VercelDeviceToken> {
	const http = options.fetch ?? fetch;
	const clientId = options.clientId ?? VERCEL_CLI_DEVICE_CLIENT_ID;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;

	const started = await http(VERCEL_DEVICE_AUTHORIZATION_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form({ client_id: clientId }),
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
	const link = grant.verification_uri_complete ?? grant.verification_uri;
	options.emit(
		`${OWNER_DEVICE_LINE_PREFIX} ${link} code=${grant.user_code} — Connect Vercel for HoBo CD: open the link on any device, confirm the code and approve; this run waits ${Math.round(grant.expires_in / 60)} minutes.`,
	);

	let interval = (grant.interval ?? 5) * 1000;
	const deadline = now() + grant.expires_in * 1000;
	while (now() < deadline) {
		await sleep(interval);
		const reply = await http(VERCEL_DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form({
				grant_type: DEVICE_CODE_GRANT,
				device_code: grant.device_code,
				client_id: clientId,
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
	const reply = await http("https://api.vercel.com/v2/teams", {
		headers: { authorization: `Bearer ${token}` },
	}).catch(() => undefined);
	const parsed = Teams.safeParse(
		reply?.ok ? await reply.json().catch(() => null) : null,
	);
	if (!parsed.success)
		throw new VercelDeviceError(
			"HOBO_CD_VERCEL_DEVICE_FAILED",
			"Cannot list the Vercel teams the sign-in can reach.",
		);
	const teams = parsed.data.teams;
	if (named !== undefined && named !== "") {
		const match = teams.find((t) => t.id === named || t.slug === named);
		if (match === undefined)
			throw new VercelDeviceError(
				"HOBO_CD_VERCEL_TEAM_AMBIGUOUS",
				`The Vercel sign-in cannot reach team ${named}.`,
			);
		return match.id;
	}
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
