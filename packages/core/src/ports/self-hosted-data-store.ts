/**
 * Can a registered compute provider host a self-managed, stateful, TCP-served
 * data store (PostgreSQL is the motivating case)?
 *
 * The answer is derived from what a provider has *declared*, never from its
 * name: the compute capabilities of its Capability Manifest (the feature
 * tokens of each `compute` equivalence class) and the capability profiles of
 * its Yard catalog rows. There is deliberately no list of provider ids that
 * pass.
 *
 * Hosting such a store needs four things ({@link SELF_HOST_FACETS}):
 *
 *   1. a long-running container or VM (not request-scoped, not scale-to-zero);
 *   2. a volume or disk that survives restarts and redeploys;
 *   3. inbound TCP on a private or public address (not HTTP-only ingress);
 *   4. enough control of the host to run backups.
 *
 * What a declaration can establish, token by token:
 *
 *   - `vm` — a virtual machine. The operator owns the OS, the process table,
 *     the network interface and the machine's own disk, so all four facets
 *     hold by what a VM is. A `bucket.filesystem/v1` row in the Yard catalog
 *     additionally shows a volume that outlives the machine; without one the
 *     data shares the VM's lifetime, which is reported as a caveat, not a no.
 *   - `container` — a container runtime, and nothing more. Containers are sold
 *     request-scoped, scale-to-zero, HTTP-only and diskless at least as often
 *     as not, so each facet must be declared with its own token
 *     (`long-running`, `persistent-volume`, `tcp`, `exec`). A filesystem
 *     volume elsewhere in the same catalog does not show the container can
 *     mount it.
 *   - anything else (`static`, `edge`, `worker`, …) is not a host form.
 *
 * Three verdicts, and the middle one is the honest one: `can` when one compute
 * capability establishes every facet, `cannot` when nothing declared is a VM
 * or container at all, `undetermined` when a host form is declared but the
 * declaration is too coarse to tell — with exactly which facets are missing,
 * so the fix (enrich that provider's declaration) is nameable.
 *
 * Pure and deterministic: no clock, no environment, no I/O.
 */
import { deepFreeze } from "../parse-utils.js";
import { capability } from "./capability-catalog.js";

// public-contract: the facet vocabulary a self-host assessment reports in.
export const SELF_HOST_FACETS = Object.freeze([
	"long-running-compute",
	"persistent-volume",
	"inbound-tcp",
	"operator-control",
] as const);

export type SelfHostFacet = (typeof SELF_HOST_FACETS)[number];

export type SelfHostFacetState = "declared" | "undeclared" | "absent";

export type SelfHostVerdict = "can" | "cannot" | "undetermined";

/** One `compute` capability as a provider's Capability Manifest declares it. */
export interface RegisteredComputeCapability {
	readonly resourceClass: string;
	readonly providerService: string;
	readonly features: readonly string[];
}

/** One Yard catalog row: the capability profile and the product behind it. */
export interface RegisteredCatalogRow {
	readonly profile: string;
	readonly productId?: string;
}

/** Everything a registered provider has declared that this question reads. */
export interface RegisteredHostDeclaration {
	readonly providerId: string;
	readonly compute: readonly RegisteredComputeCapability[];
	readonly catalog: readonly RegisteredCatalogRow[];
}

export interface SelfHostFacetFinding {
	readonly facet: SelfHostFacet;
	readonly state: SelfHostFacetState;
	readonly reason: string;
}

export interface SelfHostAssessment {
	readonly providerId: string;
	readonly verdict: SelfHostVerdict;
	/** The compute capability the verdict rests on, when one is a host form. */
	readonly resourceClass?: string;
	readonly findings: readonly SelfHostFacetFinding[];
	/** Facets the declaration does not establish; empty unless `undetermined`. */
	readonly missing: readonly SelfHostFacet[];
	/** True-but-qualified facts a `can` verdict still carries. */
	readonly caveats: readonly string[];
	readonly summary: string;
}

// public-contract: the feature tokens a compute declaration is read for.
export const SELF_HOST_FEATURE_TOKENS = Object.freeze({
	vm: "vm",
	container: "container",
	longRunning: "long-running",
	persistentVolume: "persistent-volume",
	inboundTcp: "tcp",
	operatorControl: "exec",
} as const);

const VOLUME_PROFILE = capability.bucket.filesystem;

/** Assess one provider's declaration. */
export function assessSelfHostedDataStore(
	declaration: RegisteredHostDeclaration,
): SelfHostAssessment {
	const volumes = declaration.catalog
		.filter((row) => row.profile === VOLUME_PROFILE)
		.map((row) => row.productId ?? row.profile);
	const candidates = declaration.compute
		.map((entry) => assessCompute(entry, volumes))
		.filter((entry) => entry !== undefined)
		.sort((left, right) => left.missing.length - right.missing.length);
	const best = candidates[0];
	if (best === undefined) {
		const declared = declaration.compute.map(
			(entry) => `${entry.providerService} [${entry.features.join(", ")}]`,
		);
		const reason =
			declared.length === 0
				? "declares no compute capability"
				: `declares compute only as ${declared.join("; ")}: none is a VM or a container`;
		return deepFreeze({
			providerId: declaration.providerId,
			verdict: "cannot",
			findings: SELF_HOST_FACETS.map((facet) => ({
				facet,
				state: "absent" as const,
				reason,
			})),
			missing: [],
			caveats: [],
			summary: `${declaration.providerId} cannot host it: ${reason}`,
		});
	}
	const verdict = best.missing.length === 0 ? "can" : "undetermined";
	return deepFreeze({
		providerId: declaration.providerId,
		verdict,
		resourceClass: best.resourceClass,
		findings: best.findings,
		missing: best.missing,
		caveats: best.caveats,
		summary:
			verdict === "can"
				? `${declaration.providerId} can host it on ${best.providerService}`
				: `${declaration.providerId} is undetermined: ${best.providerService} declares a container but not ${best.missing.join(", ")}`,
	});
}

/** Assess every declaration, in the order given. */
export function assessSelfHostedDataStores(
	declarations: readonly RegisteredHostDeclaration[],
): readonly SelfHostAssessment[] {
	return deepFreeze(declarations.map(assessSelfHostedDataStore));
}

function assessCompute(
	entry: RegisteredComputeCapability,
	volumes: readonly string[],
) {
	const has = (token: string) => entry.features.includes(token);
	const tokens = SELF_HOST_FEATURE_TOKENS;
	if (has(tokens.vm)) {
		const attached =
			volumes.length > 0
				? `the VM's own disk, plus attachable volume ${volumes.join(", ")} (${VOLUME_PROFILE})`
				: "the VM's own disk";
		return {
			resourceClass: entry.resourceClass,
			providerService: entry.providerService,
			findings: [
				finding("long-running-compute", "declared", "a VM runs until stopped"),
				finding("persistent-volume", "declared", attached),
				finding(
					"inbound-tcp",
					"declared",
					"a VM has its own network interface and can listen on any port",
				),
				finding(
					"operator-control",
					"declared",
					"the operator owns the VM's OS, so backup tooling can run beside the store",
				),
			],
			missing: [],
			caveats:
				volumes.length > 0
					? []
					: [
							`no ${VOLUME_PROFILE} volume is declared: data lives on the VM's own disk and is lost if the machine is rebuilt or deleted`,
						],
		};
	}
	if (!has(tokens.container)) return undefined;
	const findings = [
		tokenFinding(
			"long-running-compute",
			has(tokens.longRunning),
			tokens.longRunning,
			"a container may be request-scoped or scale to zero",
		),
		tokenFinding(
			"persistent-volume",
			has(tokens.persistentVolume),
			tokens.persistentVolume,
			volumes.length > 0
				? `${volumes.join(", ")} is declared as ${VOLUME_PROFILE}, but nothing declares that this container can mount it`
				: `no ${VOLUME_PROFILE} volume is declared and container disks are ephemeral unless stated`,
		),
		tokenFinding(
			"inbound-tcp",
			has(tokens.inboundTcp),
			tokens.inboundTcp,
			has("http")
				? "only http ingress is declared"
				: "no ingress protocol is declared",
		),
		tokenFinding(
			"operator-control",
			has(tokens.operatorControl),
			tokens.operatorControl,
			"nothing declares a way to run backup tooling beside the store",
		),
	];
	return {
		resourceClass: entry.resourceClass,
		providerService: entry.providerService,
		findings,
		missing: findings
			.filter((entry) => entry.state !== "declared")
			.map((entry) => entry.facet),
		caveats: [],
	};
}

function tokenFinding(
	facet: SelfHostFacet,
	declared: boolean,
	token: string,
	otherwise: string,
): SelfHostFacetFinding {
	return declared
		? finding(facet, "declared", `declares the ${token} feature`)
		: finding(facet, "undeclared", otherwise);
}

function finding(
	facet: SelfHostFacet,
	state: SelfHostFacetState,
	reason: string,
): SelfHostFacetFinding {
	return { facet, state, reason };
}
