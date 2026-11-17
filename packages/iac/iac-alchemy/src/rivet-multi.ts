import { PoolHost } from "@alchemy.run/rivet/Host";
import * as Effect from "effect/Effect";
import { AlchemyIacError } from "./plan.js";
import {
	bindRivetHttpSource,
	createRivetPrimitiveMappers,
	type RivetHttpSource,
} from "./rivet.js";
import type { RivetHttpEntrypoint } from "./rivet-runtime.js";

export interface RivetPoolSource<Entrypoint extends RivetHttpEntrypoint> {
	readonly source: RivetHttpSource<Entrypoint>;
	/** Digest of the canonical physical pool identity, including its account and namespace. */
	readonly poolDigest: string;
	readonly poolHost: PoolHost["Service"];
}

/**
 * Verify that the named host uses exactly this physical pool, that the digest
 * identifies it canonically, and that this external program exclusively owns
 * the pool. The host must perform this check independently of application input.
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
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: pool services and verifiers enter through a runtime provider boundary. */
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
		if (
			!/^sha256:[a-f0-9]{64}$/u.test(input.poolDigest) ||
			host === null ||
			typeof host !== "object"
		)
			throw new AlchemyIacError(
				"RIVET_POOL_UNVERIFIED",
				"a canonical pool digest and host service are required",
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
		const deployExternal = host.deployExternal;
		const deployCrate = host.deployCrate;
		const stableHost: PoolHost["Service"] = Object.freeze({
			deployExternal: (object) => deployExternal.call(host, object),
			deployCrate: (object) => deployCrate.call(host, object),
		});
		const attestation = Object.freeze({
			source,
			poolDigest: input.poolDigest,
			poolHost: host,
		});
		return {
			attestation,
			stableHost,
			deployExternal,
			deployCrate,
			mapper: createRivetPrimitiveMappers<Entrypoint, Requirements>(source).web,
		};
	});

	const verifySet = () => {
		const names = new Set<string>();
		const pools = new Set<string>();
		const hosts = new Set<PoolHost["Service"]>();
		const actorNames = new Set<string>();
		for (const entry of entries) {
			const { source, poolDigest, poolHost } = entry.attestation;
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
				hosts.has(poolHost) ||
				registryNames.length > 256 ||
				registryNames.some((name) => actorNames.has(name))
			)
				throw new AlchemyIacError(
					"RIVET_POOL_CONFLICT",
					"external applications need distinct names, actor registries, pool identities and pool hosts",
				);
			names.add(source.resourceName);
			pools.add(poolDigest);
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
	const mapper = {
		resourceTypes: prototype.resourceTypes,
		operations: prototype.operations,
		annotations: prototype.annotations,
		bindsEntrypoint: true,
		validate: (input: ValidationInput<Entrypoint, Requirements>): void => {
			select(input);
		},
		build: (input: BuildInput<Entrypoint, Requirements>) =>
			Effect.gen(function* () {
				const entry = select(input);
				return yield* entry.mapper
					.build(input)
					.pipe(Effect.provideService(PoolHost, entry.stableHost));
			}),
	};
	return { api: mapper, web: mapper, service: mapper };
}
/* oxlint-enable anti-slop/no-runtime-typeof */
