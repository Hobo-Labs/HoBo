/**
 * Typed operations against the documented Vercel REST endpoints this claim
 * strategy needs.
 *
 * Every call goes through the guarded transport, and the sponsoring credential
 * arrives as a {@link SecretValue} so it cannot be stringified into a log line,
 * an error message, or a receipt. Only the header builder exposes it.
 *
 * Deployment creation is deliberately *not* here. The claim-deployments guide
 * points at `POST /files` and `POST /deployments`, but their concrete versioned
 * paths were not read in this change, and a driver that guesses an endpoint
 * version is a driver that fails in production and blames the provider. It is an
 * injected port instead ({@link SponsoredDeploymentPort}).
 */
import { parseSecretRef, SecretValue } from "@hobo/bindings";

import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "./json.js";
import {
	providerErrorForStatus,
	redactProviderText,
	VercelProviderError,
} from "./provider-errors.js";
import type { TransportRequest, VercelTransport } from "./transport.js";

// public-contract: documented Vercel management API endpoint.
export const VERCEL_API_BASE = "https://api.vercel.com" as const;

/** The dashboard ceremony URL. Bearer authority, never called by this driver. */
// public-contract: ownership-claim URL surfaced to human owners.
export const VERCEL_CLAIM_DEPLOYMENT_URL =
	"https://vercel.com/claim-deployment" as const;

export type SponsoringCredential = {
	/** Scoped to one sponsor project: deploy plus transfer, nothing else. */
	readonly token: SecretValue;
	/** The sponsor team the project lives in before the claim. */
	readonly sponsorAccountId: string;
	/** Token id, so revocation does not need the value a second time. */
	readonly tokenId: string;
};

export type ApiCallOptions = {
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
};

const DEFAULT_CALL: Required<ApiCallOptions> = {
	timeoutMs: 15_000,
	maxResponseBytes: 256 * 1024,
};

function authorizedRequest(
	credential: SponsoringCredential,
	init: {
		readonly method: TransportRequest["method"];
		readonly url: string;
		readonly body?: string;
	},
	options: ApiCallOptions,
): TransportRequest {
	return {
		method: init.method,
		url: init.url,
		headers: {
			// The one place the value is exposed. It never reaches a template
			// literal that could end up in output.
			authorization: `Bearer ${credential.token.expose()}`,
			accept: "application/json",
			...(init.body !== undefined
				? { "content-type": "application/json" }
				: undefined),
		},
		...(init.body !== undefined ? { body: init.body } : undefined),
		timeoutMs: options.timeoutMs ?? DEFAULT_CALL.timeoutMs,
		maxResponseBytes: options.maxResponseBytes ?? DEFAULT_CALL.maxResponseBytes,
	};
}

function retryAfterMs(
	headers: Readonly<Record<string, string>>,
): number | undefined {
	const raw = headers["retry-after"];
	if (raw === undefined) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function parseJsonBody(body: string, operation: string): JsonObject {
	const parsed = parseJsonValue(body);
	if (!isJsonObject(parsed)) {
		throw new VercelProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`${operation} returned a body that is not a JSON object`,
			{ detail: { operation, preview: redactProviderText(body, 80) } },
		);
	}
	return parsed;
}

function requireString(
	body: JsonObject,
	key: string,
	operation: string,
): string {
	const value = body[key];
	if (!isJsonString(value) || value.length === 0) {
		throw new VercelProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`${operation} response is missing the documented ${key} field`,
			{ detail: { operation, field: key } },
		);
	}
	return value;
}

/**
 * The transfer code, kept as a {@link SecretValue}.
 *
 * The code is the whole claim: whoever holds it can take the project and its
 * database. Returning a bare string here is how it ends up in a log.
 */
export type ProjectTransferRequest = {
	readonly code: SecretValue;
	readonly expiresAt: number;
};

/** Parse-don't-validate boundary for a returned transfer code. */
function sealTransferCode(code: string, projectId: string): SecretValue {
	const slug = projectId.replace(/[^A-Za-z0-9._~-]/gu, "-").slice(0, 96);
	// A locator, not a value: the ref names where the code is custodied.
	const ref = parseSecretRef(
		`hobo-token://vercel/project-transfer/${slug || "project"}`,
	);
	return new SecretValue(ref, code);
}

export type CreateTransferRequestInput = {
	readonly projectId: string;
	readonly teamId?: string;
	/** When set, Vercel signs an acceptance webhook with HMAC-SHA256. */
	readonly callbackUrl?: string;
	readonly callbackSecret?: SecretValue;
	/** Instant the request was issued, used with the documented 24 hour TTL. */
	readonly issuedAt: number;
};

/**
 * `POST /projects/{idOrName}/transfer-request`.
 *
 * Returns a code valid for 24 hours (documented). A 5xx or dropped connection
 * here is ambiguous — the request may have been created and the code lost — so
 * recovery is {@link observeOrAdoptProject} followed by a fresh request rather
 * than a blind retry that assumes failure.
 */
export async function createProjectTransferRequest(
	transport: VercelTransport,
	credential: SponsoringCredential,
	input: CreateTransferRequestInput,
	options: ApiCallOptions = {},
): Promise<ProjectTransferRequest> {
	const operation = "createProjectTransferRequest";
	const query =
		input.teamId === undefined
			? ""
			: `?teamId=${encodeURIComponent(input.teamId)}`;
	const body = JSON.stringify({
		...(input.callbackUrl !== undefined
			? { callbackUrl: input.callbackUrl }
			: undefined),
		...(input.callbackSecret !== undefined
			? { callbackSecret: input.callbackSecret.expose() }
			: undefined),
	});
	const response = await transport.request(
		authorizedRequest(
			credential,
			{
				method: "POST",
				url: `${VERCEL_API_BASE}/projects/${encodeURIComponent(input.projectId)}/transfer-request${query}`,
				body,
			},
			options,
		),
	);
	if (response.status !== 200) {
		const retryAfter = retryAfterMs(response.headers);
		throw providerErrorForStatus(response.status, {
			method: "POST",
			operation,
			body: response.body,
			...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : undefined),
		});
	}
	const parsed = parseJsonBody(response.body, operation);
	const code = requireString(parsed, "code", operation);
	return {
		code: sealTransferCode(code, input.projectId),
		expiresAt: input.issuedAt + 24 * 60 * 60 * 1000,
	};
}

// parallel-type-allowed: the proto VercelProjectView is the design-time contract view and this package wires no buf codegen; the TypeScript form is what `getProject` constructs after parsing, where every field is already proven non-empty, so an absent accountId is unrepresentable rather than an empty string.
export type VercelProjectView = {
	readonly id: string;
	readonly name: string;
	readonly accountId: string;
};

/** `GET /v9/projects/{idOrName}`. `accountId` is the ownership fact. */
export async function getProject(
	transport: VercelTransport,
	credential: SponsoringCredential,
	input: { readonly projectId: string; readonly teamId?: string },
	options: ApiCallOptions = {},
): Promise<VercelProjectView> {
	const operation = "getProject";
	const query =
		input.teamId === undefined
			? ""
			: `?teamId=${encodeURIComponent(input.teamId)}`;
	const response = await transport.request(
		authorizedRequest(
			credential,
			{
				method: "GET",
				url: `${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(input.projectId)}${query}`,
			},
			options,
		),
	);
	if (response.status !== 200) {
		const retryAfter = retryAfterMs(response.headers);
		throw providerErrorForStatus(response.status, {
			method: "GET",
			operation,
			body: response.body,
			...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : undefined),
		});
	}
	const parsed = parseJsonBody(response.body, operation);
	return {
		id: requireString(parsed, "id", operation),
		name: requireString(parsed, "name", operation),
		accountId: requireString(parsed, "accountId", operation),
	};
}

export type ProjectObservation =
	| { readonly state: "owned-by-sponsor"; readonly accountId: string }
	| { readonly state: "already-transferred"; readonly accountId: string }
	| { readonly state: "unreachable-by-sponsor" };

/**
 * The observe/adopt step after an ambiguous mutation.
 *
 * Three outcomes matter and they are genuinely different: the project is still
 * ours (issue a fresh transfer request), the project has moved (the claim
 * already happened — adopt it, do not re-create), or our credential can no
 * longer see it at all (which is also consistent with a completed transfer and
 * must not be reported as a provisioning failure).
 */
export async function observeOrAdoptProject(
	transport: VercelTransport,
	credential: SponsoringCredential,
	input: { readonly projectId: string; readonly teamId?: string },
	options: ApiCallOptions = {},
): Promise<ProjectObservation> {
	try {
		const project = await getProject(transport, credential, input, options);
		return project.accountId === credential.sponsorAccountId
			? { state: "owned-by-sponsor", accountId: project.accountId }
			: { state: "already-transferred", accountId: project.accountId };
	} catch (error) {
		if (
			error instanceof VercelProviderError &&
			error.code === "PROVIDER_AUTH_FAILED"
		) {
			return { state: "unreachable-by-sponsor" };
		}
		throw error;
	}
}

/**
 * `DELETE /v3/user/tokens/{tokenId}`.
 *
 * A 404 is success: a token that no longer exists cannot be used, and treating
 * it as an error is how revocation ends up retried forever.
 */
export async function revokeSponsoringToken(
	transport: VercelTransport,
	credential: SponsoringCredential,
	input: { readonly tokenId: string },
	options: ApiCallOptions = {},
): Promise<{ readonly tokenId: string; readonly alreadyGone: boolean }> {
	const operation = "revokeSponsoringToken";
	const response = await transport.request(
		authorizedRequest(
			credential,
			{
				method: "DELETE",
				url: `${VERCEL_API_BASE}/v3/user/tokens/${encodeURIComponent(input.tokenId)}`,
			},
			options,
		),
	);
	if (response.status === 404) {
		return { tokenId: input.tokenId, alreadyGone: true };
	}
	if (response.status !== 200) {
		throw providerErrorForStatus(response.status, {
			method: "DELETE",
			operation,
			body: response.body,
		});
	}
	const parsed = parseJsonBody(response.body, operation);
	return {
		tokenId: requireString(parsed, "tokenId", operation),
		alreadyGone: false,
	};
}

/**
 * Deployment creation as an injected port.
 *
 * A host that has read the current `POST /files` / `POST /deployments` contract
 * supplies this; the strategy above only needs the resulting project identity.
 */
export interface SponsoredDeploymentPort {
	createSponsoredDeployment(input: {
		readonly projectName: string;
		readonly sponsorAccountId: string;
		readonly idempotencyKey: string;
	}): Promise<{
		readonly projectId: string;
		readonly deploymentId: string;
		readonly primaryUrl: string;
	}>;
}
