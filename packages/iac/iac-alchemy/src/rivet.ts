/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: source values cross an external provider boundary and are validated before use. */
import { isAbsolute, resolve } from "node:path";
import { types } from "node:util";
import { DurableObject, type Providers } from "@alchemy.run/rivet";
import { PoolHost } from "@alchemy.run/rivet/Host";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { AnyActorDefinition } from "rivetkit";
import type { PrimitiveDeclaration } from "./bindle.js";
import { AlchemyIacError } from "./plan.js";
import {
	isRivetHttpBinding,
	type RivetHttpBinding,
	type RivetHttpEntrypoint,
} from "./rivet-runtime.js";
import { inspectRivetRegistry, rivetOwnData } from "./rivet-source-boundary.js";
import { isRivetSynchronousTrue } from "./rivet-synchronous-authority.js";
import {
	type AlchemySourceClaim,
	type AlchemySourceFence,
	captureAlchemySourceFence,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "./source-fence.js";

export {
	describeRivetPrimitiveSupport,
	type RivetPrimitiveSupport,
} from "./rivet-catalog.js";

const hasOwnDescriptor = Object.hasOwn;
const isProxy = types.isProxy;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const objectKeys = Object.keys;
const freeze = Object.freeze;

export interface RivetRegistry {
	readonly config: {
		readonly use: Readonly<Record<string, AnyActorDefinition>>;
	};
}

export interface RivetHttpSource<Entrypoint extends RivetHttpEntrypoint> {
	readonly main: string;
	readonly resourceName: string;
	readonly kind: "api" | "web" | "service";
	readonly actorName: string;

	readonly sourceDigest: string;

	readonly sourceFence: AlchemySourceFence;
	readonly registry: RivetRegistry;
	readonly binding: RivetHttpBinding<Entrypoint>;

	readonly verifySource: (source: {
		readonly main: string;
		readonly sourceDigest: string;
		readonly resourceName: string;
		readonly actorName: string;
		readonly registry: RivetRegistry;
		readonly binding: RivetHttpBinding<Entrypoint>;
	}) => boolean;
}

function name(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

export function bindRivetHttpSource<Entrypoint extends RivetHttpEntrypoint>(
	input: RivetHttpSource<Entrypoint>,
): RivetHttpSource<Entrypoint> {
	const main = rivetOwnData<string>(input, "main");
	const resourceName = rivetOwnData<string>(input, "resourceName");
	const kind = rivetOwnData<RivetHttpSource<Entrypoint>["kind"]>(input, "kind");
	const actorName = rivetOwnData<string>(input, "actorName");
	const sourceDigest = rivetOwnData<string>(input, "sourceDigest");
	const sourceFence = rivetOwnData<AlchemySourceFence>(input, "sourceFence");
	const registry = rivetOwnData<RivetRegistry>(input, "registry");
	const binding = rivetOwnData<RivetHttpBinding<Entrypoint>>(input, "binding");
	const verifySource = rivetOwnData<
		RivetHttpSource<Entrypoint>["verifySource"]
	>(input, "verifySource");
	if (
		typeof main !== "string" ||
		typeof resourceName !== "string" ||
		typeof kind !== "string" ||
		typeof actorName !== "string" ||
		typeof sourceDigest !== "string" ||
		registry === undefined ||
		binding === undefined ||
		typeof verifySource !== "function" ||
		isProxy(verifySource) ||
		isProxy(sourceFence)
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"source fields must be bounded own data",
		);
	const verifyFence = rivetOwnData<AlchemySourceFence["verify"]>(
		sourceFence,
		"verify",
	);
	const fence =
		typeof verifyFence === "function" && !isProxy(verifyFence)
			? captureAlchemySourceFence(sourceFence)
			: undefined;
	if (fence === undefined || fence.sourceDigest !== sourceDigest)
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"an immutable source fence bound to the reviewed digest is required",
		);
	const source = freeze({
		main,
		resourceName,
		kind,
		actorName,
		sourceDigest,
		sourceFence: fence,
		registry,
		binding,
		verifySource,
	});
	if (
		!isAbsolute(source.main) ||
		source.main.length > 4096 ||
		/[\p{Cc}]/u.test(source.main) ||
		!name(source.resourceName) ||
		!name(source.actorName) ||
		!["api", "web", "service"].includes(source.kind) ||
		!/^sha256:[a-f0-9]{64}$/u.test(source.sourceDigest)
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"a bounded absolute program source and digest are required",
		);
	const actors = inspectRivetRegistry(source.registry);
	if (
		!isRivetHttpBinding(source.binding) ||
		source.resourceName !== source.actorName ||
		source.actorName !== source.binding.actorName ||
		actors?.actor(source.actorName) !== source.binding.actor
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			"the resource and actor names must match and the registry must contain the bound actor",
		);
	let verified = false;
	try {
		verified = isRivetSynchronousTrue(
			source.verifySource({
				main: source.main,
				sourceDigest: source.sourceDigest,
				resourceName: source.resourceName,
				actorName: source.actorName,
				registry: source.registry,
				binding: source.binding,
			}),
		);
	} catch {
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"source verification was unavailable",
		);
	}
	if (
		verified !== true ||
		!isRivetHttpBinding(source.binding) ||
		inspectRivetRegistry(source.registry)?.actor(source.actorName) !==
			source.binding.actor
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"the host did not verify the source and runtime binding",
		);
	return source;
}

interface ValidationInput<Entrypoint, Requirements> {
	readonly declaration: PrimitiveDeclaration;
	readonly entrypoint: Entrypoint | undefined;
	readonly requirements: Requirements;
	readonly bindleName: string;
	readonly dependencyDeclarations: Readonly<
		Record<string, PrimitiveDeclaration>
	>;
}

export function createRivetPrimitiveMappers<
	Entrypoint extends RivetHttpEntrypoint,
	Requirements,
>(sourceInput: RivetHttpSource<Entrypoint>) {
	const source = bindRivetHttpSource(sourceInput);
	const sourceClaim = (
		input: ValidationInput<Entrypoint, Requirements>,
	): AlchemySourceClaim =>
		freeze({
			resourceId: input.declaration.name,
			resourceType: "Rivet.DurableObject",
			bindleName: input.bindleName,
			applicationName: source.resourceName,
			sourceKind: "rivet-http",
			sourcePath: resolve(source.main),
			sourceDigest: source.sourceDigest,
			environmentDigest: source.sourceFence.environmentDigest,
			proofRef: source.sourceFence.proofRef,
		});
	const checkSource = (claim: AlchemySourceClaim): void => {
		bindRivetHttpSource(source);
		let verified = false;
		try {
			verified = verifyAlchemySourceFence(source.sourceFence, claim);
		} catch {}
		if (verified !== true)
			throw new AlchemyIacError(
				"RIVET_SOURCE_UNVERIFIED",
				"the immutable source and artifact fence could not be verified",
			);
	};
	const validate = (input: ValidationInput<Entrypoint, Requirements>): void => {
		checkSource(sourceClaim(input));
		if (
			input.declaration.name !== source.resourceName ||
			input.declaration.kind !== source.kind ||
			input.entrypoint !== source.binding.entrypoint
		)
			throw new AlchemyIacError(
				"RIVET_SOURCE_MISMATCH",
				"the deployed source must bind this exact application entrypoint",
			);
		if (
			input.declaration.dependsOn.length > 0 ||
			objectKeys(input.dependencyDeclarations).length > 0
		)
			throw new AlchemyIacError(
				"RIVET_DEPENDENCY_UNSUPPORTED",
				"external RivetKit programs do not have Alchemy resource bindings",
			);
		for (const annotation of input.declaration.annotations) {
			if (
				annotation.provider !== "hobo" ||
				annotation.option !== "session-replay"
			)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"annotation is not supported by the Rivet application mapping",
				);
			const enabled = getOwnDescriptor(annotation.config, "enabled");
			if (
				enabled === undefined ||
				!hasOwnDescriptor(enabled, "value") ||
				enabled.value !== false
			)
				throw new AlchemyIacError(
					"RIVET_REPLAY_UNSUPPORTED",
					"enabled session replay requires a replay implementation",
				);
		}
	};
	const mapper = freeze({
		resourceTypes: freeze(["Rivet.DurableObject"]),
		operations: freeze<string[]>([]),
		annotations: freeze(["hobo:session-replay"]),
		bindsEntrypoint: true,
		limitations: freeze([
			"Only the attested source kind, actor name and entrypoint are mapped.",
			"Resource dependencies and enabled session replay are unsupported; the host must fence the source and exclusive pool.",
		]),
		validate,
		build: (
			input: ValidationInput<Entrypoint, Requirements> & {
				readonly dependencies: Readonly<Record<string, ResourceLike>>;
			},
		): Effect.Effect<
			{
				primary: DurableObject;
				resources: readonly DurableObject[];
				boundDependencies: readonly string[];
				boundEntrypoint: Entrypoint;
			},
			never,
			PoolHost | Providers
		> =>
			Effect.gen(function* () {
				validate(input);
				if (objectKeys(input.dependencies).length !== 0)
					throw new AlchemyIacError(
						"RIVET_DEPENDENCY_UNSUPPORTED",
						"external RivetKit programs do not have Alchemy resource bindings",
					);
				const claim = sourceClaim(input);
				const host = yield* PoolHost;
				let registered: object | undefined;
				const protectedHost: PoolHost["Service"] = {
					deployExternal: ({ id, main, resource }) =>
						Effect.gen(function* () {
							if (
								registered !== undefined ||
								id !== claim.resourceId ||
								main !== claim.sourcePath ||
								resource.FQN !== claim.resourceId ||
								resource.Type !== claim.resourceType
							)
								throw new AlchemyIacError(
									"RIVET_SOURCE_MISMATCH",
									"pool deployment does not match its source claim",
								);
							checkSource(claim);
							registerAlchemySource(resource, {
								claim,
								verify: (value) =>
									verifyAlchemySourceFence(source.sourceFence, value),
							});
							registered = resource;
							yield* host.deployExternal(freeze({ id, main, resource }));
							checkSource(claim);
						}),
					deployCrate: (object) => host.deployCrate(object),
				};
				const primary = yield* DurableObject(input.declaration.name, {
					main: source.main,
				}).pipe(Effect.provideService(PoolHost, protectedHost));
				if (
					primary.FQN !== claim.resourceId ||
					primary.Type !== claim.resourceType ||
					(registered !== undefined && registered !== primary)
				)
					throw new AlchemyIacError(
						"RIVET_SOURCE_MISMATCH",
						"the primary resource does not match its source claim",
					);
				if (registered === undefined)
					registerAlchemySource(primary, {
						claim,
						verify: (value) =>
							verifyAlchemySourceFence(source.sourceFence, value),
					});
				checkSource(claim);
				return {
					primary,
					resources: [primary],
					boundDependencies: [],
					boundEntrypoint: source.binding.entrypoint,
				};
			}),
	});
	const unavailable: typeof mapper = freeze({
		...mapper,
		resourceTypes: freeze<string[]>([]),
		validate: () => {
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"no attested Rivet source for this HTTP kind",
			);
		},
		build: () => {
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				"no attested Rivet source for this HTTP kind",
			);
		},
	});
	return freeze({
		api: source.kind === "api" ? mapper : unavailable,
		web: source.kind === "web" ? mapper : unavailable,
		service: source.kind === "service" ? mapper : unavailable,
	});
}
