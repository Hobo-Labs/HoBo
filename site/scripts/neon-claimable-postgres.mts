/**
 * Anonymous Temporary Postgres via Neon Claimable (neon.new).
 *
 * Zero project API keys: POST https://neon.new/api/v1/database with no Authorization.
 * Unclaimed DBs expire ~72h; claim URL optional for persistence.
 *
 * Realizes OpenSaaS Bindle `db` port on Examples Temporary yards when OCI
 * postgres cannot run under zero-key hosts.
 */
import { type JsonObject } from "../src/lib/json-inspect.js";
import { randomBytes } from "node:crypto";

export const NEON_CLAIMABLE_API =
	"https://neon.new/api/v1/database" as const;

export type NeonClaimablePostgres = {
	readonly ok: true;
	readonly databaseUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly neonProjectId: string;
	readonly status: string;
	readonly mocked: boolean;
	readonly anonymous: true;
	readonly temporary: true;
	readonly mode: "neon-claimable";
	readonly realizesBindle: "db";
};

export class NeonClaimablePostgresError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NeonClaimablePostgresError";
	}
}

export type ProvisionNeonClaimablePostgresInput = {
	readonly ref?: string;
	readonly mock?: boolean;
	readonly fetchImpl?: typeof fetch;
	readonly apiUrl?: string;
};

export async function provisionNeonClaimablePostgres(
	input: ProvisionNeonClaimablePostgresInput = {},
): Promise<NeonClaimablePostgres> {
	const ref = (input.ref?.trim() || "hobo-opensaas").slice(0, 64);
	const mock = Boolean(input.mock);
	const fetchImpl = input.fetchImpl ?? fetch;
	const apiUrl = input.apiUrl ?? NEON_CLAIMABLE_API;

	if (mock) {
		const id = randomBytes(4).toString("hex");
		const result: NeonClaimablePostgres = {
			ok: true,
			databaseUrl: `postgresql://neon:mock@ep-mock-${id}.anon.hobo.test/neondb?sslmode=require`,
			claimUrl: `https://neon.new/claim/mock-${id}`,
			expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
			neonProjectId: `mock-${id}`,
			status: "UNCLAIMED",
			mocked: true,
			anonymous: true,
			temporary: true,
			mode: "neon-claimable",
			realizesBindle: "db",
		};
		return result;
	}

	let response: Response;
	try {
		response = await fetchImpl(apiUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ref }),
			signal: AbortSignal.timeout(60_000),
		});
	} catch (error) {
		throw new NeonClaimablePostgresError(
			`Neon claimable POST failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const text = await response.text();
	let body: JsonObject;
	try {
		// SAFETY: assertion required at this I/O boundary.
		body = JSON.parse(text) as JsonObject;
	} catch {
		throw new NeonClaimablePostgresError(
			`Neon claimable returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
		);
	}

	if (!response.ok) {
		throw new NeonClaimablePostgresError(
			`Neon claimable HTTP ${response.status}: ${text.slice(0, 300)}`,
		);
	}

	const databaseUrl =
		Object.prototype.toString.call(body.connection_string) === "[object String]"
			? body.connection_string
			: Object.prototype.toString.call(body.databaseUrl) === "[object String]"
				? body.databaseUrl
				: "";
	const claimUrl = Object.prototype.toString.call(body.claim_url) === "[object String]" ? body.claim_url : "";
	const expiresAt =
		Object.prototype.toString.call(body.expires_at) === "[object String]"
			? body.expires_at
			: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
	const neonProjectId =
		Object.prototype.toString.call(body.neon_project_id) === "[object String]" ? body.neon_project_id : "";
	const status = Object.prototype.toString.call(body.status) === "[object String]" ? body.status : "UNKNOWN";

	if (!databaseUrl.startsWith("postgres")) {
		throw new NeonClaimablePostgresError(
			"Neon claimable response missing postgres connection_string",
		);
	}
	if (!claimUrl) {
		throw new NeonClaimablePostgresError(
			"Neon claimable response missing claim_url",
		);
	}

	const result: NeonClaimablePostgres = {
		ok: true,
		databaseUrl,
		claimUrl,
		expiresAt,
		neonProjectId,
		status,
		mocked: false,
		anonymous: true,
		temporary: true,
		mode: "neon-claimable",
		realizesBindle: "db",
	};

	return result;
}
