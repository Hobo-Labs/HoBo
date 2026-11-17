/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread, anti-slop/no-reflect-apply -- SAFETY: host values cross provider boundaries, and Reflect.apply avoids mutable function.call properties. */
import { isAbsolute, resolve } from "node:path";
import { DurableObject } from "@alchemy.run/rivet";
import { PoolHost } from "@alchemy.run/rivet/Host";
import * as Effect from "effect/Effect";
import type { AnyActorDefinition } from "rivetkit";
import { AlchemyIacError } from "./plan.js";
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

/** A source-fenced external program and its exclusively owned Rivet pool. */
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
	/**
	 * Independently verify the source and artifact closure, exclusive pool, and
	 * that the deployed main starts a registry with this exact actor definition
	 * and its authorized host policies. Inspecting the in-process registry alone
	 * cannot prove that the separately bundled main actually starts it.
	 */
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
/**
 * Validate the registry and host-owned source attestation. Composition code
 * must supply a verifier for the actual branded actor; structural checks do
 * not establish the identity of the actor that will run in the pool.
 */
export function bindRivetStandaloneSource<
	Binding extends RivetStandaloneBinding,
>(
	input: RivetStandaloneSource<Binding>,
	isBinding: (value: Binding) => boolean,
	label: string,
): RivetStandaloneSource<Binding> {
	const snapshot = Object.freeze({ ...input });
	const fence = captureAlchemySourceFence(snapshot.sourceFence);
	if (!fence || fence.sourceDigest !== snapshot.sourceDigest)
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			`the ${label} requires a host-verified immutable source and artifact fence`,
		);
	const source = Object.freeze({ ...snapshot, sourceFence: fence });
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
	const external = Object.getOwnPropertyDescriptor(
		source.poolHost,
		"deployExternal",
	);
	const crate = Object.getOwnPropertyDescriptor(source.poolHost, "deployCrate");
	if (
		!external ||
		!("value" in external) ||
		typeof external.value !== "function" ||
		!crate ||
		!("value" in crate) ||
		typeof crate.value !== "function"
	)
		throw new AlchemyIacError(
			"RIVET_POOL_UNVERIFIED",
			"the exclusive pool requires stable host deployment functions",
		);
	const matches = () =>
		Object.getOwnPropertyDescriptor(source.poolHost, "deployExternal")
			?.value === external.value &&
		Object.getOwnPropertyDescriptor(source.poolHost, "deployCrate")?.value ===
			crate.value &&
		isBinding(source.binding) &&
		source.binding.actorName === source.resourceName &&
		Object.keys(source.registry.config.use).length === 1 &&
		Object.hasOwn(source.registry.config.use, source.resourceName) &&
		source.registry.config.use[source.resourceName] === source.binding.actor;
	if (!matches())
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			`the standalone registry must contain exactly the named ${label} actor`,
		);
	let verified = false;
	try {
		verified = source.verifySource(source) === true;
	} catch {
		/* A failed verifier is not proof. */
	}
	if (!verified || !matches())
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			`the host did not verify the exact ${label} source and exclusive pool`,
		);
	return source;
}
/** Construct the real Alchemy Rivet DurableObject for this standalone actor. */
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
	const claim: AlchemySourceClaim = Object.freeze({
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
			if (
				host.deployExternal !== deployExternal ||
				host.deployCrate !== deployCrate
			)
				return false;
			return verifyAlchemySourceFence(source.sourceFence, candidate);
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
					yield* Reflect.apply(deployExternal, host, [
						Object.freeze({ id, main, resource }),
					]);
					check();
				}),
			deployCrate: (object) => Reflect.apply(deployCrate, host, [object]),
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
