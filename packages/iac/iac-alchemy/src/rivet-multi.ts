import { types } from "node:util";
import { PoolHost } from "@alchemy.run/rivet/Host";
import * as Effect from "effect/Effect";
import { AlchemyIacError } from "./plan.js";
import {
	bindRivetHttpSource,
	createRivetPrimitiveMappers,
	type RivetHttpSource,
} from "./rivet.js";
import type { RivetHttpEntrypoint } from "./rivet-runtime.js";
import { inspectRivetRegistry, rivetOwnData } from "./rivet-source-boundary.js";
import { isRivetSynchronousTrue } from "./rivet-synchronous-authority.js";
import { verifyAlchemySourceFence } from "./source-fence.js";

export interface RivetPoolSource<Entrypoint extends RivetHttpEntrypoint> {
	readonly source: RivetHttpSource<Entrypoint>;

	readonly poolDigest: string;

	readonly isolationDigest: string;
	readonly poolHost: PoolHost["Service"];
}

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
const applyCaptured = Reflect.apply;
const hasOwnDescriptor = Object.hasOwn;
const isProxy = types.isProxy;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const isArray = Array.isArray;
const freeze = Object.freeze;
const createNull = Object.create;
const defineProperty = Object.defineProperty;
const nativeString = String;
const NativeSet = Set;
const setHas = NativeSet.prototype.has;
const setAdd = NativeSet.prototype.add;

function appendOwnData<Value>(items: Value[], value: Value): void {
	const descriptor: PropertyDescriptor = createNull(null);
	descriptor.value = value;
	descriptor.enumerable = true;
	descriptor.configurable = true;
	descriptor.writable = true;
	defineProperty(items, nativeString(items.length), freeze(descriptor));
}

function contains<Value>(set: Set<Value>, value: Value): boolean {
	return applyCaptured(setHas, set, [value]);
}

function include<Value>(set: Set<Value>, value: Value): void {
	applyCaptured(setAdd, set, [value]);
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: pool services cross a provider boundary, and Reflect.apply avoids mutable function.call properties. */
export function createRivetMultiPoolPrimitiveMappers<
	Entrypoint extends RivetHttpEntrypoint,
	Requirements,
>(
	inputs: readonly RivetPoolSource<Entrypoint>[],
	verifyPool: RivetPoolVerifier<Entrypoint>,
) {
	if (
		isProxy(inputs) ||
		!isArray(inputs) ||
		inputs.length === 0 ||
		inputs.length > 256 ||
		typeof verifyPool !== "function" ||
		isProxy(verifyPool)
	)
		throw new AlchemyIacError(
			"RIVET_POOL_UNVERIFIED",
			"bounded sources and host pool verification are required",
		);
	const captured: RivetPoolSource<Entrypoint>[] = [];
	for (let index = 0; index < inputs.length; index++) {
		const item = getOwnDescriptor(inputs, nativeString(index));
		if (item === undefined || !hasOwnDescriptor(item, "value"))
			throw new AlchemyIacError(
				"RIVET_POOL_UNVERIFIED",
				"pool entries must be own data",
			);
		const value: unknown = item.value;
		const source = rivetOwnData<RivetHttpSource<Entrypoint>>(value, "source");
		const poolHost = rivetOwnData<PoolHost["Service"]>(value, "poolHost");
		const poolDigest = rivetOwnData<string>(value, "poolDigest");
		const isolationDigest = rivetOwnData<string>(value, "isolationDigest");
		if (
			source === undefined ||
			poolHost === undefined ||
			poolDigest === undefined ||
			isolationDigest === undefined ||
			isProxy(poolHost)
		)
			throw new AlchemyIacError(
				"RIVET_POOL_UNVERIFIED",
				"pool fields must be bounded own data",
			);
		appendOwnData(
			captured,
			freeze({ source, poolHost, poolDigest, isolationDigest }),
		);
	}
	const createEntry = (input: RivetPoolSource<Entrypoint>) => {
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
		const external = getOwnDescriptor(host, "deployExternal");
		const crate = getOwnDescriptor(host, "deployCrate");
		if (
			external === undefined ||
			!hasOwnDescriptor(external, "value") ||
			typeof external.value !== "function" ||
			isProxy(external.value) ||
			crate === undefined ||
			!hasOwnDescriptor(crate, "value") ||
			typeof crate.value !== "function" ||
			isProxy(crate.value)
		)
			throw new AlchemyIacError(
				"RIVET_POOL_UNVERIFIED",
				"the pool host must provide stable deployment functions",
			);
		const deployExternal = external.value;
		const deployCrate = crate.value;
		const stableHost: PoolHost["Service"] = freeze({
			deployExternal: (object) => applyCaptured(deployExternal, host, [object]),
			deployCrate: (object) => applyCaptured(deployCrate, host, [object]),
		});
		const attestation = freeze({
			source,
			poolDigest,
			isolationDigest,
			poolHost: host,
		});

		const fencedSource = freeze({
			...source,
			sourceFence: freeze({
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
	};
	const entries: ReturnType<typeof createEntry>[] = [];
	for (let index = 0; index < captured.length; index++) {
		const input = captured[index];
		if (input === undefined)
			throw new AlchemyIacError(
				"RIVET_POOL_UNVERIFIED",
				"pool entry is unavailable",
			);
		appendOwnData(entries, createEntry(input));
	}
	freeze(entries);

	const verifySet = () => {
		const names = new NativeSet<string>();
		const pools = new NativeSet<string>();
		const isolationDomains = new NativeSet<string>();
		const hosts = new NativeSet<PoolHost["Service"]>();
		const actorNames = new NativeSet<string>();
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (entry === undefined)
				throw new AlchemyIacError(
					"RIVET_POOL_UNVERIFIED",
					"pool entry is unavailable",
				);
			const { source, poolDigest, isolationDigest, poolHost } =
				entry.attestation;
			bindRivetHttpSource(source);
			const external = getOwnDescriptor(poolHost, "deployExternal");
			const crate = getOwnDescriptor(poolHost, "deployCrate");
			if (
				external === undefined ||
				!hasOwnDescriptor(external, "value") ||
				external.value !== entry.deployExternal ||
				crate === undefined ||
				!hasOwnDescriptor(crate, "value") ||
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
			const registryNames = inspectRivetRegistry(source.registry)?.names;
			if (
				registryNames === undefined ||
				contains(names, source.resourceName) ||
				contains(pools, poolDigest) ||
				contains(isolationDomains, isolationDigest) ||
				contains(hosts, poolHost) ||
				registryNames.length > 256
			)
				throw new AlchemyIacError(
					"RIVET_POOL_CONFLICT",
					"external applications need distinct names, actor registries, pools, runner isolation domains and hosts",
				);
			for (let position = 0; position < registryNames.length; position++) {
				const actorName = registryNames[position];
				if (actorName === undefined || contains(actorNames, actorName))
					throw new AlchemyIacError(
						"RIVET_POOL_CONFLICT",
						"external applications need distinct actor registries",
					);
				include(actorNames, actorName);
			}
			include(names, source.resourceName);
			include(pools, poolDigest);
			include(isolationDomains, isolationDigest);
			include(hosts, poolHost);
		}
	};
	const verifyAll = () => {
		verifySet();
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (entry === undefined)
				throw new AlchemyIacError(
					"RIVET_POOL_UNVERIFIED",
					"pool entry is unavailable",
				);
			let verified = false;
			try {
				verified = isRivetSynchronousTrue(verifyPool(entry.attestation));
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
		let entry: (typeof entries)[number] | undefined;
		for (let index = 0; index < entries.length; index++) {
			const candidate = entries[index];
			if (
				candidate?.attestation.source.resourceName === input.declaration.name
			) {
				entry = candidate;
				break;
			}
		}
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
		let available = false;
		for (let index = 0; index < entries.length; index++) {
			if (entries[index]?.attestation.source.kind === kind) {
				available = true;
				break;
			}
		}
		const checkKind = (input: ValidationInput<Entrypoint, Requirements>) => {
			if (!available || input.declaration.kind !== kind)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"no attested Rivet source for this HTTP kind",
				);
			return select(input);
		};
		return freeze({
			resourceTypes: available ? prototype.resourceTypes : freeze<string[]>([]),
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
	return freeze({
		api: mapperFor("api"),
		web: mapperFor("web"),
		service: mapperFor("service"),
		ui: mapperFor("ui"),
	});
}
/* oxlint-enable anti-slop/no-runtime-typeof */
