import { createHash } from "node:crypto";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
	type OwnerCredentialResolver,
	parseOwnerCredentialLocator,
	resolveOwnerCredential,
} from "../runners/owner-credentials.js";

export type Agent37SandboxSize = "small" | "default" | "large" | "xlarge";
export type Agent37SandboxRegion = "us" | "eu" | "ap-south";

export interface Agent37SnapshotBase {
	readonly name: string;
	readonly setupHash?: string;
}

export interface Agent37SnapshotProps {
	readonly name: string;
	readonly run: readonly string[];
	readonly from?: Agent37SnapshotBase;
	readonly cwd?: string;
	readonly size?: Agent37SandboxSize;
	readonly region?: Agent37SandboxRegion;
	readonly credentialLocator?: string;
	readonly credentialConfigKey?: string;
}

export interface Agent37SnapshotAttr {
	readonly snapshotId: string;
	readonly name: string;
	readonly size: Agent37SandboxSize;
	readonly region: Agent37SandboxRegion;
	readonly setupHash: string;
	readonly baseName: string | undefined;
}

export type Agent37Snapshot = Resource<
	"Hobo.Agent37Snapshot",
	Agent37SnapshotProps,
	Agent37SnapshotAttr
>;

export const Agent37Snapshot = Resource<Agent37Snapshot>(
	"Hobo.Agent37Snapshot",
);

export interface Agent37SandboxProps {
	readonly name: string;
	readonly size?: Agent37SandboxSize;
	readonly region?: Agent37SandboxRegion;
	readonly snapshot?: Agent37SnapshotBase;
	readonly forkFromSandboxId?: string;
	readonly autoStopSeconds?: number;
	readonly noEnv?: boolean;
	readonly labels?: readonly string[];
	readonly credentialLocator?: string;
	readonly credentialConfigKey?: string;
}

export interface Agent37SandboxAttr {
	readonly sandboxId: string;
	readonly name: string;
	readonly provider: "agent37";
	readonly size: Agent37SandboxSize;
	readonly region: Agent37SandboxRegion;
	readonly snapshotName: string | undefined;
	readonly forkedFrom: string | undefined;
	readonly endpointUrl: string;
	readonly state: "ready" | "archived";
	readonly noEnv: boolean;
	readonly labels: readonly string[];
}

export type Agent37Sandbox = Resource<
	"Hobo.Agent37Sandbox",
	Agent37SandboxProps,
	Agent37SandboxAttr
>;

export const Agent37Sandbox = Resource<Agent37Sandbox>("Hobo.Agent37Sandbox");

export class Agent37SandboxError extends Data.TaggedError(
	"Agent37SandboxError",
)<{
	readonly code:
		| "AGENT37_SNAPSHOT_FAILED"
		| "AGENT37_SANDBOX_FAILED"
		| "AGENT37_AUTH_MISSING";
	readonly message: string;
}> {}

export interface Agent37SandboxApiClient {
	readonly buildSnapshot: (input: {
		readonly name: string;
		readonly run: readonly string[];
		readonly fromSnapshotName: string | undefined;
		readonly cwd: string;
		readonly size: Agent37SandboxSize;
		readonly region: Agent37SandboxRegion;
		readonly setupHash: string;
		readonly authorizationHeader: string;
	}) => Promise<{ readonly snapshotId: string }>;
	readonly deleteSnapshot: (input: {
		readonly snapshotId: string;
		readonly authorizationHeader: string;
	}) => Promise<void>;
	readonly createSandbox: (input: {
		readonly name: string;
		readonly size: Agent37SandboxSize;
		readonly region: Agent37SandboxRegion;
		readonly snapshotName: string | undefined;
		readonly forkFromSandboxId: string | undefined;
		readonly autoStopSeconds: number;
		readonly noEnv: boolean;
		readonly labels: readonly string[];
		readonly authorizationHeader: string;
	}) => Promise<{
		readonly sandboxId: string;
		readonly endpointUrl: string;
		readonly state: "ready" | "archived";
	}>;
	readonly execSandbox: (input: {
		readonly sandboxId: string;
		readonly command: string;
		readonly cwd?: string;
		readonly authorizationHeader: string;
	}) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
	readonly deleteSandbox: (input: {
		readonly sandboxId: string;
		readonly authorizationHeader: string;
	}) => Promise<void>;
}

export interface Agent37SandboxProviderOptions {
	readonly client: Agent37SandboxApiClient;
	readonly resolveCredential?: OwnerCredentialResolver;
	readonly defaultCredentialConfigKey?: string;
}

export function computeAgent37SetupHash(input: {
	readonly run: readonly string[];
	readonly from?: Agent37SnapshotBase;
	readonly cwd?: string;
	readonly size?: Agent37SandboxSize;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				run: input.run,
				from: input.from?.name ?? null,
				fromHash: input.from?.setupHash ?? null,
				cwd: input.cwd ?? "/home/user",
				size: input.size ?? "default",
			}),
		)
		.digest("hex");
}

function resolveAgent37AuthHeader(
	options: Agent37SandboxProviderOptions,
	credentialLocator: string | undefined,
	credentialConfigKey: string | undefined,
): Effect.Effect<string, Agent37SandboxError> {
	return Effect.gen(function* () {
		if (credentialLocator !== undefined) {
			if (options.resolveCredential === undefined) {
				return yield* Effect.fail(
					new Agent37SandboxError({
						code: "AGENT37_AUTH_MISSING",
						message:
							"owner credential resolver is required for owner:// locator",
					}),
				);
			}
			const validated = parseOwnerCredentialLocator(credentialLocator);
			const value = yield* resolveOwnerCredential(
				options.resolveCredential,
				validated,
			).pipe(
				Effect.mapError(
					(error) =>
						new Agent37SandboxError({
							code: "AGENT37_AUTH_MISSING",
							message: error.message,
						}),
				),
			);
			return `Bearer ${value}`;
		}
		const configKey =
			credentialConfigKey ??
			options.defaultCredentialConfigKey ??
			"AGENT37_API_KEY";
		const secret = yield* Config.Redacted(configKey).pipe(
			Effect.mapError(
				() =>
					new Agent37SandboxError({
						code: "AGENT37_AUTH_MISSING",
						message: `missing Agent37 secret in Alchemy ConfigProvider: ${configKey}`,
					}),
			),
		);
		return `Bearer ${Redacted.value(secret)}`;
	});
}

export function Agent37SnapshotProvider(
	options: Agent37SandboxProviderOptions,
) {
	return Provider.succeed(Agent37Snapshot, {
		reconcile: ({ news, output }) =>
			Effect.gen(function* () {
				const size = news.size ?? "default";
				const region = news.region ?? "us";
				const setupHash = computeAgent37SetupHash({
					run: news.run,
					...(news.from !== undefined ? { from: news.from } : undefined),
					...(news.cwd !== undefined ? { cwd: news.cwd } : undefined),
					size,
				});
				if (
					output !== undefined &&
					output.name === news.name &&
					output.setupHash === setupHash &&
					output.size === size &&
					output.region === region
				) {
					return output;
				}
				const authorizationHeader = yield* resolveAgent37AuthHeader(
					options,
					news.credentialLocator,
					news.credentialConfigKey,
				);
				const built = yield* Effect.tryPromise({
					try: () =>
						options.client.buildSnapshot({
							name: news.name,
							run: news.run,
							fromSnapshotName: news.from?.name,
							cwd: news.cwd ?? "/home/user",
							size,
							region,
							setupHash,
							authorizationHeader,
						}),
					catch: (cause) =>
						new Agent37SandboxError({
							code: "AGENT37_SNAPSHOT_FAILED",
							message:
								cause instanceof Error
									? cause.message
									: "agent37 snapshot build failed",
						}),
				});
				return {
					snapshotId: built.snapshotId,
					name: news.name,
					size,
					region,
					setupHash,
					baseName: news.from?.name,
				};
			}),
		delete: ({ output, olds }) =>
			Effect.gen(function* () {
				if (output === undefined) return;
				const authorizationHeader = yield* resolveAgent37AuthHeader(
					options,
					olds?.credentialLocator,
					olds?.credentialConfigKey,
				);
				yield* Effect.tryPromise({
					try: () =>
						options.client.deleteSnapshot({
							snapshotId: output.snapshotId,
							authorizationHeader,
						}),
					catch: (cause) =>
						new Agent37SandboxError({
							code: "AGENT37_SNAPSHOT_FAILED",
							message:
								cause instanceof Error
									? cause.message
									: "agent37 snapshot delete failed",
						}),
				});
			}),
	});
}

export function Agent37SandboxProvider(options: Agent37SandboxProviderOptions) {
	return Provider.succeed(Agent37Sandbox, {
		reconcile: ({ news, output }) =>
			Effect.gen(function* () {
				const size = news.size ?? "default";
				const region = news.region ?? "us";
				const noEnv = news.noEnv ?? true;
				if (
					output !== undefined &&
					output.name === news.name &&
					output.snapshotName === news.snapshot?.name &&
					output.forkedFrom === news.forkFromSandboxId &&
					output.size === size &&
					output.region === region
				) {
					return {
						...output,
						labels: [...(news.labels ?? [])],
					};
				}
				const authorizationHeader = yield* resolveAgent37AuthHeader(
					options,
					news.credentialLocator,
					news.credentialConfigKey,
				);
				const created = yield* Effect.tryPromise({
					try: () =>
						options.client.createSandbox({
							name: news.name,
							size,
							region,
							snapshotName: news.snapshot?.name,
							forkFromSandboxId: news.forkFromSandboxId,
							autoStopSeconds: news.autoStopSeconds ?? 300,
							noEnv,
							labels: news.labels ?? [],
							authorizationHeader,
						}),
					catch: (cause) =>
						new Agent37SandboxError({
							code: "AGENT37_SANDBOX_FAILED",
							message:
								cause instanceof Error
									? cause.message
									: "agent37 sandbox create failed",
						}),
				});
				return {
					sandboxId: created.sandboxId,
					name: news.name,
					provider: "agent37" as const,
					size,
					region,
					snapshotName: news.snapshot?.name,
					forkedFrom: news.forkFromSandboxId,
					endpointUrl: created.endpointUrl,
					state: created.state,
					noEnv,
					labels: [...(news.labels ?? [])],
				};
			}),
		delete: ({ output, olds }) =>
			Effect.gen(function* () {
				if (output === undefined) return;
				const authorizationHeader = yield* resolveAgent37AuthHeader(
					options,
					olds?.credentialLocator,
					olds?.credentialConfigKey,
				);
				yield* Effect.tryPromise({
					try: () =>
						options.client.deleteSandbox({
							sandboxId: output.sandboxId,
							authorizationHeader,
						}),
					catch: (cause) =>
						new Agent37SandboxError({
							code: "AGENT37_SANDBOX_FAILED",
							message:
								cause instanceof Error
									? cause.message
									: "agent37 sandbox delete failed",
						}),
				});
			}),
	});
}
