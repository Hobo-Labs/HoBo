export type StageGateCheckKind =
	| "lint"
	| "guard"
	| "schema"
	| "contract"
	| "conformance"
	| "build"
	| "sign"
	| "verify"
	| "acceptance";

export interface StageGateCheck {
	readonly checkId: string;
	readonly command: readonly string[];
	readonly kind: StageGateCheckKind;
	/**
	 * Check ids that must have passed earlier in the same run. When one did
	 * not, this check is recorded `skipped` and never started: its input (a
	 * fresh plan, the report of this run) does not exist. When they all
	 * passed, the check is handed their evidence as one JSON object keyed by
	 * check id in HOBO_STAGE_GATE_REQUIRED_EVIDENCE (gate-status.ts).
	 */
	readonly requires?: readonly string[];
	/**
	 * Exit codes that mean the check could not be carried out (ai-bdd's 3,
	 * infrastructure): recorded `not_run`, never `failed` or `passed`. Unset,
	 * every non-zero exit is a failure, as for the S0 gate.
	 */
	readonly notRunExitCodes?: readonly number[];
	/**
	 * How long the check may run. One that outlives it is stopped with
	 * SIGTERM and recorded `not_run` (exit code 3): it said nothing about what
	 * it checks. A function is given the env the runner runs the check with
	 * (RunStageGateOptions.env), so a bound read from that env is the one the
	 * check sees. Unset, a check runs as long as it takes.
	 */
	readonly timeoutMs?: number | ((env: NodeJS.ProcessEnv) => number);
}

export interface StageGateDefinition {
	readonly gateId: string;
	readonly checks: readonly StageGateCheck[];
}

/** `not_run`: the check could not be carried out, so it says nothing about what it checks (ADR-0172). */
export type CheckStatus = "passed" | "failed" | "skipped" | "not_run";
/** `not_run`: no check failed, and at least one could not be carried out. */
export type RecordStatus = "passed" | "failed" | "skipped" | "not_run";

/** What a check left behind as evidence: string fields only (data-models/stage_gate_record.proto `map<string, string> evidence`). */
export interface CheckEvidence {
	readonly [key: string]: string;
}

// domain-view: readonly parse target narrowed to the CheckStatus union; data-models/stage_gate_record.proto CheckResult is its wire form.
export interface CheckResult {
	readonly checkId: string;
	readonly command: readonly string[];
	readonly exitCode: number;
	readonly status: CheckStatus;
	readonly evidence: CheckEvidence;
}

// domain-view: readonly parse target; data-models/stage_gate_record.proto ComponentArtifact is its wire form.
export interface ComponentArtifact {
	readonly digestSha256: string;
	readonly byteLength: number;
	readonly mediaType: string;
}

// domain-view: readonly parse target; data-models/stage_gate_record.proto SignatureEvidence is its wire form.
export interface SignatureEvidence {
	readonly verified: boolean;
	readonly signerIdentity: string;
	readonly provenanceTier: string;
	readonly conformanceReportDigest: string;
}

// domain-view: readonly parse-produced aggregate narrowed to the RecordStatus union; data-models/stage_gate_record.proto StageGateRecord is its wire form.
export interface StageGateRecord {
	readonly gateId: string;
	readonly status: RecordStatus;
	readonly repoCommit: string;
	readonly ciRunUrl: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly checks: readonly CheckResult[];
	readonly artifact: ComponentArtifact;
	readonly signature: SignatureEvidence;
}

/**
 * A record as JSON, in the snake_case field names of
 * data-models/stage_gate_record.proto: what `serializeStageGateRecord` returns
 * and the record file holds. An object type (not an interface) so it is a
 * JSON value as it stands and goes back through `parseStageGateRecord`.
 */
export type StageGateRecordJson = {
	readonly gate_id: string;
	readonly status: RecordStatus;
	readonly repo_commit: string;
	readonly ci_run_url: string;
	readonly started_at: string;
	readonly finished_at: string;
	readonly checks: readonly {
		readonly check_id: string;
		readonly command: readonly string[];
		readonly exit_code: number;
		readonly status: CheckStatus;
		readonly evidence: CheckEvidence;
	}[];
	readonly artifact: {
		readonly digest_sha256: string;
		readonly byte_length: number;
		readonly media_type: string;
	};
	readonly signature: {
		readonly verified: boolean;
		readonly signer_identity: string;
		readonly provenance_tier: string;
		readonly conformance_report_digest: string;
	};
};

export class StageGateParseError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`stage-gate record parse failed: ${issues.join("; ")}`);
		this.name = "StageGateParseError";
		this.issues = issues;
	}
}

export interface RunStageGateOptions {
	readonly cwd?: string;
	readonly outFile?: string;
	readonly ciRunUrl?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface RunStageGateResult {
	readonly record: StageGateRecord;
	readonly exitCode: number;
}
