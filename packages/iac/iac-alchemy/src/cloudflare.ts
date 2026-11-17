import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Namespace } from "@alchemy.run/cloudflare/KV/Namespace";
import type { Providers } from "@alchemy.run/cloudflare/Providers";
import { Queue } from "@alchemy.run/cloudflare/Queues/Queue";
import { Bucket } from "@alchemy.run/cloudflare/R2/Bucket";
import { Vite } from "@alchemy.run/cloudflare/Website/Vite";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import * as Effect from "effect/Effect";
import {
	type AlchemyPrimitiveInput,
	type AlchemyPrimitiveMapper,
	type AlchemyPrimitiveSupport,
	describeAlchemyPrimitiveSupport,
} from "./bindle.js";
import {
	type CloudflareBindleEntrypoint,
	cloudflareDependencyBindings,
	inspectCloudflareWorker,
	validateCloudflareHttpAnnotations,
} from "./cloudflare-runtime.js";
import { AlchemyIacError } from "./plan.js";
import {
	type AlchemySourceClaim,
	type AlchemySourceFence,
	captureAlchemySourceFence,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "./source-fence.js";

export interface CloudflareBindleMappingOptions {
	/** Resource name to source module. The module must default-export bindleCloudflareWorker for that entrypoint. */
	readonly workerModules: Readonly<Record<string, string>>;
	/** Trusted source tree containing framework application roots. Defaults to the current directory. */
	readonly projectRoot?: string;
	/** Trusted host authority, required for every executable application source. */
	readonly sourceFence?: AlchemySourceFence;
}

const viteEntrypoints = new WeakMap<CloudflareBindleEntrypoint, string>();

/** Declare a Vite application's source as the web entrypoint of a Bindle. */
export function cloudflareViteApp(root: string): () => never {
	const entrypoint = (): never => {
		throw new Error("Vite applications are served by their framework runtime");
	};
	const metadata = Object.freeze({ framework: "vite", root });
	Object.defineProperty(entrypoint, Symbol.for("hobo.webapp.meta"), {
		value: metadata,
	});
	viteEntrypoints.set(entrypoint, root);
	return Object.freeze(entrypoint);
}

export type CloudflareBindleMappers<Requirements> = Readonly<
	Record<
		"api" | "bucket" | "kv" | "queue" | "service" | "web",
		AlchemyPrimitiveMapper<CloudflareBindleEntrypoint, Requirements, Providers>
	>
>;

const CLOUD_FLARE_LIMITATIONS: Readonly<Record<string, string>> = Object.freeze(
	{
		api: "HTTP Worker requires an exported bindle module and disabled session replay.",
		kv: "KV infrastructure only: the HoBo WASI store runtime and its consistency are not bound.",
		bucket:
			"R2 infrastructure only: blob object metadata, blob events and presigned URLs are not bound.",
		queue:
			"Queue infrastructure is available; idempotent enqueue and leased dequeue are not implemented.",
		topic:
			"Cloudflare Queue delivery is not a multi-subscriber messaging topic.",
		secret:
			"Cloudflare secrets have no implemented HoBo put/access runtime binding.",
		data: "Cloudflare databases have no implemented HoBo data-port binding.",
		schedule: "No scheduler binding is implemented for this mapping.",
		project: "No equivalent HoBo project isolation binding is implemented.",
		websocket:
			"No HoBo websocket lifecycle or broadcast binding is implemented.",
		job: "No HoBo job submit and completion binding is implemented.",
		web: "Vite website or HTTP Worker; both require disabled session replay and Vite dependencies are unsupported.",
		service:
			"HTTP Worker requires an exported bindle module and disabled session replay.",
		external:
			"External dependency authority and connection metadata are not mapped.",
		container: "Container configuration and lifecycle are not mapped.",
		"wasm-component": "The WASI component runtime and imports are not mapped.",
		flag: "No HoBo feature-flag evaluation or mutation binding is implemented.",
		auth: "No HoBo identity verification and session binding is implemented.",
		crypto:
			"No HoBo cryptographic key lifecycle and policy binding is implemented.",
		notify: "No HoBo notification delivery binding is implemented.",
		guardrail: "No HoBo guardrail evaluation binding is implemented.",
		ui: "No HoBo UI render and drive binding is implemented.",
		experiment:
			"No HoBo experiment assignment and analysis binding is implemented.",
		rollout: "No HoBo rollout progression and rollback binding is implemented.",
	},
);

export interface CloudflarePrimitiveSupport extends AlchemyPrimitiveSupport {
	readonly reason: string;
}

/** Describe every supplied catalog entry, including kinds this provider cannot map. */
export function describeCloudflarePrimitiveSupport(
	catalog: readonly {
		readonly factory: string;
		readonly allowVerbs: readonly string[];
	}[],
): CloudflarePrimitiveSupport[] {
	return describeAlchemyPrimitiveSupport(
		catalog,
		cloudflareBindleMappers({ workerModules: {} }),
	).map((support) => ({
		...support,
		reason: Object.hasOwn(CLOUD_FLARE_LIMITATIONS, support.kind)
			? (CLOUD_FLARE_LIMITATIONS[support.kind] ?? "No mapping is implemented.")
			: "No mapping is implemented for this primitive.",
	}));
}

/** Map supported HoBo declarations to real Alchemy Cloudflare resources. */
export function cloudflareBindleMappers<Requirements>(
	options: CloudflareBindleMappingOptions,
) {
	const workerModules = Object.freeze({ ...options.workerModules });
	const workingDirectory = process.cwd();
	const projectRoot = resolve(options.projectRoot ?? workingDirectory);
	const sourceFence = captureAlchemySourceFence(options.sourceFence);
	type Input = AlchemyPrimitiveInput<CloudflareBindleEntrypoint, Requirements>;
	const sourceBinding = (
		input: Input,
		sourceKind: "worker" | "vite",
		sourcePath: string,
		resourceId: string,
	) => {
		if (
			sourceFence === undefined ||
			!isAbsolute(sourcePath) ||
			sourcePath.length > 4096 ||
			/[\p{Cc}]/u.test(sourcePath)
		)
			throw new AlchemyIacError(
				"SOURCE_FENCE_REQUIRED",
				"a trusted immutable source and environment fence is required",
			);
		const claim: AlchemySourceClaim = Object.freeze({
			resourceId,
			resourceType: "Cloudflare.Worker",
			bindleName: input.bindleName,
			applicationName: input.declaration.name,
			sourceKind,
			sourcePath,
			sourceDigest: sourceFence.sourceDigest,
			environmentDigest: sourceFence.environmentDigest,
			proofRef: sourceFence.proofRef,
		});
		if (!verifyAlchemySourceFence(sourceFence, claim))
			throw new AlchemyIacError(
				"SOURCE_FENCE_UNVERIFIED",
				"the host did not fence this exact application source",
			);
		return {
			claim,
			verify: (value: AlchemySourceClaim) =>
				verifyAlchemySourceFence(sourceFence, value),
		};
	};
	const viteRoot = (input: Input): string | undefined => {
		const websiteAnnotations = input.declaration.annotations.filter(
			(annotation) =>
				annotation.provider === "hobo" && annotation.option === "webapp",
		);
		if (websiteAnnotations.length === 0) return undefined;
		const website = websiteAnnotations[0];
		if (websiteAnnotations.length !== 1 || website === undefined)
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				"multiple web app annotations are unsupported",
			);
		validateCloudflareHttpAnnotations({
			...input.declaration,
			annotations: input.declaration.annotations.filter(
				(annotation) => annotation !== website,
			),
		});
		const properties = Object.getOwnPropertyDescriptors(website.config);
		const framework = properties.framework;
		const root = properties.root;
		if (
			Object.keys(properties).length !== 2 ||
			framework === undefined ||
			!("value" in framework) ||
			framework.value !== "vite" ||
			root === undefined ||
			!("value" in root) ||
			/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: annotation data crosses the provider boundary. */
			typeof root.value !== "string" ||
			root.value.length === 0 ||
			root.value.length > 4096 ||
			root.value.trim() !== root.value ||
			/[\\\p{Cc}]/u.test(root.value) ||
			isAbsolute(root.value) ||
			root.value.split("/").includes("..") ||
			input.entrypoint === undefined ||
			viteEntrypoints.get(input.entrypoint) !== root.value
		)
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				"Vite requires its provider-owned entrypoint and a bounded relative root",
			);
		if (Object.keys(input.dependencyDeclarations).length !== 0)
			throw new AlchemyIacError(
				"BINDLE_GRAPH_UNSUPPORTED",
				"Vite application dependencies are not bound",
			);
		try {
			const tree = realpathSync(projectRoot);
			const source = realpathSync(resolve(tree, root.value));
			const path = relative(tree, source);
			if (
				path === ".." ||
				path.startsWith(`..${sep}`) ||
				isAbsolute(path) ||
				!statSync(source).isDirectory()
			)
				throw new Error("outside source tree");
			return source;
		} catch {
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				"Vite root must be an existing directory inside the project root",
			);
		}
	};
	const noDependencies = (input: Input) => {
		if (Object.keys(input.dependencyDeclarations).length !== 0)
			throw new AlchemyIacError(
				"BINDLE_GRAPH_UNSUPPORTED",
				`${input.declaration.kind} does not support declared dependencies`,
			);
	};
	const empty = {
		annotations: [],
		bindsEntrypoint: false,
		validate: noDependencies,
	} as const;
	const http: AlchemyPrimitiveMapper<
		CloudflareBindleEntrypoint,
		Requirements,
		Providers
	> = {
		resourceTypes: ["Cloudflare.Worker"],
		operations: [],
		annotations: ["hobo:session-replay"],
		bindsEntrypoint: true,
		limitations: [CLOUD_FLARE_LIMITATIONS.web ?? "HTTP support is limited."],
		validate(input) {
			validateCloudflareHttpAnnotations(input.declaration);
			cloudflareDependencyBindings(input.dependencyDeclarations);
			const path = Object.hasOwn(workerModules, input.declaration.name)
				? workerModules[input.declaration.name]
				: undefined;
			if (
				input.entrypoint === undefined ||
				path === undefined ||
				path.length === 0 ||
				path.length > 4096 ||
				/[\p{Cc}]/u.test(path)
			)
				throw new AlchemyIacError(
					"ENTRYPOINT_UNSUPPORTED",
					`worker module is required for ${input.declaration.name}`,
				);
			sourceBinding(
				input,
				"worker",
				resolve(workingDirectory, path),
				input.declaration.name,
			);
		},
		build(input) {
			return Effect.gen(function* () {
				const path = workerModules[input.declaration.name];
				if (path === undefined)
					throw new AlchemyIacError(
						"ENTRYPOINT_UNSUPPORTED",
						"worker module vanished",
					);
				const sourcePath = resolve(workingDirectory, path);
				sourceBinding(input, "worker", sourcePath, input.declaration.name);
				const loaded = yield* Effect.promise(async () => {
					try {
						return await import(pathToFileURL(sourcePath).href);
					} catch {
						throw new AlchemyIacError(
							"ENTRYPOINT_UNSUPPORTED",
							"worker module could not be imported",
						);
					}
				});
				const exported = loaded.default;
				/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the source module is an external runtime boundary; its default export must be an inspectable worker object. */
				if (typeof exported !== "object" || exported === null)
					throw new AlchemyIacError(
						"ENTRYPOINT_UNSUPPORTED",
						"worker module has no bindle worker default export",
					);
				/* oxlint-enable anti-slop/no-runtime-typeof */
				const description = inspectCloudflareWorker(exported);
				const expected = cloudflareDependencyBindings(
					input.dependencyDeclarations,
				);
				if (
					description === undefined ||
					description.entrypoint !== input.entrypoint ||
					description.bindleName !== input.bindleName ||
					description.resourceName !== input.declaration.name ||
					JSON.stringify(description.bindings) !== JSON.stringify(expected)
				)
					throw new AlchemyIacError(
						"ENTRYPOINT_UNSUPPORTED",
						"worker module does not bind this entrypoint and its declared dependencies",
					);
				const bindings: Record<string, Worker> = Object.create(null);
				for (const binding of description.bindings) {
					const dependency = input.dependencies[binding.name];
					if (
						dependency === undefined ||
						dependency.Type !== "Cloudflare.Worker"
					)
						throw new AlchemyIacError(
							"BINDLE_GRAPH_UNSUPPORTED",
							`invalid native binding for ${binding.name}`,
						);
					// SAFETY: the dependency's Alchemy resource type was checked above.
					bindings[binding.env] = dependency as Worker;
				}
				const primary = yield* Worker(input.declaration.name, {
					main: sourcePath,
					env: bindings,
				});
				registerAlchemySource(
					primary,
					sourceBinding(input, "worker", sourcePath, primary.FQN),
				);
				return {
					primary,
					resources: [primary],
					boundDependencies: description.bindings.map(
						(binding) => binding.name,
					),
					boundEntrypoint: input.entrypoint,
				};
			});
		},
	};
	const web: AlchemyPrimitiveMapper<
		CloudflareBindleEntrypoint,
		Requirements,
		Providers
	> = {
		...http,
		annotations: ["hobo:session-replay", "hobo:webapp"],
		validate(input) {
			const root = viteRoot(input);
			if (root === undefined) http.validate?.(input);
			else sourceBinding(input, "vite", root, input.declaration.name);
		},
		build(input) {
			const root = viteRoot(input);
			if (root === undefined) return http.build(input);
			const entrypoint = input.entrypoint;
			if (entrypoint === undefined)
				throw new AlchemyIacError(
					"ENTRYPOINT_UNSUPPORTED",
					"Vite entrypoint is missing",
				);
			sourceBinding(input, "vite", root, input.declaration.name);
			return Effect.gen(function* () {
				const primary = yield* Vite(input.declaration.name, { rootDir: root });
				registerAlchemySource(
					primary,
					sourceBinding(input, "vite", root, primary.FQN),
				);
				return {
					primary,
					resources: [primary],
					boundDependencies: [],
					boundEntrypoint: entrypoint,
				};
			});
		},
	};
	return {
		bucket: {
			...empty,
			resourceTypes: ["Cloudflare.R2.Bucket"],
			operations: [],
			limitations: [
				CLOUD_FLARE_LIMITATIONS.bucket ?? "Bucket support is limited.",
			],
			build: (input) =>
				Effect.gen(function* () {
					const primary = yield* Bucket(input.declaration.name, {});
					return { primary, resources: [primary], boundDependencies: [] };
				}),
		},
		kv: {
			...empty,
			resourceTypes: ["Cloudflare.KV.Namespace"],
			operations: [],
			limitations: [CLOUD_FLARE_LIMITATIONS.kv ?? "KV support is limited."],
			build: (input) =>
				Effect.gen(function* () {
					const primary = yield* Namespace(input.declaration.name, {});
					return { primary, resources: [primary], boundDependencies: [] };
				}),
		},
		queue: {
			...empty,
			resourceTypes: ["Cloudflare.Queues.Queue"],
			operations: [],
			limitations: [
				CLOUD_FLARE_LIMITATIONS.queue ?? "Queue support is limited.",
			],
			build: (input) =>
				Effect.gen(function* () {
					const primary = yield* Queue(input.declaration.name, {});
					return { primary, resources: [primary], boundDependencies: [] };
				}),
		},
		web,
		api: http,
		service: http,
	} satisfies CloudflareBindleMappers<Requirements>;
}
