// Fixtures for the cd-gitops suites (owned by WP16).
import { create } from "@bufbuild/protobuf";
import {
	type CdContext,
	type CredentialResolver,
	type PublisherPort,
	SetOrigin,
	type SetRecord,
	SetRecordSchema,
} from "@hobo/cd";
import type {
	HttpTransport,
	JsonValue,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	type PublisherConfig,
	parsePublisherConfig,
	type ResolvedSet,
} from "../src/index.js";

export const NOW = Date.parse("2026-11-12T12:00:00.000Z");

export const ctx: CdContext = {
	tenant: "acme",
	principal: { kind: "service", id: "cd" },
	now: () => NOW,
};

export const set: SetRecord = create(SetRecordSchema, {
	schemaVersion: "hobo.cd.set/v1",
	setId: "set-prod-7",
	tenant: "acme",
	environment: "prod",
	campId: "prod",
	freightId: `sha256:${"1".repeat(64)}`,
	planHash: `sha256:${"2".repeat(64)}`,
	contentHash: `sha256:${"3".repeat(64)}`,
	origin: SetOrigin.PROMOTION,
	resolvedSetDigest: `sha256:${"4".repeat(64)}`,
	createdAt: "2026-11-12T11:59:00.000Z",
});

export type PublishInput = Parameters<PublisherPort["publish"]>[0];

/** A JSON document standing in for a ResolvedDeploymentSet. */
export function asResolved<T extends JsonValue>(value: T): ResolvedSet {
	// SAFETY: the publisher only serializes the resolved set as canonical JSON.
	return value as never;
}

/** The publish input every suite uses (fixture Set, fixture resolved set). */
export function publishInput(): PublishInput {
	return { set, resolved, signal: new AbortController().signal };
}

export const resolved = asResolved({
	schemaVersion: "hobo.resolved-set/v1",
	resources: [
		{ name: "web", provider: "kubernetes", outputs: { replicas: "3" } },
	],
});

type Host =
	| "GIT_HOST_GITHUB"
	| "GIT_HOST_GITLAB"
	| "GIT_HOST_GITEA"
	| "GIT_HOST_BITBUCKET";
type Engine = "GITOPS_ENGINE_ARGO_CD" | "GITOPS_ENGINE_FLUX";

const API = {
	GIT_HOST_GITHUB: "https://api.github.com",
	GIT_HOST_GITLAB: "https://gitlab.example/api/v4",
	GIT_HOST_GITEA: "https://forge.example/api/v1",
	GIT_HOST_BITBUCKET: "https://api.bitbucket.org/2.0",
} satisfies Record<Host, string>;

export function config(
	engine: Engine = "GITOPS_ENGINE_ARGO_CD",
	host: Host = "GIT_HOST_GITHUB",
): PublisherConfig {
	const argo = engine === "GITOPS_ENGINE_ARGO_CD";
	return parsePublisherConfig({
		schemaVersion: "hobo.cd-gitops.publisher/v1",
		name: argo ? "argo-cd" : "flux",
		engine,
		autoSync: true,
		prune: true,
		repository: {
			host,
			apiBaseUrl: API[host],
			repository: "acme/deploy",
			branch: "main",
			pathPrefix: "hobo/camps",
			cloneUrl: "https://git.example/acme/deploy.git",
			credentialRef: "git/acme-deploy",
		},
		endpoint: {
			apiBaseUrl: argo ? "https://argocd.example" : "https://kube.example:6443",
			credentialRef: argo ? "engine/argocd" : "engine/kube",
		},
	});
}

export function credentials(
	tokens: Record<string, string> = {
		"git/acme-deploy": "git-token",
		"engine/argocd": "argo-token",
		"engine/kube": "kube-token",
	},
): CredentialResolver & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async resolve(ref, scope) {
			calls.push(`${ref}@${scope}`);
			const value = tokens[ref];
			return value === undefined ? {} : { token: value };
		},
	};
}

export function json(
	status: number,
	body: JsonValue,
	headers: Record<string, string> = {},
): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	};
}

/** Route table transport: `METHOD path?query` → handler. Unknown routes fail the test. */
export function routes(
	table: Record<string, (request: TransportRequest) => TransportResponse>,
): HttpTransport & { readonly requests: TransportRequest[] } {
	const requests: TransportRequest[] = [];
	const transport = async (
		request: TransportRequest,
	): Promise<TransportResponse> => {
		requests.push(request);
		const url = new URL(request.url);
		const key = `${request.method} ${url.pathname}${url.search}`;
		const handler = table[key];
		if (handler === undefined) throw new Error(`unexpected request ${key}`);
		return handler(request);
	};
	return Object.assign(transport, { requests });
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/**
 * An in-memory GitHub (Git Data API subset): one branch, flat file map per
 * commit. `moveBranchOnce` simulates a concurrent writer.
 */
export function fakeGitHub(options: { moveBranchOnce?: boolean } = {}) {
	const commits = new Map<string, Map<string, string>>([
		["c0000000", new Map()],
	]);
	let head = "c0000000";
	let counter = 0;
	let moved = options.moveBranchOnce !== true;
	const trees = new Map<string, Map<string, string>>();
	const base = "/repos/acme/deploy";
	const http: HttpTransport = async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		if (request.method === "GET" && path === `${base}/git/ref/heads/main`)
			return json(200, { object: { sha: head } });
		if (request.method === "GET" && path.startsWith(`${base}/contents/`)) {
			const file = decodeURIComponent(path.slice(`${base}/contents/`.length));
			const content = commits.get(url.searchParams.get("ref") ?? "")?.get(file);
			return content === undefined
				? json(404, { message: "Not Found" })
				: json(200, {
						content: b64(content),
						encoding: "base64",
						sha: `blob-${file}`,
					});
		}
		if (request.method === "GET" && path.startsWith(`${base}/git/commits/`)) {
			return json(200, {
				sha: path.split("/").pop() ?? "",
				tree: { sha: `tree-of-${path.split("/").pop()}` },
			});
		}
		if (request.method === "POST" && path === `${base}/git/trees`) {
			const body = JSON.parse(request.body ?? "{}");
			const parentSha = String(body.base_tree).replace("tree-of-", "");
			const files = new Map(commits.get(parentSha) ?? []);
			for (const entry of body.tree) files.set(entry.path, entry.content);
			counter += 1;
			const sha = `t${String(counter).padStart(7, "0")}`;
			trees.set(sha, files);
			return json(201, { sha });
		}
		if (request.method === "POST" && path === `${base}/git/commits`) {
			const body = JSON.parse(request.body ?? "{}");
			counter += 1;
			const sha = `${String(counter).padStart(8, "a")}`;
			commits.set(sha, trees.get(body.tree) ?? new Map());
			return json(201, { sha, parents: body.parents });
		}
		if (request.method === "PATCH" && path === `${base}/git/refs/heads/main`) {
			const body = JSON.parse(request.body ?? "{}");
			if (!moved) {
				// Someone else pushed first: fast-forward refused.
				moved = true;
				counter += 1;
				const other = `${String(counter).padStart(8, "b")}`;
				commits.set(other, new Map(commits.get(head) ?? []));
				head = other;
				return json(422, { message: "Update is not a fast forward" });
			}
			head = body.sha;
			return json(200, { object: { sha: head } });
		}
		throw new Error(`unexpected ${request.method} ${path}`);
	};
	return {
		http,
		head: () => head,
		files: (sha = head) => commits.get(sha) ?? new Map<string, string>(),
		commitCount: () => commits.size - 1,
	};
}
