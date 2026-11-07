// @hobo/hobo — the REAL Vercel Create Deployment client (composition/app layer).
//
// This forms the request for Vercel's Create Deployment endpoint and parses the
// deployment URL back out. It is the ONE cloud actually reachable from HoBo's own
// pipeline: when `VERCEL_TOKEN` is present, `hobo up` drives this against the live
// API; when absent, compose falls back to the in-memory Pulumi-backed provider.
//
// Grounded in Vercel's REST API — Create a new deployment:
//   POST https://api.vercel.com/v13/deployments
//   Authorization: Bearer <token>
//   Content-Type: application/json
//   body: { name, project?, files:[{file,data,encoding}], target?, projectSettings? }
//   (docs: vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment)
//
// `fetch` is INJECTED so tests exercise the exact request formation against a
// mocked transport with no network. HONEST SCOPE: the live call is credential-
// gated and NOT exercised in this sandbox — only the request formation + response
// parsing are tested (against a mocked fetch).

// A single file in the deployment payload. `data` is the file content; when
// `encoding` is "base64" the content is base64-encoded (Vercel's inline-files
// contract). `file` is the POSIX path within the deployment.
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

interface VercelFetchInit {
	readonly method?: string;
	readonly headers?: { readonly [header: string]: string };
	readonly body?: string;
}

export interface VercelDeploymentFile {
	readonly file: string;
	readonly data: string;
	readonly encoding?: "base64" | "utf-8";
}

export interface CreateDeploymentInput {
	// The deployment name (Vercel `name`, required).
	readonly name: string;
	// The inline file tree to deploy (Vercel `files`).
	readonly files: readonly VercelDeploymentFile[];
	// The deployment target — "production" or "preview" (Vercel `target`).
	readonly target?: string;
	// The project name/id (Vercel `project`); defaults to `name` when omitted.
	readonly project?: string;
	// Optional project build settings (Vercel `projectSettings`). Defaults to a
	// zero-config static + Node-functions deploy (framework: null), matching the
	// committed hello-bindle artifact which needs no build step.
	readonly projectSettings?: JsonObject;
}

export interface VercelDeploymentResult {
	// The deployment URL, normalized to include the https:// scheme (Vercel returns
	// the bare host in `url`).
	readonly url: string;
	// The deployment id (Vercel `id`).
	readonly id: string;
	// The deployment readiness state when present (Vercel `readyState`).
	readonly readyState?: string;
	// The full parsed response body, for callers that need more than url/id.
	readonly raw: JsonValue;
}

// The minimal fetch surface this client depends on — a subset of the WHATWG
// `fetch`. Injecting this (rather than the global) keeps the client testable with
// a mock transport and free of a DOM/undici lib dependency.
export interface VercelFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
	json(): Promise<JsonValue>;
}

export type VercelFetch = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body: string;
	},
) => Promise<VercelFetchResponse>;

export interface VercelClientOptions {
	// The Vercel access token, sent as `Authorization: Bearer <token>`.
	readonly token: string;
	// The transport. Defaults to the global `fetch`; injected in tests.
	readonly fetch?: VercelFetch;
	// The team id, sent as the `teamId` query parameter when the token is a team
	// token (Vercel `teamId`).
	readonly teamId?: string;
	// The API base URL. Defaults to https://api.vercel.com (override for tests).
	readonly baseUrl?: string;
}

export interface VercelClient {
	getDeployment(
		deploymentId: string,
	): Promise<VercelDeploymentResult | undefined>;
	deleteDeployment(deploymentId: string): Promise<void>;
	createDeployment(
		input: CreateDeploymentInput,
	): Promise<VercelDeploymentResult>;
}

const DEFAULT_BASE_URL = "https://api.vercel.com";

// The global `fetch` presented through the injectable `VercelFetch` shape. Node
// 18+ and modern runtimes expose a global `fetch`; we adapt it without importing
// DOM lib types.
const globalFetch: VercelFetch = (url, init) => {
	const fetchImpl =
		// SAFETY: assertion required at this I/O or test boundary.
		(
			globalThis as {
				fetch?: (
					input: string,
					init: VercelFetchInit,
				) => Promise<VercelFetchResponse>;
			}
		).fetch;
	if (!(fetchImpl instanceof Function)) {
		throw new Error(
			"vercel-client: no global fetch available; inject one via createVercelClient({ fetch })",
		);
	}
	return fetchImpl(url, init);
};

function normalizeUrl(raw: JsonValue | undefined): string {
	if (!isJsonString(raw) || raw.length === 0) {
		return "";
	}
	return raw.startsWith("http://") || raw.startsWith("https://")
		? raw
		: `https://${raw}`;
}

// Create the REAL Vercel deployment client. No network call happens at
// construction; the request is formed and sent only on `createDeployment`.
export function createVercelClient(options: VercelClientOptions): VercelClient {
	const { token } = options;
	if (!token) {
		throw new TypeError("createVercelClient: token is required");
	}
	const fetchImpl = options.fetch ?? globalFetch;
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

	function deploymentPath(deploymentId: string) {
		if (!deploymentId || !/^[A-Za-z0-9_-]+$/.test(deploymentId))
			throw new Error("invalid deployment receipt identity");
		return `${baseUrl}/v13/deployments/${encodeURIComponent(deploymentId)}${options.teamId ? `?teamId=${encodeURIComponent(options.teamId)}` : ""}`;
	}
	async function readDeployment(deploymentId: string) {
		const response = await fetchImpl(deploymentPath(deploymentId), {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
			body: "",
		});
		if (response.status === 404) return undefined;
		if (!response.ok)
			throw new Error(
				`vercel-client: get deployment failed (HTTP ${response.status})`,
			);
		const payload = await response.json();
		if (!isJsonObject(payload) || payload.id !== deploymentId)
			throw new Error(
				"vercel-client: deployment read returned a different identity",
			);
		return {
			id: deploymentId,
			url: normalizeUrl(payload.url),
			...(isJsonString(payload.readyState)
				? { readyState: payload.readyState }
				: undefined),
			raw: payload,
		};
	}
	return {
		getDeployment: readDeployment,
		async deleteDeployment(deploymentId: string) {
			const response = await fetchImpl(deploymentPath(deploymentId), {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
				body: "",
			});
			if (!response.ok && response.status !== 404)
				throw new Error(
					`vercel-client: delete deployment failed (HTTP ${response.status})`,
				);
			if (await readDeployment(deploymentId))
				throw new Error(
					"vercel-client: deployment deletion remains unconfirmed",
				);
		},
		async createDeployment(
			input: CreateDeploymentInput,
		): Promise<VercelDeploymentResult> {
			const query =
				options.teamId !== undefined
					? `?teamId=${encodeURIComponent(options.teamId)}`
					: "";
			const url = `${baseUrl}/v13/deployments${query}`;

			const body = {
				name: input.name,
				project: input.project ?? input.name,
				files: input.files.map((f) => ({
					file: f.file,
					data: f.data,
					encoding: f.encoding ?? "base64",
				})),
				...(input.target !== undefined ? { target: input.target } : undefined),
				projectSettings: input.projectSettings ?? { framework: null },
			};

			const response = await fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error(
					`vercel-client: create deployment failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
				);
			}

			const parsed = await response.json();
			const payload = isJsonObject(parsed) ? parsed : {};
			const id = isJsonString(payload.id) ? payload.id : "";
			return {
				url: normalizeUrl(payload.url),
				id,
				...(isJsonString(payload.readyState)
					? { readyState: payload.readyState }
					: undefined),
				raw: payload,
			};
		},
	};
}
