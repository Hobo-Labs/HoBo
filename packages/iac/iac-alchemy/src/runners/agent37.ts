import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
	type OwnerCredentialResolver,
	parseOwnerCredentialLocator,
	type RunnerCredentialError,
	resolveOwnerCredential,
} from "./owner-credentials.js";

export type Agent37RunnerInstanceType = "default" | "vm" | "performance";
export type Agent37RunnerRegion = "us" | "eu" | "ap-south";

export class Agent37RunnerError extends Data.TaggedError("Agent37RunnerError")<{
	readonly code: "AGENT37_PROVISION_FAILED" | "AGENT37_DELETE_FAILED";
	readonly message: string;
}> {}

export interface Agent37RunnerClient {
	readonly createSandbox: (input: {
		readonly name: string;
		readonly template: string;
		readonly instanceType: Agent37RunnerInstanceType;
		readonly region: Agent37RunnerRegion;
		readonly cpu: number;
		readonly memoryGb: number;
		readonly labels: readonly string[];
		readonly authorizationHeader: string;
	}) => Promise<{
		readonly sandboxId: string;
		readonly status: string;
		readonly endpointUrl: string;
	}>;
	readonly deleteSandbox: (input: {
		readonly sandboxId: string;
		readonly authorizationHeader: string;
	}) => Promise<void>;
	readonly listSandboxes?: (input: {
		readonly authorizationHeader: string;
	}) => Promise<
		readonly {
			readonly sandboxId: string;
			readonly name: string;
		}[]
	>;
}

function agent37RunnerConfigMatches(
	output: Agent37RunnerAttr,
	news: Agent37RunnerProps,
): boolean {
	return (
		output.name === news.name &&
		output.instanceType === news.instanceType &&
		output.region === news.region
	);
}

async function deleteAgent37Sandbox(
	options: Agent37RunnerProviderOptions,
	sandboxId: string,
	authorizationHeader: string,
): Promise<void> {
	await options.client.deleteSandbox({ sandboxId, authorizationHeader });
}

async function reconcileAgent37OrphanSandboxes(
	options: Agent37RunnerProviderOptions,
	input: {
		readonly name: string;
		readonly retainSandboxId?: string;
		readonly authorizationHeader: string;
	},
): Promise<void> {
	if (options.client.listSandboxes === undefined) return;
	const sandboxes = await options.client.listSandboxes({
		authorizationHeader: input.authorizationHeader,
	});
	for (const sandbox of sandboxes) {
		if (sandbox.name !== input.name) continue;
		if (sandbox.sandboxId === input.retainSandboxId) continue;
		await deleteAgent37Sandbox(
			options,
			sandbox.sandboxId,
			input.authorizationHeader,
		);
	}
}

export interface Agent37RunnerProps {
	readonly name: string;
	readonly template: string;
	readonly instanceType: Agent37RunnerInstanceType;
	readonly region: Agent37RunnerRegion;
	readonly cpu: number;
	readonly memoryGb: number;
	readonly labels: readonly string[];
	readonly credentialLocator: string;
}

export interface Agent37RunnerAttr {
	readonly runnerId: string;
	readonly tier: "agent37";
	readonly sandboxId: string;
	readonly name: string;
	readonly instanceType: Agent37RunnerInstanceType;
	readonly region: Agent37RunnerRegion;
	readonly status: string;
	readonly endpointUrl: string;
	readonly labels: readonly string[];
	readonly credentialLocator: string;
}

export type Agent37Runner = Resource<
	"Hobo.Agent37Runner",
	Agent37RunnerProps,
	Agent37RunnerAttr
>;

export const Agent37Runner = Resource<Agent37Runner>("Hobo.Agent37Runner");

export interface Agent37RunnerProviderOptions {
	readonly resolveCredential: OwnerCredentialResolver;
	readonly client: Agent37RunnerClient;
}

export function Agent37RunnerProvider(options: Agent37RunnerProviderOptions) {
	return Provider.succeed(Agent37Runner, {
		reconcile: ({ news, output }) =>
			Effect.gen(function* () {
				const locator = parseOwnerCredentialLocator(news.credentialLocator);
				if (
					output !== undefined &&
					agent37RunnerConfigMatches(output, news)
				) {
					return {
						...output,
						labels: [...news.labels],
						credentialLocator: locator,
					};
				}
				const credential = yield* resolveOwnerCredential(
					options.resolveCredential,
					locator,
				);
				const authorizationHeader = `Bearer ${credential}`;
				if (output !== undefined) {
					yield* Effect.tryPromise({
						try: () =>
							deleteAgent37Sandbox(
								options,
								output.sandboxId,
								authorizationHeader,
							),
						catch: (cause) =>
							new Agent37RunnerError({
								code: "AGENT37_PROVISION_FAILED",
								message:
									cause instanceof Error
										? cause.message
										: "agent37 orphan sandbox delete failed",
							}),
					});
				}
				yield* Effect.tryPromise({
					try: () =>
						reconcileAgent37OrphanSandboxes(options, {
							name: news.name,
							authorizationHeader,
						}),
					catch: (cause) =>
						new Agent37RunnerError({
							code: "AGENT37_PROVISION_FAILED",
							message:
								cause instanceof Error
									? cause.message
									: "agent37 orphan sandbox reconcile failed",
						}),
				});
				const created = yield* Effect.tryPromise({
					try: () =>
						options.client.createSandbox({
							name: news.name,
							template: news.template,
							instanceType: news.instanceType,
							region: news.region,
							cpu: news.cpu,
							memoryGb: news.memoryGb,
							labels: news.labels,
							authorizationHeader,
						}),
					catch: (cause): Agent37RunnerError | RunnerCredentialError =>
						cause instanceof Agent37RunnerError
							? cause
							: new Agent37RunnerError({
									code: "AGENT37_PROVISION_FAILED",
									message:
										cause instanceof Error
											? cause.message
											: "agent37 sandbox provision failed",
								}),
				});
				yield* Effect.tryPromise({
					try: () =>
						reconcileAgent37OrphanSandboxes(options, {
							name: news.name,
							retainSandboxId: created.sandboxId,
							authorizationHeader,
						}),
					catch: (cause) =>
						new Agent37RunnerError({
							code: "AGENT37_PROVISION_FAILED",
							message:
								cause instanceof Error
									? cause.message
									: "agent37 orphan sandbox reconcile failed",
						}),
				});
				return {
					runnerId: `agent37:${created.sandboxId}`,
					tier: "agent37" as const,
					sandboxId: created.sandboxId,
					name: news.name,
					instanceType: news.instanceType,
					region: news.region,
					status: created.status,
					endpointUrl: created.endpointUrl,
					labels: [...news.labels],
					credentialLocator: locator,
				};
			}),
		delete: ({ output }) =>
			Effect.gen(function* () {
				if (output === undefined) return;
				const credential = yield* resolveOwnerCredential(
					options.resolveCredential,
					output.credentialLocator,
				);
				yield* Effect.tryPromise({
					try: () =>
						options.client.deleteSandbox({
							sandboxId: output.sandboxId,
							authorizationHeader: `Bearer ${credential}`,
						}),
					catch: (cause) =>
						new Agent37RunnerError({
							code: "AGENT37_DELETE_FAILED",
							message:
								cause instanceof Error
									? cause.message
									: "agent37 sandbox delete failed",
						}),
				});
			}),
	});
}
