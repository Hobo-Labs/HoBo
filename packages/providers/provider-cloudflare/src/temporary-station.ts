import {
	TEMPORARY_STATION_TTL_MS as CORE_TEMPORARY_STATION_TTL_MS,
	createBoundedFetchTransport,
	type TemporaryEnvironmentStationResult as SharedTemporaryEnvironmentStationResult,
	type TransportMethod,
	type TransportResponse,
	temporaryStationExpiresAt,
} from "@hobo/core";
import { redactCloudflareText } from "./resolvers.js";
import {
	assertStationWorkerHasNoAppCode,
	ENVIRONMENT_STATION_WORKER_MODULE,
	ENVIRONMENT_STATION_WORKER_NAME_PREFIX,
} from "./station-worker-source.js";
import {
	type PreviewChallenge,
	solvePreviewChallenge,
} from "./temporary-pow.js";
import { guardedCloudflareTransport } from "./transport.js";

export const CF_API_BASE = "https://api.cloudflare.com/client/v4"; // public-contract: Cloudflare API v4 base used by Temporary Accounts
export const CF_TERMS_URL = "https://www.cloudflare.com/terms/"; // public-contract: Temporary Accounts terms URL
export const CF_PRIVACY_URL = "https://www.cloudflare.com/privacypolicy/"; // public-contract: Temporary Accounts privacy URL
/** @deprecated Prefer TEMPORARY_STATION_TTL_MS from @hobo/core — re-export for CF callers. */
export const TEMPORARY_STATION_TTL_MS = CORE_TEMPORARY_STATION_TTL_MS;

export const CLOUDFLARE_TEMPORARY_PROVIDER_ID = "cloudflare" as const; // public-contract: stable temporary provider identifier

export type TemporaryEnvironmentStationInput = {
	readonly stationId: string;
	readonly scriptName?: string;
	readonly workerModule?: string;
	readonly fetchImpl?: typeof fetch;
	/** Injected for tests — skips live challenge/provision. */
	readonly transport?: TemporaryAccountTransport;
	/** Workers compatibility_flags (e.g. nodejs_compat for sync PoW on relay). */
	readonly compatibilityFlags?: readonly string[];
	/** Plain-text Worker bindings (e.g. TEMP_API_TOKEN for CORS relay). */
	readonly bindings?: Readonly<Record<string, string>>;
};

/** Cloudflare Temporary Accounts result — shared contract + CF scriptName/accountId. */
export type TemporaryEnvironmentStationResult =
	SharedTemporaryEnvironmentStationResult & {
		readonly providerId: typeof CLOUDFLARE_TEMPORARY_PROVIDER_ID;
		readonly scriptName: string;
		readonly accountId: string;
		readonly primaryUrl: string;
	};

export type TemporaryPreviewAccount = {
	readonly accountId: string;
	readonly apiToken: string;
	readonly claimUrl: string;
	readonly workersDevSubdomain?: string;
};

export type TemporaryAccountTransport = {
	/** Observed script deletion, distinct from a successful DELETE acknowledgement. */
	deleteWorkerScript?(input: {
		accountId: string;
		apiToken: string;
		scriptName: string;
	}): Promise<{ absent: boolean }>;
	requestChallenge(): Promise<PreviewChallenge>;
	createPreviewAccount(
		challenge: PreviewChallenge,
		solution: { checkpoints: string },
	): Promise<TemporaryPreviewAccount>;
	deployWorkerScript(input: {
		accountId: string;
		apiToken: string;
		scriptName: string;
		moduleSource: string;
		compatibilityFlags?: readonly string[];
		bindings?: Readonly<Record<string, string>>;
	}): Promise<{ workersDevUrl: string }>;
};

type CfEnvelope<T> = {
	success: boolean;
	result?: T;
	errors?: Array<{ message?: string; code?: number }>;
};

function sanitizeScriptName(stationId: string, override?: string): string {
	if (override) {
		return (
			override
				.replace(/[^a-z0-9-]/giu, "-")
				.replace(/^-+|-+$/gu, "")
				.slice(0, 63)
				.toLowerCase()
				.replace(/^-+|-+$/gu, "") || "hobo-env-station"
		);
	}
	// Stable short slug — long UUID stationIds truncated mid-hyphen and broke workers.dev.
	const compact = stationId
		.replace(/[^a-z0-9]+/giu, "")
		.toLowerCase()
		.slice(-24);
	return `${ENVIRONMENT_STATION_WORKER_NAME_PREFIX}-${compact || "anon"}`.slice(
		0,
		63,
	);
}

async function readCfJson<T>(
	response: TransportResponse,
	label: string,
): Promise<T> {
	// SAFETY: this fetch boundary is the Cloudflare envelope; callers then
	// read named fields off the typed result rather than widening the body.
	let body: CfEnvelope<T>;
	try {
		// SAFETY: named envelope fields are checked below and product-specific fields are checked by callers.
		body = JSON.parse(response.body) as CfEnvelope<T>;
	} catch {
		throw new Error(
			`Cloudflare ${label} returned a non-JSON response (HTTP ${response.status}); its outcome is unknown`,
		);
	}
	if (
		!body ||
		response.status < 200 ||
		response.status >= 300 ||
		body.success !== true ||
		body.result === undefined
	) {
		const detail =
			body?.errors
				?.map((entry) => entry.message ?? String(entry.code))
				.join("; ") || `HTTP ${response.status}`;
		throw new Error(
			`Cloudflare ${label} failed: ${redactCloudflareText(detail)}`,
		);
	}
	return body.result;
}

function plainIdentifier(value: string, field: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value))
		throw new Error(`Cloudflare ${field} is not a valid scoped identifier`);
	return value;
}
function transportMethod(method: string): TransportMethod {
	switch (method) {
		case "GET":
		case "POST":
		case "PUT":
		case "DELETE":
			return method;
		default:
			throw new Error("unsupported Cloudflare temporary-account method");
	}
}

export function createCloudflareTemporaryAccountTransport(
	fetchImpl: typeof fetch = fetch,
): TemporaryAccountTransport {
	const dispatch = guardedCloudflareTransport(
		createBoundedFetchTransport({ fetchImpl }),
	);
	const send = async (
		url: string,
		init: RequestInit = {},
	): Promise<TransportResponse> => {
		// Encoding a locally authored multipart request retains its generated Content-Type boundary.
		const encoded = new Request(url, init);
		const headers: Record<string, string> = {};
		encoded.headers.forEach((value, key) => {
			headers[key] = value;
		});
		const body = encoded.body === null ? undefined : await encoded.text();
		if (body !== undefined && Buffer.byteLength(body, "utf8") > 1_048_576)
			throw new Error(
				"Cloudflare temporary-account request exceeds its transport byte bound",
			);
		return dispatch({
			method: transportMethod(encoded.method),
			url: encoded.url,
			headers,
			timeoutMs: 15000,
			maxResponseBytes: 524288,
			...(body === undefined ? undefined : { body }),
		});
	};
	return {
		async requestChallenge() {
			const response = await send(
				`${CF_API_BASE}/provisioning/previews/challenge`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				},
			);
			return readCfJson<PreviewChallenge>(response, "preview challenge");
		},

		async createPreviewAccount(challenge, solution) {
			const response = await send(`${CF_API_BASE}/provisioning/previews`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					termsOfService: CF_TERMS_URL,
					privacyPolicy: CF_PRIVACY_URL,
					acceptTermsOfService: "yes",
					challengeToken: challenge.challengeToken,
					solution,
				}),
			});
			const result = await readCfJson<{
				accountId?: string;
				account_id?: string;
				apiToken?: string;
				api_token?: string;
				claimUrl?: string;
				claim_url?: string;
				workersDevSubdomain?: string;
				subdomain?: string;
				account?: {
					id?: string;
					apiToken?: string;
					api_token?: string;
				};
				claim?: {
					url?: string;
					token?: string;
				};
			}>(response, "preview account");
			const accountId =
				result.accountId ?? result.account_id ?? result.account?.id;
			const apiToken =
				result.apiToken ??
				result.api_token ??
				result.account?.apiToken ??
				result.account?.api_token;
			const claimUrl = result.claimUrl ?? result.claim_url ?? result.claim?.url;
			if (!accountId || !apiToken || !claimUrl) {
				throw new Error(
					"Cloudflare preview account response missing accountId/apiToken/claimUrl",
				);
			}
			plainIdentifier(accountId, "preview account");
			const claim = new URL(claimUrl);
			if (
				claim.protocol !== "https:" ||
				claim.hostname !== "dash.cloudflare.com" ||
				claim.username ||
				claim.password ||
				claim.port
			)
				throw new Error(
					"Cloudflare preview claim URL is outside its dashboard authority",
				);
			const workersDevSubdomain =
				result.workersDevSubdomain ?? result.subdomain;
			return {
				accountId,
				apiToken,
				claimUrl,
				...(workersDevSubdomain ? { workersDevSubdomain } : undefined),
			};
		},

		async deployWorkerScript({
			accountId,
			apiToken,
			scriptName,
			moduleSource,
			compatibilityFlags,
			bindings,
		}) {
			plainIdentifier(accountId, "account");
			plainIdentifier(scriptName, "script");
			const bindingList = bindings
				? Object.entries(bindings).map(([name, text]) => ({
						type: "plain_text",
						name,
						text,
					}))
				: [];
			const metadata = JSON.stringify({
				main_module: "station.js",
				compatibility_date: "2024-11-01",
				...(compatibilityFlags && compatibilityFlags.length > 0
					? { compatibility_flags: [...compatibilityFlags] }
					: undefined),
				...(bindingList.length > 0 ? { bindings: bindingList } : undefined),
			});
			const form = new FormData();
			form.set("metadata", new Blob([metadata], { type: "application/json" }));
			form.set(
				"station.js",
				new File([moduleSource], "station.js", {
					type: "application/javascript+module",
				}),
			);

			const put = await send(
				`${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`,
				{
					method: "PUT",
					headers: { authorization: `Bearer ${apiToken}` },
					body: form,
				},
			);
			await readCfJson<unknown>(put, "workers script upload");

			const subdomain = await send(
				`${CF_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${apiToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ enabled: true }),
				},
			);
			const subResult = await readCfJson<{
				enabled?: boolean;
				previews_enabled?: boolean;
				subdomain?: string;
			}>(subdomain, "workers.dev subdomain enable");
			if (subResult.enabled !== true)
				throw new Error("Cloudflare did not confirm workers.dev activation");

			const account = await send(
				`${CF_API_BASE}/accounts/${accountId}/workers/subdomain`,
				{
					method: "GET",
					headers: { authorization: `Bearer ${apiToken}` },
				},
			);
			const accountSub = await readCfJson<{ subdomain?: string }>(
				account,
				"workers subdomain",
			);

			const host = accountSub.subdomain ?? subResult.subdomain;
			if (!host || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host))
				throw new Error(
					"Cloudflare has not reported a valid workers.dev subdomain; the deployment remains unverified",
				);
			return {
				workersDevUrl: `https://${scriptName}.${host}.workers.dev`,
			};
		},
		async deleteWorkerScript({ accountId, apiToken, scriptName }) {
			plainIdentifier(accountId, "account");
			plainIdentifier(scriptName, "script");
			const path = `${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`;
			const deleted = await send(path, {
				method: "DELETE",
				headers: { authorization: `Bearer ${apiToken}` },
			});
			if (deleted.status !== 404)
				await readCfJson(deleted, "workers script deletion");
			const observed = await send(`${path}/settings`, {
				method: "GET",
				headers: { authorization: `Bearer ${apiToken}` },
			});
			if (observed.status === 404) return { absent: true };
			await readCfJson(observed, "worker retirement observation");
			return { absent: false };
		},
	};
}

/**
 * Request Temporary Accounts challenge, solve PoW, create preview account.
 * Returns temporary credentials — never persist as HoBo permanent secrets.
 */
export async function solveAndProvisionAccount(
	transport: TemporaryAccountTransport,
): Promise<TemporaryPreviewAccount> {
	const challenge = await transport.requestChallenge();
	const solved = await solvePreviewChallenge(challenge);
	return transport.createPreviewAccount(challenge, solved.solution);
}

/**
 * Provision an anonymous Environment Station on a Cloudflare temporary account.
 * No user Cloudflare credentials — Temporary Accounts API + Worker deploy.
 */
export async function provisionTemporaryEnvironmentStation(
	input: TemporaryEnvironmentStationInput,
): Promise<TemporaryEnvironmentStationResult> {
	const moduleSource = input.workerModule ?? ENVIRONMENT_STATION_WORKER_MODULE;
	assertStationWorkerHasNoAppCode(moduleSource);
	const scriptName = sanitizeScriptName(input.stationId, input.scriptName);
	const transport =
		input.transport ??
		createCloudflareTemporaryAccountTransport(input.fetchImpl ?? fetch);

	const account = await solveAndProvisionAccount(transport);
	const deployed = await transport.deployWorkerScript({
		accountId: account.accountId,
		apiToken: account.apiToken,
		scriptName,
		moduleSource,
		...(input.compatibilityFlags
			? { compatibilityFlags: input.compatibilityFlags }
			: undefined),
		...(input.bindings ? { bindings: input.bindings } : undefined),
	});

	const expiresAt = temporaryStationExpiresAt(TEMPORARY_STATION_TTL_MS);
	return {
		stationId: input.stationId,
		scriptName,
		stationUrl: deployed.workersDevUrl,
		primaryUrl: deployed.workersDevUrl,
		claimUrl: account.claimUrl,
		accountId: account.accountId,
		expiresAt,
		providerId: CLOUDFLARE_TEMPORARY_PROVIDER_ID,
		anonymous: true,
		temporary: true,
	};
}
