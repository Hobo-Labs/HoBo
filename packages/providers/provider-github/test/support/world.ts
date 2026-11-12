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
	extra: Readonly<Record<string, JsonValue>> = {},
) {
	const blobs = Object.entries(files).map(([path, body]) => ({
		path,
		bytes: text(body),
	}));
	const index = text(
		JSON.stringify({
			contract: STATIC_SITE_TREE_CONTRACT,
			...extra,
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

/** The digest the build workflow's Pages artifact carries in the fixtures. */
export const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;
/** SITE_V1 as a pages-deployment Freight: its index binds the Actions artifact. */
export const SITE_DEPLOY = siteFreight(
	{
		"index.html": "<h1>v1</h1>\n",
		"assets/site.css": "body{}\n",
	},
	[],
	{ pagesArtifactDigest: ARTIFACT_DIGEST },
);

/** An artifact store that counts reads, so tests can see what a pass loads. */
export function memoryStore(...blobs: Uint8Array[]) {
	const map = new Map(blobs.map((bytes) => [digestOf(bytes), bytes]));
	const reads: string[] = [];
	return {
		map,
		reads,
		async get(digest: string) {
			reads.push(digest);
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
	status: { prefix: string; status: number; message?: string } | undefined;
	racingWriter: boolean;
	rewindOnCommit: boolean;
	rateLimitOnce: boolean;
	secondaryRateLimitOnce: boolean;
	hideDeploymentStatusReads: number;
	autoBuild: boolean;
}

/** GitHub's documentation root, as error bodies carry it. */
const DOCS = "https://docs.github.com/rest";

export interface WorldOptions {
	readonly buildType?: "legacy" | "workflow";
	readonly pages?: boolean;
	readonly sourceBranch?: string;
	readonly sourcePath?: "/" | "/docs";
	readonly push?: boolean;
	readonly writable?: boolean;
	/** false: the repository is private or absent to the credential (404). */
	readonly visible?: boolean;
}

export function githubWorld(options: WorldOptions = {}) {
	const requests: TransportRequest[] = [];
	const blobs = new Map<string, Uint8Array>();
	const trees = new Map<string, Map<string, Entry>>();
	const commits = new Map<string, Commit>();
	const refs = new Map<string, string>();
	const builds: { status: string; commit: string }[] = [];
	/** Pages deployments, oldest first; GitHub ids them by their build version. */
	const deployments: {
		status: string;
		version: string;
		environmentId: number;
	}[] = [];
	const environment: { id: number; sha: string; states: string[] }[] = [];
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
	let requestCounter = 0;
	const faults: Faults = {
		/** Lose the next mutation matching the prefix before it reaches GitHub. */
		lostBefore: undefined,
		/** Apply the next mutation matching the prefix, then lose its reply. */
		dropReply: undefined,
		/** Answer the next mutation matching the prefix with a status, applying nothing. */
		status: undefined,
		/** Move the branch to a foreign commit just before the next ref update. */
		racingWriter: false,
		/** Rewind the branch to its head's parent when the next commit is created. */
		rewindOnCommit: false,
		/** Answer the next request 403 with an exhausted primary rate limit. */
		rateLimitOnce: false,
		/** Answer the next request 403 with a secondary rate limit (retry-after). */
		secondaryRateLimitOnce: false,
		/** Answer this many next Pages deployment status reads 404. */
		hideDeploymentStatusReads: 0,
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

	/** The headers every GitHub REST response carries (2022-11-28). */
	function headers(hasBody: boolean, extra: Record<string, string> = {}) {
		requestCounter += 1;
		return {
			...(hasBody
				? { "content-type": "application/json; charset=utf-8" }
				: undefined),
			"x-github-api-version-selected": "2022-11-28",
			"x-github-media-type": "github.v3; format=json",
			"x-github-request-id": `C0DE:5EED:${requestCounter.toString(16).toUpperCase().padStart(6, "0")}:${(0x1a2b3c + requestCounter).toString(16).toUpperCase()}`,
			"x-ratelimit-limit": "5000",
			"x-ratelimit-remaining": String(5000 - requestCounter),
			"x-ratelimit-reset": "1767225600",
			"x-ratelimit-resource": "core",
			"x-ratelimit-used": String(requestCounter),
			...extra,
		};
	}

	function respond(
		status: number,
		body?: JsonValue,
		extra?: Record<string, string>,
	): TransportResponse {
		return {
			status,
			headers: headers(body !== undefined, extra),
			body: body === undefined ? "" : JSON.stringify(body),
		};
	}

	/** A GitHub error: `{message, documentation_url, status}` as the API sends it. */
	function error(
		status: number,
		message: string,
		doc: string,
		extra?: Record<string, string>,
	): TransportResponse {
		return respond(
			status,
			{ message, documentation_url: `${DOCS}${doc}`, status: String(status) },
			extra,
		);
	}

	const notFound = (doc: string) => error(404, "Not Found", doc);

	/** Record a Pages deployment and its github-pages environment deployment. */
	function deploy(version: string): JsonValue {
		const environmentId = 7_000_000 + ++deploymentCounter;
		deployments.push({ status: "deployment_queued", version, environmentId });
		environment.push({ id: environmentId, sha: version, states: ["queued"] });
		// The Pages deployment id is the build version it deploys.
		return {
			id: version,
			status_url: `${API}${PREFIX}/pages/deployments/${version}`,
			page_url: pages?.html_url ?? null,
		};
	}

	const newest = (version: string) =>
		[...deployments].reverse().find((entry) => entry.version === version);

	/** Move the newest deployment of a version to a status; success deactivates the others. */
	function settle(version: string, status: string) {
		const deployment = newest(version);
		if (deployment === undefined)
			throw new Error(`world: no deployment of ${version}`);
		deployment.status = status;
		const entry = environment.find((e) => e.id === deployment.environmentId);
		if (entry === undefined) return;
		const state =
			status === "succeed"
				? "success"
				: /failed|cancelled|error|lost/u.test(status)
					? "failure"
					: "in_progress";
		entry.states.push(state);
		if (state === "success")
			for (const other of environment)
				if (other !== entry && other.states.at(-1) === "success")
					other.states.push("inactive");
	}

	function apply(request: TransportRequest, path: string, query: string) {
		const { method } = request;
		if (request.headers.authorization !== `Bearer ${TOKEN}`)
			return error(401, "Bad credentials", "");
		if (options.visible === false)
			return notFound("/repos/repos#get-a-repository");
		if (method !== "GET" && options.writable === false)
			return error(
				403,
				"Resource not accessible by personal access token",
				"/git/blobs#create-a-blob",
				{ "x-accepted-github-permissions": "contents=write" },
			);
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
					: notFound("/pages/pages#get-a-apiname-pages-site");
			if (method === "DELETE") {
				if (!pages) return notFound("/pages/pages#delete-a-apiname-pages-site");
				pages = undefined;
				return respond(204);
			}
		}
		if (path === "/pages/builds/latest" && method === "GET") {
			const latest = builds[builds.length - 1];
			return latest
				? respond(200, { ...latest, error: { message: null } })
				: notFound("/pages/pages#get-latest-pages-build");
		}
		if (path === "/pages/builds" && method === "POST") {
			const branch = pages?.source?.branch;
			const head = branch ? refs.get(branch) : undefined;
			if (!head) return notFound("/pages/pages#request-a-apiname-pages-build");
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
				: notFound("/git/blobs#get-a-blob");
		}
		if (path === "/git/trees" && method === "POST") {
			const base = body.base_tree;
			if (base !== undefined && !trees.has(base))
				return error(422, "base_tree not found", "/git/trees#create-a-tree");
			const flat = base ? flatten(base) : new Map<string, Entry>();
			for (const entry of Array.isArray(body.tree) ? body.tree : []) {
				if (entry.type === "blob" && !blobs.has(entry.sha))
					return error(
						422,
						"tree.sha is not a blob",
						"/git/trees#create-a-tree",
					);
				if (entry.type === "tree") {
					if (!trees.has(entry.sha))
						return error(
							422,
							"tree.sha is not a tree",
							"/git/trees#create-a-tree",
						);
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
			if (!trees.has(sha)) return notFound("/git/trees#get-a-tree");
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
			if (!trees.has(tree))
				return error(
					422,
					"Tree SHA does not exist",
					"/git/commits#create-a-commit",
				);
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
				: notFound("/git/commits#get-a-commit-object");
		}
		if (path.startsWith("/git/ref/heads/") && method === "GET") {
			const branch = path.slice("/git/ref/heads/".length);
			const sha = refs.get(branch);
			return sha
				? respond(200, {
						ref: `refs/heads/${branch}`,
						object: { type: "commit", sha },
					})
				: notFound("/git/refs#get-a-reference");
		}
		if (path === "/git/refs" && method === "POST") {
			const branch = String(body.ref).replace(/^refs\/heads\//u, "");
			const sha = String(body.sha);
			if (refs.has(branch))
				return error(
					422,
					"Reference already exists",
					"/git/refs#create-a-reference",
				);
			if (!commits.has(sha))
				return error(
					422,
					"Object does not exist",
					"/git/refs#create-a-reference",
				);
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
				return error(
					422,
					"Reference does not exist",
					"/git/refs#update-a-reference",
				);
			if (body.force !== true && !descends(sha, current))
				return error(
					422,
					"Update is not a fast forward",
					"/git/refs#update-a-reference",
				);
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
				: notFound("/actions/artifacts#get-an-artifact");
		}
		if (path === "/pages/deployments" && method === "POST") {
			if (pages?.build_type !== "workflow")
				return notFound("/pages/pages#create-a-github-pages-deployment");
			if (body.oidc_token !== OIDC)
				return error(
					401,
					"Bad credentials",
					"/pages/pages#create-a-github-pages-deployment",
				);
			if (!artifacts.has(Number(body.artifact_id)))
				return error(
					404,
					"Not Found",
					"/pages/pages#create-a-github-pages-deployment",
				);
			const version = String(body.pages_build_version);
			return respond(200, deploy(version));
		}
		if (path.startsWith("/pages/deployments/") && method === "GET") {
			const deployment = newest(path.slice("/pages/deployments/".length));
			const hidden = faults.hideDeploymentStatusReads > 0;
			if (hidden) faults.hideDeploymentStatusReads -= 1;
			return deployment && !hidden
				? respond(200, { status: deployment.status })
				: notFound("/pages/pages#get-the-status-of-a-github-pages-deployment");
		}
		if (path === "/deployments" && method === "GET") {
			const listed = query.includes("environment=github-pages")
				? [...environment].reverse().slice(0, 10)
				: [];
			return respond(
				200,
				listed.map((entry) => ({
					id: entry.id,
					sha: entry.sha,
					ref: entry.sha,
					task: "deploy",
					environment: "github-pages",
					created_at: "2026-01-01T00:00:00Z",
				})),
			);
		}
		const statuses = /^\/deployments\/([0-9]+)\/statuses$/u.exec(path);
		if (statuses && method === "GET") {
			const entry = environment.find((e) => e.id === Number(statuses[1]));
			if (!entry)
				return notFound("/deployments/statuses#list-deployment-statuses");
			return respond(
				200,
				[...entry.states]
					.reverse()
					.slice(0, 1)
					.map((state, index) => ({
						id: entry.id * 100 + entry.states.length - index,
						state,
						environment: "github-pages",
					})),
			);
		}
		return error(405, `not modelled: ${method} ${path}`, "");
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
			return error(
				403,
				"API rate limit exceeded for user ID 1.",
				"/overview/rate-limits-for-the-rest-api",
				{ "x-ratelimit-remaining": "0", "x-ratelimit-used": "5000" },
			);
		}
		if (faults.secondaryRateLimitOnce) {
			faults.secondaryRateLimitOnce = false;
			return error(
				403,
				"You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
				"/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits",
				{ "retry-after": "60" },
			);
		}
		const mutation = request.method !== "GET";
		if (mutation && matches(faults.lostBefore, path)) {
			faults.lostBefore = undefined;
			throw new Error("socket hang up");
		}
		if (mutation && faults.status && path.startsWith(faults.status.prefix)) {
			const { status, message } = faults.status;
			faults.status = undefined;
			return error(status, message ?? "injected", "");
		}
		if (mutation && faults.rewindOnCommit && path === "/git/commits") {
			// Another writer rewinds the branch to an ancestor of its head.
			faults.rewindOnCommit = false;
			for (const [branch, head] of refs) {
				const parent = commits.get(head)?.parents[0];
				if (parent !== undefined) refs.set(branch, parent);
			}
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
		/** Move the newest Pages deployment of a build version to a status. */
		setDeploymentStatus(version: JsonValue | undefined, status: string) {
			settle(String(version), status);
		},
		/** Someone else deploys another build version, and it goes live. */
		foreignDeployment(version: string) {
			deploy(version);
			settle(version, "succeed");
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
