/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread, anti-slop/no-reflect-apply -- SAFETY: host values cross provider boundaries, and Reflect.apply avoids mutable function.call properties. */
import { isAbsolute, resolve } from "node:path";
import { types } from "node:util";
import { DurableObject } from "@alchemy.run/rivet";
import { PoolHost } from "@alchemy.run/rivet/Host";
import * as Effect from "effect/Effect";
import type { AnyActorDefinition } from "rivetkit";
import { AlchemyIacError } from "./plan.js";
import { inspectRivetRegistry, rivetOwnData } from "./rivet-source-boundary.js";
import { isRivetSynchronousTrue } from "./rivet-synchronous-authority.js";
import {
	type AlchemySourceClaim,
	type AlchemySourceFence,
	captureAlchemySourceFence,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "./source-fence.js";

export interface RivetStandaloneBinding {
	readonly actorName: string;
	readonly actor: AnyActorDefinition;
}
const applyCaptured = Reflect.apply;
const hasOwnDescriptor = Object.hasOwn;
const isProxy = types.isProxy;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const freeze = Object.freeze;

export interface RivetStandaloneSource<Binding extends RivetStandaloneBinding> {
	readonly main: string;
	readonly resourceName: string;
	readonly bindleName: string;
	readonly sourceDigest: string;
	readonly sourceFence: AlchemySourceFence;
	readonly poolDigest: string;
	readonly isolationDigest: string;
	readonly poolHost: PoolHost["Service"];
	readonly registry: {
		readonly config: {
			readonly use: Readonly<Record<string, AnyActorDefinition>>;
		};
	};
	readonly binding: Binding;

	readonly verifySource: (source: {
		readonly main: string;
		readonly sourceDigest: string;
		readonly sourceFence: AlchemySourceFence;
		readonly bindleName: string;
		readonly poolDigest: string;
		readonly isolationDigest: string;
		readonly poolHost: PoolHost["Service"];
		readonly resourceName: string;
		readonly registry: RivetStandaloneSource<Binding>["registry"];
		readonly binding: Binding;
	}) => boolean;
}
function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

export function bindRivetStandaloneSource<
	Binding extends RivetStandaloneBinding,
>(
	input: RivetStandaloneSource<Binding>,
	isBinding: (value: Binding) => boolean,
	label: string,
): RivetStandaloneSource<Binding> {
	const main = rivetOwnData<string>(input, "main");
	const resourceName = rivetOwnData<string>(input, "resourceName");
	const bindleName = rivetOwnData<string>(input, "bindleName");
	const sourceDigest = rivetOwnData<string>(input, "sourceDigest");
	const sourceFence = rivetOwnData<AlchemySourceFence>(input, "sourceFence");
	const poolDigest = rivetOwnData<string>(input, "poolDigest");
	const isolationDigest = rivetOwnData<string>(input, "isolationDigest");
	const poolHost = rivetOwnData<PoolHost["Service"]>(input, "poolHost");
	const registry = rivetOwnData<RivetStandaloneSource<Binding>["registry"]>(
		input,
		"registry",
	);
	const binding = rivetOwnData<Binding>(input, "binding");
	const verifySource = rivetOwnData<
		RivetStandaloneSource<Binding>["verifySource"]
	>(input, "verifySource");
	if (
		typeof main !== "string" ||
		typeof resourceName !== "string" ||
		typeof bindleName !== "string" ||
		typeof sourceDigest !== "string" ||
		typeof poolDigest !== "string" ||
		typeof isolationDigest !== "string" ||
		poolHost === undefined ||
		registry === undefined ||
		binding === undefined ||
		typeof verifySource !== "function" ||
		isProxy(verifySource) ||
		isProxy(sourceFence) ||
		isProxy(poolHost)
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"source and pool fields must be bounded own data",
		);
	const verifyFence = rivetOwnData<AlchemySourceFence["verify"]>(
		sourceFence,
		"verify",
	);
	const fence =
		typeof verifyFence === "function" && !isProxy(verifyFence)
			? captureAlchemySourceFence(sourceFence)
			: undefined;
	if (!fence || fence.sourceDigest !== sourceDigest)
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			`the ${label} requires a host-verified immutable source and artifact fence`,
		);
	const source = freeze({
		main,
		resourceName,
		bindleName,
		sourceDigest,
		sourceFence: fence,
		poolDigest,
		isolationDigest,
		poolHost,
		registry,
		binding,
		verifySource,
	});
	if (
		!isAbsolute(source.main) ||
		source.main.length > 4096 ||
		/[\p{Cc}]/u.test(source.main) ||
		!name(source.resourceName) ||
		!name(source.bindleName) ||
		typeof source.sourceDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(source.sourceDigest) ||
		typeof source.poolDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(source.poolDigest) ||
		typeof source.isolationDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(source.isolationDigest) ||
		typeof source.poolHost !== "object" ||
		source.poolHost === null ||
		typeof source.verifySource !== "function"
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"a bounded source, resource identity and host attestation are required",
		);
	const external = getOwnDescriptor(source.poolHost, "deployExternal");
	const crate = getOwnDescriptor(source.poolHost, "deployCrate");
	if (
		!external ||
		!hasOwnDescriptor(external, "value") ||
		typeof external.value !== "function" ||
		isProxy(external.value) ||
		!crate ||
		!hasOwnDescriptor(crate, "value") ||
		typeof crate.value !== "function" ||
		isProxy(crate.value)
	)
		throw new AlchemyIacError(
			"RIVET_POOL_UNVERIFIED",
			"the exclusive pool requires stable host deployment functions",
		);
	const matchesHost = () => {
		const currentExternal = getOwnDescriptor(source.poolHost, "deployExternal");
		const currentCrate = getOwnDescriptor(source.poolHost, "deployCrate");
		return (
			currentExternal !== undefined &&
			hasOwnDescriptor(currentExternal, "value") &&
			currentExternal.value === external.value &&
			currentCrate !== undefined &&
			hasOwnDescriptor(currentCrate, "value") &&
			currentCrate.value === crate.value
		);
	};
	const matches = () =>
		matchesHost() &&
		isBinding(source.binding) &&
		source.binding.actorName === source.resourceName &&
		(() => {
			const actors = inspectRivetRegistry(source.registry);
			return (
				actors?.names.length === 1 &&
				actors.actor(source.resourceName) === source.binding.actor
			);
		})() &&
		matchesHost();
	if (!matches())
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			`the standalone registry must contain exactly the named ${label} actor`,
		);
	let verified = false;
	try {
		verified = isRivetSynchronousTrue(source.verifySource(source));
	} catch {
		verified = false;
	}
	if (!verified || !matches())
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			`the host did not verify the exact ${label} source and exclusive pool`,
		);
	return source;
}

export function rivetStandaloneResource<Binding extends RivetStandaloneBinding>(
	input: RivetStandaloneSource<Binding>,
	isBinding: (value: Binding) => boolean,
	label: string,
	sourceKind: string,
) {
	const source = bindRivetStandaloneSource(input, isBinding, label);
	const host = source.poolHost;
	const deployExternal = host.deployExternal;
	const deployCrate = host.deployCrate;
	const matchesHost = () => {
		const external = getOwnDescriptor(host, "deployExternal");
		const crate = getOwnDescriptor(host, "deployCrate");
		return (
			external !== undefined &&
			hasOwnDescriptor(external, "value") &&
			external.value === deployExternal &&
			crate !== undefined &&
			hasOwnDescriptor(crate, "value") &&
			crate.value === deployCrate
		);
	};
	const matchesBinding = () => {
		if (
			!matchesHost() ||
			!isBinding(source.binding) ||
			source.binding.actorName !== source.resourceName
		)
			return false;
		const registry = inspectRivetRegistry(source.registry);
		return (
			registry?.names.length === 1 &&
			registry.actor(source.resourceName) === source.binding.actor &&
			matchesHost()
		);
	};
	const claim: AlchemySourceClaim = freeze({
		resourceId: source.resourceName,
		resourceType: "Rivet.DurableObject",
		bindleName: source.bindleName,
		applicationName: source.resourceName,
		sourceKind,
		sourcePath: resolve(source.main),
		sourceDigest: source.sourceDigest,
		environmentDigest: source.sourceFence.environmentDigest,
		proofRef: source.sourceFence.proofRef,
	});
	const verify = (candidate: AlchemySourceClaim): boolean => {
		try {
			if (
				candidate.resourceId !== claim.resourceId ||
				candidate.resourceType !== claim.resourceType ||
				candidate.bindleName !== claim.bindleName ||
				candidate.applicationName !== claim.applicationName ||
				candidate.sourceKind !== claim.sourceKind ||
				candidate.sourcePath !== claim.sourcePath ||
				candidate.sourceDigest !== claim.sourceDigest ||
				candidate.environmentDigest !== claim.environmentDigest ||
				candidate.proofRef !== claim.proofRef
			)
				return false;
			bindRivetStandaloneSource(source, isBinding, label);
			if (!matchesBinding()) return false;
			if (!verifyAlchemySourceFence(source.sourceFence, candidate))
				return false;
			return matchesBinding();
		} catch {
			return false;
		}
	};
	const check = () => {
		if (!verify(claim))
			throw new AlchemyIacError(
				"RIVET_SOURCE_UNVERIFIED",
				`the ${label} source, artifact and exclusive pool fence could not be verified`,
			);
	};
	return Effect.gen(function* () {
		check();
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
							`the pool deployment differs from the ${label} source claim`,
						);
					check();
					registerAlchemySource(resource, { claim, verify });
					registered = resource;
					yield* applyCaptured(deployExternal, host, [
						freeze({ id, main, resource }),
					]);
					check();
				}),
			deployCrate: (object) => applyCaptured(deployCrate, host, [object]),
		};
		const primary = yield* DurableObject(source.resourceName, {
			main: source.main,
		}).pipe(Effect.provideService(PoolHost, protectedHost));
		if (
			primary.FQN !== claim.resourceId ||
			primary.Type !== claim.resourceType ||
			(registered !== undefined && registered !== primary)
		)
			throw new AlchemyIacError(
				"RIVET_SOURCE_MISMATCH",
				`the ${label} resource differs from its source claim`,
			);
		if (registered === undefined)
			registerAlchemySource(primary, { claim, verify });
		check();
		return primary;
	});
}
