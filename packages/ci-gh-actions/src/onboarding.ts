import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { type Connection, ConnectionSchema } from "@hobo/ci";
import { z } from "zod";
import {
	type GithubAppManifest,
	GithubAppManifestSchema,
	type OnboardingApplyResult,
	OnboardingApplyResultSchema,
	OnboardingFileSchema,
	type OnboardingPlan,
	OnboardingPlanSchema,
	type OnboardingPrincipal,
} from "./_generated/onboarding_pb.js";

export * from "./_generated/onboarding_pb.js";

/** App JWT metadata and installation-token repository requests stay in the relay. */
export interface OnboardingGithubPort {
	request(
		installationId: number,
		path: string,
		method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		body?: string,
	): Promise<Response>;
	appRequest(path: string): Promise<Response>;
}
export interface PrepareOnboardingOptions {
	principal: Pick<OnboardingPrincipal, "accountId" | "installationIds">;
	installationId: number;
	repository: string;
	expectedRepositoryId: number;
	relayUrl: string;
	trustedRefs: readonly string[];
	trustedRepositoryAcknowledged: boolean;
	publicRepoAcknowledged?: boolean;
	allowAllPullRequests?: boolean;
	isolatedHostAvailable?: boolean;
	runnerGroupId?: number;
	assets: { workflow: string; bootstrap: string };
}
declare const parsedPlan: unique symbol;
export type ParsedOnboardingPlan = OnboardingPlan & {
	readonly [parsedPlan]: true;
};

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Repository = z.object({
	id: Id,
	full_name: z.string(),
	private: z.boolean(),
	default_branch: z.string(),
});
const Installation = z.object({
	id: Id,
	app_id: Id,
	suspended_at: z.string().nullable(),
	permissions: z.record(z.string(), z.string()),
});
const Ref = z.object({
	ref: z.string(),
	object: z.object({ type: z.literal("commit"), sha: Sha }),
});
const Commit = z.object({
	sha: Sha,
	tree: z.object({ sha: Sha }),
	parents: z.array(z.object({ sha: Sha })),
});
const PullRequest = z.object({
	number: Id,
	html_url: z.string().url(),
	state: z.enum(["open", "closed"]),
	merged_at: z.string().nullable(),
	merge_commit_sha: Sha.nullable(),
	body: z.string().nullable(),
	head: z.object({ ref: z.string(), sha: Sha, repo: z.object({ id: Id }) }),
	base: z.object({ ref: z.string(), repo: z.object({ id: Id }) }),
});
const Protection = z.object({
	enforce_admins: z.object({ enabled: z.literal(true) }),
	lock_branch: z.object({ enabled: z.literal(true) }),
	allow_force_pushes: z.object({ enabled: z.literal(false) }),
	allow_deletions: z.object({ enabled: z.literal(false) }),
});
const WORKFLOW = ".github/workflows/hobo-ci-host.yml";
const BOOTSTRAP = ".hobo-ci/bootstrap.mts";
const REQUIRED_PERMISSIONS = {
	actions: "write",
	administration: "write",
	contents: "write",
	workflows: "write",
	metadata: "read",
	pull_requests: "write",
};

/** A setup PR must be merged by the repository's ordinary review policy. */
export class OnboardingPendingError extends Error {
	constructor(message = "HoBo installation pull request has not been merged") {
		super(message);
		this.name = "OnboardingPendingError";
	}
}
function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
function origin(input: string): string {
	const url = new URL(input);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("relay must be an HTTPS origin");
	return url.origin;
}

// Reject literal destinations GitHub.com cannot reach. Hostnames still require
// an independently reachable public HTTPS endpoint, such as a local tunnel.
const unreachableWebhookAddresses = new BlockList();
unreachableWebhookAddresses.addSubnet("0.0.0.0", 8, "ipv4");
unreachableWebhookAddresses.addSubnet("10.0.0.0", 8, "ipv4");
unreachableWebhookAddresses.addSubnet("100.64.0.0", 10, "ipv4");
unreachableWebhookAddresses.addSubnet("127.0.0.0", 8, "ipv4");
unreachableWebhookAddresses.addSubnet("169.254.0.0", 16, "ipv4");
unreachableWebhookAddresses.addSubnet("172.16.0.0", 12, "ipv4");
unreachableWebhookAddresses.addSubnet("192.168.0.0", 16, "ipv4");
unreachableWebhookAddresses.addAddress("::1", "ipv6");
unreachableWebhookAddresses.addAddress("::", "ipv6");
unreachableWebhookAddresses.addSubnet("fc00::", 7, "ipv6");
unreachableWebhookAddresses.addSubnet("fe80::", 10, "ipv6");
function assertGithubReachable(url: URL): void {
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
	const family = isIP(host);
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		(family === 4 && unreachableWebhookAddresses.check(host, "ipv4")) ||
		(family === 6 && unreachableWebhookAddresses.check(host, "ipv6"))
	)
		throw new Error(
			"GitHub App webhook origin must be publicly reachable; use a public HTTPS tunnel for local development",
		);
}
function repositoryName(input: string): void {
	if (
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input) ||
		input.split("/").some((part) => part === "." || part === "..")
	)
		throw new Error("invalid repository");
}
function branchName(input: string): void {
	if (
		input.length > 200 ||
		!/^[A-Za-z0-9_./-]+$/.test(input) ||
		input.startsWith("/") ||
		input.endsWith("/") ||
		input.endsWith(".") ||
		input.includes("..") ||
		input.includes("//") ||
		input
			.split("/")
			.some((part) => part.startsWith(".") || part.endsWith(".lock"))
	)
		throw new Error("invalid Git branch ref");
}
function authorize(
	principal: Pick<OnboardingPrincipal, "accountId" | "installationIds">,
	accountId: string,
	installationId: number,
): void {
	if (
		!/^[A-Za-z0-9_-]{1,80}$/.test(accountId) ||
		principal.accountId !== accountId ||
		!Number.isSafeInteger(installationId) ||
		installationId <= 0 ||
		!principal.installationIds.includes(installationId)
	)
		throw new Error("installation is not authorized for this HoBo account");
}
async function json(response: Response) {
	if (!response.ok)
		throw new Error(`GitHub onboarding request failed (${response.status})`);
	return response.json();
}
function api(
	github: OnboardingGithubPort,
	installationId: number,
	path: string,
	method: "GET" | "POST" | "PUT" = "GET",
	body?: string,
) {
	return github.request(installationId, path, method, body);
}

export function createGithubAppManifest(options: {
	name: string;
	relayUrl: string;
	manifestCallbackUrl: string;
	installationCallbackUrl: string;
}): GithubAppManifest {
	const relay = origin(options.relayUrl);
	assertGithubReachable(new URL(relay));
	const callback = (value: string) => {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.hash)
			throw new Error("GitHub App callback must be an HTTPS URL");
		return url.href;
	};
	if (!options.name.trim() || options.name.length > 100)
		throw new Error("invalid GitHub App name");
	return create(GithubAppManifestSchema, {
		name: options.name,
		url: relay,
		hookAttributes: { url: `${relay}/github/webhooks`, active: true },
		redirectUrl: callback(options.manifestCallbackUrl),
		setupUrl: callback(options.installationCallbackUrl),
		callbackUrls: [`${relay}/v1/app-registration/oauth/callback`],
		public: true,
		defaultEvents: ["workflow_job", "workflow_run"],
		// Required for GitHub App user tokens to verify an organization administrator.
		defaultPermissions: { ...REQUIRED_PERMISSIONS, members: "read" },
	});
}
/** GitHub's manifest uses snake_case; protobuf JSON names are explicitly pinned. */
export function githubAppManifestJson(manifest: GithubAppManifest): string {
	return toJsonString(GithubAppManifestSchema, manifest, {
		alwaysEmitImplicit: true,
	});
}

async function identity(
	github: OnboardingGithubPort,
	installationId: number,
	repository: string,
	expectedRepositoryId: number,
	publicAccess: { acknowledged: boolean; isolatedHostAvailable: boolean },
) {
	const app = z
		.object({ id: Id, slug: z.string().regex(/^[A-Za-z0-9_-]+$/) })
		.parse(await json(await github.appRequest("/app")));
	const installation = Installation.parse(
		await json(await github.appRequest(`/app/installations/${installationId}`)),
	);
	if (
		installation.id !== installationId ||
		installation.app_id !== app.id ||
		installation.suspended_at !== null
	)
		throw new Error("GitHub installation identity is not active for this App");
	for (const [permission, level] of Object.entries(REQUIRED_PERMISSIONS)) {
		if (
			installation.permissions[permission] !== level &&
			!(level === "read" && installation.permissions[permission] === "write")
		)
			throw new Error(
				`GitHub App installation requires ${permission}:${level}`,
			);
	}
	const association = z
		.object({ id: Id, app_id: Id })
		.parse(
			await json(await github.appRequest(`/repos/${repository}/installation`)),
		);
	if (association.id !== installationId || association.app_id !== app.id)
		throw new Error("repository belongs to another GitHub App installation");
	const repo = Repository.parse(
		await json(await api(github, installationId, `/repos/${repository}`)),
	);
	if (
		repo.id !== expectedRepositoryId ||
		repo.full_name.toLowerCase() !== repository.toLowerCase()
	)
		throw new Error("GitHub repository identity changed");
	if (
		!repo.private &&
		!(publicAccess.acknowledged && publicAccess.isolatedHostAvailable)
	)
		throw new Error(
			"public repositories require acknowledgment and an isolated runner provider",
		);
	branchName(repo.default_branch);
	const bot = z
		.object({ id: Id, login: z.string(), type: z.literal("Bot") })
		.parse(await json(await github.appRequest(`/users/${app.slug}%5Bbot%5D`)));
	if (bot.login !== `${app.slug}[bot]`)
		throw new Error("unexpected GitHub App bot identity");
	return { repo, bot };
}
function planDigest(plan: OnboardingPlan): string {
	return hash(
		toJsonString(OnboardingPlanSchema, {
			...plan,
			planDigest: "",
		}),
	);
}
function planBranchNames(plan: OnboardingPlan): string {
	return hash(
		toJsonString(OnboardingPlanSchema, {
			...plan,
			installBranch: "",
			bridgeRef: "",
			planDigest: "",
		}),
	).slice(0, 20);
}
export function parseOnboardingPlan(input: string): ParsedOnboardingPlan {
	const plan = fromJsonString(OnboardingPlanSchema, input);
	repositoryName(plan.repository);
	branchName(plan.defaultBranch);
	if (
		!Number.isSafeInteger(plan.repositoryId) ||
		plan.repositoryId < 1 ||
		!Number.isSafeInteger(plan.installationId) ||
		plan.installationId < 1 ||
		!Number.isSafeInteger(plan.dispatcherActorId) ||
		plan.dispatcherActorId < 1 ||
		plan.runnerGroupId < 1 ||
		!/^[A-Za-z0-9_-]{1,80}$/.test(plan.accountId) ||
		!Sha.safeParse(plan.baseSha).success ||
		!Sha.safeParse(plan.baseTreeSha).success ||
		plan.bridgeWorkflow !== "hobo-ci-host.yml" ||
		!plan.trustedRepositoryAcknowledged ||
		plan.trustedRefs.length < 1 ||
		plan.trustedRefs.length > 100 ||
		new Set(plan.trustedRefs).size !== plan.trustedRefs.length ||
		plan.files.length !== 2 ||
		plan.files[0]?.path !== WORKFLOW ||
		plan.files[1]?.path !== BOOTSTRAP ||
		origin(plan.relayUrl) !== plan.relayUrl
	)
		throw new Error("invalid onboarding plan");
	for (const ref of plan.trustedRefs) {
		if (!ref.startsWith("refs/heads/"))
			throw new Error("trusted branch ref required");
		branchName(ref.slice("refs/heads/".length));
	}
	for (const file of plan.files) {
		if (
			!file.content ||
			Buffer.byteLength(file.content) > 1024 * 1024 ||
			hash(file.content) !== file.sha256
		)
			throw new Error("onboarding artifact digest mismatch");
		Object.freeze(file);
	}
	const suffix = planBranchNames(plan);
	if (
		plan.installBranch !== `hobo-ci-install-${suffix}` ||
		plan.bridgeRef !== `hobo-ci-bridge-${suffix}` ||
		planDigest(plan) !== plan.planDigest
	)
		throw new Error("onboarding plan digest mismatch");
	Object.freeze(plan.trustedRefs);
	Object.freeze(plan.files);
	// SAFETY: protobuf parsing, dependent identity/content constraints and deep freezing establish the derived plan.
	return Object.freeze(plan) as ParsedOnboardingPlan;
}
function checkedPlan(plan: OnboardingPlan): ParsedOnboardingPlan {
	return parseOnboardingPlan(toJsonString(OnboardingPlanSchema, plan));
}
export async function prepareOnboarding(
	github: OnboardingGithubPort,
	options: PrepareOnboardingOptions,
): Promise<ParsedOnboardingPlan> {
	authorize(
		options.principal,
		options.principal.accountId,
		options.installationId,
	);
	repositoryName(options.repository);
	const relay = origin(options.relayUrl);
	if (!options.trustedRepositoryAcknowledged)
		throw new Error("trusted repository acknowledgment required");
	if (options.allowAllPullRequests && !options.isolatedHostAvailable)
		throw new Error("isolated runner required for pull requests");
	const { repo, bot } = await identity(
		github,
		options.installationId,
		options.repository,
		options.expectedRepositoryId,
		{
			acknowledged: options.publicRepoAcknowledged === true,
			isolatedHostAvailable: options.isolatedHostAvailable === true,
		},
	);
	const ref = Ref.parse(
		await json(
			await api(
				github,
				options.installationId,
				`/repos/${repo.full_name}/git/ref/heads/${repo.default_branch}`,
			),
		),
	);
	if (ref.ref !== `refs/heads/${repo.default_branch}`)
		throw new Error("unexpected default branch ref");
	const commit = Commit.parse(
		await json(
			await api(
				github,
				options.installationId,
				`/repos/${repo.full_name}/git/commits/${ref.object.sha}`,
			),
		),
	);
	if (commit.sha !== ref.object.sha)
		throw new Error("default branch commit mismatch");
	const placeholder = "${{ vars.HOBO_CI_RELAY_URL }}";
	if (options.assets.workflow.split(placeholder).length !== 2)
		throw new Error(
			"workflow asset must contain exactly one relay origin placeholder",
		);
	// .mts keeps the reviewed ESM bootstrap executable even in a CommonJS repository.
	const workflow = options.assets.workflow
		.replace(placeholder, JSON.stringify(relay))
		.replaceAll(".hobo-ci/bootstrap.ts", BOOTSTRAP);
	const plan = create(OnboardingPlanSchema, {
		accountId: options.principal.accountId,
		installationId: options.installationId,
		repository: repo.full_name,
		repositoryId: repo.id,
		defaultBranch: repo.default_branch,
		baseSha: ref.object.sha,
		baseTreeSha: commit.tree.sha,
		bridgeWorkflow: "hobo-ci-host.yml",
		runnerGroupId: options.runnerGroupId ?? 1,
		dispatcherActorId: bot.id,
		trustedRefs: [...options.trustedRefs].sort(),
		publicRepoAcknowledged: options.publicRepoAcknowledged ?? false,
		allowAllPullRequests: options.allowAllPullRequests ?? false,
		trustedRepositoryAcknowledged: true,
		files: [
			create(OnboardingFileSchema, {
				path: WORKFLOW,
				content: workflow,
				sha256: hash(workflow),
			}),
			create(OnboardingFileSchema, {
				path: BOOTSTRAP,
				content: options.assets.bootstrap,
				sha256: hash(options.assets.bootstrap),
			}),
		],
		relayUrl: relay,
	});
	const suffix = planBranchNames(plan);
	plan.installBranch = `hobo-ci-install-${suffix}`;
	plan.bridgeRef = `hobo-ci-bridge-${suffix}`;
	plan.planDigest = planDigest(plan);
	return checkedPlan(plan);
}

async function verifyFiles(
	github: OnboardingGithubPort,
	plan: OnboardingPlan,
	sha: string,
): Promise<void> {
	for (const file of plan.files) {
		const result = z
			.object({
				type: z.literal("file"),
				encoding: z.literal("base64"),
				content: z.string(),
				size: z.number().int().nonnegative(),
			})
			.parse(
				await json(
					await api(
						github,
						plan.installationId,
						`/repos/${plan.repository}/contents/${file.path}?ref=${sha}`,
					),
				),
			);
		const encoded = result.content.replace(/\s/g, "");
		if (
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				encoded,
			)
		)
			throw new Error("invalid GitHub file encoding");
		const bytes = Buffer.from(encoded, "base64");
		if (
			result.size !== bytes.length ||
			!bytes.equals(Buffer.from(file.content))
		)
			throw new Error(
				"installed HoBo artifact does not match reviewed content",
			);
	}
}
async function findPullRequest(
	github: OnboardingGithubPort,
	plan: OnboardingPlan,
) {
	const owner = plan.repository.split("/")[0];
	const query = new URLSearchParams({
		state: "all",
		head: `${owner}:${plan.installBranch}`,
		per_page: "100",
	});
	const requests = z
		.array(PullRequest)
		.parse(
			await json(
				await api(
					github,
					plan.installationId,
					`/repos/${plan.repository}/pulls?${query}`,
				),
			),
		);
	if (requests.length >= 100)
		throw new Error(
			"onboarding pull request lookup is ambiguous; reconcile history",
		);
	const matches = requests.filter(
		(pr) =>
			pr.head.ref === plan.installBranch &&
			pr.head.repo.id === plan.repositoryId &&
			pr.base.ref === plan.defaultBranch &&
			pr.base.repo.id === plan.repositoryId &&
			pr.body?.includes(`HoBo onboarding plan: ${plan.planDigest}`),
	);
	if (matches.length > 1) throw new Error("ambiguous onboarding pull requests");
	return matches[0];
}
async function planIdentity(
	github: OnboardingGithubPort,
	plan: OnboardingPlan,
	isolatedHostAvailable: boolean,
) {
	const found = await identity(
		github,
		plan.installationId,
		plan.repository,
		plan.repositoryId,
		{
			acknowledged: plan.publicRepoAcknowledged,
			isolatedHostAvailable,
		},
	);
	if (
		found.repo.default_branch !== plan.defaultBranch ||
		found.bot.id !== plan.dispatcherActorId
	)
		throw new Error("onboarding repository or App identity changed");
}

/** Creates only a setup branch and PR. Never updates/bypasses the default branch. */
export async function applyOnboarding(
	github: OnboardingGithubPort,
	principal: Pick<OnboardingPrincipal, "accountId" | "installationIds">,
	input: OnboardingPlan,
	isolatedHostAvailable = false,
): Promise<OnboardingApplyResult> {
	const plan = checkedPlan(input);
	authorize(principal, plan.accountId, plan.installationId);
	await planIdentity(github, plan, isolatedHostAvailable);
	const prefix = `/repos/${plan.repository}`;
	let branchResponse = await api(
		github,
		plan.installationId,
		`${prefix}/git/ref/heads/${plan.installBranch}`,
	);
	if (branchResponse.status === 404) {
		const base = Commit.parse(
			await json(
				await api(
					github,
					plan.installationId,
					`${prefix}/git/commits/${plan.baseSha}`,
				),
			),
		);
		if (base.sha !== plan.baseSha || base.tree.sha !== plan.baseTreeSha)
			throw new Error("reviewed source tree changed");
		const tree = z.object({ sha: Sha }).parse(
			await json(
				await api(
					github,
					plan.installationId,
					`${prefix}/git/trees`,
					"POST",
					JSON.stringify({
						base_tree: plan.baseTreeSha,
						tree: plan.files.map((file) => ({
							path: file.path,
							mode: "100644",
							type: "blob",
							content: file.content,
						})),
					}),
				),
			),
		);
		const commit = z.object({ sha: Sha }).parse(
			await json(
				await api(
					github,
					plan.installationId,
					`${prefix}/git/commits`,
					"POST",
					JSON.stringify({
						message: `Configure HoBo CI\n\nHoBo onboarding plan: ${plan.planDigest}`,
						tree: tree.sha,
						parents: [plan.baseSha],
					}),
				),
			),
		);
		const created = await api(
			github,
			plan.installationId,
			`${prefix}/git/refs`,
			"POST",
			JSON.stringify({
				ref: `refs/heads/${plan.installBranch}`,
				sha: commit.sha,
			}),
		);
		// A ref-create response can be lost or race a retry; re-read the named ref, never create a second branch.
		if (!created.ok && ![409, 422, 500, 502, 503, 504].includes(created.status))
			await json(created);
		branchResponse = await api(
			github,
			plan.installationId,
			`${prefix}/git/ref/heads/${plan.installBranch}`,
		);
	}
	const branch = Ref.parse(await json(branchResponse));
	if (branch.ref !== `refs/heads/${plan.installBranch}`)
		throw new Error("unexpected installation branch");
	const branchCommit = Commit.parse(
		await json(
			await api(
				github,
				plan.installationId,
				`${prefix}/git/commits/${branch.object.sha}`,
			),
		),
	);
	if (
		branchCommit.sha !== branch.object.sha ||
		branchCommit.parents.length !== 1 ||
		branchCommit.parents[0]?.sha !== plan.baseSha
	)
		throw new Error(
			"installation branch does not match reviewed source parent",
		);
	const diff = z
		.object({
			status: z.literal("ahead"),
			total_commits: z.literal(1),
			files: z.array(
				z.object({
					filename: z.string(),
					status: z.enum(["added", "modified"]),
				}),
			),
		})
		.parse(
			await json(
				await api(
					github,
					plan.installationId,
					`${prefix}/compare/${plan.baseSha}...${branch.object.sha}`,
				),
			),
		);
	if (
		diff.files.length > plan.files.length ||
		new Set(diff.files.map((file) => file.filename)).size !==
			diff.files.length ||
		diff.files.some(
			(file) => !plan.files.some((expected) => expected.path === file.filename),
		)
	)
		throw new Error(
			"installation branch contains changes outside reviewed files",
		);
	await verifyFiles(github, plan, branch.object.sha);
	let pr = await findPullRequest(github, plan);
	if (!pr) {
		const response = await api(
			github,
			plan.installationId,
			`${prefix}/pulls`,
			"POST",
			JSON.stringify({
				title: "Configure HoBo CI",
				head: plan.installBranch,
				base: plan.defaultBranch,
				body: `Install the reviewed HoBo runner bridge. Merge under this repository's normal policy, then complete the HoBo connection.\n\nHoBo onboarding plan: ${plan.planDigest}`,
			}),
		);
		if (response.ok) {
			pr = PullRequest.parse(await response.json());
		} else {
			// A retry discovers the single deterministic PR rather than blindly replaying a create.
			pr = await findPullRequest(github, plan);
			if (!pr) await json(response);
		}
	}
	if (
		!pr ||
		pr.head.ref !== plan.installBranch ||
		pr.head.sha !== branch.object.sha ||
		pr.head.repo.id !== plan.repositoryId ||
		pr.base.ref !== plan.defaultBranch ||
		pr.base.repo.id !== plan.repositoryId ||
		!pr.body?.includes(`HoBo onboarding plan: ${plan.planDigest}`) ||
		!pr.html_url.startsWith(`https://github.com/${plan.repository}/pull/`)
	)
		throw new Error("unexpected onboarding pull request identity");
	if (pr.state === "closed" && !pr.merged_at)
		throw new OnboardingPendingError(
			"HoBo installation pull request was closed without merging",
		);
	return create(OnboardingApplyResultSchema, {
		status: "pending",
		pullRequestNumber: pr.number,
		pullRequestUrl: pr.html_url,
		branch: plan.installBranch,
		commitSha: branch.object.sha,
		planDigest: plan.planDigest,
	});
}

/** Only a merged, byte-verified setup and a locked protected pin may become a Connection. */
export async function connectRepository(
	github: OnboardingGithubPort,
	principal: Pick<OnboardingPrincipal, "accountId" | "installationIds">,
	input: OnboardingPlan,
	isolatedHostAvailable = false,
): Promise<Connection> {
	const plan = checkedPlan(input);
	authorize(principal, plan.accountId, plan.installationId);
	await planIdentity(github, plan, isolatedHostAvailable);
	const prefix = `/repos/${plan.repository}`;
	const pr = await findPullRequest(github, plan);
	if (!pr?.merged_at || !pr.merge_commit_sha)
		throw new OnboardingPendingError();
	const head = Ref.parse(
		await json(
			await api(
				github,
				plan.installationId,
				`${prefix}/git/ref/heads/${plan.defaultBranch}`,
			),
		),
	);
	if (head.ref !== `refs/heads/${plan.defaultBranch}`)
		throw new Error("unexpected default branch ref");
	await verifyFiles(github, plan, head.object.sha);
	await verifyFiles(github, plan, pr.merge_commit_sha);
	const bridgePath = `${prefix}/git/ref/heads/${plan.bridgeRef}`;
	let bridgeResponse = await api(github, plan.installationId, bridgePath);
	if (bridgeResponse.status === 404) {
		const created = await api(
			github,
			plan.installationId,
			`${prefix}/git/refs`,
			"POST",
			JSON.stringify({
				ref: `refs/heads/${plan.bridgeRef}`,
				sha: pr.merge_commit_sha,
			}),
		);
		if (!created.ok && ![409, 422, 500, 502, 503, 504].includes(created.status))
			await json(created);
		bridgeResponse = await api(github, plan.installationId, bridgePath);
	}
	const bridge = Ref.parse(await json(bridgeResponse));
	if (
		bridge.ref !== `refs/heads/${plan.bridgeRef}` ||
		bridge.object.sha !== pr.merge_commit_sha
	)
		throw new Error("bridge ref does not match the reviewed merged commit");
	const protectionPath = `${prefix}/branches/${plan.bridgeRef}/protection`;
	const protection = await api(github, plan.installationId, protectionPath);
	if (protection.status === 404) {
		await json(
			await api(
				github,
				plan.installationId,
				protectionPath,
				"PUT",
				JSON.stringify({
					required_status_checks: null,
					enforce_admins: true,
					required_pull_request_reviews: null,
					restrictions: null,
					allow_force_pushes: false,
					allow_deletions: false,
					lock_branch: true,
				}),
			),
		);
	} else {
		Protection.parse(await json(protection));
	}
	Protection.parse(
		await json(await api(github, plan.installationId, protectionPath)),
	);
	const pinned = Ref.parse(
		await json(await api(github, plan.installationId, bridgePath)),
	);
	if (pinned.ref !== bridge.ref || pinned.object.sha !== bridge.object.sha)
		throw new Error("bridge ref moved while applying protection");
	return create(ConnectionSchema, {
		accountId: plan.accountId,
		repository: plan.repository,
		repositoryId: plan.repositoryId,
		installationId: plan.installationId,
		bridgeWorkflow: plan.bridgeWorkflow,
		bridgeSha: pinned.object.sha,
		bridgeRef: plan.bridgeRef,
		runnerGroupId: plan.runnerGroupId,
		dispatcherActorId: plan.dispatcherActorId,
		allowedEvents: plan.allowAllPullRequests
			? ["push", "workflow_dispatch", "pull_request"]
			: ["push", "workflow_dispatch"],
		allowedRefs: [...plan.trustedRefs],
		trustedRepositoryAcknowledged: true,
		publicRepositoryAcknowledged: plan.publicRepoAcknowledged,
		allowAllPullRequests: plan.allowAllPullRequests,
	});
}
