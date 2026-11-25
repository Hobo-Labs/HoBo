import { create } from "@bufbuild/protobuf";
import {
	JWT_DETECTOR,
	PRIVATE_KEY_DETECTOR,
	redactProviderText,
} from "@hobo/provider-redaction";
import {
	type ReasonStructuredDetail,
	ReasonStructuredDetailSchema,
} from "../_generated/cd_pb.js";

export const RELEASE_FREIGHT_DETAIL_KINDS = [
	"scope-not-allowed",
	"credential-unresolved",
	"repository-mismatch",
	"missing-GITHUB_REPOSITORY",
	"missing-GITHUB_TOKEN",
] as const;

export type ReleaseFreightDetailKind =
	(typeof RELEASE_FREIGHT_DETAIL_KINDS)[number];

const RELEASE_PROBE_SCOPE = "release-probe";
const CD_REALIZE_SCOPE =
	/^cd-realize:[a-z0-9][a-z0-9-]{0,62}(\/[a-z0-9][a-z0-9-]{0,62})?$/u;
const CREDENTIAL_REF =
	/^(github-app:\/\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}|owner:\/\/[A-Z][A-Z0-9_]{0,63})$/u;

const MAX_CREDENTIAL_REF_LEN = 120;
const MAX_SCOPE_LEN = 96;

const GH_TOKEN_PREFIX =
	/(?:^|[^A-Za-z0-9_])(?:npm_|ghp_|ghu_|ghs_|ghr_|github_pat_)/u;
const SIG_OR_HMAC = /(?:\?|&)(?:sig|hmac)=/iu;
const LONG_HIGH_ENTROPY =
	/(?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,})(?:[^A-Za-z0-9_]|$)/u;

export function isSingleLineBounded(text: string, maxLen: number): boolean {
	const trimmed = text.trim();
	return (
		trimmed.length > 0 &&
		trimmed.length <= maxLen &&
		!trimmed.includes("\n") &&
		!trimmed.includes("\r")
	);
}

export function isValidReleaseFreightCredentialRef(ref: string): boolean {
	return (
		isSingleLineBounded(ref, MAX_CREDENTIAL_REF_LEN) && CREDENTIAL_REF.test(ref)
	);
}

export function isValidReleaseFreightScope(scope: string): boolean {
	if (!isSingleLineBounded(scope, MAX_SCOPE_LEN)) return false;
	return scope === RELEASE_PROBE_SCOPE || CD_REALIZE_SCOPE.test(scope);
}

export function isReleaseFreightScopeAllowed(
	scope: string,
	allowedScopes: ReadonlySet<string>,
): boolean {
	return isValidReleaseFreightScope(scope) && allowedScopes.has(scope.trim());
}

function isReleaseFreightDetailKind(
	value: string,
): value is ReleaseFreightDetailKind {
	return RELEASE_FREIGHT_DETAIL_KINDS.some((kind) => kind === value);
}

export function releaseFreightDetailKindOf(
	value: string,
): ReleaseFreightDetailKind | undefined {
	return isReleaseFreightDetailKind(value) ? value : undefined;
}

function isValidStructuredScope(
	kind: ReleaseFreightDetailKind,
	requestedScope: string,
): boolean {
	if (kind === "repository-mismatch")
		return isValidReleaseFreightCredentialRef(requestedScope);
	return isValidReleaseFreightScope(requestedScope);
}

export type ReleaseFreightStructuredInput = Readonly<{
	credentialRef: string;
	requestedScope: string;
	detailKind: string;
}>;

export function releaseFreightStructuredFromFields(
	fields: ReleaseFreightStructuredInput,
): ReasonStructuredDetail | undefined {
	const credentialRef = fields.credentialRef.trim();
	const requestedScope = fields.requestedScope.trim();
	const detailKind = fields.detailKind.trim();
	if (!credentialRef || !requestedScope || !detailKind) return undefined;
	return validateReasonStructuredDetail(
		create(ReasonStructuredDetailSchema, {
			credentialRef,
			requestedScope,
			detailKind,
		}),
	);
}

export function validateReasonStructuredDetail(
	detail: ReasonStructuredDetail | undefined,
): ReasonStructuredDetail | undefined {
	if (!detail) return undefined;
	const credentialRef = detail.credentialRef?.trim() ?? "";
	const requestedScope = detail.requestedScope?.trim() ?? "";
	const kind = releaseFreightDetailKindOf(detail.detailKind?.trim() ?? "");
	if (
		!kind ||
		!isValidReleaseFreightCredentialRef(credentialRef) ||
		!isValidStructuredScope(kind, requestedScope)
	)
		return undefined;
	return create(ReasonStructuredDetailSchema, {
		credentialRef,
		requestedScope,
		detailKind: kind,
	});
}

export function formatReleaseFreightBlockedDetail(
	code: string,
	detail: ReasonStructuredDetail,
): string {
	const validated = validateReasonStructuredDetail(detail);
	if (!validated) return code.trim() || "unknown";
	if (validated.detailKind === "repository-mismatch") {
		const expectedRepository = validated.requestedScope.slice(
			"github-app://".length,
		);
		return `${code}: credential=${validated.credentialRef} expected-repository=${expectedRepository} repository-mismatch`;
	}
	return `${code}: credential=${validated.credentialRef} scope=${validated.requestedScope} ${validated.detailKind}`;
}

export function formatReleaseFreightBlockedReason(
	code: string | undefined,
	detail: ReasonStructuredDetail | undefined,
): string {
	const trimmedCode = code?.trim() || "unknown";
	const validated = validateReasonStructuredDetail(detail);
	return validated
		? formatReleaseFreightBlockedDetail(trimmedCode, validated)
		: trimmedCode;
}

const RELEASE_FREIGHT_CREDENTIAL_CAPTURE =
	"(github-app://[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}|owner://[A-Z][A-Z0-9_]{0,63})";
const PARSE_SCOPE_NOT_ALLOWED = new RegExp(
	`^release Freight refuses ${RELEASE_FREIGHT_CREDENTIAL_CAPTURE}: scope ([^ ]+) is not allowed for workflow github-app credentials$`,
	"u",
);
const PARSE_CREDENTIAL_UNRESOLVED = new RegExp(
	`^release Freight does not resolve credential ${RELEASE_FREIGHT_CREDENTIAL_CAPTURE} \\(([^)]+)\\)$`,
	"u",
);
const PARSE_REPO_MISMATCH = new RegExp(
	`^release Freight refuses ${RELEASE_FREIGHT_CREDENTIAL_CAPTURE}: expected github-app://([^ ]+)$`,
	"u",
);
const PARSE_MISSING_REPOSITORY = new RegExp(
	`^release Freight needs GITHUB_REPOSITORY to authorize ${RELEASE_FREIGHT_CREDENTIAL_CAPTURE} \\(([^)]+)\\)$`,
	"u",
);
const PARSE_MISSING_TOKEN = new RegExp(
	`^release Freight needs GITHUB_TOKEN to authorize ${RELEASE_FREIGHT_CREDENTIAL_CAPTURE} \\(([^)]+)\\)$`,
	"u",
);

export function parseReleaseFreightAuthorMessage(
	message: string,
	allowedScopes: ReadonlySet<string>,
):
	| Readonly<{
			credentialRef: string;
			requestedScope: string;
			detailKind: ReleaseFreightDetailKind;
	  }>
	| undefined {
	const text = message.trim();
	const toDetail = (
		credentialRef: string,
		requestedScope: string,
		detailKind: ReleaseFreightDetailKind,
	) => {
		if (
			!isValidReleaseFreightCredentialRef(credentialRef) ||
			!isReleaseFreightScopeAllowed(requestedScope, allowedScopes)
		)
			return undefined;
		return { credentialRef, requestedScope, detailKind };
	};
	const scopeDenied = PARSE_SCOPE_NOT_ALLOWED.exec(text);
	if (scopeDenied)
		return toDetail(
			scopeDenied[1] ?? "",
			scopeDenied[2] ?? "",
			"scope-not-allowed",
		);
	const unresolved = PARSE_CREDENTIAL_UNRESOLVED.exec(text);
	if (unresolved)
		return toDetail(
			unresolved[1] ?? "",
			unresolved[2] ?? "",
			"credential-unresolved",
		);
	const repoMismatch = PARSE_REPO_MISMATCH.exec(text);
	if (repoMismatch) {
		const credentialRef = repoMismatch[1] ?? "";
		const expectedRepository = `github-app://${(repoMismatch[2] ?? "").trim()}`;
		if (
			!isValidReleaseFreightCredentialRef(credentialRef) ||
			!isValidReleaseFreightCredentialRef(expectedRepository)
		)
			return undefined;
		return {
			credentialRef,
			requestedScope: expectedRepository,
			detailKind: "repository-mismatch",
		};
	}
	const missingRepository = PARSE_MISSING_REPOSITORY.exec(text);
	if (missingRepository)
		return toDetail(
			missingRepository[1] ?? "",
			missingRepository[2] ?? "",
			"missing-GITHUB_REPOSITORY",
		);
	const missingToken = PARSE_MISSING_TOKEN.exec(text);
	if (missingToken)
		return toDetail(
			missingToken[1] ?? "",
			missingToken[2] ?? "",
			"missing-GITHUB_TOKEN",
		);
	return undefined;
}

export class ReleaseFreightBlockedError extends Error {
	readonly detailKind: ReleaseFreightDetailKind;
	readonly credentialRef: string;
	readonly requestedScope: string;

	constructor(
		detailKind: ReleaseFreightDetailKind,
		credentialRef: string,
		requestedScope: string,
	) {
		super("The realizer reported a condition.");
		this.name = "ReleaseFreightBlockedError";
		this.detailKind = detailKind;
		this.credentialRef = credentialRef;
		this.requestedScope = requestedScope;
	}

	toStructuredDetail(): ReasonStructuredDetail {
		return create(ReasonStructuredDetailSchema, {
			credentialRef: this.credentialRef,
			requestedScope: this.requestedScope,
			detailKind: this.detailKind,
		});
	}
}

export type ReleaseFreightRefusal = Readonly<{
	code: string;
	structured?: ReasonStructuredDetail;
}>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: JavaScript catch values are untrusted; only ReleaseFreightBlockedError carries structured detail.
export function releaseFreightRefusalOf(error: unknown): ReleaseFreightRefusal {
	if (error instanceof ReleaseFreightBlockedError) {
		const structured = validateReasonStructuredDetail(
			error.toStructuredDetail(),
		);
		if (structured) {
			return { code: "realize-failed", structured };
		}
	}
	return { code: "realize-failed" };
}

export function releaseFreightLogLooksSensitive(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const redacted = redactProviderText(trimmed);
	if (
		JWT_DETECTOR.test(trimmed) ||
		PRIVATE_KEY_DETECTOR.test(trimmed) ||
		JWT_DETECTOR.test(redacted) ||
		PRIVATE_KEY_DETECTOR.test(redacted)
	)
		return true;
	if (GH_TOKEN_PREFIX.test(trimmed)) return true;
	if (SIG_OR_HMAC.test(trimmed)) return true;
	if (LONG_HIGH_ENTROPY.test(trimmed)) return true;
	return false;
}

export function releaseFreightLogFragment(text: string | undefined): string {
	const trimmed = text?.trim() ?? "";
	if (!trimmed) return "";
	const singleLine = trimmed.replaceAll(/[\r\n]/gu, " ").trim();
	if (releaseFreightLogLooksSensitive(singleLine)) return "";
	return singleLine;
}
