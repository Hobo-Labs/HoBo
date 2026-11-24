import { githubAppInstallationRef } from "@hobo/core";

import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

// @hobo/runner-github — the REAL GitHub Actions REST client.
//
// This forms the requests for GitHub's Actions endpoints and parses the
// responses; nothing here is a simulation of the API shape. Grounded in the
// GitHub REST API (docs.github.com/en/rest, version 2022-11-28):
//   POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
//     Authorization: Bearer <installation token>
//     body: { "ref": "<git ref>", "inputs": { ... } }   -> 204 No Content
//   GET  /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs
//        ?event=workflow_dispatch&per_page=1            -> newest dispatched run
//   GET  /repos/{owner}/{repo}/actions/runs/{run_id}    -> { status, conclusion, html_url }
//   GET  /orgs/{org}/packages/container/{package}/versions?per_page=1
//     -> [{ name: "sha256:..." }]  (the GHCR image version name IS the digest)
//
// `fetch` is INJECTED so tests exercise the exact request formation against a
// mocked transport with no network. HONEST SCOPE: the live calls are
// credential-gated and NOT exercised in this sandbox — only request formation
// + response parsing run in the replay lane; the live lane is opt-in via
// HOBO_GITHUB_LIVE=1.
//
// Credential posture (HOBO-110): the token is a BROKERED short-lived GitHub
// App installation token minted by the Yard broker per operation — never a
// PAT, never a static secret held by this package.

// public-contract: the GitHub REST API version header value every request pins.
export const GITHUB_API_VERSION = "2022-11-28";
// public-contract: typed gate when no brokered installation token is available.
export const GITHUB_CREDENTIALS_MISSING = "GITHUB_CREDENTIALS_MISSING";
// public-contract: typed failure for non-2xx GitHub API responses.
export const GITHUB_API_ERROR = "GITHUB_API_ERROR";

const DEFAULT_BASE_URL = "https://api.github.com";

// The minimal fetch surface this client depends on — a subset of the WHATWG
// `fetch`, injected so the client is testable with a mock transport.
export interface GithubFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
	json(): Promise<JsonValue>;
}

export type GithubFetch = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body?: string;
	},
) => Promise<GithubFetchResponse>;

// Mints a short-lived installation token for one operation (the broker calls
// POST /app/installations/{id}/access_tokens with the App's JWT; this client
// only ever sees the resulting expiring token).
export type BrokeredTokenProvider = () => Promise<string>;

export class GithubCredentialsMissingError extends Error {
	readonly code = GITHUB_CREDENTIALS_MISSING;
	constructor() {
		super(
			"runner-github: no brokered GitHub installation token available — wire a token provider (the Yard broker) or mint one from HoBo's GitHub App through the owner store session (github-app://<owner>/<repo> after HoBo MCP choose_secret_store and hobo ci app create); the environment is never read.",
		);
		this.name = "GithubCredentialsMissingError";
	}
}

export class GithubApiError extends Error {
	readonly code = GITHUB_API_ERROR;
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "GithubApiError";
		this.status = status;
	}
}

export interface WorkflowDispatchInput {
	// The workflow file name or id (GitHub `workflow_id` path segment).
	readonly workflow: string;
	// The git ref the run executes on.
	readonly ref: string;
	// workflow_dispatch inputs.
	readonly inputs?: Record<string, string>;
}

export interface WorkflowRun {
	readonly id: number;
	readonly status: string;
	readonly conclusion: string | null;
	readonly htmlUrl: string;
}

export interface GithubActionsClientOptions {
	// The repository the workflows live in.
	readonly owner: string;
	readonly repo: string;
	// The brokered short-lived installation-token provider (no PATs).
	readonly token: BrokeredTokenProvider;
	// The transport. Defaults to the global `fetch`; injected in tests.
	readonly fetch?: GithubFetch;
	// The API base URL. Defaults to https://api.github.com.
	readonly baseUrl?: string;
}

export interface GithubActionsClient {
	// Fire a workflow_dispatch (204 on success).
	dispatchWorkflow(input: WorkflowDispatchInput): Promise<void>;
	// The newest workflow_dispatch run of a workflow (undefined when none yet).
	findDispatchedRun(workflow: string): Promise<WorkflowRun | undefined>;
	// A single run by id — polled until `status === "completed"`.
	getRun(runId: number): Promise<WorkflowRun>;
	// The newest GHCR container-package version digest (`sha256:...`) — how a
	// completed build run's published image becomes a pullable ImageRef.
	latestContainerDigest(packageName: string): Promise<string>;
}

const globalFetch: GithubFetch = (url, init) => {
	const fetchImpl = globalThis.fetch;
	const tag = Object.prototype.toString.call(fetchImpl);
	if (tag !== "[object Function]" && tag !== "[object AsyncFunction]") {
		throw new Error(
			"runner-github: no global fetch available; inject one via createGithubActionsClient({ fetch })",
		);
	}
	return fetchImpl(url, init);
};

export type GithubCredentialResolver = Readonly<{
	resolve(
		ref: string,
		scope: string,
	): Promise<Readonly<Record<string, string>>>;
}>;

export function githubAppTokenProvider(
	credentials: GithubCredentialResolver,
	repository: Readonly<{ owner: string; repo: string }>,
): BrokeredTokenProvider {
	return async () => {
		const ref = githubAppInstallationRef(
			`${repository.owner}/${repository.repo}`,
		);
		const material = await credentials
			.resolve(ref, "github.actions")
			.catch(() => undefined);
		const token = material?.token;
		if (!token) throw new GithubCredentialsMissingError();
		return token;
	};
}

export function createGithubActionsClient(
	options: GithubActionsClientOptions,
): GithubActionsClient {
	const transport = options.fetch ?? globalFetch;
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	const repoBase = `${baseUrl}/repos/${options.owner}/${options.repo}`;

	async function headers(): Promise<Record<string, string>> {
		const token = await options.token();
		return {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": GITHUB_API_VERSION,
		};
	}

	async function request(
		method: string,
		url: string,
		body?: string,
	): Promise<GithubFetchResponse> {
		const response = await transport(url, {
			method,
			headers: await headers(),
			...(body === undefined ? undefined : { body }),
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new GithubApiError(
				`runner-github: ${method} ${url} failed with ${response.status}: ${detail}`,
				response.status,
			);
		}
		return response;
	}

	function parseRun(raw: JsonValue): WorkflowRun {
		if (!isJsonObject(raw) || !isJsonNumber(raw.id)) {
			throw new GithubApiError(
				"runner-github: workflow run response missing numeric id",
				200,
			);
		}
		return {
			id: raw.id,
			status: isJsonString(raw.status) ? raw.status : "queued",
			conclusion:
				raw.conclusion === null
					? null
					: isJsonString(raw.conclusion)
						? raw.conclusion
						: null,
			htmlUrl: isJsonString(raw.html_url) ? raw.html_url : "",
		};
	}

	return {
		async dispatchWorkflow(input) {
			await request(
				"POST",
				`${repoBase}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
				JSON.stringify({ ref: input.ref, inputs: input.inputs ?? {} }),
			);
		},

		async findDispatchedRun(workflow) {
			const response = await request(
				"GET",
				`${repoBase}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=1`,
			);
			const payload = await response.json();
			const runs =
				isJsonObject(payload) && isJsonArray(payload.workflow_runs)
					? payload.workflow_runs
					: [];
			const first = runs[0];
			return first === undefined ? undefined : parseRun(first);
		},

		async getRun(runId) {
			const response = await request(
				"GET",
				`${repoBase}/actions/runs/${runId}`,
			);
			return parseRun(await response.json());
		},

		async latestContainerDigest(packageName) {
			const response = await request(
				"GET",
				`${baseUrl}/orgs/${options.owner}/packages/container/${encodeURIComponent(packageName)}/versions?per_page=1`,
			);
			const versions = await response.json();
			const first = isJsonArray(versions) ? versions[0] : undefined;
			const digest =
				isJsonObject(first) && isJsonString(first.name)
					? first.name
					: undefined;
			if (digest === undefined || !digest.startsWith("sha256:")) {
				throw new GithubApiError(
					`runner-github: package ${packageName} has no sha256 version digest yet`,
					200,
				);
			}
			return digest;
		},
	};
}
