/**
 * Offline GitHub world: the REST semantics the Pages realizer depends on —
 * repository read, Pages site read/unpublish, the Git Data API (content-
 * addressed blobs and trees with real git object ids, commits, refs with
 * fast-forward enforcement), Pages builds, Actions artifacts and Pages
 * deployments — with fault hooks for ambiguous outcomes and racing writers.
 * Git object ids are computed here independently of `src/site-tree.ts`, so a
 * tree id the realizer predicts and one this world builds agree only if both
 * implement git's object format. Every request is recorded.
 */

import { createHash } from "node:crypto";
import type {
	HttpTransport,
	JsonValue,
	ResolveRequest,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	GITHUB_PAGES_SITE_PRODUCT_ID,
	type GithubPagesResolverOptions,
	STATIC_SITE_TREE_CONTRACT,
} from "../../src/index.js";

export const OWNER = "hobo-fixtures";
export const REPO = "site";
export const TOKEN = "ghp_fixtureGithubToken0123456789abcdef";
export const OIDC =
	"eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwczovL2dpdGh1Yi5jb20vaG9ibyJ9.c2lnbmF0dXJl";
export const API = "https://api.github.com";
const PREFIX = `/repos/${OWNER}/${REPO}`;

export function digestOf(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const text = (value: string) => new TextEncoder().encode(value);

/** A Freight: the tree index plus its file blobs, as the artifact store holds them. */
export function siteFreight(
	files: Readonly<Record<string, string>>,
	executable: readonly string[] = [],
) {
	const blobs = Object.entries(files).map(([path, body]) => ({
		path,
		bytes: text(body),
	}));
	const index = text(
		JSON.stringify({
			contract: STATIC_SITE_TREE_CONTRACT,
			files: blobs.map((blob) => ({
				path: blob.path,
				digest: digestOf(blob.bytes),
				size: blob.bytes.byteLength,
				...(executable.includes(blob.path) ? { executable: true } : undefined),
			})),
		}),
	);
	return {
		index,
		digest: digestOf(index),
		blobs: [index, ...blobs.map((blob) => blob.bytes)],
	};
}

export const SITE_V1 = siteFreight({
	"index.html": "<h1>v1</h1>\n",
	"assets/site.css": "body{}\n",
});
export const SITE_V2 = siteFreight({
	"index.html": "<h1>v2</h1>\n",
	"assets/site.css": "body{}\n",
	"about/index.html": "<p>about</p>\n",
});

export function memoryStore(...blobs: Uint8Array[]) {
	const map = new Map(blobs.map((bytes) => [digestOf(bytes), bytes]));
	return {
		map,
		async get(digest: string) {
			return map.get(digest);
		},
	};
}

interface Entry {
	mode: string;
	type: "blob" | "tree";
	sha: string;
}
interface TreeEntryBody {
	path: string;
	mode: string;
	type: "blob" | "tree";
	sha: string;
}
/** The request bodies the modelled endpoints read, loosely: the world is a fixture. */
interface Body {
	content?: string;
	base_tree?: string;
	/** A tree-creation entry list, or a commit's tree id. */
	tree?: string | TreeEntryBody[];
	parents?: string[];
	message?: string;
	ref?: string;
	sha?: string;
	force?: boolean;
	oidc_token?: string;
	artifact_id?: number;
	pages_build_version?: string;
}
interface Commit {
	tree: string;
	parents: string[];
	message: string;
}

function sha1(...parts: (string | Uint8Array)[]): string {
	const hash = createHash("sha1");
	for (const part of parts) hash.update(part);
	return hash.digest("hex");
}

interface Faults {
	lostBefore: string | undefined;
	dropReply: string | undefined;
	status: { prefix: string; status: number } | undefined;
	racingWriter: boolean;
	rateLimitOnce: boolean;
	autoBuild: boolean;
}

export interface WorldOptions {
	readonly buildType?: "legacy" | "workflow";
	readonly pages?: boolean;
	readonly sourceBranch?: string;
	readonly sourcePath?: "/" | "/docs";
	readonly push?: boolean;
	readonly writable?: boolean;
}

export function githubWorld(options: WorldOptions = {}) {
	const requests: TransportRequest[] = [];
	const blobs = new Map<string, Uint8Array>();
	const trees = new Map<string, Map<string, Entry>>();
	const commits = new Map<string, Commit>();
	const refs = new Map<string, string>();
	const builds: { status: string; commit: string }[] = [];
	const deployments = new Map<string, { status: string; version: string }>();
	const artifacts = new Map<number, { digest: string; expired: boolean }>();
	let pages:
		| {
				build_type: string;
				source?: { branch: string; path: string };
				html_url: string;
		  }
		| undefined =
		options.pages === false
			? undefined
			: {
					build_type: options.buildType ?? "legacy",
					...(options.buildType === "workflow"
						? undefined
						: {
								source: {
									branch: options.sourceBranch ?? "gh-pages",
									path: options.sourcePath ?? "/",
								},
							}),
					html_url: `https://${OWNER}.github.io/${REPO}/`,
				};
	let commitCounter = 0;
	let deploymentCounter = 0;
	const faults: Faults = {
		/** Lose the next mutation matching the prefix before it reaches GitHub. */
		lostBefore: undefined,
		/** Apply the next mutation matching the prefix, then lose its reply. */
		dropReply: undefined,
		/** Answer the next mutation matching the prefix with a status, applying nothing. */
		status: undefined,
		/** Move the branch to a foreign commit just before the next ref update. */
		racingWriter: false,
		/** Answer the next request 403 with an exhausted rate limit. */
		rateLimitOnce: false,
		/** Whether a push to the source branch starts a Pages build. */
		autoBuild: true,
	};

	function storeTree(entries: Map<string, Entry>): string {
		const sorted = [...entries.entries()].sort(([a, ea], [b, eb]) =>
			Buffer.compare(
				Buffer.from(ea.type === "tree" ? `${a}/` : a),
				Buffer.from(eb.type === "tree" ? `${b}/` : b),
			),
		);
		const body = Buffer.concat(
			sorted.map(([name, entry]) =>
				Buffer.concat([
					Buffer.from(
						`${entry.type === "tree" ? "40000" : entry.mode} ${name}\0`,
					),
					Buffer.from(entry.sha, "hex"),
				]),
			),
		);
		const sha = sha1(`tree ${body.byteLength}\0`, body);
		trees.set(sha, entries);
		return sha;
	}

	/** Flatten a tree to path → leaf entry (blobs and explicitly set subtrees). */
	function flatten(sha: string, prefix = "", into = new Map<string, Entry>()) {
		for (const [name, entry] of trees.get(sha) ?? []) {
			const path = `${prefix}${name}`;
			if (entry.type === "tree") flatten(entry.sha, `${path}/`, into);
			else into.set(path, entry);
		}
		return into;
	}

	/** Build nested tree objects from a flat path → entry map. */
	function build(flat: Map<string, Entry>): string {
		const here = new Map<string, Entry>();
		const children = new Map<string, Map<string, Entry>>();
		for (const [path, entry] of flat) {
			const slash = path.indexOf("/");
			if (slash < 0) here.set(path, entry);
			else {
				const head = path.slice(0, slash);
				const child = children.get(head) ?? new Map();
				child.set(path.slice(slash + 1), entry);
				children.set(head, child);
			}
		}
		for (const [name, child] of children)
			here.set(name, { mode: "040000", type: "tree", sha: build(child) });
		return storeTree(here);
	}

	function descends(commit: string, ancestor: string): boolean {
		const queue = [commit];
		while (queue.length > 0) {
			const next = queue.pop();
			if (next === undefined) break;
			if (next === ancestor) return true;
			queue.push(...(commits.get(next)?.parents ?? []));
		}
		return false;
	}

	function setRef(branch: string, sha: string) {
		refs.set(branch, sha);
		if (
			faults.autoBuild &&
			pages?.build_type === "legacy" &&
			pages.source?.branch === branch
		)
			builds.push({ status: "building", commit: sha });
	}

	function respond(status: number, body?: JsonValue): TransportResponse {
		return {
			status,
			headers: {
				"content-type": "application/json",
				"x-ratelimit-remaining": "4999",
			},
			body: body === undefined ? "" : JSON.stringify(body),
		};
	}

	function apply(request: TransportRequest, path: string, query: string) {
		const { method } = request;
		if (request.headers.authorization !== `Bearer ${TOKEN}`)
			return respond(401, { message: "Bad credentials" });
		if (method !== "GET" && options.writable === false)
			return respond(403, {
				message: "Resource not accessible by integration",
			});
		// SAFETY: every body is JSON the realizer serialized; the world reads the fields it models.
		const body: Body = request.body ? JSON.parse(request.body) : {};
		if (path === "" && method === "GET")
			return respond(200, {
				full_name: `${OWNER}/${REPO}`,
				permissions: { admin: false, push: options.push ?? true, pull: true },
			});
		if (path === "/pages") {
			if (method === "GET")
				return pages
					? respond(200, { status: "built", ...pages })
					: respond(404, { message: "Not Found" });
			if (method === "DELETE") {
				if (!pages) return respond(404, { message: "Not Found" });
				pages = undefined;
				return respond(204);
			}
		}
		if (path === "/pages/builds/latest" && method === "GET") {
			const latest = builds[builds.length - 1];
			return latest
				? respond(200, { ...latest, error: { message: null } })
				: respond(404, { message: "Not Found" });
		}
		if (path === "/pages/builds" && method === "POST") {
			const branch = pages?.source?.branch;
			const head = branch ? refs.get(branch) : undefined;
			if (!head) return respond(404, { message: "Not Found" });
			builds.push({ status: "queued", commit: head });
			return respond(201, {
				url: `${API}${PREFIX}/pages/builds/latest`,
				status: "queued",
			});
		}
		if (path === "/git/blobs" && method === "POST") {
			const bytes = new Uint8Array(Buffer.from(body.content ?? "", "base64"));
			const sha = sha1(`blob ${bytes.byteLength}\0`, bytes);
			blobs.set(sha, bytes);
			return respond(201, { sha, url: `${API}${PREFIX}/git/blobs/${sha}` });
		}
		if (path.startsWith("/git/blobs/") && method === "GET") {
			const sha = path.slice("/git/blobs/".length);
			const bytes = blobs.get(sha);
			return bytes
				? respond(200, {
						sha,
						size: bytes.byteLength,
						encoding: "base64",
						content: Buffer.from(bytes).toString("base64"),
					})
				: respond(404, { message: "Not Found" });
		}
		if (path === "/git/trees" && method === "POST") {
			const base = body.base_tree;
			if (base !== undefined && !trees.has(base))
				return respond(422, { message: "base_tree not found" });
			const flat = base ? flatten(base) : new Map<string, Entry>();
			for (const entry of Array.isArray(body.tree) ? body.tree : []) {
				if (entry.type === "blob" && !blobs.has(entry.sha))
					return respond(422, { message: "tree.sha is not a blob" });
				if (entry.type === "tree") {
					if (!trees.has(entry.sha))
						return respond(422, { message: "tree.sha is not a tree" });
					for (const key of flat.keys())
						if (key === entry.path || key.startsWith(`${entry.path}/`))
							flat.delete(key);
					for (const [inner, leaf] of flatten(entry.sha))
						flat.set(`${entry.path}/${inner}`, leaf);
				} else
					flat.set(entry.path, {
						mode: entry.mode,
						type: "blob",
						sha: entry.sha,
					});
			}
			const sha = build(flat);
			return respond(201, { sha, tree: [], truncated: false });
		}
		if (path.startsWith("/git/trees/") && method === "GET") {
			const sha = path.slice("/git/trees/".length);
			if (!trees.has(sha)) return respond(404, { message: "Not Found" });
			const listing: JsonValue[] = [];
			const walk = (tree: string, prefix: string) => {
				for (const [name, entry] of trees.get(tree) ?? []) {
					listing.push({ path: `${prefix}${name}`, ...entry });
					if (entry.type === "tree" && query === "recursive=1")
						walk(entry.sha, `${prefix}${name}/`);
				}
			};
			walk(sha, "");
			return respond(200, { sha, tree: listing, truncated: false });
		}
		if (path === "/git/commits" && method === "POST") {
			const tree = String(body.tree);
			if (!trees.has(tree)) return respond(422, { message: "tree not found" });
			const parents = body.parents ?? [];
			const sha = sha1(
				`commit ${tree} ${parents.join(",")} ${++commitCounter}`,
			);
			commits.set(sha, { tree, parents, message: String(body.message) });
			return respond(201, {
				sha,
				tree: { sha: tree },
				parents: parents.map((p) => ({ sha: p })),
			});
		}
		if (path.startsWith("/git/commits/") && method === "GET") {
			const sha = path.slice("/git/commits/".length);
			const commit = commits.get(sha);
			return commit
				? respond(200, {
						sha,
						tree: { sha: commit.tree },
						message: commit.message,
					})
				: respond(404, { message: "Not Found" });
		}
		if (path.startsWith("/git/ref/heads/") && method === "GET") {
			const branch = path.slice("/git/ref/heads/".length);
			const sha = refs.get(branch);
			return sha
				? respond(200, {
						ref: `refs/heads/${branch}`,
						object: { type: "commit", sha },
					})
				: respond(404, { message: "Not Found" });
		}
		if (path === "/git/refs" && method === "POST") {
			const branch = String(body.ref).replace(/^refs\/heads\//u, "");
			const sha = String(body.sha);
			if (refs.has(branch))
				return respond(422, { message: "Reference already exists" });
			if (!commits.has(sha))
				return respond(422, { message: "Object does not exist" });
			setRef(branch, sha);
			return respond(201, {
				ref: `refs/heads/${branch}`,
				object: { type: "commit", sha: sha },
			});
		}
		if (path.startsWith("/git/refs/heads/") && method === "PATCH") {
			const branch = path.slice("/git/refs/heads/".length);
			const sha = String(body.sha);
			const current = refs.get(branch);
			if (!current)
				return respond(422, { message: "Reference does not exist" });
			if (body.force !== true && !descends(sha, current))
				return respond(422, { message: "Update is not a fast forward" });
			setRef(branch, sha);
			return respond(200, {
				ref: `refs/heads/${branch}`,
				object: { type: "commit", sha: sha },
			});
		}
		if (path.startsWith("/actions/artifacts/") && method === "GET") {
			const id = Number(path.slice("/actions/artifacts/".length));
			const artifact = artifacts.get(id);
			return artifact
				? respond(200, { id, name: "github-pages", ...artifact })
				: respond(404, { message: "Not Found" });
		}
		if (path === "/pages/deployments" && method === "POST") {
			if (pages?.build_type !== "workflow")
				return respond(404, { message: "Not Found" });
			if (body.oidc_token !== OIDC)
				return respond(401, { message: "Bad OIDC token" });
			if (!artifacts.has(Number(body.artifact_id)))
				return respond(404, { message: "Artifact not found" });
			const id = `${++deploymentCounter}`.padStart(8, "0");
			deployments.set(id, {
				status: "deployment_queued",
				version: String(body.pages_build_version),
			});
			return respond(200, {
				id,
				status_url: `${API}${PREFIX}/pages/deployments/${id}`,
				page_url: pages.html_url,
			});
		}
		if (path.startsWith("/pages/deployments/") && method === "GET") {
			const deployment = deployments.get(
				path.slice("/pages/deployments/".length),
			);
			return deployment
				? respond(200, { status: deployment.status })
				: respond(404, { message: "Not Found" });
		}
		return respond(405, { message: `not modelled: ${method} ${path}` });
	}

	const matches = (prefix: string | undefined, path: string) =>
		prefix !== undefined && path.startsWith(prefix);

	const transport: HttpTransport = async (request) => {
		requests.push(request);
		const url = new URL(request.url);
		if (url.origin !== API || !url.pathname.startsWith(PREFIX))
			throw new Error(`world: unexpected url ${url.origin}${url.pathname}`);
		const path = url.pathname.slice(PREFIX.length);
		const query = url.search.replace(/^\?/u, "");
		if (faults.rateLimitOnce) {
			faults.rateLimitOnce = false;
			return {
				status: 403,
				headers: { "x-ratelimit-remaining": "0" },
				body: JSON.stringify({ message: "API rate limit exceeded" }),
			};
		}
		const mutation = request.method !== "GET";
		if (mutation && matches(faults.lostBefore, path)) {
			faults.lostBefore = undefined;
			throw new Error("socket hang up");
		}
		if (mutation && faults.status && path.startsWith(faults.status.prefix)) {
			const { status } = faults.status;
			faults.status = undefined;
			return respond(status, { message: "injected" });
		}
		if (
			mutation &&
			faults.racingWriter &&
			(path.startsWith("/git/refs/heads/") || path === "/git/refs")
		) {
			faults.racingWriter = false;
			const branch = path.startsWith("/git/refs/heads/")
				? path.slice("/git/refs/heads/".length)
				: "gh-pages";
			const foreignTree = build(
				new Map([
					[
						"index.html",
						{
							mode: "100644",
							type: "blob",
							sha: (() => {
								const bytes = text("<h1>someone else</h1>\n");
								const sha = sha1(`blob ${bytes.byteLength}\0`, bytes);
								blobs.set(sha, bytes);
								return sha;
							})(),
						},
					],
				]),
			);
			const parent = refs.get(branch);
			const foreign = sha1(`foreign ${++commitCounter}`);
			commits.set(foreign, {
				tree: foreignTree,
				parents: parent ? [parent] : [],
				message: "foreign writer",
			});
			setRef(branch, foreign);
		}
		const response = apply(request, path, query);
		if (mutation && matches(faults.dropReply, path)) {
			faults.dropReply = undefined;
			throw new Error("ETIMEDOUT");
		}
		return response;
	};

	return {
		transport,
		requests,
		faults,
		refs,
		commits,
		trees,
		builds,
		deployments,
		artifacts,
		pages: () => pages,
		/** Finish the latest Pages build with a status. */
		finishBuild(status: "built" | "errored" = "built") {
			const latest = builds[builds.length - 1];
			if (latest) latest.status = status;
		},
		publishedTree(branch = "gh-pages", path: "/" | "/docs" = "/") {
			const head = refs.get(branch);
			const root = head ? commits.get(head)?.tree : undefined;
			if (!root || path === "/") return root;
			return trees.get(root)?.get("docs")?.sha;
		},
		mutations: () => requests.filter((request) => request.method !== "GET"),
		/** The head commit of a branch; throws when the branch is absent. */
		head(branch = "gh-pages"): string {
			const sha = refs.get(branch);
			if (sha === undefined) throw new Error(`world: no branch ${branch}`);
			return sha;
		},
		/** Move a recorded Pages deployment to a status. */
		setDeploymentStatus(id: JsonValue | undefined, status: string) {
			const deployment = deployments.get(String(id));
			if (deployment === undefined)
				throw new Error(`world: no deployment ${String(id)}`);
			deployment.status = status;
		},
	};
}

export function options(
	store: { get(digest: string): Promise<Uint8Array | undefined> },
	overrides: Partial<GithubPagesResolverOptions> = {},
): GithubPagesResolverOptions {
	return {
		api: { kind: "github.com" },
		resolveCredential: async () => TOKEN,
		artifacts: store,
		...overrides,
	};
}

/** Desired-state overrides; an `undefined` value removes the key. */
export type DesiredOverrides = Readonly<Record<string, JsonValue | undefined>>;

export function request(
	overrides: DesiredOverrides = {},
	physicalId?: string,
	observed?: Record<string, JsonValue>,
): ResolveRequest {
	const desired: Record<string, JsonValue> = {};
	const merged = {
		owner: OWNER,
		repo: REPO,
		publishMode: "branch",
		branch: "gh-pages",
		path: "/",
		artifactDigest: SITE_V1.digest,
		...overrides,
	};
	for (const [key, value] of Object.entries(merged))
		if (value !== undefined) desired[key] = value;
	return {
		ref: {
			slot: "web",
			productId: GITHUB_PAGES_SITE_PRODUCT_ID,
			logicalId: "docs-site",
			...(physicalId ? { physicalId } : undefined),
		},
		desired,
		...(observed ? { observed } : undefined),
		credentialRef: "vault://cd/github/pages",
	};
}
