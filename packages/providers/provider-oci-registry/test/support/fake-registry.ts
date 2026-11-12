/**
 * An in-memory, offline distribution-spec registry world: the recorded
 * fixture every realizer test runs against.
 *
 * It answers the requests `contracts/provider-oci-registry-distribution.pact.json`
 * declares, with the statuses and headers recorded there, and it keeps state so
 * convergence and idempotence are observable (a second reconcile must issue no
 * write). It is deliberately strict where real registries are: a manifest PUT
 * whose blobs or children are missing is refused, an upload whose bytes do not
 * hash to the declared digest is refused, and a token covers only its scopes.
 *
 * Body encoding mirrors the host transport. In `utf-8` mode a binary blob read
 * throws, exactly as `createBoundedFetchTransport`'s fatal decoder does; in
 * `latin1` mode bytes map one-to-one onto code units.
 */
import { createHash } from "node:crypto";
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import type { JsonValue } from "../../src/json.js";

export type FakeAuth =
	| {
			readonly kind: "bearer";
			readonly realm: string;
			readonly service: string;
			readonly username?: string;
			readonly password?: string;
			readonly anonymousPull?: boolean;
			readonly tokenField?: "token" | "access_token";
	  }
	| {
			readonly kind: "basic";
			readonly username: string;
			readonly password: string;
	  }
	| { readonly kind: "preminted"; readonly token: string };

export interface FakeHostConfig {
	readonly host: string;
	readonly auth?: FakeAuth;
	readonly referrersApi?: boolean;
	readonly tagDelete?: boolean;
	readonly manifestDelete?: boolean;
	readonly mount?: boolean;
	readonly blobRedirectTo?: string;
	readonly omitDigestHeader?: boolean;
}

interface Repo {
	readonly blobs: Set<string>;
	readonly manifests: Map<string, { text: string; mediaType: string }>;
	readonly tags: Map<string, string>;
}

interface HostState {
	readonly config: FakeHostConfig;
	readonly blobs: Map<string, Uint8Array>;
	readonly repos: Map<string, Repo>;
	readonly uploads: Map<string, { repo: string; chunks: Uint8Array[] }>;
	nextUpload: number;
}

export interface Fault {
	readonly match: (request: TransportRequest) => boolean;
	/** apply-then-lose: the write lands, the reply is lost. lose: nothing lands. */
	readonly mode: "apply-then-lose" | "lose";
}

export function sha256(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const utf8 = (text: string) => Buffer.from(text, "utf8");

function json(
	status: number,
	body: JsonValue,
	headers: Readonly<Record<string, string>> = {},
): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	};
}
function error(status: number, code: string): TransportResponse {
	return json(status, { errors: [{ code, message: code.toLowerCase() }] });
}

export class FakeRegistryWorld {
	readonly calls: TransportRequest[] = [];
	readonly faults: Fault[] = [];
	readonly hosts = new Map<string, HostState>();
	readonly storage = new Map<string, Uint8Array>();
	readonly tokens = new Map<string, Set<string>>();
	private nextToken = 0;

	constructor(
		readonly encoding: "utf-8" | "latin1",
		configs: readonly FakeHostConfig[],
	) {
		for (const config of configs)
			this.hosts.set(config.host, {
				config,
				blobs: new Map(),
				repos: new Map(),
				uploads: new Map(),
				nextUpload: 0,
			});
	}

	repo(host: string, name: string): Repo {
		const state = this.state(host);
		let repo = state.repos.get(name);
		if (!repo) {
			repo = { blobs: new Set(), manifests: new Map(), tags: new Map() };
			state.repos.set(name, repo);
		}
		return repo;
	}

	seedBlob(host: string, name: string, bytes: Uint8Array): string {
		const digest = sha256(bytes);
		this.state(host).blobs.set(digest, bytes);
		this.repo(host, name).blobs.add(digest);
		return digest;
	}

	seedManifest(
		host: string,
		name: string,
		text: string,
		mediaType: string,
		tags: readonly string[] = [],
	): string {
		const digest = sha256(utf8(text));
		const repo = this.repo(host, name);
		repo.manifests.set(digest, { text, mediaType });
		for (const tag of tags) repo.tags.set(tag, digest);
		return digest;
	}

	/** Writes to registries (not token exchanges, not reads). */
	mutations(): number {
		return this.calls.filter(
			(call) =>
				!["GET", "HEAD"].includes(call.method) &&
				this.hosts.has(new URL(call.url).hostname),
		).length;
	}

	paths(method?: string): string[] {
		return this.calls
			.filter((call) => method === undefined || call.method === method)
			.map((call) => {
				const url = new URL(call.url);
				return `${call.method} ${url.hostname}${url.pathname}`;
			});
	}

	readonly transport: HttpTransport = async (request) => {
		this.calls.push(request);
		const index = this.faults.findIndex((fault) => fault.match(request));
		if (index >= 0) {
			const [fault] = this.faults.splice(index, 1);
			if (fault?.mode === "lose") throw new Error("socket hang up");
			this.handle(request);
			throw new Error("socket hang up after send");
		}
		return this.handle(request);
	};

	private state(host: string): HostState {
		const state = this.hosts.get(host);
		if (!state) throw new Error(`fake world has no host ${host}`);
		return state;
	}

	private decode(body: string | undefined): Uint8Array {
		if (body === undefined) return new Uint8Array();
		return Buffer.from(body, this.encoding === "latin1" ? "latin1" : "utf8");
	}

	private encode(bytes: Uint8Array): string {
		if (this.encoding === "latin1")
			return Buffer.from(bytes).toString("latin1");
		// The stock fetch transport decodes fatally: binary bytes throw here.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	}

	private handle(request: TransportRequest): TransportResponse {
		const url = new URL(request.url);
		if (this.storage.has(url.pathname)) {
			if (request.headers.authorization !== undefined)
				return error(400, "CREDENTIAL_SENT_TO_STORAGE");
			const bytes = this.storage.get(url.pathname) ?? new Uint8Array();
			return { status: 200, headers: {}, body: this.encode(bytes) };
		}
		for (const state of this.hosts.values()) {
			const auth = state.config.auth;
			if (auth?.kind === "bearer" && request.url.startsWith(auth.realm))
				return this.token(auth, request, url);
		}
		const state = this.state(url.hostname);
		const uploadMatch = /^\/v2\/(.+)\/blobs\/uploads\/([^/]*)$/u.exec(
			url.pathname,
		);
		const match = /^\/v2\/(.+)\/(manifests|blobs|referrers)\/([^/]+)$/u.exec(
			url.pathname,
		);
		const name = uploadMatch?.[1] ?? match?.[1];
		if (!name) return error(404, "NAME_UNKNOWN");
		const action =
			request.method === "GET" || request.method === "HEAD"
				? "pull"
				: request.method === "DELETE"
					? "delete"
					: "push";
		const needed = [`${name}:${action}`];
		const from = url.searchParams.get("from");
		if (url.searchParams.get("mount") && from) needed.push(`${from}:pull`);
		const denied = this.authorize(state, request, needed, name, action);
		if (denied) return denied;
		if (uploadMatch)
			return this.upload(state, name, uploadMatch[2] ?? "", request, url);
		if (!match) return error(404, "NAME_UNKNOWN");
		const kind = match[2];
		const reference = match[3] ?? "";
		const repo = this.repo(state.config.host, name);
		if (kind === "blobs") {
			if (!repo.blobs.has(reference)) return error(404, "BLOB_UNKNOWN");
			const bytes = state.blobs.get(reference) ?? new Uint8Array();
			if (request.method === "HEAD")
				return {
					status: 200,
					headers: {
						"docker-content-digest": reference,
						"content-length": String(bytes.byteLength),
					},
					body: "",
				};
			if (state.config.blobRedirectTo) {
				const path = `/blobs/${reference.replace(":", "/")}`;
				this.storage.set(path, bytes);
				return {
					status: 307,
					headers: {
						location: `https://${state.config.blobRedirectTo}${path}?X-Signature=fixture`,
					},
					body: "",
				};
			}
			return {
				status: 200,
				headers: { "docker-content-digest": reference },
				body: this.encode(bytes),
			};
		}
		if (kind === "referrers") {
			if (state.config.referrersApi === false)
				return error(404, "NAME_UNKNOWN");
			const manifests = [...repo.manifests.entries()]
				.filter(([, entry]) => {
					const parsed = JSON.parse(entry.text);
					return parsed.subject?.digest === reference;
				})
				.map(([digest, entry]) => ({
					mediaType: entry.mediaType,
					digest,
					size: utf8(entry.text).byteLength,
					artifactType: JSON.parse(entry.text).artifactType,
				}));
			return json(200, {
				schemaVersion: 2,
				mediaType: "application/vnd.oci.image.index.v1+json",
				manifests,
			});
		}
		return this.manifest(state, repo, reference, request);
	}

	private token(
		auth: Extract<FakeAuth, { kind: "bearer" }>,
		request: TransportRequest,
		url: URL,
	): TransportResponse {
		if (url.searchParams.get("service") !== auth.service)
			return error(400, "SERVICE_MISMATCH");
		const header = request.headers.authorization;
		const expected =
			auth.username === undefined
				? undefined
				: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
		const authenticated = header !== undefined && header === expected;
		if (header !== undefined && !authenticated)
			return error(401, "UNAUTHORIZED");
		const granted = new Set<string>();
		for (const scope of url.searchParams.getAll("scope")) {
			const [, repo, actions] =
				/^repository:(.+):([a-z,*]+)$/u.exec(scope) ?? [];
			if (!repo || !actions) continue;
			for (const action of actions.split(","))
				if (authenticated || (auth.anonymousPull && action === "pull"))
					granted.add(`${repo}:${action}`);
		}
		const token = `fixture-registry-token-${this.nextToken++}`;
		this.tokens.set(token, granted);
		return json(200, { [auth.tokenField ?? "token"]: token, expires_in: 300 });
	}

	private authorize(
		state: HostState,
		request: TransportRequest,
		needed: readonly string[],
		name: string,
		action: string,
	): TransportResponse | undefined {
		const auth = state.config.auth;
		if (!auth) return undefined;
		const header = request.headers.authorization ?? "";
		if (auth.kind === "basic") {
			const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
			return header === expected
				? undefined
				: {
						status: 401,
						headers: { "www-authenticate": 'Basic realm="fixture"' },
						body: "",
					};
		}
		if (auth.kind === "preminted")
			return header === `Bearer ${auth.token}`
				? undefined
				: error(401, "UNAUTHORIZED");
		const granted = this.tokens.get(header.replace(/^Bearer /u, ""));
		if (granted && needed.every((scope) => granted.has(scope)))
			return undefined;
		return {
			status: 401,
			headers: {
				"www-authenticate": `Bearer realm="${auth.realm}",service="${auth.service}",scope="repository:${name}:${action}"`,
			},
			body: JSON.stringify({ errors: [{ code: "UNAUTHORIZED" }] }),
		};
	}

	private upload(
		state: HostState,
		name: string,
		id: string,
		request: TransportRequest,
		url: URL,
	): TransportResponse {
		const repo = this.repo(state.config.host, name);
		if (request.method === "POST" && id === "") {
			const mount = url.searchParams.get("mount");
			const from = url.searchParams.get("from");
			if (
				mount &&
				from &&
				state.config.mount !== false &&
				this.repo(state.config.host, from).blobs.has(mount)
			) {
				repo.blobs.add(mount);
				return {
					status: 201,
					headers: {
						location: `/v2/${name}/blobs/${mount}`,
						"docker-content-digest": mount,
					},
					body: "",
				};
			}
			const session = `upload-${state.nextUpload++}`;
			state.uploads.set(session, { repo: name, chunks: [] });
			return {
				status: 202,
				headers: {
					location: `/v2/${name}/blobs/uploads/${session}?_state=s0`,
					"docker-upload-uuid": session,
				},
				body: "",
			};
		}
		const session = state.uploads.get(id);
		if (!session || session.repo !== name)
			return error(404, "BLOB_UPLOAD_UNKNOWN");
		if (request.method === "PATCH") {
			session.chunks.push(this.decode(request.body));
			const total = session.chunks.reduce(
				(sum, chunk) => sum + chunk.byteLength,
				0,
			);
			return {
				status: 202,
				headers: {
					location: `/v2/${name}/blobs/uploads/${id}?_state=s${session.chunks.length}`,
					range: `0-${total - 1}`,
				},
				body: "",
			};
		}
		if (request.method === "PUT") {
			if (request.body) session.chunks.push(this.decode(request.body));
			const bytes = Buffer.concat(session.chunks);
			const digest = url.searchParams.get("digest");
			if (digest !== sha256(bytes)) return error(400, "DIGEST_INVALID");
			state.uploads.delete(id);
			state.blobs.set(digest, bytes);
			repo.blobs.add(digest);
			return {
				status: 201,
				headers: {
					location: `/v2/${name}/blobs/${digest}`,
					"docker-content-digest": digest,
				},
				body: "",
			};
		}
		return error(405, "UNSUPPORTED");
	}

	private manifest(
		state: HostState,
		repo: Repo,
		reference: string,
		request: TransportRequest,
	): TransportResponse {
		const digestRef = reference.startsWith("sha256:");
		const resolved = digestRef ? reference : repo.tags.get(reference);
		if (request.method === "GET" || request.method === "HEAD") {
			const entry =
				resolved === undefined ? undefined : repo.manifests.get(resolved);
			if (!entry || resolved === undefined)
				return error(404, "MANIFEST_UNKNOWN");
			const base = {
				"content-type": entry.mediaType,
				"content-length": String(utf8(entry.text).byteLength),
			};
			const headers = state.config.omitDigestHeader
				? base
				: { ...base, "docker-content-digest": resolved };
			return {
				status: 200,
				headers,
				body: request.method === "HEAD" ? "" : entry.text,
			};
		}
		if (request.method === "PUT") {
			const text = request.body ?? "";
			const digest = sha256(utf8(text));
			if (digestRef && digest !== reference)
				return error(400, "DIGEST_INVALID");
			const parsed = JSON.parse(text);
			const blobs = [parsed.config, ...(parsed.layers ?? [])].filter(Boolean);
			for (const blob of blobs)
				if (
					!repo.blobs.has(blob.digest) &&
					!String(blob.mediaType).includes(".foreign.")
				)
					return error(400, "MANIFEST_BLOB_UNKNOWN");
			for (const child of parsed.manifests ?? [])
				if (!repo.manifests.has(child.digest))
					return error(400, "MANIFEST_UNKNOWN");
			repo.manifests.set(digest, {
				text,
				mediaType: request.headers["content-type"] ?? "",
			});
			if (!digestRef) repo.tags.set(reference, digest);
			const base = {
				"docker-content-digest": digest,
				location: `/v2/x/manifests/${digest}`,
			};
			const headers =
				parsed.subject && state.config.referrersApi !== false
					? { ...base, "oci-subject": String(parsed.subject.digest) }
					: base;
			return { status: 201, headers, body: "" };
		}
		if (request.method === "DELETE") {
			if (resolved === undefined || !repo.manifests.has(resolved))
				return error(404, "MANIFEST_UNKNOWN");
			if (!digestRef) {
				if (state.config.tagDelete === false) return error(405, "UNSUPPORTED");
				repo.tags.delete(reference);
				return { status: 202, headers: {}, body: "" };
			}
			if (state.config.manifestDelete === false)
				return error(405, "UNSUPPORTED");
			repo.manifests.delete(reference);
			for (const [tag, at] of repo.tags)
				if (at === reference) repo.tags.delete(tag);
			return { status: 202, headers: {}, body: "" };
		}
		return error(405, "UNSUPPORTED");
	}
}
