import { createHash } from "node:crypto";
import { isJsonString, type JsonObject } from "../json.js";

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

export interface ExecResultFailed {
	status: "failed";
	execId: string;
	events: ExecEvent[];
	classification: "retryable" | "fatal";
	reason: string;
	sandbox: ExecSandboxContext;
}

export type ExecResult = ExecResultSucceeded | ExecResultFailed;

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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- hashes JSON serialization of provider program refs
function hashRef(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
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
			const execId = `exec-${program.action}-${hashRef({ programId: program.programId, action: program.action }).slice(7, 19)}`;
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

			try {
				// preview then apply, inside the sandbox (control-plane.md resolution
				// pipeline step 4: "IaC adapter runs preview then apply … with scoped creds").
				const diff = await iac.preview(program);
				push("exec.Diff", { summary: diff.summary, changes: diff.changes });

				if (program.action === "destroy") {
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

				const outputs = await iac.apply(program);
				push("exec.Succeeded", { outputsHash: hashRef(outputs) });
				return { status: "succeeded", execId, events, outputs, diff, sandbox };
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				// Provider/apply errors are classified retryable by default; a caller
				// (the ResourceActor) decides whether the failure crosses the no-go
				// threshold (control-plane.md reconcile loop step 4).
				return fail(
					events,
					push,
					sandbox,
					"retryable",
					`executor.apply_failed: ${reason}`,
				);
			}
		},
	};
}

function fail(
	events: ExecEvent[],
	push: (type: ExecEventType, data: JsonObject) => void,
	sandbox: ExecSandboxContext,
	classification: "retryable" | "fatal",
	reason: string,
): ExecResultFailed {
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
