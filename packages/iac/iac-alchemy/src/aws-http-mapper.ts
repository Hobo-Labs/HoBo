/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: deployment authority is host-supplied and validated at the provider boundary. */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { types } from "node:util";
import type { Providers } from "@alchemy.run/aws";
import type { Table } from "@alchemy.run/aws/DynamoDB";
import { WebFunction } from "@alchemy.run/aws/Lambda";
import type { Bucket } from "@alchemy.run/aws/S3";
import type { Secret } from "@alchemy.run/aws/SecretsManager";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { awsBindleMappers } from "./aws.js";
import type { AwsHttpEntrypoint } from "./aws-http-runtime.js";
import { type AwsHttpSource, inspectAwsHttpSource } from "./aws-http-source.js";
import type {
	AlchemyPrimitiveInput,
	AlchemyPrimitiveMapper,
} from "./bindle.js";
import { AlchemyIacError } from "./plan.js";
import {
	type AlchemySourceClaim,
	type AlchemySourceFence,
	type AlchemySourceRequirement,
	captureAlchemySourceFence,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "./source-fence.js";
import { acceptSynchronousTrue } from "./synchronous-result.js";

export function awsWebFunctionSource(
	bindleName: string,
	applicationName: string,
	sourcePath: string,
): AlchemySourceRequirement {
	return Object.freeze({
		resourceId: applicationName,
		resourceType: "AWS.Lambda.WebFunction",
		bindleName,
		applicationName,
		sourceKind: "aws-web-function",
		sourcePath,
	});
}

export function awsHttpBindleMappers<Requirements>(
	options: {
		readonly source: AwsHttpSource;
		readonly main: string;
		readonly authType: "IamAuth" | "ApplicationManaged";
		readonly maxEnvironments: number;
		readonly rateLimit: number;
		readonly sourceFence: AlchemySourceFence;
		readonly verifySource: (
			claim: Readonly<{
				main: string;
				source: AwsHttpSource;
				authType: "IamAuth" | "ApplicationManaged";
				maxEnvironments: number;
				rateLimit: number;
			}>,
		) => boolean;
	},
	base = awsBindleMappers<AwsHttpEntrypoint, Requirements>(),
) {
	if (
		!options ||
		typeof options !== "object" ||
		types.isProxy(options) ||
		Reflect.ownKeys(options).length !== 7 ||
		[
			"source",
			"main",
			"authType",
			"maxEnvironments",
			"rateLimit",
			"sourceFence",
			"verifySource",
		].some((key) => {
			const field = Object.getOwnPropertyDescriptor(options, key);
			return !field || !Object.hasOwn(field, "value") || !field.enumerable;
		})
	)
		throw new AlchemyIacError(
			"ENTRYPOINT_UNSUPPORTED",
			"AWS source options must be own data",
		);
	const { source, main, authType, maxEnvironments, rateLimit, verifySource } =
		options;
	const captured = inspectAwsHttpSource(source);
	const fence = captureAlchemySourceFence(options.sourceFence);
	if (
		!captured ||
		!fence ||
		typeof main !== "string" ||
		!isAbsolute(main) ||
		main.length > 4096 ||
		/[\p{Cc}]/u.test(main) ||
		(authType !== "IamAuth" && authType !== "ApplicationManaged") ||
		!Number.isInteger(maxEnvironments) ||
		maxEnvironments < 2 ||
		maxEnvironments > 10_000 ||
		!Number.isInteger(rateLimit) ||
		rateLimit < 0 ||
		rateLimit > 10_000 ||
		rateLimit % (rateLimit <= 1000 ? 100 : 1000) !== 0 ||
		typeof verifySource !== "function" ||
		types.isProxy(verifySource)
	)
		throw new AlchemyIacError(
			"ENTRYPOINT_UNSUPPORTED",
			"an attested AWS HTTP source, explicit endpoint authentication and valid scaling limits are required",
		);
	let canonical: string;
	try {
		canonical = realpathSync(main);
		if (canonical !== main || !statSync(main).isFile())
			throw new Error("invalid source path");
	} catch {
		throw new AlchemyIacError(
			"ENTRYPOINT_UNSUPPORTED",
			"the source must be an existing canonical file",
		);
	}
	const graph = captured.graph;
	const root = graph.bindle.resources[graph.applicationName];
	if (
		!root ||
		(root.kind !== "web" && root.kind !== "api" && root.kind !== "service")
	)
		throw new AlchemyIacError(
			"ENTRYPOINT_UNSUPPORTED",
			"unsupported AWS HTTP application",
		);
	const requirement = awsWebFunctionSource(
		graph.bindleName,
		graph.applicationName,
		canonical,
	);
	const claim: AlchemySourceClaim = Object.freeze({
		...requirement,
		sourceDigest: fence.sourceDigest,
		environmentDigest: fence.environmentDigest,
		proofRef: fence.proofRef,
	});
	const checkSource = () => {
		let verified = false;
		try {
			verified =
				acceptSynchronousTrue(
					verifySource(
						Object.freeze({
							main: canonical,
							source,
							authType,
							maxEnvironments,
							rateLimit,
						}),
					),
				) && verifyAlchemySourceFence(fence, claim);
		} catch {}
		if (!verified || !inspectAwsHttpSource(source))
			throw new AlchemyIacError(
				"SOURCE_FENCE_UNVERIFIED",
				"the host did not verify the AWS source and immutable artifact fence",
			);
	};
	type Input = AlchemyPrimitiveInput<AwsHttpEntrypoint, Requirements>;
	const validate = (input: Input) => {
		checkSource();
		if (
			input.bindleName !== graph.bindleName ||
			input.declaration.name !== graph.applicationName ||
			input.entrypoint !== graph.entrypoint ||
			JSON.stringify(input.declaration) !== JSON.stringify(root) ||
			Object.keys(input.dependencyDeclarations).length !== graph.bindings.length
		)
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				"AWS application does not match its captured source graph",
			);
		for (const binding of graph.bindings) {
			if (
				JSON.stringify(input.dependencyDeclarations[binding.name]) !==
				JSON.stringify(graph.bindle.resources[binding.name])
			)
				throw new AlchemyIacError(
					"BINDLE_GRAPH_UNSUPPORTED",
					"AWS application dependencies do not match its source graph",
				);
		}
	};
	const mapper: AlchemyPrimitiveMapper<
		AwsHttpEntrypoint,
		Requirements,
		Providers
	> = {
		resourceTypes: ["AWS.Lambda.WebFunction"],
		operations: [],
		annotations: ["hobo:session-replay"],
		bindsEntrypoint: true,
		limitations: [
			"Node.js HTTP with selected bounded DynamoDB, S3, Secrets Manager and durable queue bindings; the host authenticates source, endpoint, stores, IAM and pricing inventory.",
		],
		validate,
		build: (input) =>
			Effect.gen(function* () {
				validate(input);
				if (Object.keys(input.dependencies).length !== graph.bindings.length)
					throw new AlchemyIacError(
						"BINDLE_GRAPH_UNSUPPORTED",
						"AWS dependencies are incomplete",
					);
				const env: Record<
					string,
					Table["tableName"] | Bucket["bucketName"] | Secret["secretArn"]
				> = {};
				for (const binding of graph.bindings) {
					const dependency: ResourceLike | undefined =
						input.dependencies[binding.name];
					const expected =
						binding.kind === "kv" || binding.kind === "queue"
							? "AWS.DynamoDB.Table"
							: binding.kind === "bucket"
								? "AWS.S3.Bucket"
								: "AWS.SecretsManager.Secret";
					if (
						!dependency ||
						dependency.FQN !== binding.name ||
						dependency.Type !== expected
					)
						throw new AlchemyIacError(
							"BINDLE_GRAPH_UNSUPPORTED",
							"AWS dependency type or identity does not match",
						);
					// SAFETY: the Alchemy mapper created this dependency with the checked resource type and FQN.
					env[binding.environment] =
						binding.kind === "kv" || binding.kind === "queue"
							? (dependency as Table).tableName
							: binding.kind === "bucket"
								? (dependency as Bucket).bucketName
								: (dependency as Secret).secretArn;
				}
				const primary = yield* WebFunction(graph.applicationName, {
					main: canonical,
					authType,
					env,
					maxConcurrencyPerEnvironment: 32,
					maxEnvironments,
					rateLimit,
				});
				if (
					primary.FQN !== claim.resourceId ||
					primary.Type !== claim.resourceType
				)
					throw new AlchemyIacError(
						"ENTRYPOINT_UNSUPPORTED",
						"AWS web function identity does not match the source claim",
					);
				registerAlchemySource(primary, {
					claim,
					verify: (value) => {
						try {
							checkSource();
							return verifyAlchemySourceFence(fence, value);
						} catch {
							return false;
						}
					},
				});
				checkSource();
				return {
					primary,
					resources: [primary],
					boundDependencies: graph.bindings.map((binding) => binding.name),
					boundEntrypoint: graph.entrypoint,
				};
			}),
	};
	return Object.freeze({ ...base, [root.kind]: Object.freeze(mapper) });
}
