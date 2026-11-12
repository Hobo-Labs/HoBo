/**
 * GitHub Pages site realizer (plan 0024, HoBo.CD; D6, R2).
 *
 * The resource is the Pages site of one repository; its desired content is a
 * static-site tree Freight (a tree index plus one blob per file in the
 * artifact store, see `site-tree.ts`). It is realized through the existing
 * `ResourceResolver` port and talks HTTP only through the host's
 * `HttpTransport`, wrapped in `guardTransport` pinned to the bound GitHub API.
 * There is no git binary and no SDK: every git object is created through the
 * Git Data API, and the desired tree id is computed locally before anything
 * is uploaded.
 *
 * Two declared publish modes (`desired.publishMode`):
 *
 * - **`branch`** — the site builds from a branch (Pages `build_type` legacy).
 *   Observe `GET /pages`, the branch head (`git/ref` → `git/commits`, and the
 *   `docs` subtree when the site publishes from `/docs`) and the latest Pages
 *   build. If the published tree id differs from the Freight's, upload the
 *   missing blobs, create the tree (its id must equal the locally computed
 *   one), create a commit whose parent is the observed head, and move the ref
 *   with `force: false` — a compare-and-swap on the observed head, because the
 *   only fast-forward from that parent is the head not having moved. Then
 *   observe again.
 * - **`pages-deployment`** — the site builds from Actions (`build_type`
 *   workflow). The REST API has no artifact upload (that is the Actions
 *   runtime service, reachable only inside a workflow run), so the CI uploads
 *   the Pages artifact and the Freight names it; the realizer verifies it by
 *   digest, creates `POST /pages/deployments` with the locally computed tree
 *   id as `pages_build_version`, and observes the deployment status.
 *
 * Convergence is reported only from observation (I5): `ready` is true only
 * when the published tree id equals the Freight's and the Pages build for that
 * head commit is `built` (branch mode), or the deployment for that tree id is
 * `succeed` (deployment mode). A lost reply, a timeout or a 5xx is ambiguous
 * and is resolved by observing again.
 *
 * Credentials: `credentialRef` resolves through the host to a token with
 * `contents: write` and `pages: write`; deployment mode also asks the host for
 * the workflow's OIDC token. Neither ever reaches an outcome, an error or a
 * record (I9).
 */
import {
	createResolverRegistry,
	guardTransport,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	type ResolverAction,
	ResolverError,
	type ResourceResolver,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";
import {
	GITHUB_API_VERSION,
	GITHUB_MAX_RESPONSE_BYTES,
	GITHUB_TIMEOUT_MS,
	type GithubApiBinding,
	parseGithubApiBinding,
} from "./api.js";
import {
	fail,
	GITHUB_PAGES_SITE_PRODUCT_ID,
	GITHUB_PROVIDER_ID,
	githubProductRefusal,
	refuse,
	reject,
	unparseable,
	unsupported,
} from "./errors.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	loadSiteContent,
	parseSha256Digest,
	parseStaticSiteTree,
	type SiteContent,
} from "./site-tree.js";

// public-contract: how the Freight reaches the Pages site.
export const GITHUB_PAGES_PUBLISH_MODES = Object.freeze([
	"branch",
	"pages-deployment",
] as const);
export type GithubPagesPublishMode =
	(typeof GITHUB_PAGES_PUBLISH_MODES)[number];

// public-contract: desired-state keys the resolver reads as directives, not identity.
export const GITHUB_PAGES_DIRECTIVES = Object.freeze([
	"commitMessage",
	"onDelete",
] as const);

// public-contract: what delete() does to the site.
export const GITHUB_PAGES_DELETE_ACTIONS = Object.freeze([
	"unpublish",
	"retain",
] as const);

// public-contract: Pages deployment statuses that mean the content can never deploy.
const DEPLOYMENT_TERMINAL_FAILURE = new Set(["deployment_content_failed"]);
// Statuses after which a fresh deployment of the same artifact is the remedy.
const DEPLOYMENT_RETRYABLE_FAILURE = new Set([
	"deployment_failed",
	"deployment_cancelled",
	"deployment_attempt_error",
	"deployment_lost",
]);

/**
 * The artifact store blob reader. Structurally the `get` of `@hobo/cd`'s
 * `ArtifactStore`; declared here so a provider package does not depend on the
 * delivery service.
 */
export interface GithubArtifactBlobReader {
	get(digest: string): Promise<Uint8Array | undefined>;
}

/** API, credentials and artifact access are bound by the host, never read from a plan. */
export interface GithubPagesResolverOptions {
	readonly api: GithubApiBinding;
	/** Resolves `credentialRef` to a GitHub token (contents: write, pages: write). */
	readonly resolveCredential: (ref: string) => Promise<string>;
	readonly artifacts: GithubArtifactBlobReader;
	/**
	 * Deployment mode only: the Actions OIDC token the Pages deployments API
	 * requires (`oidc_token`). Absent means deployment mode is unavailable.
	 */
	readonly resolveDeploymentOidcToken?: (ref: string) => Promise<string>;
}

const DESIRED_KEYS = new Set([
	"owner",
	"repo",
	"publishMode",
	"artifactDigest",
	"artifactCoordinate",
	"branch",
	"path",
	"actionsArtifactId",
	"actionsArtifactDigest",
	"commitMessage",
	"onDelete",
]);
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;
// A branch name git and GitHub both accept, kept to a conservative alphabet.
const BRANCH =
	/^(?![-/.])(?!.*(?:\.\.|\/\/|@\{|\/\.|\.lock(?:\/|$)))[A-Za-z0-9._/-]{1,200}(?<![/.])$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const TOKEN = /^[!-~]{1,8192}$/u;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u;
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

interface BranchTarget {
	readonly publishMode: "branch";
	readonly branch: string;
	readonly path: "/" | "/docs";
}
interface DeploymentTarget {
	readonly publishMode: "pages-deployment";
	readonly actionsArtifactId: number;
	readonly actionsArtifactDigest: string;
}
type Target = (BranchTarget | DeploymentTarget) & {
	readonly request: ResolveRequest;
	readonly owner: string;
	readonly repo: string;
	readonly artifactDigest: string;
	readonly commitMessage: string;
	readonly onDelete: "unpublish" | "retain";
	readonly physicalId: string;
};

interface Read {
	readonly status: number;
	readonly body?: JsonObject;
}

interface Session {
	/** A side-effect-free GET; refusals for auth, permission and rate limit are raised here. */
	get(path: string, query?: string): Promise<Read>;
	/** A mutation; `undefined` means the outcome is ambiguous (no reply). */
	send(
		method: TransportMethod,
		path: string,
		body?: JsonObject,
	): Promise<TransportResponse | undefined>;
}

interface PagesView {
	readonly buildType: "legacy" | "workflow";
	readonly sourceBranch: string | null;
	readonly sourcePath: string | null;
	readonly htmlUrl: string | null;
}

interface BranchView {
	readonly headSha: string | null;
	readonly rootTree: string | null;
	readonly publishedTree: string | null;
}

interface BuildView {
	readonly status: string;
	readonly commit: string | null;
}

interface Judged {
	readonly ready: boolean;
	readonly outputs: JsonObject;
	readonly diagnostics: readonly string[];
	/** Set when GitHub reports a failure the realizer must refuse with. */
	readonly failure?: "build-errored" | "deployment-failed";
}

/** Build the resolver for the bound GitHub API. */
export function createGithubPagesResolvers(
	options: GithubPagesResolverOptions,
): readonly ResourceResolver[] {
	const api = parseGithubApiBinding(options.api);

	function target(raw: ResolveRequest): Target {
		const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
		if (request.ref.productId !== GITHUB_PAGES_SITE_PRODUCT_ID)
			throw githubProductRefusal(request.ref.productId);
		const desired = request.desired;
		for (const key of Object.keys(desired))
			if (!DESIRED_KEYS.has(key))
				reject(`GitHub Pages site does not implement desired.${key}`);
		const owner = desired.owner;
		if (!isJsonString(owner) || !OWNER.test(owner))
			reject(
				"GitHub Pages desired.owner must be a GitHub user or organization login",
			);
		const repo = desired.repo;
		if (!isJsonString(repo) || !REPO.test(repo))
			reject("GitHub Pages desired.repo must be a GitHub repository name");
		const artifactDigest = parseSha256Digest(
			desired.artifactDigest,
			"artifactDigest",
		);
		if (
			desired.artifactCoordinate !== undefined &&
			(!isJsonString(desired.artifactCoordinate) ||
				!desired.artifactCoordinate.startsWith("store://") ||
				!desired.artifactCoordinate.endsWith(`/${artifactDigest}`))
		)
			reject(
				"GitHub Pages desired.artifactCoordinate must be the store:// coordinate of desired.artifactDigest",
			);
		const commitMessage =
			desired.commitMessage ?? `Publish ${artifactDigest} (HoBo.CD)`;
		if (
			!isJsonString(commitMessage) ||
			commitMessage.trim() === "" ||
			commitMessage.length > 4096
		)
			reject("GitHub Pages desired.commitMessage must be 1-4096 characters");
		const onDelete: "unpublish" | "retain" =
			desired.onDelete === "retain"
				? "retain"
				: desired.onDelete === undefined || desired.onDelete === "unpublish"
					? "unpublish"
					: reject(
							`GitHub Pages desired.onDelete must be one of ${GITHUB_PAGES_DELETE_ACTIONS.join(", ")}`,
						);
		const physicalId = `${owner}/${repo}`;
		if (
			request.ref.physicalId !== undefined &&
			request.ref.physicalId !== physicalId
		)
			reject(
				`GitHub Pages site ${physicalId} conflicts with its pinned physical identity`,
			);
		const common = {
			request,
			owner,
			repo,
			artifactDigest,
			commitMessage,
			onDelete,
			physicalId,
		};
		const mode = desired.publishMode;
		if (mode === "branch") {
			const branch = desired.branch;
			if (!isJsonString(branch) || !BRANCH.test(branch))
				reject(
					"GitHub Pages desired.branch must be a branch name (branch mode)",
				);
			const path = desired.path ?? "/";
			if (path !== "/" && path !== "/docs")
				reject(
					'GitHub Pages desired.path must be "/" or "/docs", the two folders Pages publishes from',
				);
			for (const key of ["actionsArtifactId", "actionsArtifactDigest"])
				if (desired[key] !== undefined)
					reject(
						`GitHub Pages desired.${key} applies only to pages-deployment mode`,
					);
			return { ...common, publishMode: "branch", branch, path };
		}
		if (mode === "pages-deployment") {
			for (const key of ["branch", "path"])
				if (desired[key] !== undefined)
					reject(`GitHub Pages desired.${key} applies only to branch mode`);
			const id = desired.actionsArtifactId;
			if (id === undefined)
				refuse(
					"github-pages-artifact-unavailable",
					"pages-deployment mode needs a Pages artifact uploaded by the workflow run; the GitHub REST API has no artifact upload",
					"upload the site with actions/upload-pages-artifact in the build workflow and record its artifact id and digest on the Freight, or use publishMode branch",
				);
			if (!isJsonNumber(id) || !Number.isSafeInteger(id) || id <= 0)
				reject(
					"GitHub Pages desired.actionsArtifactId must be a positive integer",
				);
			const actionsArtifactDigest = parseSha256Digest(
				desired.actionsArtifactDigest,
				"actionsArtifactDigest",
			);
			return {
				...common,
				publishMode: "pages-deployment",
				actionsArtifactId: id,
				actionsArtifactDigest,
			};
		}
		return unsupported(
			`GitHub Pages desired.publishMode ${JSON.stringify(mode)} is not one of ${GITHUB_PAGES_PUBLISH_MODES.join(", ")}`,
			"declare publishMode branch or pages-deployment",
		);
	}

	async function content(t: Target): Promise<SiteContent> {
		const index = await options.artifacts.get(t.artifactDigest);
		if (index === undefined)
			reject(
				`static-site tree index ${t.artifactDigest} is not in the artifact store`,
				"re-put the build output into the artifact store and re-record the Freight",
			);
		return loadSiteContent(
			parseStaticSiteTree(index, t.artifactDigest),
			(digest) => options.artifacts.get(digest),
		);
	}

	async function session(t: Target, supplied: HttpTransport): Promise<Session> {
		const transport = guardTransport(supplied, api.policy);
		const credential = await options.resolveCredential(t.request.credentialRef);
		if (!isJsonString(credential) || !TOKEN.test(credential))
			fail(
				"RESOLVER_CREDENTIAL_MISSING",
				"GitHub credential is missing or malformed",
			);
		const prefix = `${api.base}/repos/${t.owner}/${t.repo}`;

		function call(
			method: TransportMethod,
			path: string,
			body?: JsonObject,
			query?: string,
		) {
			return transport({
				method,
				url: `${prefix}${path}${query ? `?${query}` : ""}`,
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${credential}`,
					"user-agent": "hobo-provider-github",
					"x-github-api-version": GITHUB_API_VERSION,
					...(body === undefined
						? undefined
						: { "content-type": "application/json" }),
				},
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
				timeoutMs: GITHUB_TIMEOUT_MS,
				maxResponseBytes: GITHUB_MAX_RESPONSE_BYTES,
			});
		}

		function screen(response: TransportResponse, what: string): void {
			if (response.status === 401)
				refuse(
					"github-credential-rejected",
					`GitHub rejected the credential for ${what} with HTTP 401`,
					"re-issue the GitHub token behind credentialRef",
				);
			if (
				response.status === 429 ||
				(response.status === 403 && rateLimited(response))
			)
				refuse(
					"github-rate-limited",
					`GitHub rate-limited ${what} (HTTP ${response.status})`,
					"reconcile again after the rate-limit window resets; nothing was changed by the refused call",
				);
			if (response.status === 403)
				refuse(
					"github-permission-missing",
					`GitHub refused ${what} with HTTP 403`,
					"grant the token behind credentialRef contents: write and pages: write on the repository (and lift any branch protection that blocks it)",
				);
		}

		return {
			async get(path, query) {
				let response: TransportResponse;
				try {
					response = await call("GET", path, undefined, query);
				} catch (error) {
					if (error instanceof ResolverError) throw error;
					return reject(
						"GitHub read failed in transport",
						"retry the reconcile; reads are side-effect free",
					);
				}
				screen(response, `GET ${path}`);
				if (response.status === 404) return { status: 404 };
				if (response.status < 200 || response.status >= 300)
					reject(
						`GitHub GET ${path} returned HTTP ${response.status}`,
						"retry the reconcile; reads are side-effect free",
					);
				return { status: response.status, body: json(response.body) };
			},
			async send(method, path, body) {
				let response: TransportResponse;
				try {
					response = await call(method, path, body);
				} catch (error) {
					if (error instanceof ResolverError) throw error;
					// The request may have reached GitHub: ambiguous, so the caller
					// resolves it by observation.
					return undefined;
				}
				screen(response, `${method} ${path}`);
				return response;
			},
		};
	}

	async function observeRepo(
		s: Session,
		t: Target,
	): Promise<{ readonly push: boolean | undefined }> {
		const read = await s.get("");
		if (read.body === undefined)
			refuse(
				"github-permission-missing",
				`repository ${t.physicalId} is not visible to the credential (HTTP 404)`,
				"check the owner and repository names and grant the token access to the repository",
			);
		const permissions = read.body.permissions;
		const push =
			isJsonObject(permissions) && isJsonBoolean(permissions.push)
				? permissions.push
				: undefined;
		return { push };
	}

	async function observePages(s: Session): Promise<PagesView | undefined> {
		const read = await s.get("/pages");
		if (read.body === undefined) return undefined;
		const body = read.body;
		// GHES releases before build_type existed only build from branches.
		const buildType = body.build_type === "workflow" ? "workflow" : "legacy";
		const source = isJsonObject(body.source) ? body.source : {};
		return {
			buildType,
			sourceBranch: isJsonString(source.branch) ? source.branch : null,
			sourcePath: isJsonString(source.path) ? source.path : null,
			htmlUrl: isJsonString(body.html_url) ? body.html_url : null,
		};
	}

	/** Pages must be enabled and configured for the declared mode; the realizer never reconfigures it. */
	function requirePages(t: Target, pages: PagesView | undefined): PagesView {
		if (pages === undefined)
			refuse(
				"github-pages-disabled",
				`GitHub Pages is not enabled for ${t.physicalId}`,
				t.publishMode === "branch"
					? `enable Pages in the repository settings with source "Deploy from a branch" ${t.branch} ${t.path}`
					: 'enable Pages in the repository settings with source "GitHub Actions"',
			);
		if (t.publishMode === "branch") {
			if (
				pages.buildType !== "legacy" ||
				pages.sourceBranch !== t.branch ||
				pages.sourcePath !== t.path
			)
				refuse(
					"github-pages-source-mismatch",
					`${t.physicalId} Pages publishes from ${pages.buildType === "workflow" ? "GitHub Actions" : `${pages.sourceBranch ?? "?"} ${pages.sourcePath ?? "?"}`}, not branch ${t.branch} ${t.path}`,
					`set the Pages source to "Deploy from a branch" ${t.branch} ${t.path}, or declare the matching publishMode, branch and path`,
				);
		} else if (pages.buildType !== "workflow")
			refuse(
				"github-pages-source-mismatch",
				`${t.physicalId} Pages builds from a branch, so the Pages deployments API cannot publish to it`,
				'set the Pages source to "GitHub Actions", or declare publishMode branch',
			);
		return pages;
	}

	async function observeBranch(
		s: Session,
		t: Target & BranchTarget,
	): Promise<BranchView> {
		const ref = await s.get(`/git/ref/heads/${t.branch}`);
		if (ref.body === undefined)
			return { headSha: null, rootTree: null, publishedTree: null };
		const object = isJsonObject(ref.body.object) ? ref.body.object : {};
		const headSha = object.sha;
		if (
			object.type !== "commit" ||
			!isJsonString(headSha) ||
			!SHA1.test(headSha)
		)
			unparseable(`GitHub ref heads/${t.branch} does not point at a commit`);
		const commit = await s.get(`/git/commits/${headSha}`);
		const tree =
			commit.body && isJsonObject(commit.body.tree)
				? commit.body.tree.sha
				: undefined;
		if (!isJsonString(tree) || !SHA1.test(tree))
			return unparseable(`GitHub commit ${headSha} has no tree`);
		if (t.path === "/") return { headSha, rootTree: tree, publishedTree: tree };
		const listing = await s.get(`/git/trees/${tree}`);
		const entries =
			listing.body && isJsonArray(listing.body.tree) ? listing.body.tree : [];
		const docs = entries.find(
			(entry) =>
				isJsonObject(entry) && entry.path === "docs" && entry.type === "tree",
		);
		const docsSha =
			isJsonObject(docs) && isJsonString(docs.sha) && SHA1.test(docs.sha)
				? docs.sha
				: null;
		return { headSha, rootTree: tree, publishedTree: docsSha };
	}

	async function observeBuild(s: Session): Promise<BuildView | undefined> {
		const read = await s.get("/pages/builds/latest");
		if (read.body === undefined) return undefined;
		const status = read.body.status;
		if (!isJsonString(status))
			return unparseable("GitHub Pages build has no status");
		const commit = read.body.commit;
		return {
			status,
			commit: isJsonString(commit) && SHA1.test(commit) ? commit : null,
		};
	}

	function judgeBranch(
		t: Target & BranchTarget,
		site: SiteContent,
		pages: PagesView,
		branch: BranchView,
		build: BuildView | undefined,
	): Judged {
		const contentMatches = branch.publishedTree === site.treeSha;
		const buildForHead =
			build !== undefined &&
			branch.headSha !== null &&
			build.commit === branch.headSha;
		const ready = contentMatches && buildForHead && build?.status === "built";
		const errored =
			contentMatches && buildForHead && build?.status === "errored";
		const diagnostics: string[] = [];
		if (contentMatches && !buildForHead)
			diagnostics.push(
				`no Pages build has been observed for head ${branch.headSha ?? "?"} yet`,
			);
		return {
			ready,
			diagnostics,
			...(errored ? { failure: "build-errored" as const } : undefined),
			outputs: {
				...identity(t, site, pages),
				branch: t.branch,
				path: t.path,
				publishedTreeSha: branch.publishedTree,
				headCommitSha: branch.headSha,
				pagesBuildStatus: build?.status ?? null,
				pagesBuildCommitSha: build?.commit ?? null,
				contentMatches,
				...lifecycle(ready, contentMatches),
			},
		};
	}

	function identity(
		t: Target,
		site: SiteContent,
		pages: PagesView,
	): JsonObject {
		return {
			owner: t.owner,
			repo: t.repo,
			publishMode: t.publishMode,
			artifactDigest: t.artifactDigest,
			treeSha: site.treeSha,
			fileCount: site.blobs.length,
			htmlUrl: pages.htmlUrl,
		};
	}

	function outcome(
		action: ResolverAction,
		t: Target,
		judged: Judged,
	): ResolveOutcome {
		return {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: t.physicalId,
			outputs: judged.outputs,
			diagnostics: [...judged.diagnostics],
		};
	}

	function steady(t: Target): ResolverAction {
		return t.request.ref.physicalId === t.physicalId ? "noop" : "adopt";
	}

	/** Issue a mutation and require one of `ok`; a lost reply or other status is reported, not thrown. */
	async function mutate(
		s: Session,
		method: TransportMethod,
		path: string,
		body?: JsonObject,
	): Promise<{ readonly response?: TransportResponse; readonly why: string }> {
		const response = await s.send(method, path, body);
		if (response === undefined) return { why: "the reply was lost" };
		return { response, why: `GitHub answered HTTP ${response.status}` };
	}

	async function uploadBlobs(
		s: Session,
		site: SiteContent,
		published: string | null,
	): Promise<void> {
		const known = new Set<string>();
		if (published !== null) {
			const listing = await s.get(`/git/trees/${published}`, "recursive=1");
			// A truncated listing proves nothing about absence: upload everything.
			if (
				listing.body &&
				listing.body.truncated !== true &&
				isJsonArray(listing.body.tree)
			)
				for (const entry of listing.body.tree)
					if (
						isJsonObject(entry) &&
						entry.type === "blob" &&
						isJsonString(entry.sha)
					)
						known.add(entry.sha);
		}
		const pending = new Map<string, SiteContent["blobs"][number]>();
		for (const blob of site.blobs)
			if (!known.has(blob.sha)) pending.set(blob.sha, blob);
		for (const blob of pending.values()) {
			const sent = await mutate(s, "POST", "/git/blobs", {
				content: Buffer.from(blob.bytes).toString("base64"),
				encoding: "base64",
			});
			if (sent.response && sent.response.status === 201) {
				if (json(sent.response.body).sha !== blob.sha)
					unparseable(
						`GitHub stored ${JSON.stringify(blob.path)} under a blob id other than its git blob id ${blob.sha}`,
					);
				continue;
			}
			// Ambiguous or refused: blobs are content-addressed, so look.
			const seen = await s.get(`/git/blobs/${blob.sha}`);
			if (seen.body === undefined)
				reject(
					`upload of ${JSON.stringify(blob.path)} is not observable on GitHub (${sent.why})`,
					"reconcile again; blob uploads are content-addressed and safe to repeat",
				);
		}
	}

	async function createTree(
		s: Session,
		body: JsonObject,
		expected: string | undefined,
	): Promise<string> {
		const sent = await mutate(s, "POST", "/git/trees", body);
		const sha =
			sent.response?.status === 201 ? json(sent.response.body).sha : undefined;
		if (!isJsonString(sha) || !SHA1.test(sha))
			return reject(
				`GitHub tree creation failed (${sent.why})`,
				"reconcile again; tree creation is content-addressed and safe to repeat",
			);
		if (expected !== undefined && sha !== expected)
			unparseable(
				`GitHub built tree ${sha}, not the locally computed Freight tree ${expected}`,
			);
		return sha;
	}

	async function push(
		s: Session,
		t: Target & BranchTarget,
		site: SiteContent,
		before: BranchView,
	): Promise<BranchView> {
		await uploadBlobs(s, site, before.publishedTree);
		const siteTree = await createTree(
			s,
			{
				tree: site.blobs.map((blob) => ({
					path: blob.path,
					mode: blob.mode,
					type: "blob",
					sha: blob.sha,
				})),
			},
			site.treeSha,
		);
		const root =
			t.path === "/"
				? siteTree
				: await createTree(
						s,
						{
							...(before.rootTree === null
								? undefined
								: { base_tree: before.rootTree }),
							tree: [
								{ path: "docs", mode: "040000", type: "tree", sha: siteTree },
							],
						},
						undefined,
					);
		const committed = await mutate(s, "POST", "/git/commits", {
			message: t.commitMessage,
			tree: root,
			parents: before.headSha === null ? [] : [before.headSha],
		});
		const commit =
			committed.response?.status === 201
				? json(committed.response.body)
				: undefined;
		const commitSha = commit?.sha;
		if (!isJsonString(commitSha) || !SHA1.test(commitSha))
			return reject(
				`GitHub commit creation failed (${committed.why})`,
				"reconcile again; an unreferenced commit is harmless",
			);
		if (!isJsonObject(commit?.tree) || commit.tree.sha !== root)
			unparseable(`GitHub commit ${commitSha} does not carry tree ${root}`);
		// Compare-and-swap: the commit's only parent is the observed head, so
		// `force: false` admits the update only if the head has not moved.
		const moved =
			before.headSha === null
				? await mutate(s, "POST", "/git/refs", {
						ref: `refs/heads/${t.branch}`,
						sha: commitSha,
					})
				: await mutate(s, "PATCH", `/git/refs/heads/${t.branch}`, {
						sha: commitSha,
						force: false,
					});
		const after = await observeBranch(s, t);
		if (after.publishedTree === site.treeSha) return after;
		if (after.headSha !== before.headSha)
			refuse(
				"github-ref-not-fast-forward",
				`heads/${t.branch} moved from ${before.headSha ?? "(absent)"} to ${after.headSha ?? "(absent)"} while publishing; the update is not a fast-forward and was not forced`,
				"reconcile again to publish on top of the new head, and stop other writers to the Pages branch",
			);
		return reject(
			`update of heads/${t.branch} to ${commitSha} is not observable on GitHub (${moved.why})`,
			"check branch protection and the token's contents: write; otherwise reconcile again, the next pass adopts or republishes",
		);
	}

	async function reconcileBranch(
		t: Target & BranchTarget,
		s: Session,
		site: SiteContent,
	): Promise<ResolveOutcome> {
		const repo = await observeRepo(s, t);
		const pages = requirePages(t, await observePages(s));
		let branch = await observeBranch(s, t);
		let action: ResolverAction | undefined;
		if (branch.publishedTree !== site.treeSha) {
			if (repo.push === false)
				refuse(
					"github-permission-missing",
					`the credential cannot push to ${t.physicalId}`,
					"grant the token behind credentialRef contents: write on the repository",
				);
			action = branch.headSha === null ? "create" : "update";
			branch = await push(s, t, site, branch);
		}
		let build = await observeBuild(s);
		const inFlight = build?.status === "queued" || build?.status === "building";
		if (action === undefined && build?.commit !== branch.headSha && !inFlight) {
			// The content is published but no build of it was observed: ask for
			// one. Not done right after a push, where GitHub builds on its own.
			const requested = await s.send("POST", "/pages/builds");
			if (
				requested !== undefined &&
				requested.status >= 300 &&
				requested.status !== 409
			)
				reject(
					`GitHub refused the Pages build request with HTTP ${requested.status}`,
					"reconcile again",
				);
			build = await observeBuild(s);
		}
		const judged = judgeBranch(t, site, pages, branch, build);
		if (judged.failure === "build-errored")
			refuse(
				"github-pages-build-errored",
				`the Pages build of ${t.physicalId} at ${branch.headSha ?? "?"} errored`,
				"read the build error under the repository's Pages settings or Actions tab, fix the site and record new Freight",
			);
		return outcome(action ?? steady(t), t, judged);
	}

	async function observeActionsArtifact(
		s: Session,
		t: Target & DeploymentTarget,
	): Promise<void> {
		const read = await s.get(`/actions/artifacts/${t.actionsArtifactId}`);
		const body = read.body;
		if (body === undefined || body.expired === true)
			refuse(
				"github-pages-artifact-unavailable",
				`Actions artifact ${t.actionsArtifactId} of ${t.physicalId} is ${body === undefined ? "absent" : "expired"}`,
				"re-run the build workflow to upload the Pages artifact again and record the new artifact id on the Freight",
			);
		if (body.digest !== t.actionsArtifactDigest)
			refuse(
				"github-pages-artifact-unavailable",
				`Actions artifact ${t.actionsArtifactId} does not carry digest ${t.actionsArtifactDigest}`,
				"record the artifact id and digest the build workflow actually uploaded",
			);
	}

	function priorDeployment(t: Target, site: SiteContent): string | undefined {
		const observed = t.request.observed;
		if (observed === undefined) return undefined;
		const id = observed.pagesDeploymentId;
		return isJsonString(id) &&
			DEPLOYMENT_ID.test(id) &&
			observed.treeSha === site.treeSha &&
			observed.actionsArtifactId ===
				(t.publishMode === "pages-deployment" ? t.actionsArtifactId : undefined)
			? id
			: undefined;
	}

	async function deploymentStatus(
		s: Session,
		id: string,
	): Promise<string | undefined> {
		const read = await s.get(`/pages/deployments/${id}`);
		if (read.body === undefined) return undefined;
		const status = read.body.status;
		if (!isJsonString(status))
			return unparseable(`GitHub Pages deployment ${id} has no status`);
		return status;
	}

	function judgeDeployment(
		t: Target & DeploymentTarget,
		site: SiteContent,
		pages: PagesView,
		id: string | null,
		status: string | null,
	): Judged {
		const ready = status === "succeed";
		const failed = status !== null && DEPLOYMENT_TERMINAL_FAILURE.has(status);
		return {
			ready,
			diagnostics:
				id === null
					? ["no Pages deployment of this tree is known to the reconciler"]
					: [],
			...(failed ? { failure: "deployment-failed" as const } : undefined),
			outputs: {
				...identity(t, site, pages),
				actionsArtifactId: t.actionsArtifactId,
				pagesBuildVersion: site.treeSha,
				pagesDeploymentId: id,
				pagesDeploymentStatus: status,
				...lifecycle(ready, id !== null),
			},
		};
	}

	async function reconcileDeployment(
		t: Target & DeploymentTarget,
		s: Session,
		site: SiteContent,
	): Promise<ResolveOutcome> {
		await observeRepo(s, t);
		const pages = requirePages(t, await observePages(s));
		await observeActionsArtifact(s, t);
		const prior = priorDeployment(t, site);
		const priorStatus =
			prior === undefined ? undefined : await deploymentStatus(s, prior);
		let id = prior;
		let status = priorStatus;
		let action: ResolverAction = steady(t);
		if (status === undefined || DEPLOYMENT_RETRYABLE_FAILURE.has(status)) {
			const oidc = await options.resolveDeploymentOidcToken?.(
				t.request.credentialRef,
			);
			if (oidc === undefined)
				refuse(
					"github-pages-artifact-unavailable",
					"pages-deployment mode needs the workflow's OIDC token and the host binds no resolveDeploymentOidcToken",
					"run the reconcile inside the Pages workflow with id-token: write, or use publishMode branch",
				);
			if (!isJsonString(oidc) || !JWT.test(oidc))
				fail(
					"RESOLVER_CREDENTIAL_MISSING",
					"the deployment OIDC token is missing or malformed",
				);
			const sent = await mutate(s, "POST", "/pages/deployments", {
				artifact_id: t.actionsArtifactId,
				pages_build_version: site.treeSha,
				oidc_token: oidc,
				environment: "github-pages",
			});
			const created =
				sent.response && sent.response.status < 300
					? json(sent.response.body).id
					: undefined;
			const createdId = isJsonNumber(created) ? String(created) : created;
			if (!isJsonString(createdId) || !DEPLOYMENT_ID.test(createdId))
				reject(
					`Pages deployment of ${t.physicalId} is not observable (${sent.why})`,
					"reconcile again; redeploying the same artifact publishes identical content",
				);
			id = createdId;
			status = (await deploymentStatus(s, createdId)) ?? "deployment_queued";
			action = prior === undefined ? "create" : "update";
		}
		const judged = judgeDeployment(t, site, pages, id ?? null, status ?? null);
		if (judged.failure === "deployment-failed")
			refuse(
				"github-pages-deployment-failed",
				`Pages deployment ${id ?? "?"} of ${t.physicalId} failed on its content (${status ?? "?"})`,
				"fix the site content and record new Freight",
			);
		return outcome(action, t, judged);
	}

	const resolver: ResourceResolver = {
		providerId: GITHUB_PROVIDER_ID,
		productId: GITHUB_PAGES_SITE_PRODUCT_ID,
		directives: GITHUB_PAGES_DIRECTIVES,
		async read(raw, transport) {
			const t = target(raw);
			const site = await content(t);
			const s = await session(t, transport);
			await observeRepo(s, t);
			const observed = await observePages(s);
			if (observed === undefined) return undefined;
			const pages = requirePages(t, observed);
			if (t.publishMode === "branch") {
				const branch = await observeBranch(s, t);
				return outcome(
					steady(t),
					t,
					judgeBranch(t, site, pages, branch, await observeBuild(s)),
				);
			}
			const prior = priorDeployment(t, site);
			const status =
				prior === undefined ? undefined : await deploymentStatus(s, prior);
			return outcome(
				steady(t),
				t,
				judgeDeployment(
					t,
					site,
					pages,
					status === undefined ? null : (prior ?? null),
					status ?? null,
				),
			);
		},
		async reconcile(raw, transport) {
			const t = target(raw);
			const site = await content(t);
			const s = await session(t, transport);
			return t.publishMode === "branch"
				? reconcileBranch(t, s, site)
				: reconcileDeployment(t, s, site);
		},
		async delete(raw, transport) {
			const t = target(raw);
			// Retain: the site stays published; the resource is only released.
			if (t.onDelete === "retain") return;
			const s = await session(t, transport);
			if ((await observePages(s)) === undefined) return;
			const sent = await mutate(s, "DELETE", "/pages");
			if ((await observePages(s)) !== undefined)
				reject(
					`unpublishing ${t.physicalId} is not observable on GitHub (${sent.why})`,
					"check the token's pages: write (administration) rights; otherwise delete again",
				);
		},
	};
	return Object.freeze([resolver]);
}

function lifecycle(ready: boolean, confirmed: boolean): JsonObject {
	return {
		ready,
		operationConfirmed: confirmed,
		operationTerminal: ready,
		absenceConfirmed: false,
		lifecycleStatus: ready ? "ready" : confirmed ? "building" : "pending",
	};
}

function rateLimited(response: TransportResponse): boolean {
	const headers = Object.fromEntries(
		Object.entries(response.headers).map(([name, value]) => [
			name.toLowerCase(),
			value,
		]),
	);
	return (
		headers["x-ratelimit-remaining"] === "0" ||
		headers["retry-after"] !== undefined
	);
}

function json(body: string): JsonObject {
	let value: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this GitHub API boundary.
		value = JSON.parse(body) as JsonValue;
	} catch {
		return unparseable("GitHub returned a non-JSON body");
	}
	if (!isJsonObject(value)) unparseable("GitHub returned a non-object body");
	return value;
}

/** Registry of every GitHub product with a shipped resolver. */
export function githubResolverRegistry(options: GithubPagesResolverOptions) {
	return createResolverRegistry(createGithubPagesResolvers(options));
}
