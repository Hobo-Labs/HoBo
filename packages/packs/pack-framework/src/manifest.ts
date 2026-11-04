/**
 * The pack manifest: everything a HoBo Yard needs to run a capability on
 * generic compute instead of buying it from a managed provider.
 *
 * A pack is not a Dockerfile with good intentions. It is a signed declaration
 * of pinned image digests per architecture, the ports it listens on, how to tell
 * when it is actually ready, what persistence it *requires* (not prefers), the
 * resource envelope it needs, the configuration it accepts, the binding profiles
 * it produces, the backup and migration operations it supports, and where its
 * bytes came from. Anything a caller would otherwise have to assume is a field
 * here, and an absent field fails a gate rather than getting a default.
 *
 * Parsing is pure: no clock, no network, no filesystem, no randomness. Signature
 * verification is a separate, injected step (`./verification.ts`) and the
 * execution surfaces only accept its output.
 */
import type { BindleRuntime } from "@hobo/capability-profiles";

import {
	type PackArchitecture,
	parsePackArchitecture,
} from "./architecture.js";
import { containsControlChar } from "./argv.js";
import {
	type ImageDigest,
	type ImageRepository,
	type ParsedPinnedImageRef,
	parsePinnedImageRef,
} from "./digest.js";
import { PackError } from "./errors.js";
import {
	canonicalizeForSigning,
	type PackSignature,
	parsePackSignature,
	sha256Of,
} from "./signature.js";

// public-contract: versions serialized pack manifests.
export const PACK_MANIFEST_SCHEMA_VERSION = "hobo.pack-manifest/v1" as const;

declare const packIdBrand: unique symbol;
declare const packVersionBrand: unique symbol;

/** `pack.<family>[.<qualifier>]/v<major>`, e.g. `pack.postgres.oci/v1`. */
export type PackId = string & { readonly [packIdBrand]: "PackId" };

/** A `<major>.<minor>.<patch>` pack revision. */
export type PackVersion = string & {
	readonly [packVersionBrand]: "PackVersion";
};

export type ParsedPackId = {
	readonly id: PackId;
	readonly family: string;
	readonly qualifiers: readonly string[];
	readonly major: number;
};

/**
 * Ownership strategies a pack may declare.
 *
 * There is no `provider-claim` member, and that is the point: a container the
 * operator started on their own compute has no provider account to be
 * transferred into. Ownership either sits with the Yard from the first byte, or
 * it moves through a migration the Yard performs.
 */
export const PACK_OWNERSHIP_STRATEGIES = [
	"yard-owned",
	"migrate-on-claim",
] as const;

export type PackOwnershipStrategy = (typeof PACK_OWNERSHIP_STRATEGIES)[number];

export type PackSourceRef = {
	readonly url: string;
	/** ISO date a human read the source. Never generated. */
	readonly checkedAt: string;
	readonly note: string;
};

export type PackImageInput = {
	readonly architecture: string;
	/** `<registry>/<path>@sha256:<hex>`. A tag is rejected. */
	readonly reference: string;
	readonly sizeBytes?: number;
};

export type PinnedPackImage = {
	readonly architecture: PackArchitecture;
	readonly reference: ParsedPinnedImageRef;
	readonly digest: ImageDigest;
	readonly repository: ImageRepository;
	readonly sizeBytes?: number;
};

export const PACK_PORT_PROTOCOLS = ["tcp", "udp"] as const;

export type PackPortProtocol = (typeof PACK_PORT_PROTOCOLS)[number];

export type PackPort = {
	readonly name: string;
	readonly containerPort: number;
	readonly protocol: PackPortProtocol;
	/** Who may reach it. `none` means internal to the workload only. */
	readonly exposure: "none" | "camp" | "yard";
};

export type PackProbeTiming = {
	readonly initialDelayMs: number;
	readonly periodMs: number;
	readonly timeoutMs: number;
	readonly failureThreshold: number;
};

/**
 * Probes are data, never a shell string. An `exec` probe carries argv as an
 * array so a value containing a space or a semicolon cannot become a second
 * command.
 */
export type PackProbe = PackProbeTiming &
	(
		| { readonly kind: "tcp"; readonly portName: string }
		| { readonly kind: "exec"; readonly argv: readonly string[] }
		| {
				readonly kind: "http-get";
				readonly portName: string;
				readonly path: string;
				readonly expectStatus: number;
		  }
	);

export type PackProbes = {
	/** Required. A pack that cannot say when it is usable cannot be gated on. */
	readonly readiness: PackProbe;
	readonly liveness?: PackProbe;
	readonly startup?: PackProbe;
};

export type PackVolume = {
	readonly name: string;
	readonly mountPath: string;
	readonly minimumBytes: number;
	readonly accessMode: "single-writer" | "shared-multi-writer";
	/**
	 * Whether an external managed store may stand in for a local volume. For a
	 * single-writer database the honest answer is usually `false`.
	 */
	readonly externalStorageAllowed: boolean;
};

export type PackPersistence =
	| {
			readonly requirement: "required";
			readonly volumes: readonly PackVolume[];
	  }
	| { readonly requirement: "not-applicable"; readonly rationale: string };

export type PackResourceBounds = {
	readonly cpuMillicoresMin: number;
	readonly cpuMillicoresMax?: number;
	readonly memoryBytesMin: number;
	readonly memoryBytesMax?: number;
	readonly ephemeralStorageBytesMin?: number;
};

export const PACK_CONFIG_FIELD_KINDS = [
	"string",
	"integer",
	"boolean",
	"enum",
	"secret-ref",
	"volume-name",
	"duration-ms",
] as const;

export type PackConfigFieldKind = (typeof PACK_CONFIG_FIELD_KINDS)[number];

export type PackConfigField = {
	readonly key: string;
	readonly kind: PackConfigFieldKind;
	readonly necessity: "required" | "optional";
	readonly description: string;
	readonly enumValues?: readonly string[];
	readonly minimum?: number;
	readonly maximum?: number;
	/** Only legal on an optional field; a required field must be supplied. */
	readonly defaultValue?: string | number | boolean;
};

export const PACK_OPERATION_KINDS = [
	"backup",
	"restore",
	"migration",
	"maintenance",
] as const;

export type PackOperationKind = (typeof PACK_OPERATION_KINDS)[number];

export type PackOperation = {
	readonly id: string;
	readonly kind: PackOperationKind;
	/** e.g. `migration.postgres.pg-dump/v1`. Absent for local maintenance. */
	readonly profileRef?: string;
	readonly description: string;
	/** How a credential reaches the child process. Never argv. */
	readonly credentialDelivery:
		| "environment"
		| "stdin"
		| "file-descriptor"
		| "none";
	/**
	 * Literal `false`. The type exists so "this operation is built as an argv
	 * array, not a shell string" is a compile-time fact rather than a comment.
	 */
	readonly shell: false;
	readonly argvBuilderRef: string;
};

export type PackProvenance = {
	readonly builder: string;
	readonly buildType: "upstream-published" | "hobo-rebuilt";
	readonly sourceRepository: string;
	readonly sourceRevision: string;
	readonly sbomRef?: string;
	readonly attestationRefs: readonly string[];
	readonly sourceRefs: readonly PackSourceRef[];
};

export type PackConformanceDeclaration = {
	readonly suiteRef: string;
	readonly outcome: "pass" | "fail" | "unknown";
	readonly evidenceCheckedAt: string;
	/** True when the outcome came from a real container run, not a fixture. */
	readonly executedAgainstContainer: boolean;
};

export type PackProfileClaimInput = {
	readonly profileId: string;
	readonly versionRange?: string;
	readonly conformanceRef: string;
	readonly conformance: "pass" | "fail" | "unknown";
};

/**
 * A parsed profile claim. `realization` is not an input: a pack manifest can
 * only ever produce `pack`, so there is no field to set wrong.
 */
export type PackProfileClaim = {
	readonly profileId: string;
	readonly versionRange: string;
	readonly realization: "pack";
	readonly conformanceRef: string;
	readonly conformance: "pass" | "fail" | "unknown";
};

export type PackManifestInput = {
	readonly schemaVersion: string;
	readonly packId: string;
	readonly packVersion: string;
	readonly displayName: string;
	readonly description: string;
	readonly runtimeModels: readonly BindleRuntime[];
	readonly implementsProfiles: readonly PackProfileClaimInput[];
	readonly images: readonly PackImageInput[];
	readonly ports: readonly PackPort[];
	readonly probes: PackProbes;
	readonly persistence: PackPersistence;
	readonly resourceBounds: PackResourceBounds;
	readonly configSchema: readonly PackConfigField[];
	readonly producesBindingProfiles: readonly string[];
	readonly operations: readonly PackOperation[];
	readonly ownership: PackOwnershipStrategy;
	readonly provenance: PackProvenance;
	readonly conformance: PackConformanceDeclaration;
	readonly signature: PackSignature;
};

export type ParsedPackManifest = Omit<
	PackManifestInput,
	"schemaVersion" | "packId" | "packVersion" | "images" | "implementsProfiles"
> & {
	readonly schemaVersion: typeof PACK_MANIFEST_SCHEMA_VERSION;
	readonly packId: PackId;
	readonly parsedPackId: ParsedPackId;
	readonly packVersion: PackVersion;
	readonly images: readonly PinnedPackImage[];
	readonly implementsProfiles: readonly PackProfileClaim[];
	/**
	 * The canonical bytes a signer signs: the manifest as authored, minus its
	 * own signature block. Recorded at parse time so verification checks the
	 * document that was published rather than a re-serialization of the parsed
	 * view, whose derived fields the signer never saw.
	 */
	readonly signingPayload: string;
};

/**
 * The digest a signer must cover. Exported so a signing tool and this package
 * cannot disagree about what "the manifest" means.
 */
export function packManifestPayloadDigest(
	input: Omit<PackManifestInput, "signature"> & {
		readonly signature?: PackSignature;
	},
): string {
	return sha256Of(canonicalizeForSigning(input));
}

const PACK_ID =
	/^pack\.([a-z0-9]+(?:-[a-z0-9]+)*)((?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*)\/v([1-9][0-9]*)$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONFIG_KEY = /^[a-z][a-zA-Z0-9]*$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/?)+$/u;

const HTTPS_URL = /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/\S*)?$/iu;

function invalid(
	detail: string,
	extra?: Readonly<Record<string, string | number>>,
): never {
	throw new PackError(
		"PACK_MANIFEST_INVALID",
		detail,
		extra !== undefined ? { detail: extra } : {},
	);
}

export function parsePackId(input: string): ParsedPackId {
	const match = PACK_ID.exec(input);
	if (match === null) {
		invalid(
			`pack id ${JSON.stringify(input)} must be pack.<family>[.<qualifier>]/v<major> in lowercase`,
		);
	}
	// SAFETY: `const family = match[1] as string;` is required at this I/O or test boundary.
	const family = match[1] as string;
	const qualifierPart = match[2] ?? "";
	return {
		// SAFETY: `id: input as PackId,` is required at this I/O or test boundary.
		id: input as PackId,
		family,
		qualifiers:
			qualifierPart.length > 0 ? qualifierPart.slice(1).split(".") : [],
		major: Number(match[3]),
	};
}

export function parsePackVersion(input: string): PackVersion {
	if (!SEMVER.test(input)) {
		invalid(
			`pack version ${JSON.stringify(input)} must be <major>.<minor>.<patch>`,
		);
	}
	// SAFETY: `return input as PackVersion;` is required at this I/O or test boundary.
	return input as PackVersion;
}

function parseImages(
	inputs: readonly PackImageInput[],
): readonly PinnedPackImage[] {
	if (inputs.length === 0) {
		invalid("a pack manifest must pin at least one image digest");
	}
	const seen = new Set<PackArchitecture>();
	const parsed: PinnedPackImage[] = [];
	for (const input of inputs) {
		const architecture = parsePackArchitecture(input.architecture);
		if (seen.has(architecture)) {
			invalid(`pack manifest pins ${architecture} more than once`);
		}
		seen.add(architecture);
		const reference = parsePinnedImageRef(input.reference);
		if (input.sizeBytes !== undefined) {
			if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
				invalid("image sizeBytes must be a positive integer when declared");
			}
		}
		parsed.push({
			architecture,
			reference,
			digest: reference.digest,
			repository: reference.repository,
			...(input.sizeBytes !== undefined
				? { sizeBytes: input.sizeBytes }
				: undefined),
		});
	}
	// One repository per pack: a manifest whose arm64 image comes from a
	// different repository than its amd64 image is describing two products.
	const repositories = new Set(parsed.map((image) => image.repository));
	if (repositories.size > 1) {
		invalid(
			`pack manifest pins images from ${repositories.size} repositories; every architecture must come from one`,
		);
	}
	return [...parsed].sort((a, b) =>
		a.architecture.localeCompare(b.architecture),
	);
}

function parseProbe(
	probe: PackProbe,
	ports: readonly PackPort[],
	what: string,
): PackProbe {
	for (const [key, value] of [
		["initialDelayMs", probe.initialDelayMs],
		["periodMs", probe.periodMs],
		["timeoutMs", probe.timeoutMs],
		["failureThreshold", probe.failureThreshold],
	] as const) {
		if (!Number.isInteger(value) || value < 0) {
			invalid(`${what} ${key} must be a non-negative integer`);
		}
	}
	if (
		probe.periodMs === 0 ||
		probe.timeoutMs === 0 ||
		probe.failureThreshold === 0
	) {
		invalid(
			`${what} periodMs, timeoutMs, and failureThreshold must be positive`,
		);
	}
	if (probe.timeoutMs > probe.periodMs) {
		invalid(
			`${what} timeoutMs must not exceed periodMs, or probes overlap themselves`,
		);
	}
	if (probe.kind === "exec") {
		if (probe.argv.length === 0) {
			invalid(`${what} exec probe must carry a non-empty argv array`);
		}
		for (const element of probe.argv) {
			if (element.length === 0 || containsControlChar(element)) {
				invalid(
					`${what} exec argv elements must be non-empty and free of control characters`,
				);
			}
		}
	} else {
		if (!ports.some((port) => port.name === probe.portName)) {
			invalid(
				`${what} references undeclared port ${JSON.stringify(probe.portName)}`,
			);
		}
		if (probe.kind === "http-get") {
			if (!probe.path.startsWith("/")) {
				invalid(`${what} http-get path must start with /`);
			}
			if (!Number.isInteger(probe.expectStatus) || probe.expectStatus < 100) {
				invalid(`${what} http-get expectStatus must be a valid HTTP status`);
			}
		}
	}
	return probe;
}

function parsePorts(ports: readonly PackPort[]): readonly PackPort[] {
	const names = new Set<string>();
	for (const port of ports) {
		if (!IDENTIFIER.test(port.name)) {
			invalid(
				`port name ${JSON.stringify(port.name)} must be a lowercase dns-style label`,
			);
		}
		if (names.has(port.name)) invalid(`duplicate port name ${port.name}`);
		names.add(port.name);
		if (
			!Number.isInteger(port.containerPort) ||
			port.containerPort < 1 ||
			port.containerPort > 65535
		) {
			invalid(`port ${port.name} has an out-of-range containerPort`);
		}
	}
	return [...ports].sort((a, b) => a.name.localeCompare(b.name));
}

function parsePersistence(persistence: PackPersistence): PackPersistence {
	if (persistence.requirement === "not-applicable") {
		if (persistence.rationale.trim().length === 0) {
			invalid(
				"a pack that declares no persistence requirement must say why, so the omission is a decision rather than a gap",
			);
		}
		return persistence;
	}
	if (persistence.volumes.length === 0) {
		invalid(
			"a pack that requires persistence must declare at least one volume",
		);
	}
	const names = new Set<string>();
	const paths = new Set<string>();
	for (const volume of persistence.volumes) {
		if (!IDENTIFIER.test(volume.name)) {
			invalid(
				`volume name ${JSON.stringify(volume.name)} must be a lowercase dns-style label`,
			);
		}
		if (names.has(volume.name)) invalid(`duplicate volume name ${volume.name}`);
		names.add(volume.name);
		if (
			!ABSOLUTE_PATH.test(volume.mountPath) ||
			volume.mountPath.includes("..")
		) {
			invalid(
				`volume ${volume.name} mountPath must be an absolute path without traversal`,
			);
		}
		if (paths.has(volume.mountPath))
			invalid(`duplicate volume mountPath ${volume.mountPath}`);
		paths.add(volume.mountPath);
		if (!Number.isInteger(volume.minimumBytes) || volume.minimumBytes <= 0) {
			invalid(`volume ${volume.name} minimumBytes must be a positive integer`);
		}
	}
	return {
		requirement: "required",
		volumes: [...persistence.volumes].sort((a, b) =>
			a.name.localeCompare(b.name),
		),
	};
}

function parseResourceBounds(bounds: PackResourceBounds): PackResourceBounds {
	if (
		!Number.isInteger(bounds.cpuMillicoresMin) ||
		bounds.cpuMillicoresMin <= 0
	) {
		invalid("resourceBounds.cpuMillicoresMin must be a positive integer");
	}
	if (!Number.isInteger(bounds.memoryBytesMin) || bounds.memoryBytesMin <= 0) {
		invalid("resourceBounds.memoryBytesMin must be a positive integer");
	}
	if (
		bounds.cpuMillicoresMax !== undefined &&
		bounds.cpuMillicoresMax < bounds.cpuMillicoresMin
	) {
		invalid("resourceBounds.cpuMillicoresMax is below cpuMillicoresMin");
	}
	if (
		bounds.memoryBytesMax !== undefined &&
		bounds.memoryBytesMax < bounds.memoryBytesMin
	) {
		invalid("resourceBounds.memoryBytesMax is below memoryBytesMin");
	}
	if (
		bounds.ephemeralStorageBytesMin !== undefined &&
		(!Number.isInteger(bounds.ephemeralStorageBytesMin) ||
			bounds.ephemeralStorageBytesMin <= 0)
	) {
		invalid(
			"resourceBounds.ephemeralStorageBytesMin must be a positive integer when declared",
		);
	}
	return bounds;
}

function parseConfigSchema(
	fields: readonly PackConfigField[],
	persistence: PackPersistence,
): readonly PackConfigField[] {
	const keys = new Set<string>();
	for (const field of fields) {
		if (!CONFIG_KEY.test(field.key)) {
			invalid(
				`configuration key ${JSON.stringify(field.key)} must be lowerCamelCase`,
			);
		}
		if (keys.has(field.key))
			invalid(`duplicate configuration key ${field.key}`);
		keys.add(field.key);
		// SAFETY: `if (!(PACK_CONFIG_FIELD_KINDS as readonly string[]).includes(field.kind)) {` is required at this I/O or test boundary.
		if (!(PACK_CONFIG_FIELD_KINDS as readonly string[]).includes(field.kind)) {
			invalid(
				`configuration key ${field.key} has unknown kind ${String(field.kind)}`,
			);
		}
		if (
			field.kind === "enum" &&
			(field.enumValues === undefined || field.enumValues.length === 0)
		) {
			invalid(`enum configuration key ${field.key} must declare enumValues`);
		}
		if (field.kind !== "enum" && field.enumValues !== undefined) {
			invalid(
				`configuration key ${field.key} declares enumValues but is not an enum`,
			);
		}
		if (field.defaultValue !== undefined && field.necessity === "required") {
			invalid(
				`required configuration key ${field.key} must not carry a default; a default on a required field is how an unsafe value gets chosen silently`,
			);
		}
		if (field.kind === "secret-ref" && field.defaultValue !== undefined) {
			invalid(
				`secret-ref configuration key ${field.key} must never carry a default value`,
			);
		}
		if (
			field.minimum !== undefined &&
			field.maximum !== undefined &&
			field.minimum > field.maximum
		) {
			invalid(`configuration key ${field.key} has minimum above maximum`);
		}
	}
	if (persistence.requirement === "required") {
		const volumeFields = fields.filter((field) => field.kind === "volume-name");
		if (volumeFields.length === 0) {
			invalid(
				"a pack that requires persistence must expose a volume-name configuration key, so a deployment cannot omit storage by omission",
			);
		}
		if (volumeFields.some((field) => field.necessity !== "required")) {
			invalid(
				"the volume-name configuration key of a persistent pack must be required",
			);
		}
	}
	return [...fields].sort((a, b) => a.key.localeCompare(b.key));
}

function parseOperations(
	operations: readonly PackOperation[],
): readonly PackOperation[] {
	const ids = new Set<string>();
	for (const operation of operations) {
		if (!IDENTIFIER.test(operation.id.replace(/\./gu, "-"))) {
			invalid(
				`operation id ${JSON.stringify(operation.id)} must be lowercase dot/dash separated`,
			);
		}
		if (ids.has(operation.id))
			invalid(`duplicate operation id ${operation.id}`);
		ids.add(operation.id);
		// SAFETY: `if (!(PACK_OPERATION_KINDS as readonly string[]).includes(operation.kind)) {` is required at this I/O or test boundary.
		if (!(PACK_OPERATION_KINDS as readonly string[]).includes(operation.kind)) {
			invalid(
				`operation ${operation.id} has unknown kind ${String(operation.kind)}`,
			);
		}
		// `shell` is typed `false`, but a manifest can arrive from JSON.
		// SAFETY: `if ((operation.shell as boolean) !== false) {` is required at this I/O or test boundary.
		if ((operation.shell as boolean) !== false) {
			invalid(
				`operation ${operation.id} declares shell invocation; pack operations are argv arrays only`,
			);
		}
		if (operation.argvBuilderRef.trim().length === 0) {
			invalid(
				`operation ${operation.id} must name the argv builder that produces its command`,
			);
		}
	}
	return [...operations].sort((a, b) => a.id.localeCompare(b.id));
}

function parseProvenance(provenance: PackProvenance): PackProvenance {
	if (provenance.builder.trim().length === 0) {
		invalid("provenance.builder must name who produced the image");
	}
	if (provenance.sourceRefs.length === 0) {
		invalid(
			"provenance must cite at least one official source with the date it was checked",
		);
	}
	for (const source of provenance.sourceRefs) {
		if (!HTTPS_URL.test(source.url)) {
			invalid(
				`provenance source ${JSON.stringify(source.url)} must be an https URL`,
			);
		}
		if (!ISO_DATE.test(source.checkedAt)) {
			invalid(`provenance source ${source.url} needs a YYYY-MM-DD checkedAt`);
		}
	}
	return {
		...provenance,
		sourceRefs: [...provenance.sourceRefs].sort((a, b) =>
			a.url.localeCompare(b.url),
		),
		attestationRefs: [...provenance.attestationRefs].sort((a, b) =>
			a.localeCompare(b),
		),
	};
}

function parseProfileClaims(
	claims: readonly PackProfileClaimInput[],
): readonly PackProfileClaim[] {
	if (claims.length === 0) {
		invalid("a pack manifest must claim at least one capability profile");
	}
	const seen = new Set<string>();
	const parsed: PackProfileClaim[] = [];
	for (const claim of claims) {
		if (seen.has(claim.profileId)) {
			invalid(`pack manifest claims ${claim.profileId} more than once`);
		}
		seen.add(claim.profileId);
		if (claim.conformanceRef.trim().length === 0) {
			invalid(
				`profile claim ${claim.profileId} must name its conformance suite`,
			);
		}
		parsed.push({
			profileId: claim.profileId,
			versionRange: claim.versionRange ?? ">=1",
			realization: "pack",
			conformanceRef: claim.conformanceRef,
			conformance: claim.conformance,
		});
	}
	return [...parsed].sort((a, b) => a.profileId.localeCompare(b.profileId));
}

/**
 * The single parse boundary for a pack manifest.
 *
 * Everything downstream — the semantics projection, the configuration parser,
 * the conformance harness — accepts {@link ParsedPackManifest} (or the verified
 * narrowing of it) and therefore never re-checks these invariants.
 */
export function parsePackManifest(
	input: PackManifestInput,
): ParsedPackManifest {
	if (input.schemaVersion !== PACK_MANIFEST_SCHEMA_VERSION) {
		throw new PackError(
			"PROVIDER_CONTRACT_CHANGED",
			`unsupported pack manifest schemaVersion ${JSON.stringify(String(input.schemaVersion))}`,
			{ detail: { expected: PACK_MANIFEST_SCHEMA_VERSION } },
		);
	}
	if (
		// SAFETY: `!(PACK_OWNERSHIP_STRATEGIES as readonly string[]).includes(input.ownership)` is required at this I/O or test boundary.
		!(PACK_OWNERSHIP_STRATEGIES as readonly string[]).includes(input.ownership)
	) {
		invalid(
			`ownership ${JSON.stringify(String(input.ownership))} is not a pack ownership strategy; a pack on generic compute is never provider-claimable`,
		);
	}
	if (input.runtimeModels.length === 0) {
		invalid("a pack manifest must declare at least one runtime model");
	}
	if (input.producesBindingProfiles.length === 0) {
		invalid("a pack manifest must declare the binding profiles it produces");
	}
	if (
		input.displayName.trim().length === 0 ||
		input.description.trim().length === 0
	) {
		invalid("a pack manifest needs a displayName and a description");
	}
	if (!ISO_DATE.test(input.conformance.evidenceCheckedAt)) {
		invalid("conformance.evidenceCheckedAt must be a YYYY-MM-DD date");
	}
	if (input.conformance.suiteRef.trim().length === 0) {
		invalid(
			"conformance.suiteRef must name the suite that produced the outcome",
		);
	}

	const parsedPackId = parsePackId(input.packId);
	const ports = parsePorts(input.ports);
	const persistence = parsePersistence(input.persistence);

	const probes: PackProbes = {
		readiness: parseProbe(input.probes.readiness, ports, "readiness probe"),
		...(input.probes.liveness !== undefined
			? { liveness: parseProbe(input.probes.liveness, ports, "liveness probe") }
			: undefined),
		...(input.probes.startup !== undefined
			? { startup: parseProbe(input.probes.startup, ports, "startup probe") }
			: undefined),
	};

	return {
		schemaVersion: PACK_MANIFEST_SCHEMA_VERSION,
		packId: parsedPackId.id,
		parsedPackId,
		packVersion: parsePackVersion(input.packVersion),
		displayName: input.displayName,
		description: input.description,
		runtimeModels: [...input.runtimeModels].sort((a, b) => a.localeCompare(b)),
		implementsProfiles: parseProfileClaims(input.implementsProfiles),
		images: parseImages(input.images),
		ports,
		probes,
		persistence,
		resourceBounds: parseResourceBounds(input.resourceBounds),
		configSchema: parseConfigSchema(input.configSchema, persistence),
		producesBindingProfiles: [...input.producesBindingProfiles].sort((a, b) =>
			a.localeCompare(b),
		),
		operations: parseOperations(input.operations),
		ownership: input.ownership,
		provenance: parseProvenance(input.provenance),
		conformance: input.conformance,
		signature: parsePackSignature(input.signature),
		signingPayload: canonicalizeForSigning(input),
	};
}
