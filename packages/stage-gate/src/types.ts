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
	readonly requires?: readonly string[];
	readonly notRunExitCodes?: readonly number[];
	readonly timeoutMs?: number | ((env: NodeJS.ProcessEnv) => number);
}

export interface StageGateDefinition {
	readonly gateId: string;
	readonly checks: readonly StageGateCheck[];
}

export type CheckStatus = "passed" | "failed" | "skipped" | "not_run";
export type RecordStatus = "passed" | "failed" | "skipped" | "not_run";

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
