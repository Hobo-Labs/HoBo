/**
 * Verse-inspired EffectSpec for Contract IR (ADR-0136).
 * Effects are first-class optional annotations on BoundaryContract.
 * No Effect-TS / Polly / XState dependencies.
 */

// public-contract: schema version for EffectSpec declarations (ADR-0136).
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export const EFFECT_SPEC_SCHEMA_VERSION = "hobo.effect-spec/v1";
// public-contract: schema version for captured EffectManifest exports (ADR-0136).
export const EFFECT_MANIFEST_SCHEMA_VERSION = "hobo.effect-manifest/v1";

/** Exclusive-ish purity lattice (more pure → less pure). */
export const PURITY_LEVELS = Object.freeze([
	"pure",
	"varies",
	"transacts",
	"noRollback",
] as const);

export type PurityLevel = (typeof PURITY_LEVELS)[number];

/** Additive capability effects. */
export const CAPABILITY_EFFECTS = Object.freeze([
	"decides",
	"suspends",
	"allocates",
	"concurrent",
] as const);

export type CapabilityEffect = (typeof CAPABILITY_EFFECTS)[number];

/** Domain I/O effects (drive harness mocks and external capture). */
export const DOMAIN_EFFECTS = Object.freeze([
	"network",
	"storage",
	"identity",
	"policyEval",
	"eventEmit",
	"metering",
	"overlayTunnel",
	"iac",
	"secretsResidual",
	"clock",
	"externalCall",
	"agentTool",
] as const);

export type DomainEffect = (typeof DOMAIN_EFFECTS)[number];

export type EffectKind = CapabilityEffect | DomainEffect;

// ADR-0136 parse-don't-validate DSL surface with readonly refined fields;
// generated contracts_pb.ts EffectSpec is its wire form.
// domain-view: deliberate refined domain type, permanent by design.
export interface EffectSpec {
	readonly schemaVersion: typeof EFFECT_SPEC_SCHEMA_VERSION;
	/** Exclusive purity position on the lattice. */
	readonly purity: PurityLevel;
	/** Additive capability effects (sorted unique). */
	readonly capabilities: readonly CapabilityEffect[];
	/** Domain I/O effects (sorted unique). */
	readonly domains: readonly DomainEffect[];
}

export interface EffectSpecInput {
	purity?: unknown;
	capabilities?: unknown;
	domains?: unknown;
}

export class EffectValidationError extends Error {
	readonly code: string;
	readonly path: string;
	constructor(code: string, message: string, path = "$") {
		super(`${code} at ${path}: ${message}`);
		this.name = "EffectValidationError";
		this.code = code;
		this.path = path;
	}
}

const PURITY_RANK = {
	pure: 0,
	varies: 1,
	transacts: 2,
	noRollback: 3,
} as const;

const PURITY_SET = new Set<string>(PURITY_LEVELS);
const CAP_SET = new Set<string>(CAPABILITY_EFFECTS);
const DOMAIN_SET = new Set<string>(DOMAIN_EFFECTS);

/**
 * Conservative default for external-facing / unknown contracts.
 * pure must be declared explicitly.
 */
export function conservativeDefaultEffects(): EffectSpec {
	return Object.freeze({
		schemaVersion: EFFECT_SPEC_SCHEMA_VERSION,
		purity: "noRollback",
		// SAFETY: assertion required at this I/O or test boundary.
		capabilities: Object.freeze(["decides"] as CapabilityEffect[]),
		// SAFETY: assertion required at this I/O or test boundary.
		domains: Object.freeze(["network", "externalCall"] as DomainEffect[]),
	});
}

export function pureEffects(): EffectSpec {
	return Object.freeze({
		schemaVersion: EFFECT_SPEC_SCHEMA_VERSION,
		purity: "pure",
		// SAFETY: assertion required at this I/O or test boundary.
		capabilities: Object.freeze([] as CapabilityEffect[]),
		// SAFETY: assertion required at this I/O or test boundary.
		domains: Object.freeze([] as DomainEffect[]),
	});
}

export function parseEffectSpec<T>(input: T): EffectSpec {
	if (input === undefined || input === null) {
		return conservativeDefaultEffects();
	}
	const source = expectObject(cloneAsJson(input), "$.effects");
	// SAFETY: assertion required at this I/O or test boundary.
	const purity = enumValue(
		source.purity ?? "noRollback",
		PURITY_SET,
		"$.effects.purity",
	) as PurityLevel;
	// SAFETY: assertion required at this I/O or test boundary.
	const capabilities = uniqueEnumArray(
		source.capabilities ?? [],
		CAP_SET,
		"$.effects.capabilities",
	) as CapabilityEffect[];
	// SAFETY: assertion required at this I/O or test boundary.
	const domains = uniqueEnumArray(
		source.domains ?? [],
		DOMAIN_SET,
		"$.effects.domains",
	) as DomainEffect[];

	// pure forbids domain I/O and most capabilities except decides (typed failure ok).
	if (purity === "pure") {
		if (domains.length > 0) {
			throw new EffectValidationError(
				"pure-forbids-domains",
				`pure contracts cannot declare domain effects: ${domains.join(",")}`,
				"$.effects.domains",
			);
		}
		const forbidden = capabilities.filter((c) => c !== "decides");
		if (forbidden.length > 0) {
			throw new EffectValidationError(
				"pure-forbids-capabilities",
				`pure contracts cannot declare: ${forbidden.join(",")}`,
				"$.effects.capabilities",
			);
		}
	}

	// network/externalCall imply at least varies purity
	if (
		(domains.includes("network") || domains.includes("externalCall")) &&
		PURITY_RANK[purity] < PURITY_RANK.varies
	) {
		throw new EffectValidationError(
			"domain-requires-purity",
			"network/externalCall require purity >= varies",
			"$.effects.purity",
		);
	}

	return Object.freeze({
		schemaVersion: EFFECT_SPEC_SCHEMA_VERSION,
		purity,
		capabilities: Object.freeze(capabilities),
		domains: Object.freeze(domains),
	});
}

export function createEffectSpec(input: EffectSpecInput = {}): EffectSpec {
	return parseEffectSpec(input);
}

// ── Lattice helpers ─────────────────────────────────────────────────────────

export function isPure(spec: EffectSpec): boolean {
	return (
		spec.purity === "pure" &&
		spec.domains.length === 0 &&
		spec.capabilities.every((c) => c === "decides")
	);
}

export function mayFail(spec: EffectSpec): boolean {
	return spec.capabilities.includes("decides");
}

export function requiresNetwork(spec: EffectSpec): boolean {
	return (
		spec.domains.includes("network") || spec.domains.includes("externalCall")
	);
}

export function purityRank(level: PurityLevel): number {
	return PURITY_RANK[level];
}

/** Join purity to least pure (higher rank). */
export function purityJoin(a: PurityLevel, b: PurityLevel): PurityLevel {
	return PURITY_RANK[a] >= PURITY_RANK[b] ? a : b;
}

/** Union of two effect sets (caller must declare at least the union of callees). */
export function effectUnion(a: EffectSpec, b: EffectSpec): EffectSpec {
	return Object.freeze({
		schemaVersion: EFFECT_SPEC_SCHEMA_VERSION,
		purity: purityJoin(a.purity, b.purity),
		capabilities: Object.freeze(
			// SAFETY: assertion required at this I/O or test boundary.
			uniqueSorted([
				...a.capabilities,
				...b.capabilities,
			]) as CapabilityEffect[],
		),
		domains: Object.freeze(
			// SAFETY: assertion required at this I/O or test boundary.
			uniqueSorted([...a.domains, ...b.domains]) as DomainEffect[],
		),
	});
}

/**
 * Subtyping: `provided` can be used where `required` is expected iff
 * provided is safer — purity rank ≤ required, capabilities ⊆ required,
 * domains ⊆ required.
 */
export function effectSubtype(
	provided: EffectSpec,
	required: EffectSpec,
): boolean {
	if (PURITY_RANK[provided.purity] > PURITY_RANK[required.purity]) {
		return false;
	}
	for (const c of provided.capabilities) {
		if (!required.capabilities.includes(c)) return false;
	}
	for (const d of provided.domains) {
		if (!required.domains.includes(d)) return false;
	}
	return true;
}

export interface EffectDiff {
	readonly purityWidened: boolean;
	readonly addedCapabilities: CapabilityEffect[];
	readonly addedDomains: DomainEffect[];
}

/** Effects present in `next` but not in `prev` (widening). */
export function effectDiff(prev: EffectSpec, next: EffectSpec): EffectDiff {
	return {
		purityWidened: PURITY_RANK[next.purity] > PURITY_RANK[prev.purity],
		addedCapabilities: next.capabilities.filter(
			(c) => !prev.capabilities.includes(c),
		),
		addedDomains: next.domains.filter((d) => !prev.domains.includes(d)),
	};
}

/**
 * Effect widening is breaking when consumers assumed a narrower effect set.
 * Adding domain I/O or reducing purity is breaking; removing effects is safe.
 */
export function isEffectWideningBreaking(
	prev: EffectSpec,
	next: EffectSpec,
): boolean {
	const diff = effectDiff(prev, next);
	return (
		diff.purityWidened ||
		diff.addedCapabilities.length > 0 ||
		diff.addedDomains.length > 0
	);
}

// ── EffectManifest (export for external systems) ────────────────────────────

// ADR-0136 parse-don't-validate export manifest with refined readonly fields;
// generated contracts_pb.ts EffectManifest is the wire form.
// domain-view: deliberate refined domain type, permanent by design.
export interface EffectManifest {
	readonly schemaVersion: typeof EFFECT_MANIFEST_SCHEMA_VERSION;
	readonly contractId: string;
	readonly contractVersion: string;
	readonly channel: string;
	readonly effects: EffectSpec;
	/** Lattice position label for SRE/policy consumers. */
	readonly purityLabel: PurityLevel;
	readonly mayFail: boolean;
	readonly requiresNetwork: boolean;
	readonly isPure: boolean;
	readonly exportedAt: string;
}

export function toEffectManifest(input: {
	contractId: string;
	contractVersion: string;
	channel: string;
	effects: EffectSpec;
	exportedAt?: string;
}): EffectManifest {
	const effects = parseEffectSpec(input.effects);
	return Object.freeze({
		schemaVersion: EFFECT_MANIFEST_SCHEMA_VERSION,
		contractId: input.contractId,
		contractVersion: input.contractVersion,
		channel: input.channel,
		effects,
		purityLabel: effects.purity,
		mayFail: mayFail(effects),
		requiresNetwork: requiresNetwork(effects),
		isPure: isPure(effects),
		exportedAt: input.exportedAt ?? new Date().toISOString(),
	});
}

export function serializeEffectManifest(manifest: EffectManifest): string {
	return JSON.stringify(manifest, null, 2);
}

// ── Effect capture (facts only; no re-execution on replay) ───────────────────

// public-contract: fact name emitted when a contract effect is declared (ADR-0136).
export const EFFECT_DECLARED_EVENT = "contract.EffectDeclared";
// public-contract: fact name emitted when a declared effect is invoked (ADR-0136).
export const EFFECT_INVOKED_EVENT = "contract.EffectInvoked";

export interface EffectCaptureFact {
	readonly type: typeof EFFECT_DECLARED_EVENT | typeof EFFECT_INVOKED_EVENT;
	readonly contractId: string;
	readonly channel: string;
	readonly effects: EffectSpec;
	readonly at: string;
	/** OTel-style attributes for external export. */
	readonly attributes: Readonly<Record<string, string | boolean | number>>;
}

export interface EffectSink {
	record(fact: EffectCaptureFact): void;
}

export function createInMemoryEffectSink(): EffectSink & {
	facts(): readonly EffectCaptureFact[];
} {
	const facts: EffectCaptureFact[] = [];
	return {
		record(fact) {
			facts.push(
				Object.freeze({ ...fact, attributes: { ...fact.attributes } }),
			);
		},
		facts: () => facts,
	};
}

export function createEffectTracer(sink: EffectSink) {
	return {
		declare(input: {
			contractId: string;
			channel: string;
			effects: EffectSpec;
			at?: string;
		}): EffectCaptureFact {
			const fact = buildCaptureFact(
				EFFECT_DECLARED_EVENT,
				input.contractId,
				input.channel,
				input.effects,
				input.at,
			);
			sink.record(fact);
			return fact;
		},
		/**
		 * Record that an effectful boundary was invoked. Does not re-execute
		 * work — inspection reconstructs from these facts on replay.
		 */
		invoked(input: {
			contractId: string;
			channel: string;
			effects: EffectSpec;
			at?: string;
		}): EffectCaptureFact {
			const fact = buildCaptureFact(
				EFFECT_INVOKED_EVENT,
				input.contractId,
				input.channel,
				input.effects,
				input.at,
			);
			sink.record(fact);
			return fact;
		},
	};
}

function buildCaptureFact(
	type: typeof EFFECT_DECLARED_EVENT | typeof EFFECT_INVOKED_EVENT,
	contractId: string,
	channel: string,
	effects: EffectSpec,
	at?: string,
): EffectCaptureFact {
	const spec = parseEffectSpec(effects);
	return Object.freeze({
		type,
		contractId,
		channel,
		effects: spec,
		at: at ?? new Date().toISOString(),
		attributes: Object.freeze({
			"hobo.effect.purity": spec.purity,
			"hobo.effect.may_fail": mayFail(spec),
			"hobo.effect.requires_network": requiresNetwork(spec),
			"hobo.effect.is_pure": isPure(spec),
			"hobo.effect.domains": spec.domains.join(","),
			"hobo.effect.capabilities": spec.capabilities.join(","),
			"hobo.contract.id": contractId,
			"hobo.contract.channel": channel,
		}),
	});
}

// ── parsers ─────────────────────────────────────────────────────────────────

function expectObject(input: JsonValue, path: string): JsonObject {
	if (input === null || !isJsonObject(input) || Array.isArray(input)) {
		throw new EffectValidationError(
			"expected-object",
			"expected a JSON object",
			path,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return input as JsonObject;
}

function enumValue(
	input: JsonValue,
	allowed: Set<string>,
	path: string,
): string {
	if (!isJsonString(input) || !allowed.has(input)) {
		throw new EffectValidationError("unknown-value", String(input), path);
	}
	return input;
}

function uniqueEnumArray(
	input: JsonValue,
	allowed: Set<string>,
	path: string,
): string[] {
	if (!Array.isArray(input)) {
		throw new EffectValidationError("expected-array", "expected array", path);
	}
	const out: string[] = [];
	for (let i = 0; i < input.length; i++) {
		const v = enumValue(input[i], allowed, `${path}[${i}]`);
		if (!out.includes(v)) out.push(v);
	}
	return out.sort();
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort();
}
