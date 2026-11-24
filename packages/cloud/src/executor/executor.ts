import { createHash } from "node:crypto";
import { isJsonString, type JsonObject } from "../json.js";
import type { ResourcePlan } from "../plan-types.js";

// The Executor (control-plane.md "Executor sandbox model"): the sandboxed apply
// step. IaC apply runs untrusted-ish provider code, so it is isolated — no
// ambient cloud creds, a short-lived capability-scoped token injected per exec,
// and egress bounded to an allowlist. Full Firecracker isolation is out of scope
// (S2-03b models the *sandbox contract*); this in-process implementation is the
// CI-friendly backend that enforces the same invariants deterministically.
//
// The Executor drives an injected IacProvider (adapter boundary — the concrete
// pulumi/terraform adapter is never imported by this kernel; it is passed in),
// runs `preview` then `apply`, streams exec.Output/exec.Diff, and finishes with a
// terminal exec.Succeeded/exec.Failed.

// Parse, don't validate: the domain-view types below narrow the protobuf wire
// records in data-models/cloud.proto (IacProgram, ScopedCredential, Exec*).

// domain-view: parsed IacProgram; wire form is IacProgram in data-models/cloud.proto.
export interface IacProgram {
	programId: string;
	deploymentId: string;
	resourceId: string;
	provider: string;
	driver: string;
	action: "preview" | "apply" | "destroy";
	stackName: string;
	operationGeneration?: string;
	/** The declaration the provider must realize, when supplied by the orchestrator. */
	resource?: ResourcePlan;
}

export type IacOutputs = Record<string, string>;

// domain-view: parsed ScopedCredential; wire form is ScopedCredential in data-models/cloud.proto.
export interface ScopedCredential {
	id: string;
	scope: string;
	ttlSeconds: number;
	readonly ambient: false;
}

// The IacProvider *mechanism* port (control-plane.md "IacProvider"). Concrete
// adapters (pulumi/terraform/crossplane) implement it; the kernel only depends
// on this shape and receives an implementation by injection.
export interface IacDiff {
	summary: string;
	changes: number;
}

export interface IacDriftReport {
	drift: boolean;
	observed: IacOutputs;
}

export interface IacProvider {
	readonly id: string;
	preview(program: IacProgram): Promise<IacDiff>;
	apply(program: IacProgram): Promise<IacOutputs>;
	destroy(program: IacProgram): Promise<void>;
	refresh(program: IacProgram): Promise<IacDriftReport>;
}

export type ExecEventType =
	| "exec.Started"
	| "exec.Output"
	| "exec.Diff"
	| "exec.Succeeded"
	| "exec.Failed";

export interface ExecEvent {
	type: ExecEventType;
	execId: string;
	seq: number;
	data: JsonObject;
}

export interface ExecSandboxContext {
	execId: string;
	backend: "firecracker" | "container" | "in-process";
	// Invariant proven by the sandbox: the run held no ambient cloud creds; the
	// only credential was the injected scoped token.
	readonly ambientCredentials: false;
	credentialId: string;
	allowedEgress: string[];
}

export interface ExecResultSucceeded {
	status: "succeeded";
	execId: string;
	events: ExecEvent[];
	outputs: IacOutputs;
	diff: IacDiff;
	sandbox: ExecSandboxContext;
}

interface ExecResultFailureBase {
	status: "failed";
	execId: string;
	events: ExecEvent[];
	reason: string;
	sandbox: ExecSandboxContext;
}

export type ExecResultFailed = ExecResultFailureBase &
	(
		| {
				classification: "retryable" | "fatal";
				requiresReconciliation?: false;
				reservationId?: never;
				reconciliationOperation?: never;
		  }
		| {
				classification: "fatal";
				requiresReconciliation: true;
				reservationId?: string;
				reconciliationOperation: IacProgram["action"];
		  }
	);

export type ExecResult = ExecResultSucceeded | ExecResultFailed;

interface ReconciliationMetadata {
	requiresReconciliation: true;
	reconciliationOperation: IacProgram["action"];
	reservationId?: string;
}

interface ProviderFailure {
	reason: string;
	requiresReconciliation: boolean;
	provesNotStarted: boolean;
	reservationId?: string;
}

export interface ExecRunOptions {
	// An explicitly-injected environment snapshot the sandbox is allowed to see.
	// The Executor NEVER reads process.env — proving no ambient-credential access.
	// A conformance test passes ambient cred keys here and asserts a fatal refusal.
	ambientEnv?: Record<string, string>;
	// Egress the program attempts, each matched against the allowlist.
	egressAttempts?: Array<{ target: string; channel?: "normal" | "covert" }>;
}

// The Executor port (S2-03a): typed interface `run(program, scopedCreds) => …`.
export interface Executor {
	run(
		program: IacProgram,
		credential: ScopedCredential,
		options?: ExecRunOptions,
	): Promise<ExecResult>;
}

// Cloud-provider ambient credential env vars the sandbox must never carry
// (control-plane.md "no ambient cloud creds"). Presence in the injected env
// snapshot is a hard sandbox violation.
export const AMBIENT_CREDENTIAL_KEYS: readonly string[] = Object.freeze([
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GCP_SERVICE_ACCOUNT_KEY",
	"AZURE_CLIENT_SECRET",
	"PULUMI_ACCESS_TOKEN",
	"HCLOUD_TOKEN",
	"DIGITALOCEAN_TOKEN",
]);

export interface InProcessExecutorOptions {
	iac: IacProvider;
	allowedEgress?: string[];
	now?: () => string;
}

type HashRefInput = IacProgram | Readonly<Record<string, string>>;

function hashRef(value: HashRefInput): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function iacExecutionId(program: IacProgram): string {
	const digest =
		program.operationGeneration === undefined
			? hashRef({ programId: program.programId, action: program.action })
			: hashRef({
					programId: program.programId,
					action: program.action,
					operationGeneration: program.operationGeneration,
				});
	return `exec-${program.action}-${program.operationGeneration === undefined ? digest.slice(7, 19) : digest.slice(7)}`;
}

// The sandboxed, in-process Executor. It scopes creds per-exec (only the injected
// token), asserts no ambient cloud creds, bounds egress to the allowlist, runs
// preview then apply against the injected IacProvider, and streams exec.* events.
export function createInProcessExecutor(
	options: InProcessExecutorOptions,
): Executor {
	const iac = options.iac;
	const allowedEgress = [...(options.allowedEgress ?? [])];
	const allowed = new Set(allowedEgress);

	return {
		async run(program, credential, runOptions = {}) {
			const execId = iacExecutionId(program);
			const events: ExecEvent[] = [];
			let seq = 0;
			const push = (type: ExecEventType, data: JsonObject): void => {
				seq += 1;
				events.push({ type, execId, seq, data });
			};

			const sandbox: ExecSandboxContext = {
				execId,
				backend: "in-process",
				ambientCredentials: false,
				credentialId: credential.id,
				allowedEgress: [...allowedEgress],
			};

			push("exec.Started", {
				resourceId: program.resourceId,
				programHash: hashRef(program),
			});

			// --- S2-03b sandbox hardening: no ambient credentials ----------------
			// The only credential permitted is the injected scoped token. Any
			// ambient cloud cred visible to the run is a fatal sandbox violation.
			if (credential.ambient !== false) {
				return fail(
					events,
					push,
					sandbox,
					"fatal",
					"sandbox.ambient_credentials: injected credential is not scoped",
				);
			}
			const ambientEnv = runOptions.ambientEnv ?? {};
			const leaked = AMBIENT_CREDENTIAL_KEYS.filter(
				(key) => isJsonString(ambientEnv[key]) && ambientEnv[key].length > 0,
			);
			if (leaked.length > 0) {
				return fail(
					events,
					push,
					sandbox,
					"fatal",
					`sandbox.ambient_credentials: ambient cloud credentials present (${leaked.sort().join(", ")}); creds must arrive only via the scoped token`,
				);
			}

			push("exec.Output", {
				stream: "stdout",
				line: `sandbox=in-process driver=${program.driver} action=${program.action} ambientCredentials=false scope=${credential.scope}`,
			});

			// --- S2-03b sandbox hardening: bounded egress ------------------------
			for (const attempt of runOptions.egressAttempts ?? []) {
				if (!allowed.has(attempt.target)) {
					push("exec.Output", {
						stream: "stderr",
						line: `egress denied: ${attempt.target}`,
					});
					return fail(
						events,
						push,
						sandbox,
						"fatal",
						`sandbox.egress_scope: undeclared egress denied: ${attempt.target}`,
					);
				}
			}

			let stage: "preview" | "apply" | "destroy" = "preview";
			let mutationStarted = false;
			try {
				const diff = await iac.preview(program);
				push("exec.Diff", { summary: diff.summary, changes: diff.changes });
				if (program.action === "preview") {
					push("exec.Succeeded", { outputsHash: hashRef({}) });
					return {
						status: "succeeded",
						execId,
						events,
						outputs: {},
						diff,
						sandbox,
					};
				}

				if (program.action === "destroy") {
					stage = "destroy";
					mutationStarted = true;
					await iac.destroy(program);
					push("exec.Succeeded", {
						outputsHash: hashRef({ destroyed: program.resourceId }),
					});
					return {
						status: "succeeded",
						execId,
						events,
						outputs: {},
						diff,
						sandbox,
					};
				}

				stage = "apply";
				mutationStarted = true;
				const outputs = await iac.apply(program);
				push("exec.Succeeded", { outputsHash: hashRef(outputs) });
				return { status: "succeeded", execId, events, outputs, diff, sandbox };
			} catch (error) {
				const failure = readProviderFailure(error);
				const uncertain =
					failure.requiresReconciliation ||
					failure.reservationId !== undefined ||
					(mutationStarted && !failure.provesNotStarted);
				const reconciliation: ReconciliationMetadata = {
					requiresReconciliation: true,
					reconciliationOperation: program.action,
				};
				if (failure.reservationId !== undefined)
					reconciliation.reservationId = failure.reservationId;
				return fail(
					events,
					push,
					sandbox,
					uncertain ? "fatal" : "retryable",
					`executor.${stage}_failed: ${failure.reason}`,
					uncertain ? reconciliation : undefined,
				);
			}
		},
	};
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: provider-thrown values cross an untrusted boundary and may contain throwing accessors. */
function readProviderFailure(error: unknown): ProviderFailure {
	try {
		const reason = (
			error instanceof Error ? error.message : String(error)
		).slice(0, 4096);
		const requiresReconciliation =
			typeof error === "object" &&
			error !== null &&
			"requiresReconciliation" in error &&
			error.requiresReconciliation === true;
		const provesNotStarted =
			typeof error === "object" &&
			error !== null &&
			Object.getOwnPropertyDescriptor(error, "requiresReconciliation")
				?.value === false &&
			Object.getOwnPropertyDescriptor(error, "executionOutcome")?.value ===
				"not-started";
		const candidateId =
			typeof error === "object" && error !== null && "reservationId" in error
				? error.reservationId
				: undefined;
		if (
			typeof candidateId === "string" &&
			candidateId.length > 0 &&
			candidateId.length <= 204 &&
			candidateId.trim() === candidateId &&
			!/[\p{Cc}]/u.test(candidateId)
		) {
			return {
				reason,
				requiresReconciliation,
				provesNotStarted,
				reservationId: candidateId,
			};
		}
		return { reason, requiresReconciliation, provesNotStarted };
	} catch {
		return {
			reason: "uninspectable provider failure",
			requiresReconciliation: true,
			provesNotStarted: false,
		};
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

function fail(
	events: ExecEvent[],
	push: (type: ExecEventType, data: JsonObject) => void,
	sandbox: ExecSandboxContext,
	classification: "retryable" | "fatal",
	reason: string,
	reconciliation?: ReconciliationMetadata,
): ExecResultFailed {
	if (reconciliation !== undefined) {
		push("exec.Failed", { classification: "fatal", reason, ...reconciliation });
		return {
			status: "failed",
			execId: sandbox.execId,
			events,
			classification: "fatal",
			reason,
			...reconciliation,
			sandbox,
		};
	}
	push("exec.Failed", { classification, reason });
	return {
		status: "failed",
		execId: sandbox.execId,
		events,
		classification,
		reason,
		sandbox,
	};
}

// The Identity token broker stub (control-plane.md: "The Orchestrator requests a
// short-lived, capability-scoped token from Identity for that specific resource +
// provider + action, injected into the microVM at start, expired at end"). Full
// Identity brokering is S3; this issues deterministic dev-mode scoped tokens.
export interface CredentialBroker {
	issue(request: { scope: string; ttlSeconds?: number }): ScopedCredential;
	revoke(credential: ScopedCredential): void;
	activeCount(): number;
}

export function credentialScope(input: {
	tenant: string;
	resourceId: string;
	driver: string;
	action: string;
}): string {
	return `tenant:${input.tenant}/resource:${input.resourceId}/job:${input.driver}/action:${input.action}`;
}

export function createInProcessCredentialBroker(): CredentialBroker {
	const active = new Map<string, ScopedCredential>();
	return {
		issue({ scope, ttlSeconds = 300 }) {
			if (!scope) throw new TypeError("credential scope is required");
			const id = `scoped-${createHash("sha256").update(scope).digest("hex").slice(0, 12)}`;
			const credential: ScopedCredential = {
				id,
				scope,
				ttlSeconds,
				ambient: false,
			};
			active.set(id, credential);
			return credential;
		},
		revoke(credential) {
			if (credential?.id) active.delete(credential.id);
		},
		activeCount() {
			return active.size;
		},
	};
}
