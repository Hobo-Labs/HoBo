// @hobo/hobo — the REAL Cloudflare Workers Script Upload client (composition/app layer).
//
// This forms the request for Cloudflare's Workers Script Upload endpoint (a
// module Worker upload) and derives the deployed workers.dev URL. It is the SECOND
// cloud actually reachable from HoBo's own pipeline (alongside Vercel): when
// `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` are present, `hobo up` drives
// this against the live API; when absent, compose falls back to Vercel or the
// in-memory Pulumi-backed provider.
//
// Grounded in Cloudflare's REST API — Workers Script Upload (module upload):
//   PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{script_name}
//   Authorization: Bearer <token>
//   Content-Type: multipart/form-data  (boundary set by the transport)
//   body: a `metadata` part ({"main_module":"worker.mjs","compatibility_date":...};
//         type=application/json) + the ESM module part
//         (worker.mjs=@worker.mjs; type=application/javascript+module)
//   (docs: developers.cloudflare.com — Multipart upload metadata; claim-deployments
//    shows the exact `-F 'metadata=…' -F 'worker.mjs=@worker.mjs;…'` upload.)
// The deployed workers.dev URL is derived per the docs:
//   GET https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/subdomain
//   -> result.subdomain; URL = https://<script_name>.<subdomain>.workers.dev
//   (docs: developers.cloudflare.com/api/operations/worker-subdomain-get-subdomain/)
// The per-script workers.dev route is enabled via the script subdomain subresource:
//   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{script_name}/subdomain
//   body: { "enabled": true }
//   (docs: api/resources/workers/subresources/scripts/subresources/subdomain/)
//
// `fetch` is INJECTED so tests exercise the exact request formation against a
// mocked transport with no network. HONEST SCOPE: the live call is credential-
// gated and NOT exercised in this sandbox — only the request formation + response
// parsing are tested (against a mocked fetch).

// The default Workers `compatibility_date`. Fixed (not "today") so the formed
// request is deterministic and reproducible across runs/tests.
import { isJsonString, type JsonValue } from "./json.js";

interface CloudflareFetchInit {
	readonly method?: string;
	readonly headers?: { readonly [header: string]: string };
	readonly body?: FormData | string;
}

const DEFAULT_COMPATIBILITY_DATE = "2025-01-01";
const DEFAULT_MODULE_FILE_NAME = "worker.mjs";
const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

export interface UploadWorkerInput {
	// The Worker script name (Cloudflare `script_name`) — also the workers.dev
	// subdomain label. Must be alphanumeric + dashes to be workers.dev-eligible.
	readonly scriptName: string;
	// The ESM module source (the `export default { fetch }` Worker).
	readonly moduleContent: string;
	// Whether to enable the workers.dev route for the script (default true). When
	// false, no route is enabled and the returned `url` is empty.
	readonly enableSubdomain?: boolean;
	// The module part filename referenced by `main_module` (default "worker.mjs").
	readonly moduleFileName?: string;
	// The Workers `compatibility_date` (default a fixed, reproducible date).
	readonly compatibilityDate?: string;
}

export interface UploadWorkerResult {
	// The deployed workers.dev URL (https://<script>.<subdomain>.workers.dev), or ""
	// when `enableSubdomain` is false / no subdomain could be derived.
	readonly url: string;
	// The uploaded script name (Cloudflare `script_name`).
	readonly scriptName: string;
}

// The minimal fetch surface this client depends on — a subset of the WHATWG
// `fetch`. Injecting this (rather than the global) keeps the client testable with
// a mock transport. `body` is a multipart `FormData` (the module upload) or a JSON
// string (the subdomain-enable call).
export interface CloudflareFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
	json(): Promise<JsonValue>;
}

export type CloudflareFetch = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body?: FormData | string;
	},
) => Promise<CloudflareFetchResponse>;

export interface CloudflareClientOptions {
	// The Cloudflare API token, sent as `Authorization: Bearer <token>`.
	readonly token: string;
	// The Cloudflare account id (Cloudflare `account_id` path segment).
	readonly accountId: string;
	// The transport. Defaults to the global `fetch`; injected in tests.
	readonly fetch?: CloudflareFetch;
	// The API base URL. Defaults to https://api.cloudflare.com/client/v4.
	readonly baseUrl?: string;
}

export interface CloudflareClient {
	deleteWorker(scriptName: string): Promise<void>;
	uploadWorker(input: UploadWorkerInput): Promise<UploadWorkerResult>;
	// Whether a Worker script of this name currently exists on the account. GETs
	//   GET /accounts/{account_id}/workers/scripts/{script_name}
	// returning true on 2xx and false on 404. Used by the deploy provider's
	// `refresh` to detect an out-of-band delete (drift). Non-404 errors throw.
	scriptExists(scriptName: string): Promise<boolean>;
}

// The global `fetch` presented through the injectable `CloudflareFetch` shape.
// Node 18+ and modern runtimes expose a global `fetch`; we adapt it without
// importing DOM lib types.
const globalFetch: CloudflareFetch = (url, init) => {
	const fetchImpl =
		// SAFETY: assertion required at this I/O or test boundary.
		(
			globalThis as {
				fetch?: (
					input: string,
					init: CloudflareFetchInit,
				) => Promise<CloudflareFetchResponse>;
			}
		).fetch;
	if (!(fetchImpl instanceof Function)) {
		throw new Error(
			"cloudflare-client: no global fetch available; inject one via createCloudflareClient({ fetch })",
		);
	}
	return fetchImpl(url, init);
};

async function assertOk(
	response: CloudflareFetchResponse,
	what: string,
): Promise<void> {
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`cloudflare-client: ${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
}

// Create the REAL Cloudflare Workers client. No network call happens at
// construction; the request is formed and sent only on `uploadWorker`.
export function createCloudflareClient(
	options: CloudflareClientOptions,
): CloudflareClient {
	const { token, accountId } = options;
	if (!token) {
		throw new TypeError("createCloudflareClient: token is required");
	}
	if (!accountId) {
		throw new TypeError("createCloudflareClient: accountId is required");
	}
	const fetchImpl = options.fetch ?? globalFetch;
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	const accountBase = `${baseUrl}/accounts/${encodeURIComponent(accountId)}`;

	return {
		async uploadWorker(input: UploadWorkerInput): Promise<UploadWorkerResult> {
			const moduleFileName = input.moduleFileName ?? DEFAULT_MODULE_FILE_NAME;
			const compatibilityDate =
				input.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;
			const enableSubdomain = input.enableSubdomain ?? true;

			// --- 1) Module upload (multipart/form-data) --------------------------
			// The metadata part names the ESM `main_module`; the module part carries
			// the script bytes as an application/javascript+module file. The transport
			// sets the multipart Content-Type + boundary, so we only send Authorization.
			const metadata = {
				main_module: moduleFileName,
				compatibility_date: compatibilityDate,
			};
			const form = new FormData();
			form.append(
				"metadata",
				new Blob([JSON.stringify(metadata)], { type: "application/json" }),
			);
			form.append(
				moduleFileName,
				new Blob([input.moduleContent], {
					type: "application/javascript+module",
				}),
				moduleFileName,
			);

			const uploadResponse = await fetchImpl(
				`${accountBase}/workers/scripts/${encodeURIComponent(input.scriptName)}`,
				{
					method: "PUT",
					headers: { Authorization: `Bearer ${token}` },
					body: form,
				},
			);
			await assertOk(uploadResponse, "upload worker");

			if (!enableSubdomain) {
				return { url: "", scriptName: input.scriptName };
			}

			// --- 2) Enable the workers.dev route for this script -----------------
			const enableResponse = await fetchImpl(
				`${accountBase}/workers/scripts/${encodeURIComponent(input.scriptName)}/subdomain`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ enabled: true }),
				},
			);
			await assertOk(enableResponse, "enable workers.dev subdomain");

			// --- 3) Derive the deployed URL from the account subdomain -----------
			const subdomainResponse = await fetchImpl(
				`${accountBase}/workers/subdomain`,
				{ method: "GET", headers: { Authorization: `Bearer ${token}` } },
			);
			await assertOk(subdomainResponse, "get account subdomain");
			// SAFETY: assertion required at this I/O or test boundary.
			const parsed = (await subdomainResponse.json()) as {
				result?: { subdomain?: unknown };
			};
			const subdomain = isJsonString(parsed.result?.subdomain)
				? parsed.result.subdomain
				: "";
			const url =
				subdomain.length > 0
					? `https://${input.scriptName}.${subdomain}.workers.dev`
					: "";
			return { url, scriptName: input.scriptName };
		},
		async deleteWorker(scriptName: string): Promise<void> {
			const path = `${accountBase}/workers/scripts/${encodeURIComponent(scriptName)}`;
			const response = await fetchImpl(path, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});
			if (response.status !== 404)
				await assertOk(response, "delete worker script");
			const observed = await fetchImpl(path, {
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
			});
			if (observed.status !== 404) {
				await assertOk(observed, "confirm worker deletion");
				throw new Error(
					"cloudflare-client: worker deletion remains unconfirmed",
				);
			}
		},
		async scriptExists(scriptName: string): Promise<boolean> {
			const response = await fetchImpl(
				`${accountBase}/workers/scripts/${encodeURIComponent(scriptName)}`,
				{ method: "GET", headers: { Authorization: `Bearer ${token}` } },
			);
			if (response.ok) {
				return true;
			}
			if (response.status === 404) {
				return false;
			}
			await assertOk(response, "get worker script");
			return false;
		},
	};
}
