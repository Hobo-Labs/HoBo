import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// @hobo/runner-depot — the REAL Depot BuildService client.
//
// This forms the requests for Depot's public Connect-protocol API and parses
// the responses; nothing here simulates the API shape. Grounded in Depot's
// documented build API (depot.dev/docs — Connect RPC over HTTPS, JSON
// encoding):
//   POST https://api.depot.dev/depot.build.v1.BuildService/CreateBuild
//     Authorization: Bearer <project token>   body: { "project_id": "..." }
//     -> { "build_id": "...", "build_token": "..." }
//   POST https://api.depot.dev/depot.build.v1.BuildService/GetBuild
//     body: { "build_id": "..." } -> { "build_id", "status" }
// The registered build is then executed by a BuildKit executor holding the
// per-build token (the `depot` CLI drives this in the live lane); the
// executor reports the pushed image digest and the shared-cache hit ratio.
//
// `fetch` is INJECTED so tests exercise the exact request formation against a
// mocked transport with no network. HONEST SCOPE: the live calls are
// credential-gated and NOT exercised in this sandbox — only request
// formation + response parsing run in the replay lane.
//
// Credential posture (HOBO-110): the token is a BROKERED short-lived Depot
// project token minted by the Yard broker per operation (Depot's OIDC trust
// exchange) — never a static Depot token held by this package.

// public-contract: typed gate when no brokered Depot project token exists.
export const DEPOT_CREDENTIALS_MISSING = "DEPOT_CREDENTIALS_MISSING";
// public-contract: typed failure for non-2xx Depot API responses.
export const DEPOT_API_ERROR = "DEPOT_API_ERROR";

const DEFAULT_BASE_URL = "https://api.depot.dev";

// The minimal fetch surface this client depends on — a subset of the WHATWG
// `fetch`, injected so the client is testable with a mock transport.
export interface DepotFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
	json(): Promise<JsonValue>;
}

export type DepotFetch = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body?: string;
	},
) => Promise<DepotFetchResponse>;

// Mints a short-lived project token for one operation (the broker holds the
// Depot OIDC trust relationship; this client only sees the expiring token).
export type BrokeredDepotTokenProvider = () => Promise<string>;

export class DepotCredentialsMissingError extends Error {
	readonly code = DEPOT_CREDENTIALS_MISSING;
	constructor() {
		super(
			"runner-depot: no brokered Depot project token available — wire a token provider (the Yard broker) or resolve owner://DEPOT_PROJECT_TOKEN through the owner store session (HoBo MCP choose_secret_store); the environment is never read.",
		);
		this.name = "DepotCredentialsMissingError";
	}
}

export class DepotApiError extends Error {
	readonly code = DEPOT_API_ERROR;
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "DepotApiError";
		this.status = status;
	}
}

export interface DepotBuildHandle {
	readonly buildId: string;
	readonly buildToken: string;
}

export interface DepotBuildStatus {
	readonly buildId: string;
	readonly status: string;
}

export interface DepotClientOptions {
	// The Depot project builds register against.
	readonly projectId: string;
	// The brokered short-lived project-token provider (no static tokens).
	readonly token: BrokeredDepotTokenProvider;
	// The transport. Defaults to the global `fetch`; injected in tests.
	readonly fetch?: DepotFetch;
	// The API base URL. Defaults to https://api.depot.dev.
	readonly baseUrl?: string;
}

export interface DepotClient {
	// Register a build with the BuildService (returns the per-build token the
	// BuildKit executor authenticates with).
	createBuild(): Promise<DepotBuildHandle>;
	// A build's current status by id.
	getBuild(buildId: string): Promise<DepotBuildStatus>;
}

const globalFetch: DepotFetch = (url, init) => {
	const fetchImpl = globalThis.fetch;
	const tag = Object.prototype.toString.call(fetchImpl);
	if (tag !== "[object Function]" && tag !== "[object AsyncFunction]") {
		throw new Error(
			"runner-depot: no global fetch available; inject one via createDepotClient({ fetch })",
		);
	}
	return fetchImpl(url, init);
};

export type DepotCredentialResolver = Readonly<{
	resolve(
		ref: string,
		scope: string,
	): Promise<Readonly<Record<string, string>>>;
}>;

// public-contract: the owner-store entry the Depot runner reads its project token from.
export const DEPOT_PROJECT_TOKEN_REF = "owner://DEPOT_PROJECT_TOKEN";

export function ownerDepotTokenProvider(
	credentials: DepotCredentialResolver,
): BrokeredDepotTokenProvider {
	return async () => {
		const material = await credentials
			.resolve(DEPOT_PROJECT_TOKEN_REF, "depot.project")
			.catch(() => undefined);
		const token = material?.token;
		if (!token) throw new DepotCredentialsMissingError();
		return token;
	};
}

export function createDepotClient(options: DepotClientOptions): DepotClient {
	const transport = options.fetch ?? globalFetch;
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

	async function rpc(method: string, body: JsonObject): Promise<JsonValue> {
		const token = await options.token();
		const url = `${baseUrl}/depot.build.v1.BuildService/${method}`;
		const response = await transport(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new DepotApiError(
				`runner-depot: POST ${url} failed with ${response.status}: ${detail}`,
				response.status,
			);
		}
		return response.json();
	}

	return {
		async createBuild() {
			const payload = await rpc("CreateBuild", {
				project_id: options.projectId,
			});
			if (
				!isJsonObject(payload) ||
				!isJsonString(payload.build_id) ||
				payload.build_id.length === 0 ||
				!isJsonString(payload.build_token) ||
				payload.build_token.length === 0
			) {
				throw new DepotApiError(
					"runner-depot: CreateBuild response missing build_id/build_token",
					200,
				);
			}
			return { buildId: payload.build_id, buildToken: payload.build_token };
		},

		async getBuild(buildId) {
			const payload = await rpc("GetBuild", { build_id: buildId });
			const document = isJsonObject(payload) ? payload : {};
			return {
				buildId: isJsonString(document.build_id) ? document.build_id : buildId,
				status: isJsonString(document.status) ? document.status : "unknown",
			};
		},
	};
}
