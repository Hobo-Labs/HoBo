import { createHash } from "node:crypto";
import { parseSecretRef } from "@hobo/bindings";
import {
	createResolverRegistry,
	guardTransport,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceMutationJournal,
	type ResourceResolver,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";
import { NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID } from "./definitions.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
	parseJsonValue,
} from "./json.js";

// public-contract: immutable static deployments are separate from the owning site.
export const NETLIFY_STATIC_DEPLOY_PRODUCT_ID = "netlify.static-deploy/v1";
export const NETLIFY_RESOLVED_PRODUCT_IDS = Object.freeze([
	NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID,
	NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
]);

/** Explicit account identity and a host-owned durable mutation journal. */
export type NetlifyResolverOptions = {
	readonly accountId: string;
	readonly accountSlug: string;
	readonly resolveCredential: (ref: string) => Promise<string>;
	readonly mutationJournal?: ResourceMutationJournal;
	/** Credential-free reads from the immutable public deployment origin. */
	readonly artifactTransport?: HttpTransport;
	readonly maxArtifactBytes?: number;
	readonly maxArtifactFiles?: number;
};

const ORIGIN = "https://api.netlify.com/api/v1";
const MAX_PAGES = 25;
const PAGE_SIZE = 100;

function refuse(message: string): never {
	throw new ResolverError("RESOLVER_PRODUCT_UNSUPPORTED", message);
}
function field(record: JsonObject, name: string): string {
	const value = record[name];
	if (!isJsonString(value) || value.length === 0)
		refuse(`netlify requires ${name}`);
	return value;
}
function identifier(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
		refuse("netlify requires a plain resource identifier");
	return value;
}
function object(response: TransportResponse): JsonObject {
	const parsed = parseJsonValue(response.body);
	if (!isJsonObject(parsed))
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"netlify returned an invalid object response",
		);
	return parsed;
}
function result(
	action: ResolveOutcome["action"],
	id: string,
	outputs: JsonObject,
): ResolveOutcome {
	return {
		contract: RESOLVER_CONTRACT,
		action,
		physicalId: id,
		outputs,
		diagnostics: [],
	};
}
function status(
	response: TransportResponse,
	expected: readonly number[],
): void {
	if (!expected.includes(response.status))
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`netlify API refused the call with HTTP ${response.status}`,
		);
}
function parsed(request: ResolveRequest, productId: string): ResolveRequest {
	const value = parseResolveRequest(parseJsonObject(JSON.stringify(request)));
	if (value.ref.productId !== productId)
		refuse(
			"netlify resolver product identity differs from the requested product",
		);
	return value;
}
function scopedSite(
	record: JsonObject,
	options: NetlifyResolverOptions,
	expectedId?: string,
): JsonObject {
	const id = field(record, "id");
	if (expectedId !== undefined && id !== expectedId)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"netlify returned a different site identity",
		);
	if (record.account_id !== options.accountId)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"netlify site belongs to a different owning account",
		);
	const outputs = {
		id,
		name: field(record, "name"),
		accountId: options.accountId,
		...(isJsonString(record.ssl_url) ? { url: record.ssl_url } : undefined),
	};
	if (isJsonObject(record.published_deploy)) {
		return {
			...outputs,
			deployId: field(record.published_deploy, "id"),
			deployState: field(record.published_deploy, "state"),
			ready: record.published_deploy.state === "ready",
		};
	}
	return { ...outputs, ready: false };
}

async function caller(
	options: NetlifyResolverOptions,
	request: ResolveRequest,
	transport: HttpTransport,
) {
	let token: string;
	try {
		parseSecretRef(request.credentialRef);
	} catch {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"netlify credential must be a scoped custody locator",
		);
	}
	try {
		token = await options.resolveCredential(request.credentialRef);
	} catch {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"netlify credential custody could not resolve the scoped reference",
		);
	}
	if (!token.trim())
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"netlify credential custody returned no material",
		);
	const dispatch = guardTransport(transport, {
		allowedHosts: ["api.netlify.com"],
		allowedPathPrefixes: ["/api/v1/"],
		maxTimeoutMs: 15000,
		maxResponseBytes: 524288,
	});
	return async (
		method: TransportMethod,
		path: string,
		body?: string,
		contentType = "application/json",
	): Promise<TransportResponse> => {
		const outbound = {
			method,
			url: `${ORIGIN}${path}`,
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json",
				"content-type": contentType,
			},
			timeoutMs: 15000,
			maxResponseBytes: 524288,
			...(body === undefined ? undefined : { body }),
		};
		if (method === "POST") {
			if (path === `/${encodeURIComponent(options.accountSlug)}/sites`) {
				const accounts = await dispatch({
					method: "GET",
					url: `${ORIGIN}/accounts`,
					headers: outbound.headers,
					timeoutMs: outbound.timeoutMs,
					maxResponseBytes: outbound.maxResponseBytes,
				});
				status(accounts, [200]);
				const records = parseJsonValue(accounts.body);
				if (
					!isJsonArray(records) ||
					records.filter(
						(record) =>
							isJsonObject(record) &&
							record.id === options.accountId &&
							record.slug === options.accountSlug,
					).length !== 1
				)
					throw new ResolverError(
						"RESOLVER_OUTPUT_UNPARSEABLE",
						"netlify account slug does not identify the approved native account",
					);
			}
			if (options.mutationJournal?.persistence !== "durable-cas")
				refuse(
					"netlify create requires a durable mutation journal before allocating billable resources",
				);
			const operationId = field(request.desired, "operationId");
			const mutationId = JSON.stringify([
				"netlify",
				options.accountId,
				request.ref.productId,
				operationId,
				path,
			]);
			const requestDigest = `sha256:${createHash("sha256")
				.update(JSON.stringify({ method, path, body: body ?? "" }))
				.digest("hex")}`;
			const claim = await options.mutationJournal.claim({
				mutationId,
				requestDigest,
			});
			if (claim.status !== "claimed")
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					"netlify create already attempted; observe its existing result instead of issuing another POST",
				);
			try {
				const response = await dispatch(outbound);
				if (response.status < 200 || response.status >= 300) {
					await options.mutationJournal.uncertain(mutationId, requestDigest);
					return response;
				}
				await options.mutationJournal.acknowledge(mutationId, requestDigest);
				return response;
			} catch (error) {
				await options.mutationJournal.uncertain(mutationId, requestDigest);
				throw error;
			}
		}
		return dispatch(outbound);
	};
}

function createSiteResolver(options: NetlifyResolverOptions): ResourceResolver {
	const staticDeploy = createStaticDeployResolver(options);
	const withArtifact = async (
		site: JsonObject,
		request: ResolveRequest,
		transport: HttpTransport,
		reconcile: boolean,
	): Promise<JsonObject> => {
		if (request.desired.files === undefined) return site;
		const child: ResolveRequest = {
			ref: {
				slot: "web",
				productId: NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
				logicalId: request.ref.logicalId,
			},
			desired: {
				siteId: field(site, "id"),
				files: request.desired.files,
				operationId: field(request.desired, "operationId"),
			},
			credentialRef: request.credentialRef,
		};
		const deployment = reconcile
			? await staticDeploy.reconcile(child, transport)
			: await staticDeploy.read?.(child, transport);
		if (!deployment)
			return { ...site, ready: false, operationConfirmed: false };
		return {
			...site,
			...deployment.outputs,
			id: field(site, "id"),
			siteId: field(site, "id"),
			deployId: deployment.physicalId,
		};
	};
	const name = (request: ResolveRequest) => {
		const value = isJsonString(request.desired.name)
			? request.desired.name
			: request.ref.logicalId;
		if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value))
			refuse("netlify site name must be a stable lowercase DNS label");
		return value;
	};
	const observe = async (request: ResolveRequest, transport: HttpTransport) => {
		const send = await caller(options, request, transport);
		if (request.ref.physicalId) {
			const response = await send(
				"GET",
				`/sites/${encodeURIComponent(identifier(request.ref.physicalId))}`,
			);
			if (response.status === 404 || response.status === 410) return undefined;
			status(response, [200]);
			return scopedSite(object(response), options, request.ref.physicalId);
		}
		const desiredName = name(request);
		const matches: JsonObject[] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const response = await send(
				"GET",
				`/${encodeURIComponent(options.accountSlug)}/sites?name=${encodeURIComponent(desiredName)}&page=${page}&per_page=${PAGE_SIZE}`,
			);
			status(response, [200]);
			const records = parseJsonValue(response.body);
			if (!isJsonArray(records))
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"netlify list sites returned a non-array",
				);
			for (const record of records) {
				if (!isJsonObject(record))
					throw new ResolverError(
						"RESOLVER_OUTPUT_UNPARSEABLE",
						"netlify list sites returned an invalid record",
					);
				if (record.name === desiredName)
					matches.push(scopedSite(record, options));
			}
			if (records.length < PAGE_SIZE) {
				if (matches.length > 1)
					throw new ResolverError(
						"RESOLVER_OUTPUT_UNPARSEABLE",
						"netlify returned ambiguous duplicate site names",
					);
				return matches[0];
			}
		}
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"netlify site listing exceeded its bounded pagination window",
		);
	};
	return {
		providerId: "netlify",
		productId: NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID,
		async read(raw, transport) {
			const request = parsed(raw, NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID);
			const found = await observe(request, transport);
			return found
				? result(
						"noop",
						field(found, "id"),
						await withArtifact(found, request, transport, false),
					)
				: undefined;
		},
		async reconcile(raw, transport) {
			const request = parsed(raw, NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID);
			const found = await observe(request, transport);
			if (found)
				return result(
					request.ref.physicalId ? "noop" : "adopt",
					field(found, "id"),
					await withArtifact(found, request, transport, true),
				);
			if (request.ref.physicalId)
				refuse(
					"netlify known site is absent; allocating a replacement needs a new approved intent",
				);
			const send = await caller(options, request, transport);
			const response = await send(
				"POST",
				`/${encodeURIComponent(options.accountSlug)}/sites`,
				JSON.stringify({ name: name(request) }),
			);
			status(response, [201]);
			const created = scopedSite(object(response), options);
			if (created.name !== name(request))
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"netlify created a different site name",
				);
			return result(
				"create",
				field(created, "id"),
				await withArtifact(created, request, transport, true),
			);
		},
		async delete(raw, transport) {
			const request = parsed(raw, NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID);
			const found = await observe(request, transport);
			if (!found) return;
			const send = await caller(options, request, transport);
			status(
				await send(
					"DELETE",
					`/sites/${encodeURIComponent(field(found, "id"))}`,
				),
				[204, 404, 410],
			);
			// Acknowledge only. read() must independently return absence before retirement.
		},
	};
}

function createStaticDeployResolver(
	options: NetlifyResolverOptions,
): ResourceResolver {
	const siteId = (request: ResolveRequest) =>
		identifier(field(request.desired, "siteId"));
	const filesOf = (request: ResolveRequest) => {
		const files = request.desired.files;
		if (
			!isJsonObject(files) ||
			!Object.keys(files).length ||
			Object.keys(files).length > (options.maxArtifactFiles ?? 256)
		)
			refuse(
				"netlify static deploy requires a nonempty bounded UTF-8 file map",
			);
		let bytes = 0;
		return Object.fromEntries(
			Object.keys(files)
				.sort()
				.map((path) => {
					const content = files[path];
					if (
						!isJsonString(content) ||
						!path.startsWith("/") ||
						path.includes("..") ||
						path.includes("//") ||
						path.includes("\\") ||
						path.length > 512
					)
						refuse(
							"netlify static files require safe absolute paths and UTF-8 text content",
						);
					bytes += Buffer.byteLength(content, "utf8");
					if (bytes > (options.maxArtifactBytes ?? 1_048_576))
						refuse(
							"netlify static artifact exceeds the approved transport byte bound",
						);
					return [path, content] as const;
				}),
		);
	};
	const observeArtifact = async (
		record: JsonObject,
		request: ResolveRequest,
		transport: HttpTransport,
	) => {
		const url = new URL(field(record, "deploy_ssl_url"));
		if (
			url.protocol !== "https:" ||
			!url.hostname.endsWith(".netlify.app") ||
			url.username ||
			url.password ||
			url.port ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"netlify deployment artifact URL is outside its HTTPS hosting authority",
			);
		const read = guardTransport(options.artifactTransport ?? transport, {
			allowedHosts: [url.hostname],
			allowedPathPrefixes: ["/"],
			maxTimeoutMs: 15000,
			maxResponseBytes: options.maxArtifactBytes ?? 1_048_576,
		});
		const actual: (readonly [string, string])[] = [];
		let remaining = options.maxArtifactBytes ?? 1_048_576;
		for (const path of Object.keys(filesOf(request)).sort()) {
			if (remaining <= 0)
				refuse(
					"netlify independent artifact observation exhausted its aggregate byte bound",
				);
			const encoded = path.split("/").map(encodeURIComponent).join("/");
			const response = await read({
				method: "GET",
				url: `${url.origin}${encoded}`,
				headers: { accept: "*/*" },
				timeoutMs: 15000,
				maxResponseBytes: remaining,
			});
			status(response, [200]);
			remaining -= Buffer.byteLength(response.body, "utf8");
			actual.push([path, response.body]);
		}
		return {
			artifactDigest: `sha256:${createHash("sha256")
				.update(JSON.stringify(Object.fromEntries(actual)))
				.digest("hex")}`,
			servingEndpoint: url.origin,
		};
	};
	const artifactTitle = (request: ResolveRequest) =>
		`hobo:${createHash("sha256")
			.update(
				JSON.stringify([
					field(request.desired, "operationId"),
					request.desired.files,
				]),
			)
			.digest("hex")}`;
	const observe = async (
		request: ResolveRequest,
		transport: HttpTransport,
		verifyArtifact = true,
	): Promise<JsonObject | undefined> => {
		const send = await caller(options, request, transport);
		const site = await send(
			"GET",
			`/sites/${encodeURIComponent(siteId(request))}`,
		);
		status(site, [200]);
		scopedSite(object(site), options, siteId(request));
		let physicalId = request.ref.physicalId;
		if (!physicalId) {
			const matches: string[] = [];
			for (let page = 1; page <= MAX_PAGES; page++) {
				const response = await send(
					"GET",
					`/sites/${encodeURIComponent(siteId(request))}/deploys?page=${page}&per_page=${PAGE_SIZE}`,
				);
				status(response, [200]);
				const records = parseJsonValue(response.body);
				if (!isJsonArray(records))
					throw new ResolverError(
						"RESOLVER_OUTPUT_UNPARSEABLE",
						"netlify returned an invalid deployment list",
					);
				for (const record of records) {
					if (!isJsonObject(record))
						throw new ResolverError(
							"RESOLVER_OUTPUT_UNPARSEABLE",
							"netlify returned an invalid deployment record",
						);
					if (
						record.title === artifactTitle(request) &&
						record.site_id === siteId(request)
					)
						matches.push(field(record, "id"));
				}
				if (records.length < PAGE_SIZE) {
					if (matches.length > 1)
						throw new ResolverError(
							"RESOLVER_OUTPUT_UNPARSEABLE",
							"multiple netlify deployments claim the same immutable operation; retain liabilities and reconcile",
						);
					physicalId = matches[0];
					break;
				}
				if (page === MAX_PAGES)
					throw new ResolverError(
						"RESOLVER_OUTPUT_UNPARSEABLE",
						"netlify deployment discovery exceeded its pagination bound",
					);
			}
			if (!physicalId) return undefined;
		}
		const response = await send(
			"GET",
			`/deploys/${encodeURIComponent(identifier(physicalId))}`,
		);
		if (response.status === 404 || response.status === 410) return undefined;
		status(response, [200]);
		const record = object(response);
		if (record.id !== physicalId || record.site_id !== siteId(request))
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"netlify deployment identity or site scope differs from the approved resource",
			);
		if (record.title !== artifactTitle(request))
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"netlify deployment artifact does not match the approved operation",
			);
		const outputs = {
			id: field(record, "id"),
			siteId: siteId(request),
			state: field(record, "state"),
			ready: record.state === "ready",
			operationConfirmed: record.state === "ready" || record.state === "error",
			lifecycleStatus:
				record.state === "error"
					? "failed"
					: record.state === "ready"
						? "ready"
						: "pending",
			requiredFiles: record.required ?? [],
			...(isJsonString(record.deploy_ssl_url)
				? { url: record.deploy_ssl_url }
				: undefined),
			...(isJsonString(record.title)
				? { operationId: record.title }
				: undefined),
		};
		if (record.state === "ready" && verifyArtifact)
			return {
				...outputs,
				...(await observeArtifact(record, request, transport)),
			};
		return outputs;
	};
	const resume = async (
		request: ResolveRequest,
		found: JsonObject,
		transport: HttpTransport,
	) => {
		const required = found.requiredFiles;
		if (!isJsonArray(required) || !required.every(isJsonString))
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"netlify returned an invalid required file list",
			);
		if (!required.length) return found;
		const files = filesOf(request),
			hashes = Object.fromEntries(
				Object.entries(files).map(
					([path, content]) =>
						[path, createHash("sha1").update(content).digest("hex")] as const,
				),
			);
		for (const hash of required)
			if (!Object.values(hashes).includes(hash))
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"netlify requested bytes outside the approved artifact",
				);
		const send = await caller(options, request, transport),
			id = identifier(field(found, "id"));
		for (const [path, content] of Object.entries(files))
			if (required.includes(hashes[path] ?? ""))
				status(
					await send(
						"PUT",
						`/deploys/${encodeURIComponent(id)}/files/${path.slice(1).split("/").map(encodeURIComponent).join("/")}`,
						content,
						"application/octet-stream",
					),
					[200],
				);
		return (
			(await observe(
				{ ...request, ref: { ...request.ref, physicalId: id } },
				transport,
			)) ?? found
		);
	};
	return {
		providerId: "netlify",
		productId: NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
		async read(raw, transport) {
			const request = parsed(raw, NETLIFY_STATIC_DEPLOY_PRODUCT_ID);
			const found = await observe(request, transport);
			return found ? result("noop", field(found, "id"), found) : undefined;
		},
		async reconcile(raw, transport) {
			const request = parsed(raw, NETLIFY_STATIC_DEPLOY_PRODUCT_ID);
			filesOf(request);
			const found = await observe(request, transport);
			if (found) {
				const resumed = await resume(request, found, transport);
				return result(
					request.ref.physicalId ? "noop" : "adopt",
					field(resumed, "id"),
					resumed,
				);
			}
			if (request.ref.physicalId) {
				refuse(
					"netlify known deployment is absent; a fresh deployment requires a new approved intent",
				);
			}
			const files = request.desired.files;
			if (!isJsonObject(files) || Object.keys(files).length === 0)
				refuse("netlify static deploy requires a nonempty UTF-8 file map");
			const hashes = Object.fromEntries(
				Object.entries(files).map(([path, content]) => {
					if (
						!isJsonString(content) ||
						!path.startsWith("/") ||
						path.includes("..") ||
						path.includes("\\") ||
						path.length > 512
					)
						refuse(
							"netlify static files require absolute safe paths and UTF-8 text content",
						);
					return [
						path,
						createHash("sha1").update(content).digest("hex"),
					] as const;
				}),
			);
			const send = await caller(options, request, transport);
			// Verify the site's owning account before uploading any bytes.
			const site = await send(
				"GET",
				`/sites/${encodeURIComponent(siteId(request))}`,
			);
			status(site, [200]);
			scopedSite(object(site), options, siteId(request));
			const title = artifactTitle(request);
			const response = await send(
				"POST",
				`/sites/${encodeURIComponent(siteId(request))}/deploys?title=${encodeURIComponent(title)}`,
				JSON.stringify({ files: hashes, draft: true }),
			);
			status(response, [200]);
			const created = object(response),
				id = identifier(field(created, "id"));
			if (created.site_id !== siteId(request))
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"netlify created a deployment in a different site",
				);
			if (created.required !== undefined && !isJsonArray(created.required))
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"netlify returned an invalid required-file list",
				);
			const required = created.required ?? [];
			if (!isJsonArray(required) || !required.every(isJsonString))
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"netlify returned invalid required file identities",
				);
			for (const hash of required)
				if (!Object.values(hashes).includes(hash))
					throw new ResolverError(
						"RESOLVER_OUTPUT_UNPARSEABLE",
						"netlify requested file bytes outside the approved artifact",
					);
			for (const [path, content] of Object.entries(files))
				if (required.includes(hashes[path] ?? "")) {
					if (!isJsonString(content)) refuse("invalid static file content");
					status(
						await send(
							"PUT",
							`/deploys/${encodeURIComponent(id)}/files/${path.slice(1).split("/").map(encodeURIComponent).join("/")}`,
							content,
							"application/octet-stream",
						),
						[200],
					);
				}
			const observed = await observe(
				{ ...request, ref: { ...request.ref, physicalId: id } },
				transport,
			);
			if (!observed)
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"netlify deployment acknowledgement has no independent readback yet; retain its operation journal and reconcile",
				);
			return result("create", id, observed);
		},
		async delete(raw, transport) {
			const request = parsed(raw, NETLIFY_STATIC_DEPLOY_PRODUCT_ID);
			if (!request.ref.physicalId)
				refuse(
					"netlify deployment deletion requires its observed physical identity",
				);
			if (!(await observe(request, transport, false))) return;
			const send = await caller(options, request, transport);
			status(
				await send(
					"DELETE",
					`/deploys/${encodeURIComponent(identifier(request.ref.physicalId))}`,
				),
				[204, 404, 410],
			);
		},
	};
}

export function netlifyResolvers(
	options: NetlifyResolverOptions,
): readonly ResourceResolver[] {
	identifier(options.accountId);
	identifier(options.accountSlug);
	if (
		!Number.isSafeInteger(options.maxArtifactBytes ?? 1_048_576) ||
		(options.maxArtifactBytes ?? 1_048_576) <= 0 ||
		(options.maxArtifactBytes ?? 1_048_576) > 16_777_216 ||
		!Number.isSafeInteger(options.maxArtifactFiles ?? 256) ||
		(options.maxArtifactFiles ?? 256) <= 0 ||
		(options.maxArtifactFiles ?? 256) > 1024
	)
		refuse("netlify requires bounded artifact limits");
	return Object.freeze([
		createSiteResolver(options),
		createStaticDeployResolver(options),
	]);
}

export function netlifyResolverRegistry(options: NetlifyResolverOptions) {
	return createResolverRegistry(netlifyResolvers(options));
}
