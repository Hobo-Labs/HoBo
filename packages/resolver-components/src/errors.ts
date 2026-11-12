// Typed failures of the resolver-component host. Every refusal carries a
// stable code and a remediation sentence, and extends the @hobo/core
// `ResolverError` so callers of the `ResourceResolver` seam branch on the
// resolver-contract code they already know.
import { ResolverError, type ResolverErrorCode } from "@hobo/core";

// public-contract: every refusal the component host reports.
export const RESOLVER_COMPONENT_ERROR_CODES = Object.freeze([
	"component.manifest-invalid",
	"component.bundle-unverified",
	"component.bundle-signature-failed",
	"component.bundle-digest-mismatch",
	"component.engine-unavailable",
	"component.describe-mismatch",
	"component.egress-denied",
	"component.secret-exfiltration",
	"component.fuel-exhausted",
	"component.memory-exceeded",
	"component.timeout",
	"component.trap",
	"component.guest-rejected",
	"component.guest-unsupported",
	"component.output-unparseable",
	"component.credential-unavailable",
] as const);
export type ResolverComponentErrorCode =
	(typeof RESOLVER_COMPONENT_ERROR_CODES)[number];

const REMEDIATION: Readonly<Record<ResolverComponentErrorCode, string>> =
	Object.freeze({
		"component.manifest-invalid":
			"Fix the component manifest against data-models/resolver_components.cue and re-sign the bundle.",
		"component.bundle-unverified":
			"Configure a registry SignatureVerifier (JWKS, issuer, audience); unsigned components never load.",
		"component.bundle-signature-failed":
			"Re-sign the bundle with a trusted registry key; a tampered or foreign signature never loads.",
		"component.bundle-digest-mismatch":
			"Rebuild the bundle: the registry manifest must bind the exact component-manifest and wasm digests.",
		"component.engine-unavailable":
			"Register an engine that can instantiate this wasm digest (see README 'Engines'), or install the pinned toolchain.",
		"component.describe-mismatch":
			"Make describe() return exactly the resource classes declared in the signed manifest, then re-sign.",
		"component.egress-denied":
			"Add the host to the manifest egress allowlist (exact host, port, path prefix) and re-sign; private and metadata addresses stay denied outside agent-mode local allowlists.",
		"component.secret-exfiltration":
			"The component returned or forwarded injected credential material; quarantine the bundle and audit its source.",
		"component.fuel-exhausted":
			"Reduce work per call or raise limits.fuel up to the CD_DEFAULTS cap and re-sign.",
		"component.memory-exceeded":
			"Stream smaller bodies or raise limits.memory_bytes up to the CD_DEFAULTS cap and re-sign.",
		"component.timeout":
			"Make the call finish within limits.call_timeout_ms (cap 30 s); slow providers should report a pending outcome and converge on the next reconcile.",
		"component.trap":
			"The component trapped; read the invocation record and the component log, fix the guest and rebuild.",
		"component.guest-rejected":
			"The provider rejected the request; fix the desired state named in the message.",
		"component.guest-unsupported":
			"The component does not support this request; route the product to a resolver that does.",
		"component.output-unparseable":
			"The component returned a value outside the hobo:resolver WIT contract; fix the guest.",
		"component.credential-unavailable":
			"Make the credential locator resolvable where the reconciler runs (agent-local in agent mode).",
	});

const CORE_CODE: Readonly<
	Record<ResolverComponentErrorCode, ResolverErrorCode>
> = Object.freeze({
	"component.manifest-invalid": "RESOLVER_PRODUCT_UNSUPPORTED",
	"component.bundle-unverified": "RESOLVER_PRODUCT_UNSUPPORTED",
	"component.bundle-signature-failed": "RESOLVER_PRODUCT_UNSUPPORTED",
	"component.bundle-digest-mismatch": "RESOLVER_PRODUCT_UNSUPPORTED",
	"component.engine-unavailable": "RESOLVER_PRODUCT_UNSUPPORTED",
	"component.describe-mismatch": "RESOLVER_PRODUCT_UNSUPPORTED",
	"component.egress-denied": "RESOLVER_PROVIDER_REJECTED",
	"component.secret-exfiltration": "RESOLVER_OUTPUT_UNPARSEABLE",
	"component.fuel-exhausted": "RESOLVER_PROVIDER_REJECTED",
	"component.memory-exceeded": "RESOLVER_PROVIDER_REJECTED",
	"component.timeout": "RESOLVER_PROVIDER_REJECTED",
	"component.trap": "RESOLVER_PROVIDER_REJECTED",
	"component.guest-rejected": "RESOLVER_PROVIDER_REJECTED",
	"component.guest-unsupported": "RESOLVER_PRODUCT_UNSUPPORTED",
	"component.output-unparseable": "RESOLVER_OUTPUT_UNPARSEABLE",
	"component.credential-unavailable": "RESOLVER_CREDENTIAL_MISSING",
});

/** A component-host refusal: a `ResolverError` with a component code. */
export class ResolverComponentError extends ResolverError {
	readonly componentCode: ResolverComponentErrorCode;
	readonly remediation: string;
	readonly componentId?: string;

	constructor(
		code: ResolverComponentErrorCode,
		message: string,
		componentId?: string,
		productId?: string,
	) {
		super(CORE_CODE[code], `${code}: ${message}`, productId);
		this.name = "ResolverComponentError";
		this.componentCode = code;
		this.remediation = REMEDIATION[code];
		if (componentId !== undefined) this.componentId = componentId;
	}
}

/** Remediation sentence for a code (also used by runbooks and the CLI). */
export function remediationFor(code: ResolverComponentErrorCode): string {
	return REMEDIATION[code];
}
