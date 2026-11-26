/**
 * Strong claim by replacement.
 *
 * A Convex admin key is, per the official deploy-key documentation, "an
 * irrevocable secret baked into the deployment when created". So any admin
 * key that HoBo, an agent, or a shared temporary backend ever held cannot be
 * rotated away. If we want to hand a user a backend they *exclusively* own,
 * upgrading the temporary backend in place is not provable — the old
 * authority still opens the door forever.
 *
 * The only honest move is replacement: stand up a FRESH backend (B1) under a
 * fresh authority (K1), move code, config, data and files across, verify,
 * cut the logical connector over, hold a bounded rollback window, and only
 * then destroy the temporary backend (B0) and its authority (K0).
 *
 * This module is the saga as a PURE state machine:
 * - `decideStrongClaim(state, command)` — pure, returns events or a typed
 *   rejection. Every ordering invariant lives here.
 * - `reduceStrongClaim(state, event)` — pure fold. Defense in depth: it will
 *   not mark a claim complete once a failure has been recorded.
 * - `ConvexMigrationDriver` — every effect (network, process, registry, DNS)
 *   is behind this injected port. Nothing in this file performs I/O.
 *
 * Authority is only ever represented as an opaque *reference* parsed by
 * `parseAuthorityRef`; key material is rejected at the boundary and
 * `assertNoAuthorityMaterial` re-checks emitted events and receipts.
 */

import type { ConvexHostingFormId } from "./hosting-forms.js";
import type { JsonValue } from "./json.js";

// public-contract: strong-claim record schema id consumers pin.
export const STRONG_CLAIM_SCHEMA = "hobo.provider-convex.strong-claim/v1";
// public-contract: strong-claim receipt schema id.
export const STRONG_CLAIM_RECEIPT_SCHEMA =
	"hobo.provider-convex.strong-claim-receipt/v1";

// ---------------------------------------------------------------------------
// Authority references (parse, don't validate)
// ---------------------------------------------------------------------------

declare const authorityRefBrand: unique symbol;

/** An opaque handle to an authority held by a broker — never the secret. */
export type AuthorityRef = string & { readonly [authorityRefBrand]: true };

export class StrongClaimError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "StrongClaimError";
		this.code = code;
	}
}

export class StrongClaimSecretLeakError extends StrongClaimError {
	constructor(context: string) {
		super(
			"authority-material-leak",
			`refusing to emit ${context}: it contains something shaped like Convex key material`,
		);
		this.name = "StrongClaimSecretLeakError";
	}
}

/**
 * Convex key shapes: admin keys (`bold-hyena-681|01c2…`) and deploy keys
 * (`prod:`/`preview:`/`dev:`/`project:` prefix, then `name|base64`). The
 * separator plus a long opaque tail is the tell.
 */
const CONVEX_KEY_MATERIAL =
	/(?:prod|preview|dev|project):[\w:-]+\||[a-z][a-z0-9]*(?:-[a-z0-9]+){1,4}\|[A-Za-z0-9+/=_-]{12,}/u;

export function looksLikeAuthorityMaterial(value: string): boolean {
	return CONVEX_KEY_MATERIAL.test(value);
}

/**
 * Boundary parser: a broker handle in, a branded ref out. Anything that looks
 * like a Convex admin/deploy key is refused here so it can never reach an
 * event, a receipt, a plan, or a log line.
 */
export function parseAuthorityRef(value: string): AuthorityRef {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new StrongClaimError(
			"authority-ref-empty",
			"authority reference must be a non-empty broker handle",
		);
	}
	if (looksLikeAuthorityMaterial(trimmed)) {
		throw new StrongClaimSecretLeakError("an authority reference");
	}
	// SAFETY: parseAuthorityRef rejects empty and key-shaped strings at this boundary.
	return trimmed as AuthorityRef;
}

/** Throws when any string anywhere in `value` looks like key material. */
export function assertNoAuthorityMaterial(
	value: JsonValue | StrongClaimEvent | StrongClaimReceipt,
	context: string,
): void {
	const serialized = JSON.stringify(value) ?? "";
	if (looksLikeAuthorityMaterial(serialized)) {
		throw new StrongClaimSecretLeakError(context);
	}
}

// ---------------------------------------------------------------------------
// Domain records
// ---------------------------------------------------------------------------

export interface BackendRef {
	readonly backendId: string;
	readonly hostingFormId: ConvexHostingFormId;
	readonly url: string;
	readonly authorityRef: AuthorityRef;
}

export const VERIFICATION_CHECK_KEYS = [
	"documentCountsMatch",
	"sampledHashesMatch",
	"filesMatch",
	"indexesReady",
	"httpActionsRouting",
	"websocketHealthy",
	"authConfigMatches",
	"appHealthy",
] as const;

export type VerificationCheckKey = (typeof VERIFICATION_CHECK_KEYS)[number];

export type VerificationSummary = {
	readonly [K in VerificationCheckKey]: boolean;
};

/** Which verification checks did not pass. Pure. */
export function verificationFailures(
	summary: VerificationSummary,
): readonly VerificationCheckKey[] {
	return VERIFICATION_CHECK_KEYS.filter((key) => summary[key] !== true);
}

export function verificationPassed(summary: VerificationSummary): boolean {
	return verificationFailures(summary).length === 0;
}

export type StrongClaimPhase =
	| "idle"
	| "temporary-backend"
	| "destination-ready"
	| "code-deployed"
	| "source-fenced"
	| "exported"
	| "imported"
	| "verified"
	| "rollback-window-open"
	| "rollback-window-closed"
	| "source-destroyed"
	| "claimed"
	| "failed";

export type StrongClaimFailureCode =
	| "import-failed"
	| "verification-failed"
	| "cutover-failed"
	| "rolled-back"
	| "aborted"
	| "driver-error";

export type StrongClaimRejectionCode =
	| "wrong-phase"
	| "terminal"
	| "reused-compromised-authority"
	| "destination-not-fresh"
	| "source-not-fenced"
	| "cutover-before-verification"
	| "destroy-before-cutover"
	| "destroy-before-rollback-window-closed"
	| "verification-incomplete";

export interface StrongClaimFailure {
	readonly code: StrongClaimFailureCode;
	readonly message: string;
}

export interface StrongClaimState {
	readonly schema: typeof STRONG_CLAIM_SCHEMA;
	readonly claimId: string;
	readonly phase: StrongClaimPhase;
	readonly source: BackendRef | null;
	readonly destination: BackendRef | null;
	/** Which backend is the system of record right now. */
	readonly authoritative: "source" | "destination";
	readonly sourceWritable: boolean;
	/**
	 * Every authority that existed before the claim, or that a temporary
	 * backend ever exposed. Treated as compromised for proving exclusive
	 * ownership even if nothing bad ever happened to it.
	 */
	readonly compromisedAuthorityRefs: readonly string[];
	readonly verification: VerificationSummary | null;
	readonly cutoverDone: boolean;
	readonly connectorId: string | null;
	readonly rollbackWindowMs: number;
	readonly rollbackWindowClosed: boolean;
	readonly sourceDestroyed: boolean;
	readonly claimComplete: boolean;
	readonly failure: StrongClaimFailure | null;
}

// ---------------------------------------------------------------------------
// Commands and events
// ---------------------------------------------------------------------------

export type StrongClaimCommand =
	| {
			readonly type: "StartClaim";
			readonly source: BackendRef;
			readonly rollbackWindowMs: number;
	  }
	| { readonly type: "ProvisionDestination"; readonly destination: BackendRef }
	| {
			readonly type: "DeployCodeAndConfig";
			readonly configKeys: readonly string[];
	  }
	| { readonly type: "QuiesceSource"; readonly fenceToken: string }
	| {
			readonly type: "ExportSource";
			readonly artifactRef: string;
			readonly documentCount: number;
			readonly fileCount: number;
	  }
	| {
			readonly type: "ImportIntoDestination";
			readonly artifactRef: string;
			readonly ok: boolean;
			readonly reason?: string;
	  }
	| {
			readonly type: "VerifyDestination";
			readonly summary: VerificationSummary;
	  }
	| {
			readonly type: "CutoverConnector";
			readonly connectorId: string;
			readonly ok: boolean;
			readonly reason?: string;
	  }
	| { readonly type: "CloseRollbackWindow" }
	| { readonly type: "DestroySource" }
	| { readonly type: "Rollback"; readonly reason: string }
	| {
			readonly type: "Abort";
			readonly code: StrongClaimFailureCode;
			readonly message: string;
	  };

export type StrongClaimEvent =
	| {
			readonly type: "claim.Started";
			readonly claimId: string;
			readonly sourceBackendId: string;
			readonly sourceHostingFormId: ConvexHostingFormId;
			readonly compromisedAuthorityRefs: readonly string[];
			readonly rollbackWindowMs: number;
	  }
	| {
			readonly type: "claim.DestinationProvisioned";
			readonly destinationBackendId: string;
			readonly destinationUrl: string;
			readonly destinationAuthorityRef: string;
			readonly hostingFormId: ConvexHostingFormId;
	  }
	| {
			readonly type: "claim.CodeDeployed";
			readonly destinationBackendId: string;
			readonly configKeys: readonly string[];
	  }
	| { readonly type: "claim.SourceFenced"; readonly fenceToken: string }
	| {
			readonly type: "claim.Exported";
			readonly artifactRef: string;
			readonly documentCount: number;
			readonly fileCount: number;
	  }
	| { readonly type: "claim.Imported"; readonly artifactRef: string }
	| { readonly type: "claim.ImportFailed"; readonly reason: string }
	| {
			readonly type: "claim.Verified";
			readonly summary: VerificationSummary;
	  }
	| {
			readonly type: "claim.VerificationFailed";
			readonly failedChecks: readonly VerificationCheckKey[];
	  }
	| {
			readonly type: "claim.CutoverCompleted";
			readonly connectorId: string;
			readonly rollbackWindowMs: number;
	  }
	| { readonly type: "claim.CutoverFailed"; readonly reason: string }
	| { readonly type: "claim.RollbackWindowClosed" }
	| { readonly type: "claim.RolledBack"; readonly reason: string }
	| {
			readonly type: "claim.SourceDestroyed";
			readonly destroyedBackendId: string;
			readonly destroyedAuthorityRefs: readonly string[];
	  }
	| {
			readonly type: "claim.Completed";
			readonly destinationBackendId: string;
	  }
	| {
			readonly type: "claim.Failed";
			readonly code: StrongClaimFailureCode;
			readonly message: string;
	  };

export type StrongClaimEventType = StrongClaimEvent["type"];

export type StrongClaimDecision =
	| { readonly ok: true; readonly events: readonly StrongClaimEvent[] }
	| {
			readonly ok: false;
			readonly rejection: {
				readonly code: StrongClaimRejectionCode;
				readonly message: string;
			};
	  };

// ---------------------------------------------------------------------------
// Pure state machine
// ---------------------------------------------------------------------------

const TERMINAL_PHASES: readonly StrongClaimPhase[] = ["claimed", "failed"];

export function isTerminal(state: StrongClaimState): boolean {
	return TERMINAL_PHASES.includes(state.phase);
}

export function initialStrongClaimState(claimId: string): StrongClaimState {
	return Object.freeze({
		schema: STRONG_CLAIM_SCHEMA,
		claimId,
		phase: "idle",
		source: null,
		destination: null,
		authoritative: "source",
		sourceWritable: true,
		compromisedAuthorityRefs: Object.freeze([]),
		verification: null,
		cutoverDone: false,
		connectorId: null,
		rollbackWindowMs: 0,
		rollbackWindowClosed: false,
		sourceDestroyed: false,
		claimComplete: false,
		failure: null,
	});
}

function next(
	state: StrongClaimState,
	patch: Partial<StrongClaimState>,
): StrongClaimState {
	return Object.freeze({ ...state, ...patch });
}

function fail(
	state: StrongClaimState,
	failure: StrongClaimFailure,
): StrongClaimState {
	// A failure NEVER leaves the destination authoritative and NEVER reports a
	// completed claim. The source keeps the crown until a cutover succeeds.
	return next(state, {
		phase: "failed",
		failure,
		claimComplete: false,
		authoritative: state.cutoverDone ? state.authoritative : "source",
	});
}

/** Pure fold. Unknown-for-this-phase events are ignored rather than thrown. */
export function reduceStrongClaim(
	state: StrongClaimState,
	event: StrongClaimEvent,
): StrongClaimState {
	switch (event.type) {
		case "claim.Started":
			return next(state, {
				phase: "temporary-backend",
				compromisedAuthorityRefs: Object.freeze([
					...event.compromisedAuthorityRefs,
				]),
				rollbackWindowMs: event.rollbackWindowMs,
				authoritative: "source",
				sourceWritable: true,
			});
		case "claim.DestinationProvisioned":
			return next(state, { phase: "destination-ready" });
		case "claim.CodeDeployed":
			return next(state, { phase: "code-deployed" });
		case "claim.SourceFenced":
			return next(state, { phase: "source-fenced", sourceWritable: false });
		case "claim.Exported":
			return next(state, { phase: "exported" });
		case "claim.Imported":
			return next(state, { phase: "imported" });
		case "claim.ImportFailed":
			return fail(state, {
				code: "import-failed",
				message: event.reason,
			});
		case "claim.Verified":
			return next(state, { phase: "verified", verification: event.summary });
		case "claim.VerificationFailed":
			return fail(state, {
				code: "verification-failed",
				message: `verification checks failed: ${event.failedChecks.join(", ")}`,
			});
		case "claim.CutoverCompleted":
			return next(state, {
				phase: "rollback-window-open",
				authoritative: "destination",
				cutoverDone: true,
				connectorId: event.connectorId,
				rollbackWindowMs: event.rollbackWindowMs,
				rollbackWindowClosed: false,
			});
		case "claim.CutoverFailed":
			return fail(state, { code: "cutover-failed", message: event.reason });
		case "claim.RollbackWindowClosed":
			return next(state, {
				phase: "rollback-window-closed",
				rollbackWindowClosed: true,
			});
		case "claim.RolledBack":
			return next(
				fail(next(state, { cutoverDone: false, authoritative: "source" }), {
					code: "rolled-back",
					message: event.reason,
				}),
				{ sourceWritable: true, rollbackWindowClosed: false },
			);
		case "claim.SourceDestroyed":
			return next(state, { phase: "source-destroyed", sourceDestroyed: true });
		case "claim.Completed":
			// Defense in depth: a recorded failure can never become a claim.
			if (state.failure !== null) return state;
			return next(state, { phase: "claimed", claimComplete: true });
		case "claim.Failed":
			return fail(state, { code: event.code, message: event.message });
		default:
			return state;
	}
}

export function reduceStrongClaimAll(
	state: StrongClaimState,
	events: readonly StrongClaimEvent[],
): StrongClaimState {
	return events.reduce(reduceStrongClaim, state);
}

function reject(
	code: StrongClaimRejectionCode,
	message: string,
): StrongClaimDecision {
	return { ok: false, rejection: { code, message } };
}

function accept(...events: StrongClaimEvent[]): StrongClaimDecision {
	for (const event of events) {
		assertNoAuthorityMaterial(event, `event ${event.type}`);
	}
	return { ok: true, events: Object.freeze([...events]) };
}

/**
 * The whole ordering contract of the saga. Pure: no clocks, no I/O, no
 * randomness — the same (state, command) always yields the same decision.
 */
export function decideStrongClaim(
	state: StrongClaimState,
	command: StrongClaimCommand,
): StrongClaimDecision {
	if (isTerminal(state) && command.type !== "Abort") {
		return reject(
			"terminal",
			`claim ${state.claimId} is ${state.phase}; ${command.type} is not accepted`,
		);
	}

	switch (command.type) {
		case "StartClaim": {
			if (state.phase !== "idle") {
				return reject("wrong-phase", "claim already started");
			}
			return accept({
				type: "claim.Started",
				claimId: state.claimId,
				sourceBackendId: command.source.backendId,
				sourceHostingFormId: command.source.hostingFormId,
				compromisedAuthorityRefs: [command.source.authorityRef],
				rollbackWindowMs: command.rollbackWindowMs,
			});
		}

		case "ProvisionDestination": {
			if (state.phase !== "temporary-backend") {
				return reject(
					"wrong-phase",
					`destination can only be provisioned from a temporary backend, not ${state.phase}`,
				);
			}
			if (
				state.compromisedAuthorityRefs.includes(
					command.destination.authorityRef,
				)
			) {
				return reject(
					"reused-compromised-authority",
					"the destination must carry a FRESH authority; a pre-claim authority proves nothing about exclusive ownership",
				);
			}
			if (
				state.source !== null &&
				state.source.backendId === command.destination.backendId
			) {
				return reject(
					"destination-not-fresh",
					"the destination must be a different backend from the temporary source",
				);
			}
			return accept({
				type: "claim.DestinationProvisioned",
				destinationBackendId: command.destination.backendId,
				destinationUrl: command.destination.url,
				destinationAuthorityRef: command.destination.authorityRef,
				hostingFormId: command.destination.hostingFormId,
			});
		}

		case "DeployCodeAndConfig": {
			if (state.phase !== "destination-ready") {
				return reject(
					"wrong-phase",
					`code/config deploy expects a ready destination, not ${state.phase}`,
				);
			}
			return accept({
				type: "claim.CodeDeployed",
				destinationBackendId: state.destination?.backendId ?? "",
				configKeys: command.configKeys,
			});
		}

		case "QuiesceSource": {
			if (state.phase !== "code-deployed") {
				return reject(
					"wrong-phase",
					`the source is fenced after code/config land, not from ${state.phase}`,
				);
			}
			return accept({
				type: "claim.SourceFenced",
				fenceToken: command.fenceToken,
			});
		}

		case "ExportSource": {
			if (state.phase !== "source-fenced" || state.sourceWritable) {
				return reject(
					"source-not-fenced",
					"export requires a quiesced source; an unfenced source can accept writes the export will miss",
				);
			}
			return accept({
				type: "claim.Exported",
				artifactRef: command.artifactRef,
				documentCount: command.documentCount,
				fileCount: command.fileCount,
			});
		}

		case "ImportIntoDestination": {
			if (state.phase !== "exported") {
				return reject(
					"wrong-phase",
					`import expects an export artifact, not phase ${state.phase}`,
				);
			}
			if (!command.ok) {
				return accept({
					type: "claim.ImportFailed",
					reason: command.reason ?? "import reported failure",
				});
			}
			return accept({
				type: "claim.Imported",
				artifactRef: command.artifactRef,
			});
		}

		case "VerifyDestination": {
			if (state.phase !== "imported") {
				return reject(
					"wrong-phase",
					`verification runs against an imported destination, not ${state.phase}`,
				);
			}
			const failures = verificationFailures(command.summary);
			if (failures.length > 0) {
				return accept({
					type: "claim.VerificationFailed",
					failedChecks: failures,
				});
			}
			return accept({ type: "claim.Verified", summary: command.summary });
		}

		case "CutoverConnector": {
			if (state.phase !== "verified") {
				return reject(
					"cutover-before-verification",
					"the connector only moves after every verification check passes",
				);
			}
			if (
				state.verification === null ||
				!verificationPassed(state.verification)
			) {
				return reject(
					"verification-incomplete",
					"no complete verification summary recorded for this claim",
				);
			}
			if (!command.ok) {
				return accept({
					type: "claim.CutoverFailed",
					reason: command.reason ?? "connector cutover reported failure",
				});
			}
			return accept({
				type: "claim.CutoverCompleted",
				connectorId: command.connectorId,
				rollbackWindowMs: state.rollbackWindowMs,
			});
		}

		case "CloseRollbackWindow": {
			if (state.phase !== "rollback-window-open") {
				return reject(
					"wrong-phase",
					`there is no open rollback window in phase ${state.phase}`,
				);
			}
			return accept({ type: "claim.RollbackWindowClosed" });
		}

		case "DestroySource": {
			if (!state.cutoverDone) {
				return reject(
					"destroy-before-cutover",
					"the temporary backend is the system of record until cutover succeeds",
				);
			}
			if (!state.rollbackWindowClosed) {
				return reject(
					"destroy-before-rollback-window-closed",
					"the rollback window must close before the source and its authority are destroyed",
				);
			}
			const destroyed: string[] = [...state.compromisedAuthorityRefs];
			return accept(
				{
					type: "claim.SourceDestroyed",
					destroyedBackendId: state.source?.backendId ?? "",
					destroyedAuthorityRefs: destroyed,
				},
				{
					type: "claim.Completed",
					destinationBackendId: state.destination?.backendId ?? "",
				},
			);
		}

		case "Rollback": {
			if (!state.cutoverDone) {
				return reject(
					"wrong-phase",
					"nothing to roll back: the connector has not moved",
				);
			}
			if (state.sourceDestroyed) {
				return reject(
					"wrong-phase",
					"the source is destroyed; rollback is no longer possible",
				);
			}
			return accept({ type: "claim.RolledBack", reason: command.reason });
		}

		case "Abort": {
			if (state.claimComplete) {
				return reject("terminal", "a completed claim cannot be aborted");
			}
			return accept({
				type: "claim.Failed",
				code: command.code,
				message: command.message,
			});
		}

		default:
			return reject("wrong-phase", "unknown command");
	}
}

/** decide + reduce in one step, keeping backend refs attached to the state. */
export function applyStrongClaim(
	state: StrongClaimState,
	command: StrongClaimCommand,
) {
	const decision = decideStrongClaim(state, command);
	if (!decision.ok) return { state, decision };

	let nextState = reduceStrongClaimAll(state, decision.events);
	if (command.type === "StartClaim") {
		nextState = next(nextState, { source: command.source });
	}
	if (
		command.type === "ProvisionDestination" &&
		decision.events.some((e) => e.type === "claim.DestinationProvisioned")
	) {
		nextState = next(nextState, { destination: command.destination });
	}
	return { state: nextState, decision };
}

/**
 * Can `authorityRef` open the destination backend? A pre-claim authority
 * (K0, or anything a temporary backend ever exposed) is always `false` —
 * that is the entire point of replacement over in-place upgrade.
 */
export function authorityCanAccessDestination(
	state: StrongClaimState,
	authorityRef: string,
): boolean {
	if (state.destination === null) return false;
	if (state.compromisedAuthorityRefs.includes(authorityRef)) return false;
	return state.destination.authorityRef === authorityRef;
}

// ---------------------------------------------------------------------------
// Effect ports — every side effect the saga needs, injected
// ---------------------------------------------------------------------------

export interface ProvisionDestinationInput {
	readonly claimId: string;
	readonly hostingFormId: ConvexHostingFormId;
	readonly source: BackendRef;
}

export interface DeployCodeInput {
	readonly claimId: string;
	readonly destination: BackendRef;
}

export interface QuiesceInput {
	readonly claimId: string;
	readonly source: BackendRef;
}

export interface ExportInput {
	readonly claimId: string;
	readonly source: BackendRef;
	readonly fenceToken: string;
}

export interface ExportArtifact {
	readonly artifactRef: string;
	readonly documentCount: number;
	readonly fileCount: number;
}

export interface ImportInput {
	readonly claimId: string;
	readonly destination: BackendRef;
	readonly artifact: ExportArtifact;
}

export interface ImportOutcome {
	readonly ok: boolean;
	readonly reason?: string;
}

export interface VerifyInput {
	readonly claimId: string;
	readonly source: BackendRef;
	readonly destination: BackendRef;
	readonly artifact: ExportArtifact;
}

export interface CutoverInput {
	readonly claimId: string;
	readonly destination: BackendRef;
}

export interface CutoverOutcome {
	readonly ok: boolean;
	readonly connectorId: string;
	readonly reason?: string;
}

export interface RollbackWindowInput {
	readonly claimId: string;
	readonly rollbackWindowMs: number;
}

export interface RollbackWindowOutcome {
	readonly rollback: boolean;
	readonly reason?: string;
}

export interface DestroyInput {
	readonly claimId: string;
	readonly source: BackendRef;
	readonly authorityRefs: readonly string[];
}

export interface DestroyOutcome {
	readonly ok: boolean;
	readonly destroyedBackendId: string;
	readonly reason?: string;
}

/** Every network/process effect the strong claim needs. No defaults. */
export interface ConvexMigrationDriver {
	provisionDestination(input: ProvisionDestinationInput): Promise<BackendRef>;
	deployCodeAndConfig(
		input: DeployCodeInput,
	): Promise<{ readonly configKeys: readonly string[] }>;
	quiesceSource(input: QuiesceInput): Promise<{ readonly fenceToken: string }>;
	export(input: ExportInput): Promise<ExportArtifact>;
	import(input: ImportInput): Promise<ImportOutcome>;
	verify(input: VerifyInput): Promise<VerificationSummary>;
	cutover(input: CutoverInput): Promise<CutoverOutcome>;
	awaitRollbackWindow(
		input: RollbackWindowInput,
	): Promise<RollbackWindowOutcome>;
	destroy(input: DestroyInput): Promise<DestroyOutcome>;
}

// ---------------------------------------------------------------------------
// Receipt + executor
// ---------------------------------------------------------------------------

export interface StrongClaimReceipt {
	readonly schema: typeof STRONG_CLAIM_RECEIPT_SCHEMA;
	readonly claimId: string;
	readonly claimComplete: boolean;
	readonly phase: StrongClaimPhase;
	readonly destinationBackendId: string | null;
	readonly destinationUrl: string | null;
	readonly destinationAuthorityRef: string | null;
	readonly retiredAuthorityRefs: readonly string[];
	readonly sourceDestroyed: boolean;
	readonly verification: VerificationSummary | null;
	readonly failure: StrongClaimFailure | null;
	readonly eventTypes: readonly StrongClaimEventType[];
}

export function strongClaimReceipt(
	state: StrongClaimState,
	events: readonly StrongClaimEvent[],
): StrongClaimReceipt {
	const receipt: StrongClaimReceipt = Object.freeze({
		schema: STRONG_CLAIM_RECEIPT_SCHEMA,
		claimId: state.claimId,
		claimComplete: state.claimComplete,
		phase: state.phase,
		destinationBackendId: state.destination?.backendId ?? null,
		destinationUrl: state.destination?.url ?? null,
		destinationAuthorityRef: state.destination?.authorityRef ?? null,
		retiredAuthorityRefs: Object.freeze([...state.compromisedAuthorityRefs]),
		sourceDestroyed: state.sourceDestroyed,
		verification: state.verification,
		failure: state.failure,
		eventTypes: Object.freeze(events.map((event) => event.type)),
	});
	assertNoAuthorityMaterial(receipt, "a strong-claim receipt");
	return receipt;
}

export interface RunStrongClaimInput {
	readonly claimId: string;
	readonly source: BackendRef;
	readonly destinationHostingFormId: ConvexHostingFormId;
	readonly rollbackWindowMs: number;
	readonly driver: ConvexMigrationDriver;
}

export interface StrongClaimRunResult {
	readonly ok: boolean;
	readonly state: StrongClaimState;
	readonly events: readonly StrongClaimEvent[];
	readonly receipt: StrongClaimReceipt;
}

/**
 * Drives the pure machine through the injected driver. Every guard still
 * lives in `decideStrongClaim`; this function only sequences effects and
 * converts a thrown driver error into an `Abort`.
 */
export async function runStrongClaim(
	input: RunStrongClaimInput,
): Promise<StrongClaimRunResult> {
	const events: StrongClaimEvent[] = [];
	let state = initialStrongClaimState(input.claimId);

	const send = (command: StrongClaimCommand): StrongClaimDecision => {
		const applied = applyStrongClaim(state, command);
		state = applied.state;
		if (applied.decision.ok) events.push(...applied.decision.events);
		return applied.decision;
	};

	const abort = (
		code: StrongClaimFailureCode,
		message: string,
	): StrongClaimRunResult => {
		send({ type: "Abort", code, message });
		return finish();
	};

	const finish = (): StrongClaimRunResult => ({
		ok: state.claimComplete,
		state,
		events: Object.freeze([...events]),
		receipt: strongClaimReceipt(state, events),
	});

	const started = send({
		type: "StartClaim",
		source: input.source,
		rollbackWindowMs: input.rollbackWindowMs,
	});
	if (!started.ok) return finish();

	try {
		const destination = await input.driver.provisionDestination({
			claimId: input.claimId,
			hostingFormId: input.destinationHostingFormId,
			source: input.source,
		});
		if (!send({ type: "ProvisionDestination", destination }).ok) {
			return abort(
				"driver-error",
				"driver returned a destination the saga refused",
			);
		}

		const deployed = await input.driver.deployCodeAndConfig({
			claimId: input.claimId,
			destination,
		});
		if (
			!send({ type: "DeployCodeAndConfig", configKeys: deployed.configKeys }).ok
		) {
			return abort("driver-error", "code/config deploy rejected");
		}

		const fence = await input.driver.quiesceSource({
			claimId: input.claimId,
			source: input.source,
		});
		if (!send({ type: "QuiesceSource", fenceToken: fence.fenceToken }).ok) {
			return abort("driver-error", "source fence rejected");
		}

		const artifact = await input.driver.export({
			claimId: input.claimId,
			source: input.source,
			fenceToken: fence.fenceToken,
		});
		if (
			!send({
				type: "ExportSource",
				artifactRef: artifact.artifactRef,
				documentCount: artifact.documentCount,
				fileCount: artifact.fileCount,
			}).ok
		) {
			return abort("driver-error", "export rejected");
		}

		const imported = await input.driver.import({
			claimId: input.claimId,
			destination,
			artifact,
		});
		send({
			type: "ImportIntoDestination",
			artifactRef: artifact.artifactRef,
			ok: imported.ok,
			...(imported.reason === undefined
				? undefined
				: { reason: imported.reason }),
		});
		if (state.failure !== null) return finish();

		const summary = await input.driver.verify({
			claimId: input.claimId,
			source: input.source,
			destination,
			artifact,
		});
		send({ type: "VerifyDestination", summary });
		if (state.failure !== null) return finish();

		const cutover = await input.driver.cutover({
			claimId: input.claimId,
			destination,
		});
		send({
			type: "CutoverConnector",
			connectorId: cutover.connectorId,
			ok: cutover.ok,
			...(cutover.reason === undefined
				? undefined
				: { reason: cutover.reason }),
		});
		if (state.failure !== null) return finish();

		const rollbackWindow = await input.driver.awaitRollbackWindow({
			claimId: input.claimId,
			rollbackWindowMs: state.rollbackWindowMs,
		});
		if (rollbackWindow.rollback) {
			send({
				type: "Rollback",
				reason: rollbackWindow.reason ?? "rollback requested during the window",
			});
			return finish();
		}

		if (!send({ type: "CloseRollbackWindow" }).ok) {
			return abort("driver-error", "rollback window could not be closed");
		}

		const destroyed = await input.driver.destroy({
			claimId: input.claimId,
			source: input.source,
			authorityRefs: state.compromisedAuthorityRefs,
		});
		if (!destroyed.ok) {
			return abort(
				"driver-error",
				destroyed.reason ?? "source destruction failed",
			);
		}
		if (!send({ type: "DestroySource" }).ok) {
			return abort("driver-error", "source destruction rejected");
		}

		return finish();
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "unknown driver failure";
		return abort("driver-error", message);
	}
}
