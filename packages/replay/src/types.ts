/**
 * Session Replay domain types.
 * Parse, don't validate: wire payloads become derived domain types via parse* constructors.
 * Wire shapes live in data-models/replay.proto + replay.cue (ADR-0137).
 */

// public-contract: wire schema / event catalog constants.
export const REPLAY_SCHEMA_VERSION = "hobo.replay/v1" as const;
export const REPLAY_PRIVACY_SCHEMA = "hobo.replay-privacy/v1" as const;
export const REPLAY_CORRELATION_SCHEMA = "hobo.replay-correlation/v1" as const;
export const REPLAY_CONTRACT_VERSION = "hobo.session-replay/v1" as const;

export type IsolationClass =
	| "local-dev"
	| "preview"
	| "development"
	| "staging"
	| "production"
	| "ephemeral";

export type SessionStatus = "recording" | "ended" | "retained" | "erased";

// domain-view: camelCase + branded hash + frozen arrays; wire form is PrivacyPolicy in replay.proto
export type PrivacyPolicy = Readonly<{
	schemaVersion: typeof REPLAY_PRIVACY_SCHEMA;
	maskInputs: boolean;
	maskPasswords: boolean;
	maskEmails: boolean;
	maskTel: boolean;
	maskSelectors: readonly string[];
	blockAttributes: readonly string[];
	captureNetwork: boolean;
	captureConsole: boolean;
	captureErrors: boolean;
}>;

// domain-view: PrincipalRef-safe correlation without free-text PII; wire form SessionCorrelation proto
export type SessionCorrelation = Readonly<{
	schemaVersion: typeof REPLAY_CORRELATION_SCHEMA;
	/** Continuous-identity PrincipalRef — never free-text email/name. */
	principalRef?: string;
	stationId: string;
	yardId?: string;
	campId?: string;
	trailId?: string;
	controlPlaneEventId?: string;
	errorId?: string;
	harnessFlagKeys: readonly string[];
	isolationClass: IsolationClass;
	tenant: string;
	env: string;
}>;

// domain-view: content-addressed chunk meta; wire form RecordingChunk proto
export type RecordingChunk = Readonly<{
	schemaVersion: typeof REPLAY_SCHEMA_VERSION;
	sessionId: string;
	seq: number;
	contentHash: `sha256:${string}`;
	byteSize: number;
	blobRef: string;
	createdAt: string;
}>;

// domain-view: projection snapshot for SessionIndex; wire form SessionRecord proto
export type SessionRecord = Readonly<{
	schemaVersion: typeof REPLAY_SCHEMA_VERSION;
	id: string;
	status: SessionStatus;
	startedAt: string;
	endedAt?: string;
	correlation: SessionCorrelation;
	privacy: PrivacyPolicy;
	chunkCount: number;
	totalBytes: number;
	summary?: string;
}>;

/** rrweb-compatible event envelope (type + data + timestamp). */
export type RrwebEvent = Readonly<{
	type: number;
	data: Readonly<Record<string, unknown>>;
	timestamp: number;
}>;

export class ReplayParseError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ReplayParseError";
		this.code = code;
	}
}

const ISOLATION: readonly IsolationClass[] = [
	"local-dev",
	"preview",
	"development",
	"staging",
	"production",
	"ephemeral",
];

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ReplayParseError(
			"replay-parse-invalid",
			`${field} must be a non-empty string`,
		);
	}
	return value;
}

function requireBool(
	value: unknown,
	field: string,
	fallback: boolean,
): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		throw new ReplayParseError(
			"replay-parse-invalid",
			`${field} must be a boolean`,
		);
	}
	return value;
}

function stringList(value: unknown): readonly string[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
		throw new ReplayParseError("replay-parse-invalid", "expected string array");
	}
	return Object.freeze([...value]);
}

/** Default privacy: mask passwords/emails/tel/inputs client-side before send. */
export function defaultPrivacyPolicy(
	overrides?: Partial<Omit<PrivacyPolicy, "schemaVersion">>,
): PrivacyPolicy {
	return Object.freeze({
		schemaVersion: REPLAY_PRIVACY_SCHEMA,
		maskInputs: overrides?.maskInputs ?? true,
		maskPasswords: overrides?.maskPasswords ?? true,
		maskEmails: overrides?.maskEmails ?? true,
		maskTel: overrides?.maskTel ?? true,
		maskSelectors: Object.freeze([
			...(overrides?.maskSelectors ?? [
				"[data-hobo-mask]",
				".hobo-mask",
				"input[type=password]",
				"input[type=email]",
				"input[type=tel]",
				"[autocomplete=cc-number]",
				"[autocomplete=cc-csc]",
			]),
		]),
		blockAttributes: Object.freeze([
			...(overrides?.blockAttributes ?? ["value", "data-ssn", "data-pii"]),
		]),
		captureNetwork: overrides?.captureNetwork ?? true,
		captureConsole: overrides?.captureConsole ?? true,
		captureErrors: overrides?.captureErrors ?? true,
	});
}

export function parsePrivacyPolicy(raw: unknown): PrivacyPolicy {
	if (raw === null || typeof raw !== "object") {
		throw new ReplayParseError(
			"replay-parse-invalid",
			"privacy policy must be an object",
		);
	}
	const o = raw as Record<string, unknown>;
	return defaultPrivacyPolicy({
		maskInputs: requireBool(o.maskInputs ?? o.mask_inputs, "maskInputs", true),
		maskPasswords: requireBool(
			o.maskPasswords ?? o.mask_passwords,
			"maskPasswords",
			true,
		),
		maskEmails: requireBool(o.maskEmails ?? o.mask_emails, "maskEmails", true),
		maskTel: requireBool(o.maskTel ?? o.mask_tel, "maskTel", true),
		maskSelectors: [...stringList(o.maskSelectors ?? o.mask_selectors)],
		blockAttributes: [...stringList(o.blockAttributes ?? o.block_attributes)],
		captureNetwork: requireBool(
			o.captureNetwork ?? o.capture_network,
			"captureNetwork",
			true,
		),
		captureConsole: requireBool(
			o.captureConsole ?? o.capture_console,
			"captureConsole",
			true,
		),
		captureErrors: requireBool(
			o.captureErrors ?? o.capture_errors,
			"captureErrors",
			true,
		),
	});
}

export function parseSessionCorrelation(raw: unknown): SessionCorrelation {
	if (raw === null || typeof raw !== "object") {
		throw new ReplayParseError(
			"replay-parse-invalid",
			"correlation must be an object",
		);
	}
	const o = raw as Record<string, unknown>;
	const isolation = requireString(
		o.isolationClass ?? o.isolation_class ?? "local-dev",
		"isolationClass",
	) as IsolationClass;
	if (!ISOLATION.includes(isolation)) {
		throw new ReplayParseError(
			"replay-parse-invalid",
			`unknown isolation class: ${isolation}`,
		);
	}
	const principal =
		typeof o.principalRef === "string"
			? o.principalRef
			: typeof o.principal_ref === "string"
				? o.principal_ref
				: undefined;
	// Refuse free-text PII-looking principal refs.
	if (
		principal &&
		(/@/.test(principal) ||
			/\s/.test(principal) ||
			principal.toLowerCase().includes("email"))
	) {
		throw new ReplayParseError(
			"replay-pii-forbidden",
			"principalRef must not contain free-text PII (use PrincipalRef dual fixture id)",
		);
	}
	return Object.freeze({
		schemaVersion: REPLAY_CORRELATION_SCHEMA,
		...(principal !== undefined ? { principalRef: principal } : {}),
		stationId: requireString(o.stationId ?? o.station_id, "stationId"),
		...(typeof (o.yardId ?? o.yard_id) === "string"
			? { yardId: String(o.yardId ?? o.yard_id) }
			: {}),
		...(typeof (o.campId ?? o.camp_id) === "string"
			? { campId: String(o.campId ?? o.camp_id) }
			: {}),
		...(typeof (o.trailId ?? o.trail_id) === "string"
			? { trailId: String(o.trailId ?? o.trail_id) }
			: {}),
		...(typeof (o.controlPlaneEventId ?? o.control_plane_event_id) === "string"
			? {
					controlPlaneEventId: String(
						o.controlPlaneEventId ?? o.control_plane_event_id,
					),
				}
			: {}),
		...(typeof (o.errorId ?? o.error_id) === "string"
			? { errorId: String(o.errorId ?? o.error_id) }
			: {}),
		harnessFlagKeys: stringList(o.harnessFlagKeys ?? o.harness_flag_keys ?? []),
		isolationClass: isolation,
		tenant: requireString(o.tenant ?? "local", "tenant"),
		env: requireString(o.env ?? "local-dev", "env"),
	});
}

export function parseSessionRecord(raw: unknown): SessionRecord {
	if (raw === null || typeof raw !== "object") {
		throw new ReplayParseError(
			"replay-parse-invalid",
			"session record must be an object",
		);
	}
	const o = raw as Record<string, unknown>;
	const status = requireString(
		o.status ?? "recording",
		"status",
	) as SessionStatus;
	const allowed: SessionStatus[] = ["recording", "ended", "retained", "erased"];
	if (!allowed.includes(status)) {
		throw new ReplayParseError(
			"replay-parse-invalid",
			`unknown session status: ${status}`,
		);
	}
	return Object.freeze({
		schemaVersion: REPLAY_SCHEMA_VERSION,
		id: requireString(o.id, "id"),
		status,
		startedAt: requireString(o.startedAt ?? o.started_at, "startedAt"),
		...(typeof (o.endedAt ?? o.ended_at) === "string"
			? { endedAt: String(o.endedAt ?? o.ended_at) }
			: {}),
		correlation: parseSessionCorrelation(o.correlation ?? {}),
		privacy: parsePrivacyPolicy(o.privacy ?? {}),
		chunkCount: Number(o.chunkCount ?? o.chunk_count ?? 0),
		totalBytes: Number(o.totalBytes ?? o.total_bytes ?? 0),
		...(typeof o.summary === "string" ? { summary: o.summary } : {}),
	});
}
