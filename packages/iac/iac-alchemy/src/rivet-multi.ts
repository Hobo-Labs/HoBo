import { PoolHost } from "@alchemy.run/rivet/Host";
import * as Effect from "effect/Effect";
import { AlchemyIacError } from "./plan.js";
import {
	bindRivetHttpSource,
	createRivetPrimitiveMappers,
	type RivetHttpSource,
} from "./rivet.js";
import type { RivetHttpEntrypoint } from "./rivet-runtime.js";
import { verifyAlchemySourceFence } from "./source-fence.js";

export interface RivetPoolSource<Entrypoint extends RivetHttpEntrypoint> {
	readonly source: RivetHttpSource<Entrypoint>;
	/** Digest of the canonical physical pool identity, including its account and namespace. */
	readonly poolDigest: string;
	/** Digest of the host's exclusive runner isolation domain; Rivet Cloud uses its cluster. */
	readonly isolationDigest: string;
	readonly poolHost: PoolHost["Service"];
}

/**
 * Verify that the named host uses exactly this physical pool, that the digest
 * and runner isolation domain identify them canonically, and that this external
 * program exclusively owns them. The host must perform this check independently
 * of application input.
 */
export type RivetPoolVerifier<Entrypoint extends RivetHttpEntrypoint> = (
	entry: RivetPoolSource<Entrypoint>,
) => boolean;

type SingleMapper<
	Entrypoint extends RivetHttpEntrypoint,
	Requirements,
> = ReturnType<
	typeof createRivetPrimitiveMappers<Entrypoint, Requirements>
>["web"];
type ValidationInput<
	Entrypoint extends RivetHttpEntrypoint,
	Requirements,
> = Parameters<SingleMapper<Entrypoint, Requirements>["validate"]>[0];
type BuildInput<
	Entrypoint extends RivetHttpEntrypoint,
	Requirements,
> = Parameters<SingleMapper<Entrypoint, Requirements>["build"]>[0];

/**
 * One external Rivet program owns a whole Alchemy pool. Map multiple apps only
 * when a host independently attests a different exclusive pool for each one.
 */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: pool services cross a provider boundary, and Reflect.apply avoids mutable function.call properties. */
export function createRivetMultiPoolPrimitiveMappers<
	Entrypoint extends RivetHttpEntrypoint,
	Requirements,
>(
	inputs: readonly RivetPoolSource<Entrypoint>[],
	verifyPool: RivetPoolVerifier<Entrypoint>,
) {
	if (
		!Array.isArray(inputs) ||
		inputs.length === 0 ||
		inputs.length > 256 ||
		typeof verifyPool !== "function"
	)
		throw new AlchemyIacError(
			"RIVET_POOL_UNVERIFIED",
			"bounded sources and host pool verification are required",
		);
	const entries = inputs.map((input: RivetPoolSource<Entrypoint>) => {
		const source = bindRivetHttpSource(input.source);
		const host = input.poolHost;
		const poolDigest = input.poolDigest;
		const isolationDigest = input.isolationDigest;
		if (
			typeof poolDigest !== "string" ||
			typeof isolationDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(poolDigest) ||
			!/^sha256:[a-f0-9]{64}$/u.test(isolationDigest) ||
			host === null ||
			typeof host !== "object"
		)
			throw new AlchemyIacError(
				"RIVET_POOL_UNVERIFIED",
				"canonical pool and runner isolation digests and a host service are required",
			);
		const external = Object.getOwnPropertyDescriptor(host, "deployExternal");
		const crate = Object.getOwnPropertyDescriptor(host, "deployCrate");
		if (
			external === undefined ||
			!("value" in external) ||
			typeof external.value !== "function" ||
			crate === undefined ||
			!("value" in crate) ||
			typeof crate.value !== "function"
		)
			throw new AlchemyIacError(
				"RIVET_POOL_UNVERIFIED",
				"the pool host must provide stable deployment functions",
			);
		const deployExternal = external.value;
		const deployCrate = crate.value;
		const stableHost: PoolHost["Service"] = Object.freeze({
			deployExternal: (object) => Reflect.apply(deployExternal, host, [object]),
			deployCrate: (object) => Reflect.apply(deployCrate, host, [object]),
		});
		const attestation = Object.freeze({
			source,
			poolDigest,
			isolationDigest,
			poolHost: host,
		});
		// The source claim is also the plan/apply revalidation hook. Carry
		// exclusive pool and runner ownership through every such check, not only
		// through the initial pool selection.
		const fencedSource = Object.freeze({
			...source,
			sourceFence: Object.freeze({
				...source.sourceFence,
				verify: (claim: Parameters<typeof source.sourceFence.verify>[0]) => {
					try {
						verifyAll();
						if (!verifyAlchemySourceFence(source.sourceFence, claim))
							return false;
						verifyAll();
						return true;
					} catch {
						return false;
					}
				},
			}),
		});
		return {
			attestation,
			stableHost,
			deployExternal,
			deployCrate,
			mapper: createRivetPrimitiveMappers<Entrypoint, Requirements>(
				fencedSource,
			)[source.kind],
		};
	});

	const verifySet = () => {
		const names = new Set<string>();
		const pools = new Set<string>();
		const isolationDomains = new Set<string>();
		const hosts = new Set<PoolHost["Service"]>();
		const actorNames = new Set<string>();
		for (const entry of entries) {
			const { source, poolDigest, isolationDigest, poolHost } =
				entry.attestation;
			bindRivetHttpSource(source);
			const external = Object.getOwnPropertyDescriptor(
				poolHost,
				"deployExternal",
			);
			const crate = Object.getOwnPropertyDescriptor(poolHost, "deployCrate");
			if (
				external === undefined ||
				!("value" in external) ||
				external.value !== entry.deployExternal ||
				crate === undefined ||
				!("value" in crate) ||
				crate.value !== entry.deployCrate
			)
				throw new AlchemyIacError(
					"RIVET_POOL_UNVERIFIED",
					"the attested pool host changed",
				);
			if (source.sourceDigest !== entries[0]?.attestation.source.sourceDigest)
				throw new AlchemyIacError(
					"RIVET_SOURCE_MISMATCH",
					"all pool sources must share the reviewed target digest",
				);
			const registryNames = Object.keys(source.registry.config.use);
			if (
				names.has(source.resourceName) ||
				pools.has(poolDigest) ||
				isolationDomains.has(isolationDigest) ||
				hosts.has(poolHost) ||
				registryNames.length > 256 ||
				registryNames.some((name) => actorNames.has(name))
			)
				throw new AlchemyIacError(
					"RIVET_POOL_CONFLICT",
					"external applications need distinct names, actor registries, pools, runner isolation domains and hosts",
				);
			names.add(source.resourceName);
			pools.add(poolDigest);
			isolationDomains.add(isolationDigest);
			hosts.add(poolHost);
			for (const name of registryNames) actorNames.add(name);
		}
	};
	const verifyAll = () => {
		verifySet();
		for (const entry of entries) {
			let verified = false;
			try {
				verified = verifyPool(entry.attestation);
			} catch {
				throw new AlchemyIacError(
					"RIVET_POOL_UNVERIFIED",
					"pool verification was unavailable",
				);
			}
			if (verified !== true)
				throw new AlchemyIacError(
					"RIVET_POOL_UNVERIFIED",
					"the host did not verify exclusive pool ownership",
				);
		}
		verifySet();
	};
	verifyAll();
	const select = (input: ValidationInput<Entrypoint, Requirements>) => {
		verifyAll();
		const entry = entries.find(
			(candidate) =>
				candidate.attestation.source.resourceName === input.declaration.name,
		);
		if (entry === undefined)
			throw new AlchemyIacError(
				"RIVET_SOURCE_MISMATCH",
				"no verified Rivet source for this application",
			);
		entry.mapper.validate(input);
		return entry;
	};
	const prototype = entries[0]?.mapper;
	if (prototype === undefined)
		throw new AlchemyIacError(
			"RIVET_POOL_UNVERIFIED",
			"at least one source is required",
		);
	const mapperFor = (kind: RivetHttpSource<Entrypoint>["kind"]) => {
		const available = entries.some(
			(entry) => entry.attestation.source.kind === kind,
		);
		const checkKind = (input: ValidationInput<Entrypoint, Requirements>) => {
			if (!available || input.declaration.kind !== kind)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"no attested Rivet source for this HTTP kind",
				);
			return select(input);
		};
		return Object.freeze({
			resourceTypes: available
				? prototype.resourceTypes
				: Object.freeze<string[]>([]),
			operations: prototype.operations,
			annotations: prototype.annotations,
			bindsEntrypoint: true,
			limitations: prototype.limitations,
			validate: (input: ValidationInput<Entrypoint, Requirements>): void => {
				checkKind(input);
			},
			build: (input: BuildInput<Entrypoint, Requirements>) =>
				Effect.gen(function* () {
					const entry = checkKind(input);
					return yield* entry.mapper
						.build(input)
						.pipe(Effect.provideService(PoolHost, entry.stableHost));
				}),
		});
	};
	return Object.freeze({
		api: mapperFor("api"),
		web: mapperFor("web"),
		service: mapperFor("service"),
	});
}
/* oxlint-enable anti-slop/no-runtime-typeof */
