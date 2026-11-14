/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this preflight checks untrusted source and provider response fields before constructing evidence. */
/** Read-only Vercel Git deployment source and schedule capability preflight. */
import { parseSecretRef } from "@hobo/bindings";
import {
	canonicalJson,
	guardTransport,
	type HttpTransport,
	ResolverError,
	type TransportRequest,
} from "@hobo/core";
import {
	type VercelBillingPlan,
	type VercelDeploymentComponent,
	verifyVercelDeploymentComponent,
} from "./deployment-components.js";
import { vercelPreviewBranch } from "./git-branch.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "./json.js";
import type { VercelResolverOptions } from "./resolvers.js";

export type VercelDeploymentPreflightInput = Readonly<{
	teamId: string;
	project: string;
	organization: string;
	repository: string;
	revision: string;
	rootDirectory: string;
	buildCommand: string;
	installCommand?: string;
	environment: "production" | "preview";
	previewBranch?: string;
	credentialRef: string;
	gitSourceAuthRef?: string;
	components: readonly VercelDeploymentComponent[];
	/** Additional approved function entries, including the public HTTP entry. */
	requiredEntries?: readonly string[];
	/** Routes approved on the HTTP binding, checked against the pinned source. */
	requiredRoutes?: readonly {
		readonly src: string;
		readonly dest: string;
		readonly transforms: readonly {
			readonly type: string;
			readonly op: string;
			readonly args: string;
		}[];
	}[];
}>;
export type VercelDeploymentPreflightEvidence = Readonly<{
	teamId: string;
	projectId?: string;
	projectAction: "create" | "update" | "none";
	gitLinkAction: "create-with-project" | "link" | "none";
	organization: string;
	repository: string;
	revision: string;
	environment: "production" | "preview";
	previewBranch?: string;
	componentsChecked: number;
	entriesChecked: number;
	routesChecked: number;
	billingPlan?: VercelBillingPlan;
	/** These are separate provider/runtime/financial checks, not source facts. */
	deploymentPermission: "not-observed";
	gitLinkPermission: "not-observed";
	scheduleCapacity: "not-observed";
	runtimeAuthentication: "not-observed";
	previewScheduleActivation: "requires-enable" | "not-applicable";
}>;

export class VercelDeploymentPreflightError extends ResolverError {
	constructor(
		readonly reason: "PROJECT_GIT_MISMATCH" | "UNSUPERVISED_GIT_DEPLOYMENT",
		message: string,
	) {
		super("RESOLVER_PRODUCT_UNSUPPORTED", message);
		this.name = "VercelDeploymentPreflightError";
	}
}

function fail(message: string): never {
	throw new ResolverError("RESOLVER_PRODUCT_UNSUPPORTED", message);
}
function id(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value))
		return fail("Vercel preflight requires scoped identifiers");
	return value;
}
function path(value: string): string {
	if (
		!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) ||
		value.split("/").some((part) => part === "." || part === "..")
	)
		return fail("Vercel preflight requires safe repository paths");
	return value;
}
function object(body: string) {
	const value = parseJsonValue(body);
	if (!isJsonObject(value))
		return fail("Provider preflight returned an invalid object");
	return value;
}
function check(status: number, operation: string) {
	if (status !== 200)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${operation} returned HTTP ${status}`,
		);
}

function checkedComponents(components: readonly VercelDeploymentComponent[]) {
	if (!Array.isArray(components) || components.length > 128)
		return fail("Vercel preflight component list is invalid");
	const seen = new Set<string>();
	for (const component of components) {
		if (
			!component ||
			!["queue", "schedule", "schedule-function", "cron"].includes(
				component.kind,
			)
		)
			return fail("Vercel preflight component kind is invalid");
		if (!/\.(?:[cm]?js|[cm]?ts)$/u.test(path(component.entry)))
			return fail(
				"Vercel preflight requires a JavaScript or TypeScript function entry",
			);
		let key: string;
		if (component.kind === "queue" || component.kind === "schedule") {
			if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(component.topic))
				return fail("Vercel queue topic has an invalid name");
			key =
				component.kind === "queue"
					? `queue:${component.topic}`
					: `schedule:${id(component.name)}`;
		} else if (component.kind === "schedule-function") {
			path(component.function);
			key = `schedule:${id(component.name)}`;
		} else {
			if (
				!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u.test(component.path) ||
				component.path.length > 512 ||
				component.path
					.split("/")
					.some((part: string) => part === "." || part === "..")
			)
				return fail("Vercel cron path must be an exact safe path");
			key = `cron:${component.path}`;
		}
		if (
			component.kind !== "queue" &&
			(!component.cron ||
				component.cron.length > 256 ||
				!Number.isSafeInteger(component.maximumJitterSeconds) ||
				component.maximumJitterSeconds < 0)
		)
			return fail("Vercel schedule timing requirements are invalid");
		if (seen.has(key)) return fail("Vercel deployment component is duplicated");
		seen.add(key);
	}
}

/** Only GETs are performed. This plans project creation, update and Git linking,
 * validates the exact remote commit and source files, and checks plan timing.
 * It does not claim budget, permissions, runtime readiness or schedule capacity. */
export async function preflightVercelGitDeployment(
	input: VercelDeploymentPreflightInput,
	options: VercelResolverOptions,
	transport: HttpTransport,
): Promise<VercelDeploymentPreflightEvidence> {
	const teamId = id(input.teamId),
		project = id(input.project),
		organization = id(input.organization),
		repository = id(input.repository),
		root = path(input.rootDirectory);
	if (options.teamId !== teamId)
		return fail("Vercel preflight differs from the verified team scope");
	if (!/^[a-f0-9]{40}$/u.test(input.revision))
		return fail("Vercel preflight requires a full Git SHA");
	if (input.environment !== "production" && input.environment !== "preview")
		return fail("Vercel preflight requires a production or preview target");
	if (
		!input.buildCommand ||
		input.buildCommand.length > 256 ||
		(input.installCommand !== undefined &&
			(!input.installCommand || input.installCommand.length > 256))
	)
		return fail("Vercel preflight requires bounded build settings");
	checkedComponents(input.components);
	const previewBranch =
		input.previewBranch === undefined
			? undefined
			: vercelPreviewBranch(input.previewBranch);
	if (previewBranch && input.environment !== "preview")
		return fail("Vercel preview branch is only valid for a preview deployment");
	if (
		input.environment === "preview" &&
		input.components.some(
			(component) =>
				component.kind === "schedule" || component.kind === "schedule-function",
		) &&
		!previewBranch
	)
		return fail("Vercel preview schedule requires an approved Git branch");
	if (
		input.requiredEntries !== undefined &&
		(!Array.isArray(input.requiredEntries) ||
			input.requiredEntries.length > 128 ||
			input.requiredEntries.some(
				(entry) =>
					typeof entry !== "string" ||
					!/\.(?:[cm]?js|[cm]?ts)$/u.test(path(entry)),
			))
	)
		return fail("Vercel preflight function entries are invalid");
	if (input.requiredRoutes !== undefined) {
		if (
			!Array.isArray(input.requiredRoutes) ||
			input.requiredRoutes.length > 128
		)
			return fail("Vercel preflight routes are invalid");
		for (const route of input.requiredRoutes) {
			if (
				!route ||
				typeof route.src !== "string" ||
				!route.src.startsWith("/") ||
				route.src.length > 512 ||
				typeof route.dest !== "string" ||
				!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(route.dest) ||
				!Array.isArray(route.transforms) ||
				route.transforms.length > 8 ||
				route.transforms.some(
					(t: {
						readonly type: string;
						readonly op: string;
						readonly args: string;
					}) =>
						!t ||
						t.type !== "request.path" ||
						t.op !== "set" ||
						typeof t.args !== "string" ||
						!t.args.startsWith("/") ||
						t.args.length > 512,
				)
			)
				return fail("Vercel preflight routes are invalid");
			if (
				!(input.requiredEntries ?? []).some(
					(entry) =>
						`/${entry.replace(/\.(?:[cm]?js|[cm]?ts)$/u, "")}` === route.dest,
				)
			)
				return fail("Vercel route does not target an approved HTTP entry");
		}
	}
	try {
		parseSecretRef(input.credentialRef);
		if (input.gitSourceAuthRef) parseSecretRef(input.gitSourceAuthRef);
	} catch {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"Preflight credentials must be custody locators",
		);
	}
	let token: string;
	try {
		token = await options.resolveCredential(input.credentialRef);
	} catch {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"Vercel preflight credential is unavailable",
		);
	}
	if (!token.trim())
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"Vercel preflight credential is unavailable",
		);
	let gitToken: string | undefined;
	if (input.gitSourceAuthRef) {
		if (!options.resolveGitCredential)
			return fail(
				"Private Git source requires a separately scoped GitHub credential lease",
			);
		try {
			gitToken = await options.resolveGitCredential(input.gitSourceAuthRef, {
				organization,
				repository,
				revision: input.revision,
			});
		} catch {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"GitHub preflight credential is unavailable",
			);
		}
		if (!gitToken.trim())
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"GitHub preflight credential is unavailable",
			);
	}
	const vercel = guardTransport(transport, {
		allowedHosts: ["api.vercel.com"],
		allowedPathPrefixes: ["/v9/projects", "/v2/teams"],
		maxTimeoutMs: 15000,
		maxResponseBytes: 524288,
	});
	const github = guardTransport(transport, {
		allowedHosts: ["api.github.com"],
		allowedPathPrefixes: ["/repos"],
		maxTimeoutMs: 15000,
		maxResponseBytes: 524288,
	});
	const send = async (
		kind: "vercel" | "github",
		requestPath: string,
		raw = false,
	) => {
		const request: TransportRequest = {
			method: "GET",
			url: `${kind === "vercel" ? "https://api.vercel.com" : "https://api.github.com"}${requestPath}`,
			headers:
				kind === "vercel"
					? { authorization: `Bearer ${token}`, accept: "application/json" }
					: {
							accept: raw
								? "application/vnd.github.raw+json"
								: "application/vnd.github+json",
							"user-agent": "hobo-vercel-preflight",
							...(gitToken
								? { authorization: `Bearer ${gitToken}` }
								: undefined),
						},
			timeoutMs: 15000,
			maxResponseBytes: 524288,
		};
		try {
			return await (kind === "vercel" ? vercel : github)(request);
		} catch {
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				`${kind === "vercel" ? "Vercel" : "GitHub"} preflight read failed`,
			);
		}
	};
	const teamQuery = new URLSearchParams({ teamId });
	const gitPrefix = `/repos/${encodeURIComponent(organization)}/${encodeURIComponent(repository)}`;
	const sourcePath = (entry: string) =>
		`${gitPrefix}/contents/${`${root}/${path(entry)}`.split("/").map(encodeURIComponent).join("/")}?${new URLSearchParams({ ref: input.revision })}`;
	const entries = [
		...new Set([
			...input.components.map((component) => path(component.entry)),
			...(input.requiredEntries ?? []).map(path),
		]),
	];
	const scheduled = input.components.some(
		(component) => component.kind !== "queue",
	);
	const [
		projectResponse,
		commitResponse,
		configResponse,
		teamResponse,
		branchResponse,
		...entryResponses
	] = await Promise.all([
		send("vercel", `/v9/projects/${encodeURIComponent(project)}?${teamQuery}`),
		send("github", `${gitPrefix}/git/commits/${input.revision}`),
		send("github", sourcePath("vercel.json"), true),
		scheduled
			? send("vercel", `/v2/teams/${encodeURIComponent(teamId)}?${teamQuery}`)
			: Promise.resolve(undefined),
		previewBranch
			? send(
					"github",
					`${gitPrefix}/git/ref/heads/${previewBranch.split("/").map(encodeURIComponent).join("/")}`,
				)
			: Promise.resolve(undefined),
		...entries.map((entry) => send("github", sourcePath(entry), true)),
	]);
	if (projectResponse.status !== 404)
		check(projectResponse.status, "Vercel project preflight");
	check(commitResponse.status, "GitHub commit preflight");
	check(configResponse.status, "GitHub configuration preflight");
	let projectId: string | undefined;
	let projectAction: "create" | "update" | "none" = "create";
	let gitLinkAction: "create-with-project" | "link" | "none" =
		"create-with-project";
	if (projectResponse.status === 200) {
		const projectInfo = object(projectResponse.body);
		if (
			projectInfo.name !== project ||
			projectInfo.accountId !== teamId ||
			!isJsonString(projectInfo.id) ||
			!/^prj_[A-Za-z0-9_-]{1,128}$/u.test(projectInfo.id)
		)
			return fail("Vercel project ownership differs from the approved target");
		projectId = id(projectInfo.id);
		projectAction =
			projectInfo.rootDirectory !== root ||
			projectInfo.buildCommand !== input.buildCommand ||
			(input.installCommand !== undefined &&
				projectInfo.installCommand !== input.installCommand)
				? "update"
				: "none";
		if (
			projectInfo.link !== undefined &&
			projectInfo.link !== null &&
			!isJsonArray(projectInfo.link) &&
			!isJsonObject(projectInfo.link)
		)
			return fail("Vercel project Git linkage is malformed");
		const links = isJsonArray(projectInfo.link)
			? projectInfo.link
			: isJsonObject(projectInfo.link)
				? [projectInfo.link]
				: [];
		const matches = links.filter(
			(link) =>
				isJsonObject(link) &&
				(link.type === "github" || link.type === "github-limited") &&
				link.org === organization &&
				link.repo === repository &&
				link.sourceless !== true,
		);
		if (links.length && (links.length !== 1 || matches.length !== 1))
			throw new VercelDeploymentPreflightError(
				"PROJECT_GIT_MISMATCH",
				"Vercel project is linked to a different Git repository",
			);
		gitLinkAction = links.length ? "none" : "link";
	}
	if (object(commitResponse.body).sha !== input.revision)
		return fail("GitHub did not confirm the exact approved commit");
	if (branchResponse && previewBranch) {
		check(branchResponse.status, "GitHub preview branch preflight");
		const branch = object(branchResponse.body);
		if (
			branch.ref !== `refs/heads/${previewBranch}` ||
			!isJsonObject(branch.object) ||
			branch.object.sha !== input.revision
		)
			return fail(
				"GitHub preview branch head differs from the approved revision",
			);
	}
	for (const response of entryResponses) {
		check(response.status, "GitHub function source preflight");
		if (!response.body.trim()) return fail("Vercel function source is empty");
	}
	let billingPlan: VercelBillingPlan | undefined;
	if (teamResponse) {
		check(teamResponse.status, "Vercel team plan preflight");
		const team = object(teamResponse.body);
		if (
			team.id !== teamId ||
			!isJsonObject(team.billing) ||
			!["hobby", "pro", "enterprise"].includes(String(team.billing.plan))
		)
			return fail("Vercel team billing plan could not be verified");
		// SAFETY: the plan was checked against the complete allowed enum.
		billingPlan = team.billing.plan as VercelBillingPlan;
	}
	const configuration = parseJsonValue(configResponse.body);
	if (
		!isJsonObject(configuration) ||
		!isJsonObject(configuration.git) ||
		configuration.git.deploymentEnabled !== false
	)
		throw new VercelDeploymentPreflightError(
			"UNSUPERVISED_GIT_DEPLOYMENT",
			"Vercel Git auto-deploy must be disabled for supervised applications",
		);
	for (const route of input.requiredRoutes ?? []) {
		if (
			!isJsonArray(configuration.routes) ||
			configuration.routes.filter(
				(candidate) => canonicalJson(candidate) === canonicalJson(route),
			).length !== 1
		)
			return fail(
				"Vercel deployment route differs from the approved HTTP binding",
			);
	}
	for (const component of input.components)
		verifyVercelDeploymentComponent({
			configuration,
			component,
			environment: input.environment,
			...(billingPlan ? { plan: billingPlan } : undefined),
		});
	return {
		teamId,
		...(projectId ? { projectId } : undefined),
		projectAction,
		gitLinkAction,
		organization,
		repository,
		revision: input.revision,
		environment: input.environment,
		...(previewBranch ? { previewBranch } : undefined),
		componentsChecked: input.components.length,
		entriesChecked: entries.length,
		routesChecked: input.requiredRoutes?.length ?? 0,
		...(billingPlan ? { billingPlan } : undefined),
		deploymentPermission: "not-observed",
		gitLinkPermission: "not-observed",
		scheduleCapacity: "not-observed",
		runtimeAuthentication: "not-observed",
		previewScheduleActivation:
			input.environment === "preview" &&
			input.components.some(
				(component) =>
					component.kind === "schedule" ||
					component.kind === "schedule-function",
			)
				? "requires-enable"
				: "not-applicable",
	};
}
