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
 * A provider package can say more than tokens do with a **host form**
 * ({@link RegisteredHostForm}): one compute product it already declares (a Yard
 * `productId`, or an equivalence `resourceClass`), stated to be a VM or a
 * container, with each facet it does or does not provide cited to the
 * vendor's documentation. Forms are assessed per product, so one provider can
 * have a form that can and a form that cannot, and the assessment lists both.
 * A form that names a `resourceClass` supersedes that class's token reading.
 *
 * Three verdicts, and the middle one is the honest one: `can` when one compute
 * capability establishes every facet, `cannot` when nothing declared is a VM
 * or container at all, `undetermined` when a host form is declared but the
 * declaration is too coarse to tell — with exactly which facets are missing,
 * so the fix (enrich that provider's declaration) is nameable.
 *
 * Pure and deterministic: no clock, no environment, no I/O.
 */
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonString,
	type JsonValue,
} from "../json.js";
import { deepFreeze, enumValue, expectObject } from "../parse-utils.js";
import { capability } from "./capability-catalog.js";
import {
	type DataStoreClaimSource,
	parseDataStoreClaimSource,
} from "./data-store-catalog.js";
import { DataStoreOfferingParseError } from "./data-store-offerings.js";

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

// public-contract: the host forms a provider may declare a compute product to be.
export const SELF_HOST_FORMS = Object.freeze(["vm", "container"] as const);

export type SelfHostForm = (typeof SELF_HOST_FORMS)[number];

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

/** One facet of one host form, cited: the product provides it, or does not. */
export interface RegisteredHostFacetClaim {
	readonly facet: SelfHostFacet;
	readonly holds: boolean;
	readonly detail: string;
	readonly sources: readonly DataStoreClaimSource[];
}

/**
 * A compute product a provider already declares, described as a self-host
 * target. `productId` is a Yard catalog product, `resourceClass` an
 * equivalence class; at least one is present and both must already exist in
 * the provider's own declarations. `volumeProductId` names the Yard
 * `bucket.filesystem/v1` product that realizes the persistent volume, when the
 * provider's catalog has one.
 */
export interface RegisteredHostForm {
	readonly productId?: string;
	readonly resourceClass?: string;
	readonly providerService: string;
	readonly form: SelfHostForm;
	readonly formSources: readonly DataStoreClaimSource[];
	readonly volumeProductId?: string;
	readonly facets: readonly RegisteredHostFacetClaim[];
}

/** Everything a registered provider has declared that this question reads. */
export interface RegisteredHostDeclaration {
	readonly providerId: string;
	readonly compute: readonly RegisteredComputeCapability[];
	readonly catalog: readonly RegisteredCatalogRow[];
	readonly hostForms?: readonly RegisteredHostForm[];
}

export interface SelfHostFacetFinding {
	readonly facet: SelfHostFacet;
	readonly state: SelfHostFacetState;
	readonly reason: string;
}

/** The verdict for one compute form of a provider. */
export interface SelfHostFormAssessment {
	/** The Yard product id, or the equivalence resource class, assessed. */
	readonly target: string;
	readonly providerService: string;
	readonly verdict: SelfHostVerdict;
	readonly findings: readonly SelfHostFacetFinding[];
	readonly missing: readonly SelfHostFacet[];
	readonly caveats: readonly string[];
}

export interface SelfHostAssessment {
	readonly providerId: string;
	readonly verdict: SelfHostVerdict;
	/** The compute form the verdict rests on, when one is a host form. */
	readonly resourceClass?: string;
	readonly findings: readonly SelfHostFacetFinding[];
	/** Facets the declaration does not establish; empty unless `undetermined`. */
	readonly missing: readonly SelfHostFacet[];
	/** True-but-qualified facts a `can` verdict still carries. */
	readonly caveats: readonly string[];
	/** Every compute form assessed, best first: which qualify and which do not. */
	readonly forms: readonly SelfHostFormAssessment[];
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
const FACETS = new Set<SelfHostFacet>(SELF_HOST_FACETS);
const FORMS = new Set<SelfHostForm>(SELF_HOST_FORMS);
const RANK: Readonly<Record<SelfHostVerdict, number>> = Object.freeze({
	can: 0,
	undetermined: 1,
	cannot: 2,
});

/**
 * Parse a host form. The evidence rule is the catalog's: the form itself and
 * every facet claim must cite at least one dated vendor source.
 */
export function parseRegisteredHostForm(
	value: JsonValue | undefined,
	path = "hostForm",
): RegisteredHostForm {
	const input = expectObject(value, path, DataStoreOfferingParseError);
	const productId = optionalText(input.productId, `${path}.productId`);
	const resourceClass = optionalText(
		input.resourceClass,
		`${path}.resourceClass`,
	);
	if (productId === undefined && resourceClass === undefined) {
		fail(path, "a productId or a resourceClass", cloneAsJson(input));
	}
	const facets = list(input.facets, `${path}.facets`).map((entry, index) => {
		const at = `${path}.facets[${index}]`;
		const claim = expectObject(entry, at, DataStoreOfferingParseError);
		if (!isJsonBoolean(claim.holds))
			fail(`${at}.holds`, "boolean", claim.holds);
		return {
			facet: enumValue(
				claim.facet,
				FACETS,
				`${at}.facet`,
				DataStoreOfferingParseError,
			),
			holds: claim.holds === true,
			detail: text(claim.detail, `${at}.detail`),
			sources: sources(claim.sources, `${at}.sources`),
		};
	});
	if (new Set(facets.map((claim) => claim.facet)).size !== facets.length) {
		fail(`${path}.facets`, "one claim per facet", input.facets);
	}
	const volumeProductId = optionalText(
		input.volumeProductId,
		`${path}.volumeProductId`,
	);
	return deepFreeze({
		providerService: text(input.providerService, `${path}.providerService`),
		form: enumValue(
			input.form,
			FORMS,
			`${path}.form`,
			DataStoreOfferingParseError,
		),
		formSources: sources(input.formSources, `${path}.formSources`),
		facets,
		...(productId === undefined ? undefined : { productId }),
		...(resourceClass === undefined ? undefined : { resourceClass }),
		...(volumeProductId === undefined ? undefined : { volumeProductId }),
	});
}

/** Assess one provider's declaration. */
export function assessSelfHostedDataStore(
	declaration: RegisteredHostDeclaration,
): SelfHostAssessment {
	const volumes = declaration.catalog
		.filter((row) => row.profile === VOLUME_PROFILE)
		.map((row) => row.productId ?? row.profile);
	const hostForms = declaration.hostForms ?? [];
	const superseded = new Set(hostForms.map((form) => form.resourceClass));
	const forms = [
		...hostForms.map((form) => assessHostForm(form, volumes)),
		...declaration.compute
			.filter((entry) => !superseded.has(entry.resourceClass))
			.map((entry) => assessCompute(entry, volumes))
			.filter((entry) => entry !== undefined),
	].sort(
		(left, right) =>
			RANK[left.verdict] - RANK[right.verdict] ||
			left.missing.length - right.missing.length,
	);
	const best = forms[0];
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
			forms: [],
			summary: `${declaration.providerId} cannot host it: ${reason}`,
		});
	}
	return deepFreeze({
		providerId: declaration.providerId,
		verdict: best.verdict,
		resourceClass: best.target,
		findings: best.findings,
		missing: best.missing,
		caveats: best.caveats,
		forms,
		summary: summarize(declaration.providerId, best, forms),
	});
}

/** Assess every declaration, in the order given. */
export function assessSelfHostedDataStores(
	declarations: readonly RegisteredHostDeclaration[],
): readonly SelfHostAssessment[] {
	return deepFreeze(declarations.map(assessSelfHostedDataStore));
}

function summarize(
	providerId: string,
	best: SelfHostFormAssessment,
	forms: readonly SelfHostFormAssessment[],
): string {
	if (best.verdict === "can") {
		return `${providerId} can host it on ${best.providerService}`;
	}
	if (best.verdict === "undetermined") {
		return `${providerId} is undetermined: ${best.providerService} declares a container but not ${best.missing.join(", ")}`;
	}
	const reasons = forms.map((form) => {
		const absent = form.findings.find((entry) => entry.state === "absent");
		return `${form.providerService}: ${absent?.reason ?? "not a host form"}`;
	});
	return `${providerId} cannot host it: ${reasons.join("; ")}`;
}

function vmFindings(volume: string): readonly SelfHostFacetFinding[] {
	return [
		finding("long-running-compute", "declared", "a VM runs until stopped"),
		finding("persistent-volume", "declared", volume),
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
	];
}

const ROOT_DISK_CAVEAT = `no ${VOLUME_PROFILE} volume is declared: data lives on the VM's own disk and is lost if the machine is rebuilt or deleted`;

function assessHostForm(
	form: RegisteredHostForm,
	volumes: readonly string[],
): SelfHostFormAssessment {
	const target = form.productId ?? form.resourceClass ?? form.providerService;
	const yardVolume =
		form.volumeProductId !== undefined && volumes.includes(form.volumeProductId)
			? form.volumeProductId
			: undefined;
	const cited = (facet: SelfHostFacet) =>
		form.facets.find((claim) => claim.facet === facet);
	if (form.form === "vm") {
		const attach = cited("persistent-volume");
		const volume =
			yardVolume !== undefined
				? `the VM's own disk, plus attachable volume ${yardVolume} (${VOLUME_PROFILE})`
				: attach?.holds === true
					? `the VM's own disk, plus ${attach.detail}`
					: "the VM's own disk";
		return {
			target,
			providerService: form.providerService,
			verdict: "can",
			findings: vmFindings(volume),
			missing: [],
			caveats:
				yardVolume !== undefined || attach?.holds === true
					? []
					: [ROOT_DISK_CAVEAT],
		};
	}
	const findings = SELF_HOST_FACETS.map((facet) => {
		const claim = cited(facet);
		if (claim === undefined) {
			return finding(facet, "undeclared", "no cited claim for this facet");
		}
		const where = claim.sources[0]?.url ?? "";
		if (!claim.holds)
			return finding(facet, "absent", `${claim.detail} (${where})`);
		return facet === "persistent-volume" && yardVolume !== undefined
			? finding(
					facet,
					"declared",
					`mounts ${yardVolume} (${VOLUME_PROFILE}): ${claim.detail} (${where})`,
				)
			: finding(facet, "declared", `${claim.detail} (${where})`);
	});
	const missing = findings
		.filter((entry) => entry.state === "undeclared")
		.map((entry) => entry.facet);
	const verdict = findings.some((entry) => entry.state === "absent")
		? "cannot"
		: missing.length === 0
			? "can"
			: "undetermined";
	return {
		target,
		providerService: form.providerService,
		verdict,
		findings,
		missing,
		caveats:
			verdict === "can" && yardVolume === undefined
				? [
						`the persistent volume is cited from vendor documentation, but no ${VOLUME_PROFILE} product in this provider's Yard catalog realizes it yet`,
					]
				: [],
	};
}

function assessCompute(
	entry: RegisteredComputeCapability,
	volumes: readonly string[],
): SelfHostFormAssessment | undefined {
	const has = (token: string) => entry.features.includes(token);
	const tokens = SELF_HOST_FEATURE_TOKENS;
	if (has(tokens.vm)) {
		return {
			target: entry.resourceClass,
			providerService: entry.providerService,
			verdict: "can",
			findings: vmFindings(
				volumes.length > 0
					? `the VM's own disk, plus attachable volume ${volumes.join(", ")} (${VOLUME_PROFILE})`
					: "the VM's own disk",
			),
			missing: [],
			caveats: volumes.length > 0 ? [] : [ROOT_DISK_CAVEAT],
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
	const missing = findings
		.filter((entry) => entry.state !== "declared")
		.map((entry) => entry.facet);
	return {
		target: entry.resourceClass,
		providerService: entry.providerService,
		verdict: missing.length === 0 ? "can" : "undetermined",
		findings,
		missing,
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

function sources(
	value: JsonValue | undefined,
	path: string,
): readonly DataStoreClaimSource[] {
	const parsed = list(value, path).map((entry, index) =>
		parseDataStoreClaimSource(entry, `${path}[${index}]`),
	);
	if (parsed.length === 0) fail(path, "at least one dated source", value);
	return parsed;
}

function list(
	value: JsonValue | undefined,
	path: string,
): readonly JsonValue[] {
	return Array.isArray(value) ? value : fail(path, "array", value);
}

function optionalText(
	value: JsonValue | undefined,
	path: string,
): string | undefined {
	return value === undefined ? undefined : text(value, path);
}

function text(value: JsonValue | undefined, path: string): string {
	if (!isJsonString(value) || value.trim().length === 0) {
		return fail(path, "non-empty string", value);
	}
	return value.trim();
}

function fail<T>(path: string, expected: string, received: T): never {
	throw new DataStoreOfferingParseError(path, expected, cloneAsJson(received));
}
