import { isAbsolute } from "node:path";
import { DurableObject, type Providers } from "@alchemy.run/rivet";
import type { PoolHost } from "@alchemy.run/rivet/Host";
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
	/** Independently verified by the host and bound to the reviewed target. */
	readonly sourceDigest: string;
	readonly registry: RivetRegistry;
	readonly binding: RivetHttpBinding<Entrypoint>;
	/** Independently verify that the reviewed module exports and starts this exact registry. */
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

/** Bind an external RivetKit program to the actor it actually registers. */
export function bindRivetHttpSource<Entrypoint extends RivetHttpEntrypoint>(
	input: RivetHttpSource<Entrypoint>,
): RivetHttpSource<Entrypoint> {
	const source = Object.freeze({ ...input });
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
	if (
		!isRivetHttpBinding(source.binding) ||
		source.actorName !== source.binding.actorName ||
		!Object.hasOwn(source.registry.config.use, source.actorName) ||
		source.registry.config.use[source.actorName] !== source.binding.actor
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			"the registry must contain the actual bound actor",
		);
	let verified = false;
	try {
		verified = source.verifySource({
			main: source.main,
			sourceDigest: source.sourceDigest,
			resourceName: source.resourceName,
			actorName: source.actorName,
			registry: source.registry,
			binding: source.binding,
		});
	} catch {
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"source verification was unavailable",
		);
	}
	if (
		verified !== true ||
		!isRivetHttpBinding(source.binding) ||
		source.registry.config.use[source.actorName] !== source.binding.actor
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

/** Map one HTTP application to Alchemy's real external Rivet DurableObject. */
export function createRivetPrimitiveMappers<
	Entrypoint extends RivetHttpEntrypoint,
	Requirements,
>(sourceInput: RivetHttpSource<Entrypoint>) {
	const source = bindRivetHttpSource(sourceInput);
	const validate = (input: ValidationInput<Entrypoint, Requirements>): void => {
		bindRivetHttpSource(source);
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
			Object.keys(input.dependencyDeclarations).length > 0
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
			const enabled = Object.getOwnPropertyDescriptor(
				annotation.config,
				"enabled",
			);
			if (
				enabled === undefined ||
				!("value" in enabled) ||
				enabled.value !== false
			)
				throw new AlchemyIacError(
					"RIVET_REPLAY_UNSUPPORTED",
					"enabled session replay requires a replay implementation",
				);
		}
	};
	const mapper = {
		resourceTypes: ["Rivet.DurableObject"],
		operations: [],
		annotations: ["hobo:session-replay"],
		bindsEntrypoint: true,
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
				if (Object.keys(input.dependencies).length !== 0)
					throw new AlchemyIacError(
						"RIVET_DEPENDENCY_UNSUPPORTED",
						"external RivetKit programs do not have Alchemy resource bindings",
					);
				const primary = yield* DurableObject(input.declaration.name, {
					main: source.main,
				});
				return {
					primary,
					resources: [primary],
					boundDependencies: [],
					boundEntrypoint: source.binding.entrypoint,
				};
			}),
	};
	return { api: mapper, web: mapper, service: mapper };
}
