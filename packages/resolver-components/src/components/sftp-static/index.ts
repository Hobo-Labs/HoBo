// Reference component `sftp-static`: publish static files to an SFTP server
// through an agent-local SFTP bridge endpoint. This is the R2 pattern for
// imperative targets: no shell-script escape hatch, no SSH key in the
// component — the bridge runs beside the agent inside the target boundary,
// holds the SFTP key, and exposes a small HTTPS API; the component reaches it
// only in agent mode, only at its registered loopback address, and the host
// attaches the bridge token from the agent-local credential store.
//
// Bridge API (HTTPS, bearer token attached by the host):
//   GET    /v1/files/<path>          200 + x-hobo-sha256 | 404
//   PUT    /v1/files/<path>          body = file content, x-hobo-sha256
//   DELETE /v1/files/<path>          2xx | 404
//   GET    /v1/files?prefix=<path>   200 JSON [{ "path", "sha256" }]
//   GET    /v1/health                200
//
// Desired state: remotePath (absolute), content (text), digest (sha256:<hex>),
// mode (optional octal string, e.g. "0644").
import {
	defineResolverGuest,
	header,
	ok,
	outcome,
	properties,
	rejected,
	type ResolverGuestImports,
	type WitInstance,
	type WitReadResult,
	type WitResolveOutcome,
	type WitResolveRequest,
	type WitResult,
} from "../../guest/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonText,
} from "../../json.js";

export const SFTP_STATIC_ID = "sftp-static" as const;
export const SFTP_STATIC_VERSION = "0.1.0" as const;
export const SFTP_STATIC_PRODUCT = "sftp/static-file" as const;
export const SFTP_STATIC_SOURCE =
	"hobo:resolver-components/components/sftp-static@0.1.0" as const;
export const SFTP_BRIDGE_DEFAULT_HOST = "sftp-bridge.hobo.local" as const;

const SHA_HEADER = "x-hobo-sha256";

export interface SftpBridgeOptions {
	readonly host?: string;
	readonly port?: string;
	/** Loopback or link-local addresses the bridge listens on. */
	readonly localAddresses?: readonly string[];
}

/** The agent-mode manifest for a bridge reachable at `options`. */
export function sftpStaticManifest(options: SftpBridgeOptions = {}): JsonObject {
	const host = options.host ?? SFTP_BRIDGE_DEFAULT_HOST;
	return {
		schema: "hobo.resolver-components.manifest/v1",
		id: SFTP_STATIC_ID,
		version: SFTP_STATIC_VERSION,
		world: "hobo:resolver/resolver-component@0.1.0",
		providerId: "sftp",
		classes: [
			{
				productId: SFTP_STATIC_PRODUCT,
				slot: "web",
				retainedFields: ["mtime"],
				observeFields: ["mode", "sha256"],
				directives: [],
			},
		],
		egress: [
			{
				host,
				ports: [options.port ?? "8443"],
				pathPrefixes: ["/v1/"],
				localAddresses: [...(options.localAddresses ?? ["127.0.0.1"])],
			},
		],
		credential: { hosts: [host] },
		modes: ["RECONCILER_MODE_RECORD_AGENT"],
	};
}

interface Desired {
	readonly remotePath: string;
	readonly content: string;
	readonly digest: string;
	readonly mode: string;
}

function desiredOf(request: WitResolveRequest): Desired | string {
	const bag = properties(request.desiredJson);
	const remotePath = bag.remotePath;
	const content = bag.content;
	const digest = bag.digest;
	if (!isJsonString(remotePath) || !remotePath.startsWith("/") || remotePath.includes(".."))
		return "remotePath must be an absolute path without ..";
	if (!isJsonString(content)) return "content must be a string";
	if (!isJsonString(digest) || !/^sha256:[0-9a-f]{64}$/u.test(digest))
		return "digest must be sha256:<64 hex>";
	const mode = isJsonString(bag.mode) ? bag.mode : "0644";
	if (!/^0[0-7]{3}$/u.test(mode)) return "mode must be an octal string such as 0644";
	return { remotePath, content, digest, mode };
}

export function sftpStaticGuest(bridgeBase = `https://${SFTP_BRIDGE_DEFAULT_HOST}:8443`) {
	return defineResolverGuest((host: ResolverGuestImports) => {
		const fileUrl = (path: string) => `${bridgeBase}/v1/files${path.split("/").map(encodeURIComponent).join("/")}`;

		const stat = async (desired: Desired, credentialRef: string) =>
			host.authorizedFetch(
				{ method: "GET", url: fileUrl(desired.remotePath), headers: [], body: null },
				credentialRef,
			);

		const reconcile = async (request: WitResolveRequest): Promise<WitResult<WitResolveOutcome>> => {
			const desired = desiredOf(request);
			if (isJsonString(desired)) return rejected(desired);
			const current = await stat(desired, request.credentialRef);
			if ("err" in current) return rejected(`bridge denied: ${current.err.val}`);
			if (current.ok.status !== 404 && current.ok.status >= 300)
				return rejected(`bridge answered ${current.ok.status}`);
			const existing = current.ok.status === 404 ? undefined : header(current.ok, SHA_HEADER);
			let action: "create" | "update" | "noop" | "adopt";
			if (existing === desired.digest) {
				action = request.ref.physicalId === null ? "adopt" : "noop";
			} else {
				const put = await host.authorizedFetch(
					{
						method: "PUT",
						url: fileUrl(desired.remotePath),
						headers: [
							[SHA_HEADER, desired.digest],
							["x-hobo-file-mode", desired.mode],
						],
						body: desired.content,
					},
					request.credentialRef,
				);
				if ("err" in put) return rejected(`bridge denied: ${put.err.val}`);
				if (put.ok.status < 200 || put.ok.status >= 300) return rejected(`bridge answered ${put.ok.status}`);
				action = existing === undefined ? "create" : "update";
			}
			return ok(outcome(action, `sftp:${desired.remotePath}`, { path: desired.remotePath, sha256: desired.digest }));
		};

		const read = async (request: WitResolveRequest): Promise<WitResult<WitReadResult | null>> => {
			const desired = desiredOf(request);
			if (isJsonString(desired)) return rejected(desired);
			const current = await stat(desired, request.credentialRef);
			if ("err" in current) return rejected(`bridge denied: ${current.err.val}`);
			if (current.ok.status === 404) return ok(null);
			if (current.ok.status >= 300) return rejected(`bridge answered ${current.ok.status}`);
			const sha256 = header(current.ok, SHA_HEADER) ?? "";
			const mode = header(current.ok, "x-hobo-file-mode") ?? "";
			const outputs: Record<string, string> = { path: desired.remotePath, sha256 };
			const mtime = header(current.ok, "last-modified");
			if (mtime !== undefined) outputs.mtime = mtime;
			return ok({
				outcome: outcome("noop", `sftp:${desired.remotePath}`, outputs),
				attributes: [
					["mode", mode],
					["sha256", sha256],
				],
			});
		};

		const remove = async (request: WitResolveRequest): Promise<WitResult<null>> => {
			const desired = desiredOf(request);
			if (isJsonString(desired)) return rejected(desired);
			const result = await host.authorizedFetch(
				{ method: "DELETE", url: fileUrl(desired.remotePath), headers: [], body: null },
				request.credentialRef,
			);
			if ("err" in result) return rejected(`bridge denied: ${result.err.val}`);
			if (result.ok.status === 404 || (result.ok.status >= 200 && result.ok.status < 300)) return ok(null);
			return rejected(`bridge answered ${result.ok.status}`);
		};

		const instances = async (_productId: string, credentialRef: string): Promise<WitResult<readonly WitInstance[]>> => {
			const result = await host.authorizedFetch(
				{ method: "GET", url: `${bridgeBase}/v1/files?prefix=%2F`, headers: [["accept", "application/json"]], body: null },
				credentialRef,
			);
			if ("err" in result) return rejected(`bridge denied: ${result.err.val}`);
			if (result.ok.status !== 200) return rejected(`bridge answered ${result.ok.status}`);
			let listed: JsonValue;
			try {
				listed = parseJsonText(result.ok.body);
			} catch {
				return rejected("bridge listing is not JSON");
			}
			if (!isJsonArray(listed)) return rejected("bridge listing is not a JSON array");
			const out: WitInstance[] = [];
			for (const entry of listed) {
				if (isJsonObject(entry) && isJsonString(entry.path))
					out.push({ logicalId: entry.path.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^_+/u, "") || "root", physicalId: `sftp:${entry.path}` });
			}
			return ok(out.sort((left, right) => (left.physicalId < right.physicalId ? -1 : 1)));
		};

		return {
			describe: async () => ({
				componentId: SFTP_STATIC_ID,
				version: SFTP_STATIC_VERSION,
				classes: [
					{
						productId: SFTP_STATIC_PRODUCT,
						slot: "web",
						retainedFields: ["mtime"],
						observeFields: ["mode", "sha256"],
						directives: [],
					},
				],
			}),
			reconcile,
			read,
			delete: remove,
			instances,
		};
	});
}
