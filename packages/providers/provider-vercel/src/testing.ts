import { createHash } from "node:crypto";
import {
	createBoundedFetchTransport,
	type HttpTransport,
	TransportGuardError,
} from "@hobo/core";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
	parseJsonValue,
} from "./json.js";

type DeploymentState = "BUILDING" | "READY" | "ERROR" | "CANCELED";
type DeploymentTarget = "preview" | "production";
type FileBytes = Readonly<Record<string, string | Uint8Array>>;
type Project = Readonly<{ id: string; name: string; teamId: string }>;
type Deployment = {
	id: string;
	project: Project;
	url: string;
	target: DeploymentTarget;
	state: DeploymentState;
	staged: boolean;
	opaqueArchive: boolean;
	syntheticResponses: Map<string, Uint8Array> | undefined;
	files: Map<string, Uint8Array>;
	meta: JsonObject;
};
type RequestRecord = Readonly<{
	method: string;
	url: URL;
	headers: Headers;
	body: Uint8Array;
	signal: AbortSignal;
	maxResponseBytes: number;
}>;
type Answer = Readonly<{
	status: number;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array;
}>;
type Fault = Readonly<{
	method: string;
	path: string;
	when: "before" | "after";
}>;
const FETCH_RESPONSE_LIMIT = 32 * 1024 * 1024;
const ARCHIVE_NAME = ".vercel/source.tgz.part1";

export interface VercelDeploymentEmulator {
	readonly fetch: typeof fetch;
	readonly transport: HttpTransport;
	seedProject(project: Project): void;
	seedDeployment(
		input: Readonly<{
			id: string;
			projectId: string;
			target: DeploymentTarget;
			state?: DeploymentState;
			staged?: boolean;
			files?: FileBytes;
			meta?: JsonObject;
		}>,
	): void;
	seedAlias(alias: string, deploymentId: string): void;
	readOpaqueArchive(deploymentId: string): Uint8Array | undefined;
	setSyntheticResponses(deploymentId: string, files: FileBytes): void;
	setState(deploymentId: string, state: DeploymentState): void;
	failNext(fault: Fault): void;
}

function bytes(value: string | Uint8Array): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new TextEncoder().encode(value);
}

function answer(status: number, value: JsonValue): Answer {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: bytes(JSON.stringify(value)),
	};
}

function error(status: number, code: string): Answer {
	return answer(status, { error: { code, message: code } });
}

function validPath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.startsWith(".vercel/source.tgz.part") &&
		!path.includes("\\") &&
		![...path].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127;
		}) &&
		!path.split("/").some((part) => !part || part === "." || part === "..")
	);
}

function safePart(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

async function requestBytes(request: Request): Promise<Uint8Array> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Buffer[] = [];
	let chunk = Buffer.alloc(64 * 1024);
	let used = 0;
	let size = 0;
	let stop = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		stop = () => {
			void reader.cancel().catch(() => {});
			reject(new DOMException("The request was cancelled.", "AbortError"));
		};
	});
	const read = async (): Promise<Uint8Array> => {
		for (;;) {
			const part = await reader.read();
			if (request.signal.aborted)
				throw new DOMException("The request was cancelled.", "AbortError");
			if (part.done) break;
			size += part.value.byteLength;
			if (size > FETCH_RESPONSE_LIMIT) {
				void reader.cancel().catch(() => {});
				throw new TypeError("Synthetic request exceeds the byte limit.");
			}
			let offset = 0;
			while (offset < part.value.byteLength) {
				const count = Math.min(
					chunk.length - used,
					part.value.byteLength - offset,
				);
				chunk.set(part.value.subarray(offset, offset + count), used);
				used += count;
				offset += count;
				if (used === chunk.length) {
					chunks.push(chunk);
					chunk = Buffer.alloc(64 * 1024);
					used = 0;
				}
			}
		}
		if (used > 0) chunks.push(chunk.subarray(0, used));
		return new Uint8Array(Buffer.concat(chunks, size));
	};
	request.signal.addEventListener("abort", stop, { once: true });
	try {
		if (request.signal.aborted) stop();
		return await Promise.race([read(), cancelled]);
	} finally {
		request.signal.removeEventListener("abort", stop);
	}
}

export function createVercelDeploymentEmulator(
	options: Readonly<{
		teamId: string;
		token: string;
		projectFetch: typeof fetch;
		initialState?: DeploymentState;
		opaqueSourceArchives?: boolean;
	}>,
): VercelDeploymentEmulator {
	if (!options.teamId || !options.token)
		throw new TypeError("The emulator needs a team and synthetic token.");
	const projects = new Map<string, Project>();
	const deployments = new Map<string, Deployment>();
	const uploads = new Map<string, Uint8Array>();
	const aliases = new Map<string, string>();
	const productionAliases = new Map<string, Set<string>>();
	let nextId = 0;
	let fault: Fault | undefined;
	const team = options.teamId;
	const token = options.token;
	const projectFetch = options.projectFetch;
	const allowOpaqueArchives = options.opaqueSourceArchives === true;
	const initialState = options.initialState ?? "BUILDING";
	if (!["BUILDING", "READY", "ERROR", "CANCELED"].includes(initialState))
		throw new TypeError("Invalid emulator deployment state.");
	const projectFor = (key: string): Project | undefined =>
		projects.get(key) ??
		[...projects.values()].find((item) => item.name === key);
	const jsonBody = (request: RequestRecord): JsonObject | undefined => {
		const value = parseJsonValue(new TextDecoder().decode(request.body));
		return isJsonObject(value) ? value : undefined;
	};
	const record = (deployment: Deployment): JsonObject => {
		const base = {
			id: deployment.id,
			projectId: deployment.project.id,
			team: { id: deployment.project.teamId },
			url: deployment.url,
			target: deployment.target === "production" ? "production" : null,
			readyState: deployment.state,
			meta: deployment.meta,
		};
		return deployment.target === "production" && deployment.state === "READY"
			? { ...base, readySubstate: deployment.staged ? "STAGED" : "PROMOTED" }
			: base;
	};
	const filesFrom = (
		input: JsonValue | undefined,
	): { files: Map<string, Uint8Array>; opaqueArchive: boolean } | undefined => {
		if (!isJsonArray(input) || input.length === 0) return undefined;
		const files = new Map<string, Uint8Array>();
		let opaqueArchive = false;
		for (const entry of input) {
			const archive =
				allowOpaqueArchives &&
				input.length === 1 &&
				isJsonObject(entry) &&
				entry.file === ARCHIVE_NAME &&
				isJsonString(entry.sha) &&
				isJsonNumber(entry.size) &&
				Number.isSafeInteger(entry.size) &&
				entry.size >= 0 &&
				entry.size <= FETCH_RESPONSE_LIMIT;
			if (
				!isJsonObject(entry) ||
				!isJsonString(entry.file) ||
				(!archive && !validPath(entry.file)) ||
				files.has(entry.file)
			)
				return undefined;
			opaqueArchive = archive;
			let content: Uint8Array;
			if (isJsonString(entry.sha)) {
				if (entry.data !== undefined) return undefined;
				const found = uploads.get(entry.sha);
				if (
					!found ||
					(entry.size !== undefined && entry.size !== found.byteLength)
				)
					return undefined;
				content = new Uint8Array(found);
			} else if (isJsonString(entry.data)) {
				if (entry.encoding === "base64") {
					if (
						!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
							entry.data,
						)
					)
						return undefined;
					content = new Uint8Array(Buffer.from(entry.data, "base64"));
				} else if (entry.encoding === undefined || entry.encoding === "utf-8") {
					content = bytes(entry.data);
				} else return undefined;
			} else return undefined;
			files.set(entry.file, content);
		}
		return { files, opaqueArchive };
	};
	const forward = async (request: RequestRecord): Promise<Answer> => {
		if (request.signal.aborted) throw new Error("Synthetic request cancelled.");
		const url = new URL(request.url);
		if (!url.searchParams.has("teamId")) url.searchParams.set("teamId", team);
		const init: RequestInit = {
			method: request.method,
			headers: request.headers,
			redirect: "error",
			signal: request.signal,
		};
		if (request.method === "POST")
			init.body = new Uint8Array(request.body).buffer;
		const response = await projectFetch(url.toString(), init);
		if (request.signal.aborted) throw new Error("Synthetic request cancelled.");
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = response.body?.getReader();
		if (reader) {
			const cancel = () => {
				void reader.cancel().catch(() => {});
			};
			request.signal.addEventListener("abort", cancel, { once: true });
			try {
				for (;;) {
					const part = await reader.read();
					if (request.signal.aborted)
						throw new Error("Synthetic request cancelled.");
					if (part.done) break;
					size += part.value.byteLength;
					if (size > request.maxResponseBytes)
						throw new TransportGuardError(
							"TRANSPORT_BODY_TOO_LARGE",
							"Synthetic response exceeds the configured limit.",
						);
					chunks.push(part.value);
				}
			} finally {
				request.signal.removeEventListener("abort", cancel);
				cancel();
			}
		}
		return {
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: new Uint8Array(Buffer.concat(chunks)),
		};
	};
	const route = async (request: RequestRecord): Promise<Answer> => {
		const { url, method, headers } = request;
		if (url.protocol !== "https:" || url.username || url.password || url.port)
			return error(400, "invalid_origin");
		if (url.hostname !== "api.vercel.com") {
			const aliasId = aliases.get(url.hostname);
			const deployment =
				(aliasId ? deployments.get(aliasId) : undefined) ??
				[...deployments.values()].find((item) => item.url === url.hostname);
			if (!deployment || method !== "GET" || deployment.state !== "READY")
				return error(404, "not_found");
			const path = safePart(url.pathname.slice(1));
			const content =
				path === undefined
					? undefined
					: deployment.opaqueArchive
						? deployment.syntheticResponses?.get(path)
						: deployment.files.get(path);
			if (deployment.opaqueArchive && !content)
				return error(501, "opaque_archive");
			return content
				? {
						status: 200,
						headers: { "content-type": "application/octet-stream" },
						body: new Uint8Array(content),
					}
				: error(404, "not_found");
		}
		if (headers.get("authorization") !== `Bearer ${token}`)
			return error(401, "unauthorized");
		const scope = url.searchParams.get("teamId") ?? team;
		if (scope !== team) return error(404, "not_found");
		const parts = url.pathname.split("/").filter(Boolean);
		if (
			method === "GET" &&
			parts.length === 3 &&
			parts[0] === "v9" &&
			parts[1] === "projects"
		) {
			const key = safePart(parts[2] ?? "");
			const project = key === undefined ? undefined : projectFor(key);
			if (!project) return error(404, "not_found");
			const response = await forward(request);
			const observed = parseJsonObject(new TextDecoder().decode(response.body));
			return response.status === 200 &&
				observed.id === project.id &&
				observed.name === project.name &&
				observed.accountId === team
				? response
				: error(404, "not_found");
		}
		if (method === "POST" && url.pathname === "/v2/files") {
			if (request.body.byteLength > FETCH_RESPONSE_LIMIT)
				return error(413, "upload_too_large");
			const sha = headers.get("x-vercel-digest");
			if (
				!sha ||
				!/^[0-9a-f]{40}$/u.test(sha) ||
				createHash("sha1").update(request.body).digest("hex") !== sha
			)
				return error(400, "invalid_digest");
			const previous = uploads.get(sha);
			if (previous && !Buffer.from(previous).equals(Buffer.from(request.body)))
				return error(409, "digest_collision");
			const response = await forward(request);
			if (response.status !== 200) return response;
			uploads.set(sha, new Uint8Array(request.body));
			return response;
		}
		if (method === "POST" && url.pathname === "/v13/deployments") {
			const input = jsonBody(request);
			if (!input) return error(400, "invalid_json");
			const projectKey = isJsonString(input.project)
				? input.project
				: isJsonString(input.name)
					? input.name
					: "";
			const project = projectFor(projectKey);
			if (!project) return error(404, "not_found");
			const checked = await forward({
				method: "GET",
				url: new URL(
					`https://api.vercel.com/v9/projects/${encodeURIComponent(project.id)}?teamId=${encodeURIComponent(team)}`,
				),
				headers,
				body: new Uint8Array(),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			});
			const observed = parseJsonObject(new TextDecoder().decode(checked.body));
			if (
				checked.status !== 200 ||
				observed.id !== project.id ||
				observed.accountId !== team
			)
				return error(404, "not_found");
			if (
				input.gitSource !== undefined ||
				(input.target !== undefined && input.target !== "production")
			)
				return error(400, "unsupported_deployment");
			if (
				input.target === "production" &&
				input.autoAssignCustomDomains !== false
			)
				return error(400, "automatic_production_unsupported");
			const source = filesFrom(input.files);
			if (!source) return error(400, "invalid_files");
			if (input.meta !== undefined && !isJsonObject(input.meta))
				return error(400, "invalid_metadata");
			const meta = isJsonObject(input.meta) ? input.meta : {};
			if (!Object.values(meta).every(isJsonString))
				return error(400, "invalid_metadata");
			do nextId += 1;
			while (deployments.has(`dpl_${nextId}`));
			const id = `dpl_${nextId}`;
			const deployment: Deployment = {
				id,
				project,
				url: `deployment-${nextId}.vercel.app`,
				target: input.target === "production" ? "production" : "preview",
				state: initialState,
				staged: input.target === "production",
				opaqueArchive: source.opaqueArchive,
				syntheticResponses: undefined,
				files: source.files,
				meta,
			};
			deployments.set(id, deployment);
			return answer(200, record(deployment));
		}
		if (
			method === "GET" &&
			(url.pathname === "/v7/deployments" || url.pathname === "/v6/deployments")
		) {
			const projectId = url.searchParams.get("projectId");
			const target = url.searchParams.get("target");
			const marker = url.searchParams.get("meta-hoboSourceRequest");
			const limit = Number(url.searchParams.get("limit") ?? "20");
			const start = Number(url.searchParams.get("until") ?? "0");
			if (
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > 100 ||
				!Number.isInteger(start) ||
				start < 0
			)
				return error(400, "invalid_pagination");
			const matching = [...deployments.values()]
				.reverse()
				.filter(
					(item) =>
						(!projectId || item.project.id === projectId) &&
						(!target || item.target === target) &&
						(!marker || item.meta.hoboSourceRequest === marker),
				);
			const page = matching.slice(start, start + limit);
			return answer(200, {
				deployments: page.map((item) => ({ uid: item.id, meta: item.meta })),
				pagination: {
					next: start + limit < matching.length ? start + limit : null,
				},
			});
		}
		if (
			parts[0] === "v13" &&
			parts[1] === "deployments" &&
			parts.length === 3
		) {
			const id = safePart(parts[2] ?? "");
			const deployment = id === undefined ? undefined : deployments.get(id);
			if (!deployment) return error(404, "not_found");
			if (method === "GET") return answer(200, record(deployment));
			if (method === "DELETE") {
				deployments.delete(deployment.id);
				for (const [alias, target] of aliases)
					if (target === deployment.id) aliases.delete(alias);
				return answer(200, { state: "DELETED" });
			}
		}
		if (
			method === "GET" &&
			parts[0] === "v4" &&
			parts[1] === "aliases" &&
			parts.length === 3
		) {
			const alias = safePart(parts[2] ?? "");
			const id = alias === undefined ? undefined : aliases.get(alias);
			const deployment = id === undefined ? undefined : deployments.get(id);
			if (
				!alias ||
				!deployment ||
				(url.searchParams.has("projectId") &&
					url.searchParams.get("projectId") !== deployment.project.id)
			)
				return error(404, "not_found");
			return answer(200, {
				alias,
				projectId: deployment.project.id,
				deploymentId: deployment.id,
			});
		}
		if (
			method === "POST" &&
			parts[1] === "projects" &&
			parts.length === 5 &&
			((parts[0] === "v10" && parts[3] === "promote") ||
				(parts[0] === "v1" && parts[3] === "rollback"))
		) {
			const projectId = safePart(parts[2] ?? "");
			const deploymentId = safePart(parts[4] ?? "");
			const project =
				projectId === undefined ? undefined : projects.get(projectId);
			const deployment =
				deploymentId === undefined ? undefined : deployments.get(deploymentId);
			if (!project || !deployment || deployment.project.id !== project.id)
				return error(404, "not_found");
			if (
				deployment.target !== "production" ||
				deployment.state !== "READY" ||
				(parts[3] === "promote" && !deployment.staged) ||
				(parts[3] === "rollback" && deployment.staged)
			)
				return error(409, "promotion_unavailable");
			for (const alias of productionAliases.get(project.id) ?? [])
				aliases.set(alias, deployment.id);
			deployment.staged = false;
			return answer(201, {});
		}
		if (
			method === "POST" &&
			parts[0] === "v2" &&
			parts[1] === "deployments" &&
			parts[3] === "aliases" &&
			parts.length === 4
		) {
			const id = safePart(parts[2] ?? "");
			const deployment = id === undefined ? undefined : deployments.get(id);
			const input = jsonBody(request);
			if (!input) return error(400, "invalid_json");
			if (!deployment || !isJsonString(input.alias))
				return error(404, "not_found");
			const oldId = aliases.get(input.alias);
			const old = oldId === undefined ? undefined : deployments.get(oldId);
			if (
				!old ||
				old.project.id !== deployment.project.id ||
				deployment.target !== "production" ||
				deployment.state !== "READY"
			)
				return error(409, "alias_unavailable");
			if (deployment.staged) return error(501, "staged_alias_unsupported");
			aliases.set(input.alias, deployment.id);
			return answer(200, {
				alias: input.alias,
				uid: `alias_${nextId}`,
				oldDeploymentId: old.id,
				created: "2026-01-01T00:00:00.000Z",
			});
		}
		return error(501, "unsupported_operation");
	};
	const dispatch = async (request: RequestRecord): Promise<Answer> => {
		if (request.signal.aborted) throw new Error("Synthetic request cancelled.");
		const selected = fault;
		const matches =
			selected?.method === request.method &&
			selected.path === request.url.pathname;
		if (matches) fault = undefined;
		if (matches && selected.when === "before")
			throw new Error("Synthetic transport failure.");
		const response = await route(request);
		if (request.signal.aborted) throw new Error("Synthetic request cancelled.");
		if (matches && selected.when === "after")
			throw new Error("Synthetic response loss.");
		return response;
	};
	const fetchWithLimit = async (
		input: Parameters<typeof globalThis.fetch>[0],
		init: Parameters<typeof globalThis.fetch>[1],
		maxResponseBytes: number,
	): Promise<Response> => {
		const request = new Request(input, init);
		if (request.signal.aborted)
			throw new DOMException("The request was cancelled.", "AbortError");
		const body = await requestBytes(request);
		if (request.signal.aborted)
			throw new DOMException("The request was cancelled.", "AbortError");
		const response = await dispatch({
			method: request.method,
			url: new URL(request.url),
			headers: request.headers,
			body,
			signal: request.signal,
			maxResponseBytes,
		});
		if (response.body.byteLength > maxResponseBytes)
			throw new TransportGuardError(
				"TRANSPORT_BODY_TOO_LARGE",
				"Synthetic response exceeds the configured limit.",
			);
		return new Response(new Uint8Array(response.body).buffer, {
			status: response.status,
			headers: response.headers,
		});
	};
	const emulatedFetch: typeof globalThis.fetch = (input, init) =>
		fetchWithLimit(input, init, FETCH_RESPONSE_LIMIT);
	const transport: HttpTransport = (request) =>
		createBoundedFetchTransport({
			fetchImpl: (input, init) =>
				fetchWithLimit(input, init, request.maxResponseBytes),
		})(request);
	return {
		fetch: emulatedFetch,
		transport,
		seedProject(project) {
			if (
				!project.id ||
				!project.name ||
				project.teamId !== team ||
				projectFor(project.id) ||
				projectFor(project.name)
			)
				throw new TypeError("Invalid emulator project.");
			projects.set(project.id, Object.freeze({ ...project }));
		},
		seedDeployment(input) {
			const project = projects.get(input.projectId);
			if (
				!project ||
				!/^dpl_[A-Za-z0-9]+$/u.test(input.id) ||
				(input.target !== "preview" && input.target !== "production") ||
				(input.staged === true && input.target !== "production") ||
				(input.state !== undefined &&
					!["BUILDING", "READY", "ERROR", "CANCELED"].includes(input.state)) ||
				deployments.has(input.id)
			)
				throw new TypeError("Invalid emulator deployment.");
			const files = new Map<string, Uint8Array>();
			let size = 0;
			for (const [path, data] of Object.entries(input.files ?? {})) {
				if (!validPath(path)) throw new TypeError("Invalid emulator file.");
				const content = bytes(data);
				size += content.byteLength;
				if (size > FETCH_RESPONSE_LIMIT)
					throw new TypeError("Emulator files exceed the limit.");
				files.set(path, content);
			}
			deployments.set(input.id, {
				id: input.id,
				project,
				url: `${input.id.replace("_", "-")}.vercel.app`,
				target: input.target,
				state: input.state ?? "READY",
				staged: input.staged ?? false,
				opaqueArchive: false,
				syntheticResponses: undefined,
				files,
				meta: structuredClone(input.meta ?? {}),
			});
		},
		seedAlias(alias, deploymentId) {
			const deployment = deployments.get(deploymentId);
			const existingId = aliases.get(alias);
			const existing =
				existingId === undefined ? undefined : deployments.get(existingId);
			if (
				deployment?.target !== "production" ||
				deployment.state !== "READY" ||
				(existing !== undefined &&
					existing.project.id !== deployment.project.id) ||
				!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/u.test(alias)
			)
				throw new TypeError("Invalid emulator alias.");
			aliases.set(alias, deploymentId);
			const configured =
				productionAliases.get(deployment.project.id) ?? new Set();
			configured.add(alias);
			productionAliases.set(deployment.project.id, configured);
			deployment.staged = false;
		},
		readOpaqueArchive(deploymentId) {
			const deployment = deployments.get(deploymentId);
			const archive = deployment?.opaqueArchive
				? deployment.files.get(ARCHIVE_NAME)
				: undefined;
			return archive ? new Uint8Array(archive) : undefined;
		},
		setSyntheticResponses(deploymentId, values) {
			const deployment = deployments.get(deploymentId);
			if (!deployment?.opaqueArchive)
				throw new TypeError("Synthetic responses require an opaque archive.");
			const responses = new Map<string, Uint8Array>();
			let size = 0;
			for (const [path, value] of Object.entries(values)) {
				if (!validPath(path))
					throw new TypeError("Invalid synthetic response.");
				const content = bytes(value);
				size += content.byteLength;
				if (size > FETCH_RESPONSE_LIMIT)
					throw new TypeError("Synthetic responses exceed the limit.");
				responses.set(path, content);
			}
			deployment.syntheticResponses = responses;
		},
		setState(deploymentId, state) {
			const deployment = deployments.get(deploymentId);
			if (!deployment) throw new TypeError("Unknown emulator deployment.");
			if (deployment.state !== "BUILDING" && deployment.state !== state)
				throw new TypeError("An emulator deployment is already terminal.");
			deployment.state = state;
		},
		failNext(value) {
			if (fault) throw new Error("A synthetic failure is already scheduled.");
			fault = Object.freeze({ ...value });
		},
	};
}
