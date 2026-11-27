import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
	type OwnerCredentialResolver,
	parseOwnerCredentialLocator,
	resolveOwnerCredential,
} from "../runners/owner-credentials.js";

export type VercelRuntimeKind = "nodejs22.x" | "nodejs24.x" | "edge";
export type VercelGitLinkPolicy = "disabled";

export class VercelCloudProviderError extends Data.TaggedError(
	"VercelCloudProviderError",
)<{
	readonly code:
		| "VERCEL_GIT_LINK_FORBIDDEN"
		| "VERCEL_AUTH_MISSING"
		| "VERCEL_API_FAILED"
		| "VERCEL_INVALID_PROJECT_NAME";
	readonly message: string;
}> {}

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/u;

export interface VercelProjectProps {
	readonly name: string;
	readonly framework?: string;
	readonly regions?: readonly string[];
	readonly gitLink?: VercelGitLinkPolicy;
	readonly credentialLocator?: string;
	readonly credentialConfigKey?: string;
}

export interface VercelProjectAttr {
	readonly projectId: string;
	readonly name: string;
	readonly framework: string;
	readonly regions: readonly string[];
	readonly gitLink: "disabled";
	readonly provider: "vercel";
}

export type VercelProject = Resource<
	"Hobo.VercelProject",
	VercelProjectProps,
	VercelProjectAttr
>;

export const VercelProject = Resource<VercelProject>("Hobo.VercelProject");

export interface VercelServiceDeploymentProps {
	readonly projectId: string;
	readonly serviceName: string;
	readonly artifactDigest: string;
	readonly runtime?: VercelRuntimeKind;
	readonly regions?: readonly string[];
	readonly routes?: readonly string[];
	readonly target?: "production" | "preview";
	readonly credentialLocator?: string;
	readonly credentialConfigKey?: string;
}

export type VercelDeploymentState =
	| "BUILDING"
	| "ERROR"
	| "INITIALIZING"
	| "QUEUED"
	| "READY"
	| "CANCELED";

export interface VercelServiceDeploymentAttr {
	readonly deploymentId: string;
	readonly projectId: string;
	readonly serviceName: string;
	readonly artifactDigest: string;
	readonly url: string;
	readonly runtime: VercelRuntimeKind;
	readonly regions: readonly string[];
	readonly routes: readonly string[];
	readonly target: "production" | "preview";
	readonly state: VercelDeploymentState;
	readonly gitLink: "disabled";
	readonly provider: "vercel";
}

export type VercelServiceDeployment = Resource<
	"Hobo.VercelServiceDeployment",
	VercelServiceDeploymentProps,
	VercelServiceDeploymentAttr
>;

export const VercelServiceDeployment = Resource<VercelServiceDeployment>(
	"Hobo.VercelServiceDeployment",
);

export interface VercelAliasProps {
	readonly deploymentId: string;
	readonly domain: string;
	readonly credentialLocator?: string;
	readonly credentialConfigKey?: string;
}

export interface VercelAliasAttr {
	readonly aliasId: string;
	readonly deploymentId: string;
	readonly domain: string;
	readonly url: string;
	readonly provider: "vercel";
}

export type VercelAlias = Resource<
	"Hobo.VercelAlias",
	VercelAliasProps,
	VercelAliasAttr
>;

export const VercelAlias = Resource<VercelAlias>("Hobo.VercelAlias");

export interface VercelCloudApiClient {
	readonly upsertProject: (input: {
		readonly name: string;
		readonly framework: string;
		readonly regions: readonly string[];
		readonly gitLink: "disabled";
		readonly authorizationHeader: string;
	}) => Promise<{ readonly projectId: string }>;
	readonly deleteProject: (input: {
		readonly projectId: string;
		readonly authorizationHeader: string;
	}) => Promise<void>;
	readonly deployService: (input: {
		readonly projectId: string;
		readonly serviceName: string;
		readonly artifactDigest: string;
		readonly runtime: VercelRuntimeKind;
		readonly regions: readonly string[];
		readonly target: "production" | "preview";
		readonly authorizationHeader: string;
	}) => Promise<{
		readonly deploymentId: string;
		readonly url: string;
		readonly state: VercelDeploymentState;
	}>;
	readonly deleteDeployment: (input: {
		readonly deploymentId: string;
		readonly authorizationHeader: string;
	}) => Promise<void>;
	readonly assignAlias: (input: {
		readonly deploymentId: string;
		readonly domain: string;
		readonly authorizationHeader: string;
	}) => Promise<{ readonly aliasId: string; readonly url: string }>;
	readonly removeAlias: (input: {
		readonly aliasId: string;
		readonly authorizationHeader: string;
	}) => Promise<void>;
}

export interface VercelCloudProviderOptions {
	readonly client: VercelCloudApiClient;
	readonly resolveCredential?: OwnerCredentialResolver;
}

function sameStringArray(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function resolveVercelAuthorization(
	options: VercelCloudProviderOptions,
	input: {
		readonly credentialLocator?: string;
		readonly credentialConfigKey?: string;
	},
): Effect.Effect<string, VercelCloudProviderError> {
	return Effect.gen(function* () {
		if (input.credentialConfigKey !== undefined) {
			const redacted = yield* Config.Redacted(input.credentialConfigKey).pipe(
				Effect.mapError(
					(cause) =>
						new VercelCloudProviderError({
							code: "VERCEL_AUTH_MISSING",
							message: cause.message,
						}),
				),
			);
			return `Bearer ${Redacted.value(redacted)}`;
		}
		if (
			input.credentialLocator !== undefined &&
			options.resolveCredential !== undefined
		) {
			const locator = parseOwnerCredentialLocator(input.credentialLocator);
			const token = yield* resolveOwnerCredential(
				options.resolveCredential,
				locator,
			).pipe(
				Effect.mapError(
					(cause) =>
						new VercelCloudProviderError({
							code: "VERCEL_AUTH_MISSING",
							message: cause.message,
						}),
				),
			);
			return `Bearer ${token}`;
		}
		return yield* new VercelCloudProviderError({
			code: "VERCEL_AUTH_MISSING",
			message:
				"Vercel provider requires either credentialConfigKey (Alchemy Environments) or owner:// credentialLocator",
		});
	});
}

export function VercelProjectProvider(options: VercelCloudProviderOptions) {
	return Provider.succeed(VercelProject, {
		reconcile: ({ news, output }) =>
			Effect.gen(function* () {
				if (!PROJECT_NAME_PATTERN.test(news.name)) {
					return yield* new VercelCloudProviderError({
						code: "VERCEL_INVALID_PROJECT_NAME",
						message: `invalid Vercel project name: ${news.name}`,
					});
				}
				if (news.gitLink !== undefined && news.gitLink !== "disabled") {
					return yield* new VercelCloudProviderError({
						code: "VERCEL_GIT_LINK_FORBIDDEN",
						message:
							"HoBo Vercel projects are intentionally unlinked from Git; HoBo CD manages deployments directly",
					});
				}
				const authorizationHeader = yield* resolveVercelAuthorization(
					options,
					news,
				);
				const framework = news.framework ?? output?.framework ?? "other";
				const regions = news.regions ?? output?.regions ?? ["iad1"];
				if (
					output !== undefined &&
					output.name === news.name &&
					output.framework === framework &&
					sameStringArray(output.regions, regions)
				) {
					return output;
				}
				const upserted = yield* Effect.tryPromise({
					try: async () =>
						await options.client.upsertProject({
							name: news.name,
							framework,
							regions,
							gitLink: "disabled",
							authorizationHeader,
						}),
					catch: (cause) =>
						new VercelCloudProviderError({
							code: "VERCEL_API_FAILED",
							message: cause instanceof Error ? cause.message : String(cause),
						}),
				});
				return {
					projectId: upserted.projectId,
					name: news.name,
					framework,
					regions: [...regions],
					gitLink: "disabled" as const,
					provider: "vercel" as const,
				};
			}),
		delete: ({ olds, output }) =>
			Effect.gen(function* () {
				const authorizationHeader = yield* resolveVercelAuthorization(
					options,
					olds,
				);
				yield* Effect.tryPromise({
					try: async () =>
						await options.client.deleteProject({
							projectId: output.projectId,
							authorizationHeader,
						}),
					catch: (cause) =>
						new VercelCloudProviderError({
							code: "VERCEL_API_FAILED",
							message: cause instanceof Error ? cause.message : String(cause),
						}),
				});
			}),
	});
}

export function VercelServiceDeploymentProvider(
	options: VercelCloudProviderOptions,
) {
	return Provider.succeed(VercelServiceDeployment, {
		reconcile: ({ news, output }) =>
			Effect.gen(function* () {
				const runtime = news.runtime ?? "nodejs22.x";
				const regions = news.regions ?? ["iad1"];
				const target = news.target ?? "production";
				const routes = news.routes ?? [];
				if (
					output !== undefined &&
					output.projectId === news.projectId &&
					output.artifactDigest === news.artifactDigest &&
					output.runtime === runtime &&
					output.target === target &&
					sameStringArray(output.regions, regions) &&
					sameStringArray(output.routes, routes)
				) {
					return output;
				}
				const authorizationHeader = yield* resolveVercelAuthorization(
					options,
					news,
				);
				const deployed = yield* Effect.tryPromise({
					try: async () =>
						await options.client.deployService({
							projectId: news.projectId,
							serviceName: news.serviceName,
							artifactDigest: news.artifactDigest,
							runtime,
							regions,
							target,
							authorizationHeader,
						}),
					catch: (cause) =>
						new VercelCloudProviderError({
							code: "VERCEL_API_FAILED",
							message: cause instanceof Error ? cause.message : String(cause),
						}),
				});
				return {
					deploymentId: deployed.deploymentId,
					projectId: news.projectId,
					serviceName: news.serviceName,
					artifactDigest: news.artifactDigest,
					url: deployed.url,
					runtime,
					regions: [...regions],
					routes: [...routes],
					target,
					state: deployed.state,
					gitLink: "disabled" as const,
					provider: "vercel" as const,
				};
			}),
		delete: ({ olds, output }) =>
			Effect.gen(function* () {
				const authorizationHeader = yield* resolveVercelAuthorization(
					options,
					olds,
				);
				yield* Effect.tryPromise({
					try: async () =>
						await options.client.deleteDeployment({
							deploymentId: output.deploymentId,
							authorizationHeader,
						}),
					catch: (cause) =>
						new VercelCloudProviderError({
							code: "VERCEL_API_FAILED",
							message: cause instanceof Error ? cause.message : String(cause),
						}),
				});
			}),
	});
}

export function VercelAliasProvider(options: VercelCloudProviderOptions) {
	return Provider.succeed(VercelAlias, {
		reconcile: ({ news, output }) =>
			Effect.gen(function* () {
				const authorizationHeader = yield* resolveVercelAuthorization(
					options,
					news,
				);
				const assigned = yield* Effect.tryPromise({
					try: async () =>
						await options.client.assignAlias({
							deploymentId: news.deploymentId,
							domain: news.domain,
							authorizationHeader,
						}),
					catch: (cause) =>
						new VercelCloudProviderError({
							code: "VERCEL_API_FAILED",
							message: cause instanceof Error ? cause.message : String(cause),
						}),
				});
				const aliasId =
					output !== undefined &&
					output.deploymentId === news.deploymentId &&
					output.domain === news.domain
						? output.aliasId
						: assigned.aliasId;
				return {
					aliasId,
					deploymentId: news.deploymentId,
					domain: news.domain,
					url: assigned.url,
					provider: "vercel" as const,
				};
			}),
		delete: ({ olds, output }) =>
			Effect.gen(function* () {
				const authorizationHeader = yield* resolveVercelAuthorization(
					options,
					olds,
				);
				yield* Effect.tryPromise({
					try: async () =>
						await options.client.removeAlias({
							aliasId: output.aliasId,
							authorizationHeader,
						}),
					catch: (cause) =>
						new VercelCloudProviderError({
							code: "VERCEL_API_FAILED",
							message: cause instanceof Error ? cause.message : String(cause),
						}),
				});
			}),
	});
}

export function VercelCloudProviders(options: VercelCloudProviderOptions) {
	return Layer.mergeAll(
		VercelProjectProvider(options),
		VercelServiceDeploymentProvider(options),
		VercelAliasProvider(options),
	);
}
