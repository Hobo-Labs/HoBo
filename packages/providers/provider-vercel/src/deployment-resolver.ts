import { createHash } from "node:crypto";
import { parseSecretRef } from "@hobo/bindings";
import {
	guardTransport,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
	parseJsonValue,
} from "./json.js";
import type { VercelResolverOptions } from "./resolvers.js";

/** Immutable preview deployment, kept separate from mutable project settings. */
// public-contract: static deployment product identity shared by the native resolver registry and Yard bindings.
export const VERCEL_STATIC_DEPLOY_PRODUCT_ID = "vercel.static-deploy/v1";
const API = "https://api.vercel.com";
const PAGE_LIMIT = 25;
function refuse(message: string): never {
	throw new ResolverError("RESOLVER_PRODUCT_UNSUPPORTED", message);
}
function invalid(message: string): never {
	throw new ResolverError("RESOLVER_OUTPUT_UNPARSEABLE", message);
}
function field(record: JsonObject, name: string): string {
	const value = record[name];
	if (!isJsonString(value) || !value)
		refuse(`vercel static deployment requires ${name}`);
	return value;
}
function identifier(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value))
		refuse("vercel requires a plain scoped identity");
	return value;
}
function object(response: TransportResponse): JsonObject {
	const value = parseJsonValue(response.body);
	if (!isJsonObject(value))
		invalid("vercel returned an invalid deployment object");
	return value;
}
function check(response: TransportResponse, statuses: readonly number[]): void {
	if (!statuses.includes(response.status))
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`vercel deployment API returned HTTP ${response.status}`,
		);
}
function parse(request: ResolveRequest): ResolveRequest {
	const value = parseResolveRequest(parseJsonObject(JSON.stringify(request)));
	if (value.ref.productId !== VERCEL_STATIC_DEPLOY_PRODUCT_ID)
		refuse("vercel deployment resolver product differs from request");
	return value;
}
function outcome(
	action: "noop" | "create" | "adopt",
	outputs: JsonObject,
): ResolveOutcome {
	return {
		contract: RESOLVER_CONTRACT,
		action,
		physicalId: field(outputs, "id"),
		outputs,
		diagnostics: [],
	};
}

/** POST is claimed once; a lost response is recovered by bounded metadata discovery. */
export function createVercelStaticDeploymentResolver(
	options: VercelResolverOptions,
): ResourceResolver {
	const maxBytes = options.maxArtifactBytes ?? 2_097_152,
		maxFiles = options.maxArtifactFiles ?? 128;
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes <= 0 ||
		maxBytes > 16_777_216 ||
		!Number.isSafeInteger(maxFiles) ||
		maxFiles <= 0 ||
		maxFiles > 1024
	)
		refuse("vercel static deployment requires bounded artifact limits");
	const filesOf = (request: ResolveRequest) => {
		const value = request.desired.files;
		if (
			!isJsonObject(value) ||
			!Object.keys(value).length ||
			Object.keys(value).length > maxFiles
		)
			refuse(
				"vercel static deployment requires a bounded nonempty UTF-8 file map",
			);
		let bytes = 0;
		const files: Record<string, string> = {};
		for (const path of Object.keys(value).sort()) {
			const content = value[path];
			if (
				!isJsonString(content) ||
				!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(path) ||
				path.split("/").some((part) => part === "." || part === "..") ||
				path.length > 512
			)
				refuse("vercel static deployment requires safe absolute file paths");
			if (
				["package.json", "vercel.json", "netlify.toml"].includes(
					path.slice(1),
				) ||
				path.startsWith("/.vercel/") ||
				path.startsWith("/api/")
			)
				refuse(
					"vercel static deployment refuses executable configuration and function sources",
				);
			bytes += Buffer.byteLength(content, "utf8");
			if (bytes > maxBytes)
				refuse("vercel artifact exceeds its aggregate byte bound");
			files[path] = content;
		}
		return files;
	};
	const marker = (request: ResolveRequest) =>
		`sha256:${createHash("sha256")
			.update(
				JSON.stringify([
					field(request.desired, "operationId"),
					filesOf(request),
				]),
			)
			.digest("hex")}`;
	const projectId = (request: ResolveRequest) =>
		identifier(field(request.desired, "projectId"));
	const query = (params: Record<string, string> = {}) => {
		const q = new URLSearchParams(params);
		if (options.teamId) q.set("teamId", identifier(options.teamId));
		return q.size ? `?${q}` : "";
	};
	const caller = async (request: ResolveRequest, transport: HttpTransport) => {
		let token: string;
		try {
			parseSecretRef(request.credentialRef);
		} catch {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_NOT_A_REF",
				"vercel credential must be a scoped custody locator",
			);
		}
		try {
			token = await options.resolveCredential(request.credentialRef);
		} catch {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"vercel credential custody could not resolve the scoped reference",
			);
		}
		if (!token.trim())
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"vercel credential custody returned no material",
			);
		const dispatch = guardTransport(transport, {
			allowedHosts: ["api.vercel.com"],
			allowedPathPrefixes: [
				"/v9/projects/",
				"/v13/deployments",
				"/v7/deployments",
			],
			maxTimeoutMs: 15000,
			maxResponseBytes: 524288,
		});
		return async (method: TransportMethod, path: string, body?: JsonObject) => {
			const serialized = body === undefined ? undefined : JSON.stringify(body);
			const outbound = {
				method,
				url: API + path,
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json",
					...(body ? { "content-type": "application/json" } : undefined),
				},
				timeoutMs: 15000,
				maxResponseBytes: 524288,
				...(serialized === undefined ? undefined : { body: serialized }),
			};
			if (method !== "POST") return dispatch(outbound);
			const journal = options.mutationJournal;
			if (journal?.persistence !== "durable-cas")
				refuse(
					"vercel immutable deployment creation requires a durable mutation journal",
				);
			const mutationId = JSON.stringify([
				"vercel",
				options.teamId ?? "personal",
				projectId(request),
				field(request.desired, "operationId"),
			]);
			const requestDigest = `sha256:${createHash("sha256")
				.update(JSON.stringify({ url: outbound.url, body: serialized }))
				.digest("hex")}`;
			if (
				(await journal.claim({ mutationId, requestDigest })).status !==
				"claimed"
			)
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					"vercel deployment was already attempted; reconcile its existing result instead of repeating POST",
				);
			try {
				const response = await dispatch(outbound);
				if (response.status >= 200 && response.status < 300)
					await journal.acknowledge(mutationId, requestDigest);
				else await journal.uncertain(mutationId, requestDigest);
				return response;
			} catch (error) {
				await journal.uncertain(mutationId, requestDigest);
				throw error;
			}
		};
	};
	const verifyProject = async (
		request: ResolveRequest,
		send: Awaited<ReturnType<typeof caller>>,
		creation = false,
	) => {
		const response = await send(
			"GET",
			`/v9/projects/${encodeURIComponent(projectId(request))}${query()}`,
		);
		check(response, [200]);
		const record = object(response);
		if (
			record.id !== projectId(request) ||
			(options.teamId !== undefined && record.accountId !== options.teamId)
		)
			invalid(
				"vercel project identity or owning account differs from the approved scope",
			);
		if (
			creation &&
			(record.framework !== null ||
				["buildCommand", "installCommand", "rootDirectory"].some(
					(key) =>
						record[key] !== undefined &&
						record[key] !== null &&
						record[key] !== "",
				) ||
				(record.outputDirectory !== undefined &&
					record.outputDirectory !== null &&
					record.outputDirectory !== "." &&
					record.outputDirectory !== ""))
		)
			refuse(
				"vercel static deployment requires a verified static project without build, install, or root overrides",
			);
	};
	const digest = async (
		record: JsonObject,
		request: ResolveRequest,
		transport: HttpTransport,
	) => {
		const raw = field(record, "url");
		let url: URL;
		try {
			url = new URL(raw.startsWith("https://") ? raw : `https://${raw}`);
		} catch {
			invalid("vercel immutable deployment URL is invalid");
		}
		if (
			url.protocol !== "https:" ||
			!url.hostname.endsWith(".vercel.app") ||
			url.username ||
			url.password ||
			url.port ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			invalid("vercel immutable deployment URL leaves its hosting authority");
		const read = guardTransport(options.artifactTransport ?? transport, {
			allowedHosts: [url.hostname],
			allowedPathPrefixes: ["/"],
			maxTimeoutMs: 15000,
			maxResponseBytes: maxBytes,
		});
		const actual: Record<string, string> = {};
		let remaining = maxBytes;
		for (const path of Object.keys(filesOf(request))) {
			if (remaining <= 0)
				invalid("vercel observed artifact exceeds its aggregate bound");
			const response = await read({
				method: "GET",
				url: url.origin + path.split("/").map(encodeURIComponent).join("/"),
				headers: { accept: "*/*" },
				timeoutMs: 15000,
				maxResponseBytes: remaining,
			});
			check(response, [200]);
			remaining -= Buffer.byteLength(response.body, "utf8");
			actual[path] = response.body;
		}
		return {
			artifactDigest: `sha256:${createHash("sha256").update(JSON.stringify(actual)).digest("hex")}`,
			servingEndpoint: url.origin,
		};
	};
	const observe = async (
		request: ResolveRequest,
		transport: HttpTransport,
		verifyArtifact = true,
	): Promise<JsonObject | undefined> => {
		filesOf(request);
		const send = await caller(request, transport);
		await verifyProject(request, send);
		let id = request.ref.physicalId;
		if (!id) {
			const matches: string[] = [];
			let until: string | undefined;
			const seen = new Set<string>();
			for (let page = 0; page < PAGE_LIMIT; page++) {
				const response = await send(
					"GET",
					`/v7/deployments${query({ projectId: projectId(request), limit: "100", ...(until ? { until } : undefined) })}`,
				);
				check(response, [200]);
				const body = object(response);
				if (!isJsonArray(body.deployments))
					invalid("vercel returned an invalid deployment list");
				for (const entry of body.deployments) {
					if (!isJsonObject(entry))
						invalid("vercel returned an invalid deployment list entry");
					if (
						isJsonObject(entry.meta) &&
						entry.meta.hoboOperation === marker(request)
					)
						matches.push(field(entry, "uid"));
				}
				const pagination = body.pagination;
				const next = isJsonObject(pagination) ? pagination.next : undefined;
				if (next === null || next === undefined) {
					if (matches.length > 1)
						invalid(
							"multiple vercel deployments claim one immutable operation",
						);
					id = matches[0];
					break;
				}
				if (!(isJsonNumber(next) || isJsonString(next)))
					invalid("vercel returned an invalid pagination cursor");
				until = String(next);
				if (seen.has(until))
					invalid("vercel repeated its deployment pagination cursor");
				seen.add(until);
				if (page === PAGE_LIMIT - 1)
					invalid("vercel deployment discovery exceeded its pagination bound");
			}
			if (!id) return undefined;
		}
		const response = await send(
			"GET",
			`/v13/deployments/${encodeURIComponent(identifier(id))}${query()}`,
		);
		if (response.status === 404 || response.status === 410) return undefined;
		check(response, [200]);
		const record = object(response);
		if (
			record.id !== id ||
			record.projectId !== projectId(request) ||
			(options.teamId !== undefined &&
				(!isJsonObject(record.team) || record.team.id !== options.teamId))
		)
			invalid(
				"vercel deployment identity or owning project/team differs from the approved resource",
			);
		if (
			!isJsonObject(record.meta) ||
			record.meta.hoboOperation !== marker(request)
		)
			invalid(
				"vercel deployment operation marker differs from the approved artifact",
			);
		const state = field(record, "readyState"),
			terminal = ["READY", "ERROR", "CANCELED"].includes(state);
		return {
			id,
			projectId: projectId(request),
			state,
			ready: state === "READY",
			operationConfirmed: terminal,
			lifecycleStatus:
				state === "READY" ? "ready" : terminal ? "failed" : "pending",
			...(isJsonString(record.url)
				? { url: `https://${record.url.replace(/^https:\/\//u, "")}` }
				: undefined),
			...(state === "READY" && verifyArtifact
				? await digest(record, request, transport)
				: undefined),
		};
	};
	return {
		providerId: "vercel",
		productId: VERCEL_STATIC_DEPLOY_PRODUCT_ID,
		async read(raw, transport) {
			const request = parse(raw),
				observed = await observe(request, transport);
			return observed ? outcome("noop", observed) : undefined;
		},
		async reconcile(raw, transport) {
			const request = parse(raw),
				found = await observe(request, transport);
			if (found)
				return outcome(request.ref.physicalId ? "noop" : "adopt", found);
			if (request.ref.physicalId)
				refuse(
					"known vercel deployment is absent; a fresh deployment requires a new approved intent",
				);
			const send = await caller(request, transport);
			await verifyProject(request, send, true);
			const name = identifier(field(request.desired, "name"));
			const response = await send("POST", `/v13/deployments${query()}`, {
				name,
				project: projectId(request),
				files: Object.entries(filesOf(request)).map(([file, data]) => ({
					file: file.slice(1),
					data,
					encoding: "utf-8",
				})),
				meta: { hoboOperation: marker(request) },
			});
			check(response, [200, 201]);
			const record = object(response),
				id = identifier(field(record, "id"));
			const observed = await observe(
				{ ...request, ref: { ...request.ref, physicalId: id } },
				transport,
			);
			if (!observed)
				invalid(
					"vercel deployment acknowledgment lacks independent readback; retain its mutation journal",
				);
			return outcome("create", observed);
		},
		async delete(raw, transport) {
			const request = parse(raw);
			if (!request.ref.physicalId)
				refuse(
					"vercel deployment deletion requires its observed physical identity",
				);
			if (!(await observe(request, transport, false))) return;
			const send = await caller(request, transport);
			const response = await send(
				"DELETE",
				`/v13/deployments/${encodeURIComponent(identifier(request.ref.physicalId))}${query()}`,
			);
			check(response, [200, 204, 404, 410]);
		},
	};
}
