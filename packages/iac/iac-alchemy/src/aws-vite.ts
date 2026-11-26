import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Vite } from "@alchemy.run/aws/Website";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { isResource, type ResourceLike } from "alchemy/Resource";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { awsBindleMappers } from "./aws.js";
import {
	type AlchemyPrimitiveInput,
	type AlchemyPrimitiveMapper,
	describeAlchemyPrimitiveSupport,
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
import { safeAlchemyFqn } from "./state-identity.js";

type AwsViteEntrypoint = (
	...args: never[]
) => object | string | number | boolean | null;
const viteEntrypoints = new WeakMap<AwsViteEntrypoint, string>();
const apply = Reflect.apply;
const getViteEntrypoint = WeakMap.prototype.get;
const setViteEntrypoint = WeakMap.prototype.set;
const types = Object.freeze({
	Build: "Website.Server",
	Bucket: "AWS.S3.Bucket",
	Files: "AWS.Website.AssetDeployment",
	KvStore: "AWS.CloudFront.KeyValueStore",
	ViewerRequest: "AWS.CloudFront.Function",
	OriginAccessControl: "AWS.CloudFront.OriginAccessControl",
	Distribution: "AWS.CloudFront.Distribution",
	KvEntries: "AWS.CloudFront.KvEntries",
	Invalidation: "AWS.CloudFront.Invalidation",
});

export function awsViteApp(root: string): () => never {
	const entrypoint = (): never => {
		throw new Error("Vite applications are served by their framework runtime");
	};
	Object.defineProperty(entrypoint, Symbol.for("hobo.webapp.meta"), {
		value: Object.freeze({ framework: "vite", root }),
	});
	apply(setViteEntrypoint, viteEntrypoints, [entrypoint, root]);
	return Object.freeze(entrypoint);
}

export function awsViteSource(
	bindleName: string,
	resourceName: string,
	sourcePath: string,
): AlchemySourceRequirement {
	return Object.freeze({
		resourceId: `${resourceName}/Build`,
		resourceType: types.Build,
		bindleName,
		applicationName: resourceName,
		sourceKind: "vite",
		sourcePath,
	});
}

export function awsViteBindleMappers<Requirements>(options: {
	readonly projectRoot: string;
	readonly sourceFence: AlchemySourceFence;
}) {
	const fence = captureAlchemySourceFence(options.sourceFence);
	const projectRoot = options.projectRoot;
	type Input = AlchemyPrimitiveInput<AwsViteEntrypoint, Requirements>;
	const source = (input: Input) => {
		if (!fence)
			throw new AlchemyIacError(
				"SOURCE_FENCE_REQUIRED",
				"a trusted source fence is required",
			);
		const web = input.declaration.annotations.filter(
			(annotation) =>
				annotation.provider === "hobo" && annotation.option === "webapp",
		);
		const replay = input.declaration.annotations.filter(
			(annotation) =>
				annotation.provider === "hobo" &&
				annotation.option === "session-replay",
		);
		if (
			web.length !== 1 ||
			replay.length > 1 ||
			web.length + replay.length !== input.declaration.annotations.length
		)
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				"Vite annotations are unsupported",
			);
		if (
			replay.some(
				(annotation) =>
					Object.getOwnPropertyDescriptor(annotation.config, "enabled")
						?.value !== false ||
					Object.keys(annotation.config).some(
						(key) => !["enabled", "defaultSupply", "sampleRate"].includes(key),
					),
			)
		)
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				"session replay must be disabled",
			);
		const config = web[0]?.config;
		const root =
			config && Object.getOwnPropertyDescriptor(config, "root")?.value;
		const framework =
			config && Object.getOwnPropertyDescriptor(config, "framework")?.value;
		if (
			!config ||
			Object.keys(config).length !== 2 ||
			framework !== "vite" ||
			/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the annotation must contain a bounded string before it is resolved as a path. */
			typeof root !== "string" ||
			!root ||
			root.length > 4096 ||
			root.trim() !== root ||
			/[\\\p{Cc}]/u.test(root) ||
			isAbsolute(root) ||
			root.split("/").includes("..") ||
			!input.entrypoint ||
			apply(getViteEntrypoint, viteEntrypoints, [input.entrypoint]) !== root
		)
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				"Vite requires its provider-owned entrypoint and a bounded relative root",
			);
		if (
			Object.keys(types).some(
				(suffix) => !safeAlchemyFqn(`${input.declaration.name}/${suffix}`),
			)
		)
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				"Vite resource names are not valid Alchemy state identities",
			);
		if (Object.keys(input.dependencyDeclarations).length !== 0)
			throw new AlchemyIacError(
				"BINDLE_GRAPH_UNSUPPORTED",
				"Vite application dependencies are not bound",
			);
		let path: string;
		try {
			const tree = realpathSync(projectRoot);
			path = realpathSync(resolve(tree, root));
			const rel = relative(tree, path);
			if (
				rel === ".." ||
				rel.startsWith(`..${sep}`) ||
				isAbsolute(rel) ||
				!statSync(path).isDirectory()
			)
				throw new Error("outside project");
		} catch {
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				"Vite root must be an existing directory inside the project root",
			);
		}
		const claim: AlchemySourceClaim = Object.freeze({
			...awsViteSource(input.bindleName, input.declaration.name, path),
			sourceDigest: fence.sourceDigest,
			environmentDigest: fence.environmentDigest,
			proofRef: fence.proofRef,
		});
		if (!verifyAlchemySourceFence(fence, claim))
			throw new AlchemyIacError(
				"SOURCE_FENCE_UNVERIFIED",
				"the host did not fence the exact Vite source",
			);
		return {
			path,
			binding: {
				claim,
				verify: (value: AlchemySourceClaim) =>
					verifyAlchemySourceFence(fence, value),
			},
		};
	};
	const web: AlchemyPrimitiveMapper<
		AwsViteEntrypoint,
		Requirements,
		Effect.Services<ReturnType<typeof Vite>>
	> = {
		resourceTypes: Object.values(types),
		operations: [],
		annotations: ["hobo:webapp", "hobo:session-replay"],
		bindsEntrypoint: true,
		limitations: [
			"Vite assets-only website; application dependencies, session replay and server-side rendering are not bound.",
		],
		validate(input) {
			source(input);
		},
		build(input) {
			const captured = source(input);
			const entrypoint = input.entrypoint;
			if (!entrypoint)
				throw new AlchemyIacError(
					"ENTRYPOINT_UNSUPPORTED",
					"Vite entrypoint is missing",
				);
			return Effect.gen(function* () {
				const context = yield* AlchemyContext;
				const remote = yield* ProviderModePolicy;
				if (context.dev && remote !== true)
					throw new AlchemyIacError(
						"MAPPING_INCOMPLETE",
						"Alchemy local Vite does not construct the live website resources",
					);
				const stack = yield* StackContext;
				const expected = Object.entries(types);
				for (const [suffix] of expected) {
					const key = `${input.declaration.name}/${suffix}`;
					if (
						Object.hasOwn(stack.resources, key) ||
						Object.hasOwn(stack.bindings, key)
					)
						throw new AlchemyIacError(
							"BINDLE_IDENTITY_COLLISION",
							"Alchemy Vite resource identity is already registered",
						);
				}
				const staged = {
					...stack,
					resources: { ...stack.resources },
					bindings: Object.fromEntries(
						Object.entries(stack.bindings).map(([key, values]) => [
							key,
							[...values],
						]),
					),
					actions: { ...stack.actions },
				};
				const site = yield* Vite(input.declaration.name, {
					rootDir: captured.path,
				}).pipe(Effect.provideService(StackContext, staged));
				const resources: ResourceLike[] = [];
				for (const key of Object.keys(staged.resources)) {
					if (Object.hasOwn(stack.resources, key)) {
						if (staged.resources[key] !== stack.resources[key])
							throw new AlchemyIacError(
								"MAPPING_INCOMPLETE",
								"Alchemy Vite changed an existing resource",
							);
						continue;
					}
					const resource = staged.resources[key];
					if (!resource)
						throw new AlchemyIacError(
							"MAPPING_INCOMPLETE",
							"Alchemy Vite resource is missing",
						);
					resources.push(resource);
				}
				const expectedNames = new Set(
					expected.map(([suffix]) => `${input.declaration.name}/${suffix}`),
				);
				const invalidPriorResources = Object.keys(stack.resources).some(
					(key) => staged.resources[key] !== stack.resources[key],
				);
				const missingPriorBindings = Object.keys(stack.bindings).some(
					(key) => !Object.hasOwn(staged.bindings, key),
				);
				const invalidBindings = Object.keys(staged.bindings).some((key) => {
					const prior = stack.bindings[key];
					const value = staged.bindings[key];
					if (!value) return true;
					if (!prior) return !expectedNames.has(key);
					return (
						value.length !== prior.length ||
						value.some((item, index) => item !== prior[index])
					);
				});
				const invalidActions =
					Object.keys(staged.actions).length !==
						Object.keys(stack.actions).length ||
					Object.keys(stack.actions).some(
						(key) => staged.actions[key] !== stack.actions[key],
					);
				if (
					resources.length !== expected.length ||
					invalidPriorResources ||
					missingPriorBindings ||
					invalidBindings ||
					invalidActions ||
					expected.some(([suffix, type]) => {
						const resource =
							staged.resources[`${input.declaration.name}/${suffix}`];
						return (
							!resource ||
							!isResource(resource) ||
							resource.FQN !== `${input.declaration.name}/${suffix}` ||
							resource.Type !== type
						);
					}) ||
					!isResource(site.build) ||
					site.build.FQN !== captured.binding.claim.resourceId
				)
					throw new AlchemyIacError(
						"MAPPING_INCOMPLETE",
						"Alchemy Vite did not construct the expected live website resources",
					);
				if (!captured.binding.verify(captured.binding.claim))
					throw new AlchemyIacError(
						"SOURCE_FENCE_UNVERIFIED",
						"the host no longer fences the Vite source",
					);
				for (const key of expectedNames) {
					if (
						Object.hasOwn(stack.resources, key) ||
						Object.hasOwn(stack.bindings, key)
					)
						throw new AlchemyIacError(
							"BINDLE_IDENTITY_COLLISION",
							"Alchemy Vite resource identity changed during construction",
						);
				}
				registerAlchemySource(site.build, captured.binding);
				for (const resource of resources)
					stack.resources[resource.FQN] = resource;
				for (const [key, values] of Object.entries(staged.bindings)) {
					if (!Object.hasOwn(stack.bindings, key)) stack.bindings[key] = values;
				}
				return {
					primary: site.build,
					resources,
					boundDependencies: [],
					boundEntrypoint: entrypoint,
				};
			});
		},
	};
	return Object.freeze({
		...awsBindleMappers<AwsViteEntrypoint, Requirements>(),
		web,
	});
}

export function describeAwsVitePrimitiveSupport(
	catalog: readonly {
		readonly factory: string;
		readonly allowVerbs: readonly string[];
	}[],
	options: {
		readonly projectRoot: string;
		readonly sourceFence: AlchemySourceFence;
	},
) {
	return describeAlchemyPrimitiveSupport(
		catalog,
		awsViteBindleMappers(options),
	);
}
