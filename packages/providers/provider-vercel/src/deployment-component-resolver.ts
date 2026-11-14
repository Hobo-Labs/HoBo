/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this resolver validates untrusted desired properties and provider response fields at their JSON boundary. */
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
	type TransportResponse,
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
	type JsonObject,
	parseJsonObject,
	parseJsonValue,
} from "./json.js";
import type { VercelResolverOptions } from "./resolvers.js";

// public-contract: versioned deployment-owned Vercel product identifier.
export const VERCEL_QUEUE_PRODUCT_ID = "vercel.queues/v1";
// public-contract: versioned deployment-owned Vercel product identifier.
export const VERCEL_SCHEDULE_PRODUCT_ID = "vercel.schedules/v1";
// public-contract: versioned deployment-owned Vercel product identifier.
export const VERCEL_CRON_PRODUCT_ID = "vercel.cron/v1";
type ComponentProduct =
	| typeof VERCEL_QUEUE_PRODUCT_ID
	| typeof VERCEL_SCHEDULE_PRODUCT_ID
	| typeof VERCEL_CRON_PRODUCT_ID;

function refuse(message: string): never {
	throw new ResolverError("RESOLVER_PRODUCT_UNSUPPORTED", message);
}
function invalid(message: string): never {
	throw new ResolverError("RESOLVER_OUTPUT_UNPARSEABLE", message);
}
function field(value: JsonObject, key: string): string {
	const result = value[key];
	if (!isJsonString(result) || !result)
		return refuse(`Vercel component requires ${key}`);
	return result;
}
function identifier(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value))
		return refuse("Vercel component requires a plain scoped identity");
	return value;
}
function sourcePath(value: string): string {
	if (
		!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) ||
		value.split("/").some((part) => part === "." || part === "..")
	)
		return refuse("Vercel component requires a safe source path");
	return value;
}
function topic(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value))
		return refuse("Vercel queue topic has an invalid name");
	return value;
}
function responseObject(response: TransportResponse): JsonObject {
	const data = parseJsonValue(response.body);
	if (!isJsonObject(data))
		return invalid("Vercel returned an invalid response");
	return data;
}
function check(response: TransportResponse, operation: string): void {
	if (response.status !== 200)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${operation} returned HTTP ${response.status}`,
		);
}
function desired(request: ResolveRequest, product: ComponentProduct) {
	const d = request.desired;
	const deploymentId = identifier(field(d, "deploymentId"));
	if (!deploymentId.startsWith("dpl_"))
		return refuse("Vercel component requires a provider deployment ID");
	if (
		request.ref.physicalId !== undefined &&
		request.ref.physicalId !== deploymentId
	)
		return refuse(
			"Vercel component physical identity differs from its owning deployment",
		);
	const project = identifier(field(d, "project"));
	const teamId = identifier(field(d, "teamId"));
	const organization = identifier(field(d, "organization"));
	const repository = identifier(field(d, "repository"));
	const revision = field(d, "revision");
	if (!/^[a-f0-9]{40}$/u.test(revision))
		return refuse("Vercel component requires a full Git SHA");
	const rootDirectory = sourcePath(field(d, "rootDirectory"));
	const entry = sourcePath(field(d, "entry"));
	if (!/\.(?:[cm]?js|[cm]?ts)$/u.test(entry))
		return refuse(
			"Vercel component entry must be a JavaScript or TypeScript source file",
		);
	const environment = field(d, "environment");
	if (environment !== "production" && environment !== "preview")
		return refuse(
			"Vercel component requires production or preview environment",
		);
	const gitSourceAuthRef = d.gitSourceAuthRef;
	if (gitSourceAuthRef !== undefined) {
		if (!isJsonString(gitSourceAuthRef))
			return refuse("Git credential must be a secret reference");
		try {
			parseSecretRef(gitSourceAuthRef);
		} catch {
			return refuse("Git credential must be a secret reference");
		}
	}
	let component: VercelDeploymentComponent;
	if (product === VERCEL_QUEUE_PRODUCT_ID) {
		component = { kind: "queue", topic: topic(field(d, "topic")), entry };
	} else {
		const maximumJitterSeconds = d.maximumJitterSeconds;
		if (
			typeof maximumJitterSeconds !== "number" ||
			!Number.isSafeInteger(maximumJitterSeconds) ||
			maximumJitterSeconds < 0
		)
			return refuse(
				"Vercel schedule requires an explicit maximum jitter in seconds",
			);
		const cron = field(d, "cron");
		if (cron.length > 256)
			return refuse("Vercel schedule exceeds the cron length limit");
		if (product === VERCEL_SCHEDULE_PRODUCT_ID) {
			if ((d.topic === undefined) === (d.function === undefined))
				return refuse(
					"Vercel schedule requires exactly one queue or function target",
				);
			component =
				d.topic !== undefined
					? {
							kind: "schedule",
							name: identifier(field(d, "name")),
							cron,
							topic: topic(field(d, "topic")),
							entry,
							maximumJitterSeconds,
						}
					: {
							kind: "schedule-function",
							name: identifier(field(d, "name")),
							cron,
							function: sourcePath(field(d, "function")),
							entry,
							maximumJitterSeconds,
						};
		} else {
			const path = field(d, "path");
			if (
				!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u.test(path) ||
				path.length > 512 ||
				path.split("/").some((part) => part === "." || part === "..")
			)
				return refuse("Vercel cron path must be an exact safe path");
			component = { kind: "cron", path, cron, entry, maximumJitterSeconds };
		}
	}
	const previewBranch =
		d.previewBranch === undefined
			? undefined
			: vercelPreviewBranch(d.previewBranch);
	if (
		d.requireProductionScheduleActivation !== undefined &&
		(d.requireProductionScheduleActivation !== true ||
			environment !== "production" ||
			(component.kind !== "schedule" && component.kind !== "schedule-function"))
	)
		return refuse(
			"Production schedule activation requires an exact production schedule",
		);
	if (previewBranch !== undefined && environment !== "preview")
		return refuse(
			"Vercel preview branch is only valid for a preview deployment",
		);
	if (
		environment === "preview" &&
		(component.kind === "schedule" || component.kind === "schedule-function") &&
		!previewBranch
	)
		return refuse("Vercel preview schedule requires an approved Git branch");
	return {
		deploymentId,
		project,
		teamId,
		organization,
		repository,
		revision,
		rootDirectory,
		environment:
			environment === "preview"
				? ("preview" as const)
				: ("production" as const),
		component,
		requireProductionScheduleActivation:
			d.requireProductionScheduleActivation === true,
		...(previewBranch ? { previewBranch } : undefined),
		...(isJsonString(gitSourceAuthRef) ? { gitSourceAuthRef } : undefined),
	};
}

/** A deployment owns these resources. This resolver verifies the exact
 * deployment's configuration; it never creates or deletes a second deployment.
 * A static schedule is staged here and must be observed active after promotion. */
export function createVercelDeploymentComponentResolver(
	options: VercelResolverOptions,
	product: ComponentProduct,
): ResourceResolver {
	const parse = (raw: ResolveRequest) => {
		const request = parseResolveRequest(parseJsonObject(JSON.stringify(raw)));
		if (request.ref.productId !== product)
			return refuse("Vercel component product differs from request");
		const expectedSlot =
			product === VERCEL_QUEUE_PRODUCT_ID ? "queue" : "service";
		if (request.ref.slot !== expectedSlot)
			return refuse("Vercel component product differs from its requested slot");
		const config = desired(request, product);
		if (!options.teamId || options.teamId !== config.teamId)
			return refuse("Vercel component differs from the verified team scope");
		return { request, config };
	};
	const senders = async (
		request: ResolveRequest,
		transport: HttpTransport,
		scope: {
			readonly organization: string;
			readonly repository: string;
			readonly revision: string;
		},
	) => {
		try {
			parseSecretRef(request.credentialRef);
		} catch {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_NOT_A_REF",
				"Vercel credential must be a scoped custody locator",
			);
		}
		let token: string;
		try {
			token = await options.resolveCredential(request.credentialRef);
		} catch {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"Vercel credential custody could not resolve the scoped reference",
			);
		}
		if (!token.trim())
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"Vercel credential custody returned no material",
			);
		const vercel = guardTransport(transport, {
			allowedHosts: ["api.vercel.com"],
			allowedPathPrefixes: [
				"/v2/teams",
				"/v4/aliases",
				"/v9/projects",
				"/v10/projects",
				"/v11/deployments",
				"/v13/deployments",
			],
			maxTimeoutMs: 15000,
			maxResponseBytes: 524288,
		});
		const github = guardTransport(transport, {
			allowedHosts: ["api.github.com"],
			allowedPathPrefixes: ["/repos"],
			maxTimeoutMs: 15000,
			maxResponseBytes: 524288,
		});
		const schedules = guardTransport(transport, {
			allowedHosts: ["vercel-schedules.com"],
			allowedPathPrefixes: ["/v1/schedules"],
			maxTimeoutMs: 15000,
			maxResponseBytes: 524288,
		});
		return {
			vercel: async (path: string) => {
				try {
					return await vercel({
						method: "GET",
						url: `https://api.vercel.com${path}`,
						headers: {
							authorization: `Bearer ${token}`,
							accept: "application/json",
						},
						timeoutMs: 15000,
						maxResponseBytes: 524288,
					});
				} catch {
					throw new ResolverError(
						"RESOLVER_PROVIDER_REJECTED",
						"Vercel API read failed",
					);
				}
			},
			schedule: async (
				path: string,
				method: "GET" | "POST",
				generation?: number,
			) => {
				const url = `https://vercel-schedules.com${path}`;
				if (method === "POST") {
					const journal = options.mutationJournal;
					if (journal?.persistence !== "durable-cas")
						return refuse(
							"Vercel preview schedule activation requires a durable mutation journal",
						);
					if (!Number.isSafeInteger(generation) || (generation ?? -1) < 0)
						return refuse(
							"Vercel preview schedule mutation requires its observed generation",
						);
					const mutationId = `vercel-preview-schedule:${createHash("sha256").update(JSON.stringify({ url, generation })).digest("hex")}`;
					const requestDigest = `sha256:${createHash("sha256").update(JSON.stringify({ method, url })).digest("hex")}`;
					if (
						(await journal.claim({ mutationId, requestDigest })).status !==
						"claimed"
					)
						return undefined;
					try {
						const response = await schedules({
							method,
							url,
							headers: {
								authorization: `Bearer ${token}`,
								accept: "application/json",
							},
							timeoutMs: 15000,
							maxResponseBytes: 524288,
						});
						if (response.status === 200 || response.status === 409)
							await journal.acknowledge(mutationId, requestDigest);
						else await journal.uncertain(mutationId, requestDigest);
						return response;
					} catch {
						await journal.uncertain(mutationId, requestDigest);
						throw new ResolverError(
							"RESOLVER_PROVIDER_REJECTED",
							"Vercel preview schedule activation outcome is uncertain",
						);
					}
				}
				try {
					return await schedules({
						method,
						url,
						headers: {
							authorization: `Bearer ${token}`,
							accept: "application/json",
						},
						timeoutMs: 15000,
						maxResponseBytes: 524288,
					});
				} catch {
					throw new ResolverError(
						"RESOLVER_PROVIDER_REJECTED",
						"Vercel schedule API read failed",
					);
				}
			},
			github: async (path: string, credentialRef?: string) => {
				let gitToken: string | undefined;
				if (credentialRef) {
					if (!options.resolveGitCredential)
						return refuse(
							"Private Git source requires a separately scoped GitHub credential lease",
						);
					try {
						gitToken = await options.resolveGitCredential(credentialRef, scope);
					} catch {
						throw new ResolverError(
							"RESOLVER_CREDENTIAL_MISSING",
							"GitHub credential custody could not resolve the scoped reference",
						);
					}
					if (!gitToken.trim())
						throw new ResolverError(
							"RESOLVER_CREDENTIAL_MISSING",
							"GitHub credential custody returned no material",
						);
				}
				try {
					return await github({
						method: "GET",
						url: `https://api.github.com${path}`,
						headers: {
							accept: "application/vnd.github.raw+json",
							"user-agent": "hobo-vercel-component",
							...(gitToken
								? { authorization: `Bearer ${gitToken}` }
								: undefined),
						},
						timeoutMs: 15000,
						maxResponseBytes: 524288,
					});
				} catch {
					throw new ResolverError(
						"RESOLVER_PROVIDER_REJECTED",
						"GitHub source read failed",
					);
				}
			},
		};
	};
	const locate = async (
		parsed: ReturnType<typeof parse>,
		transport: HttpTransport,
	) => {
		const { request, config } = parsed;
		const send = await senders(request, transport, {
			organization: config.organization,
			repository: config.repository,
			revision: config.revision,
		});
		const query = `?${new URLSearchParams({ teamId: config.teamId })}`;
		const projectResponse = await send.vercel(
			`/v9/projects/${encodeURIComponent(config.project)}${query}`,
		);
		if (projectResponse.status === 404) return { send, query };
		check(projectResponse, "Vercel project read");
		const project = responseObject(projectResponse);
		if (
			project.name !== config.project ||
			project.accountId !== config.teamId ||
			project.rootDirectory !== config.rootDirectory ||
			!isJsonString(project.id)
		)
			return invalid(
				"Vercel component project or account differs from the approved scope",
			);
		const projectId = identifier(project.id);
		const deploymentResponse = await send.vercel(
			`/v13/deployments/${encodeURIComponent(config.deploymentId)}${query}`,
		);
		if (deploymentResponse.status === 404 || deploymentResponse.status === 410)
			return { send, query, projectId };
		check(deploymentResponse, "Vercel deployment read");
		const deployment = responseObject(deploymentResponse);
		const observedProject = isJsonString(deployment.projectId)
			? deployment.projectId
			: isJsonObject(deployment.project)
				? deployment.project.id
				: undefined;
		if (
			deployment.id !== config.deploymentId ||
			observedProject !== projectId ||
			(isJsonObject(deployment.team) && deployment.team.id !== config.teamId) ||
			!isJsonObject(deployment.meta) ||
			deployment.meta.githubCommitSha !== config.revision ||
			deployment.meta.githubOrg !== config.organization ||
			deployment.meta.githubRepo !== config.repository ||
			deployment.target !==
				(config.environment === "preview" ? null : "production")
		)
			return invalid(
				"Vercel component deployment identity, scope or revision differs from the approved build",
			);
		return { send, query, projectId, deployment };
	};
	const verifyPreviewTrack = async (
		scope: {
			readonly teamId: string;
			readonly projectId: string;
			readonly deploymentId: string;
			readonly revision: string;
			readonly branch: string;
			readonly name: string;
		},
		send: Awaited<ReturnType<typeof senders>>,
	) => {
		const response = await send.vercel(
			`/v9/projects/${encodeURIComponent(scope.projectId)}?${new URLSearchParams({ teamId: scope.teamId })}`,
		);
		check(response, "Vercel preview track read");
		const project = responseObject(response);
		if (project.id !== scope.projectId || project.accountId !== scope.teamId)
			return invalid(
				"Vercel preview track project differs from the approved account",
			);
		const aliases = isJsonArray(project.alias)
			? project.alias.filter(
					(row) =>
						isJsonObject(row) &&
						row.gitBranch === scope.branch &&
						(row.environment === "preview" || row.target === "PREVIEW"),
				)
			: [];
		if (aliases.length) {
			if (
				!aliases.every(
					(row) =>
						isJsonObject(row) &&
						(row.redirect === undefined || row.redirect === null) &&
						(isJsonObject(row.deployment)
							? row.deployment.id
							: row.deploymentId) === scope.deploymentId,
				)
			)
				return refuse(
					"Vercel preview schedule track points to a different deployment",
				);
		}
		let verified = false;
		try {
			verified = (await options.verifyPreviewScheduleTrack?.(scope)) === true;
		} catch {
			/* Refuse without exposing provider details. */
		}
		if (!verified)
			return refuse(
				"Vercel preview schedule track is not verified for the approved deployment",
			);
	};
	// Schedules without a branch run against production. Verify every current
	// production domain's native alias, as the promotion routing adapter does,
	// rather than mistaking a READY but still staged build for the serving one.
	const verifyProductionTrack = async (
		scope: {
			readonly teamId: string;
			readonly projectId: string;
			readonly deploymentId: string;
		},
		send: Awaited<ReturnType<typeof senders>>,
	): Promise<boolean> => {
		const projectResponse = await send.vercel(
			`/v9/projects/${encodeURIComponent(scope.projectId)}?${new URLSearchParams({ teamId: scope.teamId })}`,
		);
		check(projectResponse, "Vercel production project read");
		const project = responseObject(projectResponse);
		if (project.id !== scope.projectId || project.accountId !== scope.teamId)
			return invalid(
				"Vercel production project differs from the approved account",
			);
		const production = isJsonObject(project.targets)
			? project.targets.production
			: undefined;
		if (
			!isJsonObject(production) ||
			production.id !== scope.deploymentId ||
			production.readyState !== "READY" ||
			(production.readySubstate !== undefined &&
				production.readySubstate !== "PROMOTED")
		)
			return false;
		const domains: string[] = [],
			cursors = new Set<string>();
		let until: string | undefined;
		for (let page = 0; page < 25; page++) {
			const query = new URLSearchParams({
				teamId: scope.teamId,
				production: "true",
				redirects: "false",
				verified: "true",
				limit: "100",
				...(until ? { until } : undefined),
			});
			const response = await send.vercel(
				`/v9/projects/${encodeURIComponent(scope.projectId)}/domains?${query}`,
			);
			check(response, "Vercel production domains read");
			const body = responseObject(response);
			if (!isJsonArray(body.domains))
				return invalid("Vercel production domain inventory is invalid");
			for (const row of body.domains) {
				if (
					!isJsonObject(row) ||
					!isJsonString(row.name) ||
					row.name.length > 253 ||
					!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(row.name) ||
					!row.name.includes(".") ||
					row.name.includes("..") ||
					domains.includes(row.name)
				)
					return invalid("Vercel production domain inventory is invalid");
				domains.push(row.name);
			}
			const next = isJsonObject(body.pagination)
				? body.pagination.next
				: undefined;
			if (next === null || next === undefined) break;
			if (
				(typeof next !== "string" && typeof next !== "number") ||
				!String(next) ||
				cursors.has(String(next)) ||
				page === 24
			)
				return invalid("Vercel production domain inventory did not terminate");
			until = String(next);
			cursors.add(until);
		}
		if (!domains.length) return false;
		for (const domain of domains) {
			const query = new URLSearchParams({
				teamId: scope.teamId,
				projectId: scope.projectId,
			});
			const response = await send.vercel(
				`/v4/aliases/${encodeURIComponent(domain)}?${query}`,
			);
			if (response.status === 404) return false;
			check(response, "Vercel production alias read");
			const alias = responseObject(response);
			if (
				alias.alias !== domain ||
				alias.projectId !== scope.projectId ||
				alias.deploymentId !== scope.deploymentId
			)
				return false;
		}
		return true;
	};
	const observe = async (
		raw: ResolveRequest,
		transport: HttpTransport,
		realize: boolean,
	): Promise<ResolveOutcome | undefined> => {
		const parsed = parse(raw),
			{ request, config } = parsed;
		const found = await locate(parsed, transport);
		if (!found.deployment || !found.projectId) return undefined;
		const state = field(found.deployment, "readyState");
		if (state !== "READY") {
			const terminal = state === "ERROR" || state === "CANCELED";
			return {
				contract: RESOLVER_CONTRACT,
				action: "noop",
				physicalId: config.deploymentId,
				outputs: {
					id: config.deploymentId,
					ready: false,
					operationConfirmed: terminal,
					lifecycleStatus: terminal ? "failed" : "pending",
				},
				diagnostics: [],
			};
		}
		const source = (path: string) => {
			const segments = `${config.rootDirectory}/${path}`
				.split("/")
				.map(encodeURIComponent)
				.join("/");
			return `/repos/${encodeURIComponent(config.organization)}/${encodeURIComponent(config.repository)}/contents/${segments}?${new URLSearchParams({ ref: config.revision })}`;
		};
		const [configurationResponse, entryResponse, buildsResponse] =
			await Promise.all([
				found.send.github(source("vercel.json"), config.gitSourceAuthRef),
				found.send.github(
					source(config.component.entry),
					config.gitSourceAuthRef,
				),
				found.send.vercel(
					`/v11/deployments/${encodeURIComponent(config.deploymentId)}/builds${found.query}`,
				),
			]);
		check(configurationResponse, "GitHub deployment configuration read");
		check(entryResponse, "GitHub function source read");
		check(buildsResponse, "Vercel deployment builds read");
		if (!entryResponse.body.trim())
			return invalid("Vercel function source is empty");
		const builds = responseObject(buildsResponse).builds;
		const acceptableEntries = [
			config.component.entry,
			`${config.rootDirectory}/${config.component.entry}`,
		];
		if (
			!isJsonArray(builds) ||
			!builds.some(
				(build) =>
					isJsonObject(build) &&
					isJsonString(build.entrypoint) &&
					acceptableEntries.includes(build.entrypoint) &&
					isJsonArray(build.output) &&
					build.output.some(
						(output) => isJsonObject(output) && output.type === "lambda",
					),
			)
		)
			return invalid("Vercel did not build the required component function");
		let plan: VercelBillingPlan | undefined;
		if (config.component.kind !== "queue") {
			const teamResponse = await found.send.vercel(
				`/v2/teams/${encodeURIComponent(config.teamId)}${found.query}`,
			);
			check(teamResponse, "Vercel team billing plan read");
			const team = responseObject(teamResponse);
			if (
				team.id !== config.teamId ||
				!isJsonObject(team.billing) ||
				!["hobby", "pro", "enterprise"].includes(String(team.billing.plan))
			)
				return invalid("Vercel team billing plan could not be verified");
			// SAFETY: the enum values were explicitly checked above.
			plan = team.billing.plan as VercelBillingPlan;
		}
		const configuration = parseJsonValue(configurationResponse.body);
		verifyVercelDeploymentComponent({
			configuration,
			component: config.component,
			environment: config.environment,
			...(plan ? { plan } : undefined),
		});
		let artifactDigest: string | undefined;
		if (options.observeGitArtifact) {
			const rawUrl = field(found.deployment, "url");
			let endpoint: URL;
			try {
				endpoint = new URL(
					rawUrl.startsWith("https://") ? rawUrl : `https://${rawUrl}`,
				);
			} catch {
				return invalid("Vercel immutable deployment URL is invalid");
			}
			if (
				endpoint.protocol !== "https:" ||
				!endpoint.hostname.endsWith(".vercel.app") ||
				endpoint.username ||
				endpoint.password ||
				endpoint.port ||
				endpoint.pathname !== "/" ||
				endpoint.search ||
				endpoint.hash
			)
				return invalid("Vercel immutable deployment URL is invalid");
			try {
				artifactDigest = await options.observeGitArtifact({
					teamId: config.teamId,
					projectId: found.projectId,
					deploymentId: config.deploymentId,
					revision: config.revision,
					repository: `${config.organization}/${config.repository}`,
					endpoint: endpoint.origin,
				});
			} catch {
				return invalid("Vercel build artifact evidence is unavailable");
			}
			if (!/^sha256:[a-f0-9]{64}$/u.test(artifactDigest))
				return invalid("Vercel build artifact evidence is invalid");
		}
		let activation = "not-observed";
		if (
			(config.component.kind === "schedule" ||
				config.component.kind === "schedule-function") &&
			(config.environment === "preview" ||
				config.requireProductionScheduleActivation)
		) {
			const component = config.component;
			const branch = config.previewBranch;
			if (config.environment === "preview" && !branch)
				return refuse(
					"Vercel preview schedule requires an approved Git branch",
				);
			if (
				config.environment === "preview" &&
				(!isJsonObject(found.deployment.meta) ||
					found.deployment.meta.githubCommitRef !== branch)
			)
				return refuse(
					"Vercel preview schedule requires a revision-pinned Git track",
				);
			const scope = {
				teamId: config.teamId,
				projectId: found.projectId,
				deploymentId: config.deploymentId,
				revision: config.revision,
				branch: branch ?? "",
				name: component.name,
			};
			const verifyTrack = async () => {
				if (config.environment === "preview") {
					await verifyPreviewTrack(scope, found.send);
					return true;
				}
				return verifyProductionTrack(scope, found.send);
			};
			if (!(await verifyTrack()))
				return {
					contract: RESOLVER_CONTRACT,
					action: "noop",
					physicalId: config.deploymentId,
					outputs: {
						id: config.deploymentId,
						projectId: found.projectId,
						ready: false,
						operationConfirmed: false,
						lifecycleStatus: "pending",
						component: component.kind,
						activation: "not-observed",
					},
					diagnostics: [],
				};
			const query = new URLSearchParams({
				namespace: "default",
				teamId: config.teamId,
				projectId: found.projectId,
				...(branch ? { branch } : undefined),
			});
			const prefix = `/v1/schedules/${encodeURIComponent(component.name)}`;
			const declared =
				isJsonObject(configuration) && isJsonObject(configuration.schedules)
					? configuration.schedules[component.name]
					: undefined;
			if (!isJsonObject(declared))
				return invalid("Vercel schedule declaration is unavailable");
			const expectedJitter = declared.jitter ?? (plan === "hobby" ? 15 : 1);
			const readSchedule = async () => {
				const response = await found.send.schedule(`${prefix}?${query}`, "GET");
				if (!response)
					return invalid("Vercel schedule read did not return a response");
				if (response.status === 404) return undefined;
				check(response, "Vercel preview schedule read");
				const item = responseObject(response);
				if (
					item.ownerId !== config.teamId ||
					item.projectId !== found.projectId ||
					item.name !== component.name ||
					item.namespace !== "default" ||
					item.source !== "static" ||
					item.timezone !== "UTC" ||
					(item.jitter ?? (plan === "hobby" ? 15 : 1)) !== expectedJitter ||
					!isJsonObject(item.expression) ||
					item.expression.type !== "cron" ||
					item.expression.cron !== component.cron ||
					!isJsonObject(item.target) ||
					(component.kind === "schedule" &&
						(item.target.type !== "queue" ||
							item.target.topic !== component.topic)) ||
					(component.kind === "schedule-function" &&
						(item.target.type !== "function" ||
							item.target.function !== component.function)) ||
					(item.state !== "active" && item.state !== "inactive")
				)
					return invalid(
						"Vercel preview schedule differs from the approved component",
					);
				return item;
			};
			let schedule = await readSchedule();
			if (schedule && !(await verifyTrack())) schedule = undefined;
			if (
				schedule &&
				realize &&
				(schedule.state !== "active" ||
					(schedule.activeUntil !== undefined && schedule.activeUntil !== null))
			) {
				const generation =
					typeof schedule.updatedAt === "number"
						? schedule.updatedAt
						: undefined;
				const response = await found.send.schedule(
					`${prefix}/enable?${query}`,
					"POST",
					generation,
				);
				if (response && response.status !== 200 && response.status !== 409)
					check(response, "Vercel preview schedule activation");
				schedule = await readSchedule();
				if (!(await verifyTrack())) schedule = undefined;
			}
			if (schedule && !(await verifyTrack())) schedule = undefined;
			if (
				schedule?.state !== "active" ||
				(schedule.activeUntil !== undefined && schedule.activeUntil !== null)
			)
				return {
					contract: RESOLVER_CONTRACT,
					action: "noop",
					physicalId: config.deploymentId,
					outputs: {
						id: config.deploymentId,
						projectId: found.projectId,
						ready: false,
						operationConfirmed: false,
						lifecycleStatus: "pending",
						component: "schedule",
						activation: schedule ? "inactive" : "not-observed",
					},
					diagnostics: [],
				};
			activation = "active";
		}
		if (config.component.kind === "cron") {
			const envResponse = await found.send.vercel(
				`/v10/projects/${encodeURIComponent(found.projectId)}/env?${new URLSearchParams({ teamId: config.teamId, decrypt: "false", target: "production" })}`,
			);
			check(envResponse, "Vercel cron credential metadata read");
			const envs = responseObject(envResponse);
			if (
				!isJsonArray(envs.envs) ||
				!envs.envs.some(
					(item) =>
						isJsonObject(item) &&
						item.key === "CRON_SECRET" &&
						(item.type === "encrypted" ||
							item.type === "sensitive" ||
							item.type === "secret") &&
						isJsonArray(item.target) &&
						item.target.includes("production"),
				)
			)
				return refuse(
					"Vercel production cron credential is missing or not protected",
				);
			if (
				!options.verifyCronAuthentication ||
				!(await options.verifyCronAuthentication({
					teamId: config.teamId,
					projectId: found.projectId,
					deploymentId: config.deploymentId,
					revision: config.revision,
					entry: config.component.entry,
					path: config.component.path,
				}))
			)
				return refuse(
					"Vercel cron handler authentication has not been independently verified",
				);
		}
		return {
			contract: RESOLVER_CONTRACT,
			action: request.ref.physicalId ? "noop" : "adopt",
			physicalId: config.deploymentId,
			outputs: {
				id: config.deploymentId,
				projectId: found.projectId,
				ready: true,
				operationConfirmed: true,
				lifecycleStatus: "ready",
				component: config.component.kind,
				activation,
				...(artifactDigest ? { artifactDigest } : undefined),
			},
			diagnostics: [],
		};
	};
	return {
		providerId: "vercel",
		productId: product,
		read: (request, transport) => observe(request, transport, false),
		async reconcile(request, transport) {
			const result = await observe(request, transport, true);
			if (!result)
				return refuse(
					"Vercel component's owning deployment must be reconciled first",
				);
			return result;
		},
		async delete(request, transport) {
			const parsed = parse(request);
			if (!parsed.request.ref.physicalId)
				return refuse(
					"Vercel component retirement requires its observed physical identity",
				);
			// A preview schedule is branch-scoped and can outlive its deployment.
			// Disable only after verifying it still targets this exact deployment.
			const { config } = parsed;
			const found = await locate(parsed, transport);
			if (!found.deployment) return;
			if (config.component.kind === "queue") {
				if (!found.projectId || !options.verifyQueueDrain)
					return refuse(
						"Vercel queue retirement requires verified drain and a durable producer fence",
					);
				let proof:
					| Awaited<
							ReturnType<NonNullable<VercelResolverOptions["verifyQueueDrain"]>>
					  >
					| undefined;
				try {
					proof = await options.verifyQueueDrain({
						teamId: config.teamId,
						projectId: found.projectId,
						deploymentId: config.deploymentId,
						revision: config.revision,
						topic: config.component.topic,
						entry: config.component.entry,
					});
				} catch {
					/* Preserve provider credential confidentiality. */
				}
				if (
					!proof?.drained ||
					!proof.fencedUntilRetired ||
					!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(proof.evidenceRef)
				)
					return refuse(
						"Vercel queue retirement requires verified drain and a durable producer fence",
					);
				return;
			}
			if (
				(config.component.kind !== "schedule" &&
					config.component.kind !== "schedule-function") ||
				config.environment !== "preview"
			)
				return;
			if (
				!found.projectId ||
				!isJsonObject(found.deployment.meta) ||
				found.deployment.meta.githubCommitRef !== config.previewBranch ||
				!config.previewBranch
			)
				return refuse(
					"Vercel preview schedule lost its approved deployment track",
				);
			const component = config.component;
			const scope = {
				teamId: config.teamId,
				projectId: found.projectId,
				deploymentId: config.deploymentId,
				revision: config.revision,
				branch: config.previewBranch,
				name: component.name,
			};
			const verifyTrack = () => verifyPreviewTrack(scope, found.send);
			await verifyTrack();
			const query = new URLSearchParams({
				namespace: "default",
				teamId: config.teamId,
				projectId: found.projectId,
				branch: config.previewBranch,
			});
			const prefix = `/v1/schedules/${encodeURIComponent(component.name)}`;
			const readSchedule = async () => {
				const response = await found.send.schedule(`${prefix}?${query}`, "GET");
				if (!response)
					return invalid("Vercel schedule read did not return a response");
				if (response.status === 404) return undefined;
				check(response, "Vercel preview schedule read");
				const item = responseObject(response);
				if (
					item.ownerId !== config.teamId ||
					item.projectId !== found.projectId ||
					item.name !== component.name ||
					item.namespace !== "default" ||
					item.source !== "static" ||
					!isJsonObject(item.expression) ||
					item.expression.type !== "cron" ||
					item.expression.cron !== component.cron ||
					!isJsonObject(item.target) ||
					(component.kind === "schedule" &&
						(item.target.type !== "queue" ||
							item.target.topic !== component.topic)) ||
					(component.kind === "schedule-function" &&
						(item.target.type !== "function" ||
							item.target.function !== component.function)) ||
					(item.state !== "active" && item.state !== "inactive")
				)
					return invalid(
						"Vercel preview schedule differs from the approved component",
					);
				return item;
			};
			const schedule = await readSchedule();
			if (!schedule || schedule.state === "inactive") return;
			const generation =
				typeof schedule.updatedAt === "number" ? schedule.updatedAt : undefined;
			const result = await found.send.schedule(
				`${prefix}/disable?${query}`,
				"POST",
				generation,
			);
			if (result && result.status !== 200 && result.status !== 409)
				check(result, "Vercel preview schedule retirement");
			const after = await readSchedule();
			await verifyTrack();
			if (after && after.state !== "inactive")
				return refuse("Vercel preview schedule retirement remains unconfirmed");
		},
		async observeAbsence(request, transport) {
			if (!request.ref.physicalId)
				return refuse(
					"Vercel component absence requires its observed physical identity",
				);
			return (await locate(parse(request), transport)).deployment === undefined;
		},
	};
}
