// Reference component `http-artifact-upload`: a generic PUT-to-endpoint
// resolver plus a health probe, which covers many static hosts and
// appliances that accept an authenticated HTTP PUT.
//
// Desired state (realization parameters):
//   uploadUrl       https URL the artifact is PUT to (allowlisted host)
//   artifactDigest  sha256:<hex> of the content
//   content         the artifact body (text)
//   contentType     optional, default application/octet-stream
//   healthUrl       optional https URL probed after upload (unauthenticated)
//   expectedStatus  optional health status, default 200
//
// Convergence: GET the upload URL; if the endpoint reports the same digest
// (`x-hobo-artifact-digest` or a quoted ETag), nothing is written (noop or
// adopt). Otherwise PUT and report create/update. Credentials are attached by
// the host to the upload host only; the health probe goes out without them.
import {
	defineResolverGuest,
	header,
	ok,
	outcome,
	properties,
	rejected,
	unsupported,
	type ResolverGuestImports,
	type WitHttpResponse,
	type WitReadResult,
	type WitResolveOutcome,
	type WitResolveRequest,
	type WitResult,
} from "../../guest/index.js";
import { isJsonNumber, isJsonString, type JsonObject } from "../../json.js";

export const HTTP_ARTIFACT_UPLOAD_ID = "http-artifact-upload" as const;
export const HTTP_ARTIFACT_UPLOAD_VERSION = "0.1.0" as const;
export const HTTP_ARTIFACT_UPLOAD_PRODUCT = "http/artifact-upload" as const;
/** Source identity bound into the component bytes by the build recipe. */
export const HTTP_ARTIFACT_UPLOAD_SOURCE =
	"hobo:resolver-components/components/http-artifact-upload@0.1.0" as const;

const DIGEST_HEADER = "x-hobo-artifact-digest";

export interface HttpUploadHost {
	readonly host: string;
	readonly pathPrefixes?: readonly string[];
	readonly ports?: readonly string[];
	/** Attach the credential to this host (the upload endpoint). */
	readonly credential?: boolean;
}

/** The manifest an operator signs for their upload and health hosts. */
export function httpArtifactUploadManifest(hosts: readonly HttpUploadHost[]): JsonObject {
	return {
		schema: "hobo.resolver-components.manifest/v1",
		id: HTTP_ARTIFACT_UPLOAD_ID,
		version: HTTP_ARTIFACT_UPLOAD_VERSION,
		world: "hobo:resolver/resolver-component@0.1.0",
		providerId: "http",
		classes: [
			{
				productId: HTTP_ARTIFACT_UPLOAD_PRODUCT,
				slot: "web",
				retainedFields: ["lastModified"],
				observeFields: ["cacheControl", "contentType", "digest"],
				directives: [],
			},
		],
		egress: hosts.map((entry) => ({
			host: entry.host,
			pathPrefixes: [...(entry.pathPrefixes ?? ["/"])],
			ports: [...(entry.ports ?? [])],
		})),
		credential: { hosts: hosts.filter((entry) => entry.credential === true).map((entry) => entry.host) },
		modes: ["RECONCILER_MODE_RECORD_CONDUCTOR", "RECONCILER_MODE_RECORD_AGENT"],
	};
}

interface Desired {
	readonly uploadUrl: string;
	readonly artifactDigest: string;
	readonly content: string;
	readonly contentType: string;
	readonly healthUrl: string | undefined;
	readonly expectedStatus: number;
}

function desiredOf(request: WitResolveRequest): Desired | string {
	const bag = properties(request.desiredJson);
	const uploadUrl = bag.uploadUrl;
	const artifactDigest = bag.artifactDigest;
	const content = bag.content;
	if (!isJsonString(uploadUrl) || !uploadUrl.startsWith("https://"))
		return "uploadUrl must be an https URL";
	if (!isJsonString(artifactDigest) || !/^sha256:[0-9a-f]{64}$/u.test(artifactDigest))
		return "artifactDigest must be sha256:<64 hex>";
	if (!isJsonString(content)) return "content must be a string";
	const healthUrl = bag.healthUrl;
	const expectedStatus = bag.expectedStatus;
	return {
		uploadUrl,
		artifactDigest,
		content,
		contentType: isJsonString(bag.contentType) ? bag.contentType : "application/octet-stream",
		healthUrl: isJsonString(healthUrl) ? healthUrl : undefined,
		expectedStatus: isJsonNumber(expectedStatus) ? expectedStatus : 200,
	};
}

function digestOf(response: WitHttpResponse): string | undefined {
	const explicit = header(response, DIGEST_HEADER);
	if (explicit !== undefined) return explicit;
	const etag = header(response, "etag");
	return etag?.replace(/^W\//u, "").replace(/^"|"$/gu, "");
}

export const httpArtifactUploadGuest = defineResolverGuest((host: ResolverGuestImports) => {
	const fetchArtifact = async (url: string, credentialRef: string) => {
		const result = await host.authorizedFetch(
			{ method: "GET", url, headers: [["accept", "*/*"]], body: null },
			credentialRef,
		);
		return result;
	};

	const probe = async (desired: Desired): Promise<string | undefined> => {
		if (desired.healthUrl === undefined) return undefined;
		const result = await host.send({ method: "GET", url: desired.healthUrl, headers: [], body: null });
		if ("err" in result) return `health probe denied: ${result.err.val}`;
		if (result.ok.status !== desired.expectedStatus)
			return `health probe returned ${result.ok.status}, expected ${desired.expectedStatus}`;
		return undefined;
	};

	const reconcile = async (request: WitResolveRequest): Promise<WitResult<WitResolveOutcome>> => {
		const desired = desiredOf(request);
		if (isJsonString(desired)) return rejected(desired);
		const current = await fetchArtifact(desired.uploadUrl, request.credentialRef);
		if ("err" in current) return rejected(`upload endpoint denied: ${current.err.val}`);
		const existing = current.ok.status === 404 ? undefined : digestOf(current.ok);
		if (current.ok.status !== 404 && current.ok.status >= 300)
			return rejected(`upload endpoint answered ${current.ok.status}`);
		let action: "create" | "update" | "noop" | "adopt";
		if (existing === desired.artifactDigest) {
			action = request.ref.physicalId === null ? "adopt" : "noop";
		} else {
			const put = await host.authorizedFetch(
				{
					method: "PUT",
					url: desired.uploadUrl,
					headers: [
						["content-type", desired.contentType],
						[DIGEST_HEADER, desired.artifactDigest],
					],
					body: desired.content,
				},
				request.credentialRef,
			);
			if ("err" in put) return rejected(`upload denied: ${put.err.val}`);
			if (put.ok.status < 200 || put.ok.status >= 300)
				return rejected(`upload answered ${put.ok.status}`);
			action = current.ok.status === 404 ? "create" : "update";
		}
		const unhealthy = await probe(desired);
		if (unhealthy !== undefined) return rejected(unhealthy);
		await host.log("info", `${action} ${desired.uploadUrl}`);
		return ok(
			outcome(action, desired.uploadUrl, {
				digest: desired.artifactDigest,
				url: desired.uploadUrl,
			}),
		);
	};

	const read = async (request: WitResolveRequest): Promise<WitResult<WitReadResult | null>> => {
		const desired = desiredOf(request);
		if (isJsonString(desired)) return rejected(desired);
		const current = await fetchArtifact(desired.uploadUrl, request.credentialRef);
		if ("err" in current) return rejected(`upload endpoint denied: ${current.err.val}`);
		if (current.ok.status === 404) return ok(null);
		if (current.ok.status >= 300) return rejected(`upload endpoint answered ${current.ok.status}`);
		const digest = digestOf(current.ok) ?? "";
		const attributes: [string, string][] = [["digest", digest]];
		const contentType = header(current.ok, "content-type");
		const cacheControl = header(current.ok, "cache-control");
		const lastModified = header(current.ok, "last-modified");
		if (contentType !== undefined) attributes.push(["contentType", contentType]);
		if (cacheControl !== undefined) attributes.push(["cacheControl", cacheControl]);
		const outputs: Record<string, string> = { digest, url: desired.uploadUrl };
		if (lastModified !== undefined) outputs.lastModified = lastModified;
		return ok({ outcome: outcome("noop", desired.uploadUrl, outputs), attributes });
	};

	const remove = async (request: WitResolveRequest): Promise<WitResult<null>> => {
		const desired = desiredOf(request);
		if (isJsonString(desired)) return rejected(desired);
		const result = await host.authorizedFetch(
			{ method: "DELETE", url: desired.uploadUrl, headers: [], body: null },
			request.credentialRef,
		);
		if ("err" in result) return rejected(`delete denied: ${result.err.val}`);
		if (result.ok.status === 404 || (result.ok.status >= 200 && result.ok.status < 300)) return ok(null);
		return rejected(`delete answered ${result.ok.status}`);
	};

	return {
		describe: async () => ({
			componentId: HTTP_ARTIFACT_UPLOAD_ID,
			version: HTTP_ARTIFACT_UPLOAD_VERSION,
			classes: [
				{
					productId: HTTP_ARTIFACT_UPLOAD_PRODUCT,
					slot: "web",
					retainedFields: ["lastModified"],
					observeFields: ["cacheControl", "contentType", "digest"],
					directives: [],
				},
			],
		}),
		reconcile,
		read,
		delete: remove,
		instances: async () =>
			unsupported("http-artifact-upload cannot enumerate an arbitrary endpoint; adopt by read()"),
	};
});
