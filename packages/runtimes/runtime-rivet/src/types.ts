export type RivetRuntimeMode = "local" | "runner" | "serverless" | "managed";

export type RivetInboxStatus =
	| "persisted"
	| "processing"
	| "committed"
	| "completed"
	| "failed-retryable"
	| "failed-terminal";

export type RivetFidelity = "local-sqlite" | "rivetkit" | "unsupported";

// domain-view: parse-don't-validate parsed/derived type; wire form is RivetRuntimeConfig in data-models/runtime_rivet.proto.
export interface RivetRuntimeConfig {
	readonly campId: string;
	readonly tenantId: string;
	readonly mode: RivetRuntimeMode;
	readonly engineImageDigest?: string;
	readonly endpointSecretRef?: string;
	readonly adminTokenSecretRef?: string;
	readonly svidBindingRef: string;
}

// domain-view: parse-don't-validate parsed/derived type; wire form is RivetDoctorReport in data-models/runtime_rivet.proto.
export interface RivetDoctorReport {
	readonly mode: RivetRuntimeMode;
	readonly rivetkitAvailable: boolean;
	readonly journalReady: boolean;
	readonly fidelity: RivetFidelity;
	readonly notes: readonly string[];
	readonly remediation: readonly string[];
}

export interface JournalFact {
	readonly type: string;
	readonly eventId: string;
	readonly payload: Uint8Array;
	readonly metadataJson: string;
	readonly causationId?: string;
	readonly correlationId?: string;
	readonly tenant: string;
	readonly project?: string;
	readonly lane?: string;
}

export interface InboxCommand {
	readonly commandId: string;
	readonly digest: string;
	readonly commandType: string;
	readonly payloadJson: string;
	readonly expectedRevision: number;
	readonly status: RivetInboxStatus;
	readonly attempt: number;
	readonly resultJson?: string;
}

export interface AcceptCommandInput {
	readonly streamId: string;
	readonly commandId: string;
	readonly digest: string;
	readonly commandType: string;
	readonly payloadJson: string;
	readonly expectedRevision: number;
}

export interface AcceptCommandResult {
	readonly status: RivetInboxStatus;
	readonly duplicate: boolean;
	readonly resultJson?: string;
}

export class RivetJournalError extends Error {
	readonly code:
		| "STALE_REVISION"
		| "DIGEST_MISMATCH"
		| "INBOX_CONFLICT"
		| "PARSE";

	constructor(code: RivetJournalError["code"], message: string) {
		super(message);
		this.name = "RivetJournalError";
		this.code = code;
	}
}
