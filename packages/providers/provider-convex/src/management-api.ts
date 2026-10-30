// Credential-gated Convex Management API client. Honesty rules
// (docs/design/live-provider-matrix.md): the live path activates only when a
// broker-supplied deploy key is present, requests are formed against an
// injected fetch so tests never need the network, and a missing credential
// FAILS CLOSED with a remediation naming the broker path — never a silent
// no-op. Env inspection is presence-only; values are never logged or echoed.

// public-contract: default Management API base consumers may override.
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

export const CONVEX_MANAGEMENT_API_BASE = "https://api.convex.dev/v1";

export interface ConvexManagementClientOptions {
	/** Broker-minted deploy key; absence gates the client closed. */
	readonly deployKey?: string;
	readonly apiBase?: string;
	readonly fetchImpl?: typeof fetch;
}

export interface ConvexDeploymentInfo {
	readonly name: string;
	readonly url: string;
	readonly state: string;
}

export class ConvexCredentialsError extends Error {
	constructor() {
		super(
			"convex deploy is credential-gated: need broker CONVEX_DEPLOY_KEY " +
				"(Convex Cloud) or CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY " +
				"(self-host). Route via secretRef / Yard token broker — never Bindle config.",
		);
		this.name = "ConvexCredentialsError";
	}
}

export interface ConvexManagementClient {
	/** True when a credential is present (presence-only; value never exposed). */
	readonly live: boolean;
	listDeployments(): Promise<readonly ConvexDeploymentInfo[]>;
	createDeployment(slug: string): Promise<ConvexDeploymentInfo>;
}

export function createConvexManagementClient(
	options: ConvexManagementClientOptions = {},
): ConvexManagementClient {
	const deployKey = options.deployKey?.trim();
	const base = (options.apiBase ?? CONVEX_MANAGEMENT_API_BASE).replace(
		/\/+$/u,
		"",
	);
	const target = new URL(base);
	if (
		target.protocol !== "https:" ||
		target.username ||
		target.password ||
		target.search ||
		target.hash
	) {
		throw new Error(
			"convex management API base must be an HTTPS URL without credentials, query, or fragment",
		);
	}
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	async function request(path: string, init?: RequestInit): Promise<JsonValue> {
		if (!deployKey) {
			throw new ConvexCredentialsError();
		}
		const response = await fetchImpl(`${base}${path}`, {
			...init,
			redirect: "error",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${deployKey}`,
				...(init?.body === undefined
					? undefined
					: { "content-type": "application/json" }),
			},
		});
		if (!response.ok) {
			throw new Error(
				`convex management API ${path} failed with ${response.status}`,
			);
		}
		// SAFETY: fetch json() is a JSON value at this management-API boundary.
		return (await response.json()) as JsonValue;
	}

	function parseDeployment(value: JsonValue): ConvexDeploymentInfo {
		if (!isJsonObject(value)) {
			throw new Error("convex deployment payload must be an object");
		}
		const name = value.name;
		const url = value.url;
		const state = value.state;
		if (!isJsonString(name) || name.length === 0) {
			throw new Error("convex deployment payload missing name");
		}
		if (!isJsonString(url) || url.length === 0) {
			throw new Error("convex deployment payload missing url");
		}
		if (!isJsonString(state) || state.length === 0) {
			throw new Error("convex deployment payload missing state");
		}
		return Object.freeze({ name, url, state });
	}

	return {
		live: Boolean(deployKey),
		async listDeployments() {
			const payload = await request("/deployments");
			if (!isJsonArray(payload)) {
				throw new Error("convex deployments payload must be an array");
			}
			return Object.freeze(payload.map(parseDeployment));
		},
		async createDeployment(slug: string) {
			if (!slug.trim()) {
				throw new Error("deployment slug must be non-empty");
			}
			const payload = await request("/deployments", {
				method: "POST",
				body: JSON.stringify({ name: slug.trim() }),
			});
			return parseDeployment(payload);
		},
	};
}

/**
 * Presence-only preflight (deploy-preflight pattern): report whether the
 * Convex lane could go live and what is missing — inspects env-var PRESENCE,
 * never values.
 */
export function describeConvexTarget(env: Record<string, string | undefined>): {
	live: boolean;
	missing: readonly string[];
} {
	const missing = ["CONVEX_DEPLOY_KEY"].filter((name) => !env[name]?.trim());
	return Object.freeze({ live: missing.length === 0, missing });
}
