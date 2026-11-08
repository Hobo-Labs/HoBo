/**
 * Stable HoBo error codes for the Kubernetes placement driver.
 *
 * Apiserver text is never interpolated verbatim. A `Status` message routinely
 * quotes the object that caused it, and the objects this driver sends near a
 * failure path include ServiceAccount tokens, imagePullSecrets and, on an
 * adopted namespace, whatever the operator already put there.
 */

export const KUBERNETES_ERROR_CODES = [
	"PROVIDER_AUTH_FAILED",
	"PROVIDER_CONTRACT_CHANGED",
	"PROVIDER_OPERATION_AMBIGUOUS",
	"PROVIDER_RATE_LIMITED",
	"PROVISIONING_CONFLICT",
	"PLACEMENT_REJECTED",
	"ROLLOUT_FAILED",
	"CLEANUP_INCOMPLETE",
] as const;

export type KubernetesErrorCode = (typeof KUBERNETES_ERROR_CODES)[number];

export type KubernetesErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type KubernetesErrorOptions = {
	/** Safe to repeat the request verbatim. Ambiguity is never retryable. */
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly detail?: KubernetesErrorDetail;
	readonly cause?: Error;
};

/** Shapes that must never survive into a message, log line, or receipt. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/\bBearer\s+\S+/giu,
	// Projected ServiceAccount tokens and any other compact JWS.
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
	// kubeconfig embeds these as base64 blobs.
	/\b(?:client-key-data|client-certificate-data|certificate-authority-data|token)\s*[=:]\s*\S+/giu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
	// .dockerconfigjson, the usual imagePullSecret payload.
	/"auths"\s*:\s*\{[\s\S]*?\}/gu,
];

const CONTROL_CHARS = new RegExp(
	`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
	"gu",
);

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters so apiserver text cannot forge a log record.
 */
export function redactClusterText(text: string, maxLength = 256): string {
	let out = text;
	for (const pattern of CREDENTIAL_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	out = out.replace(CONTROL_CHARS, " ").trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

export class KubernetesProviderError extends Error {
	readonly code: KubernetesErrorCode;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	readonly detail: KubernetesErrorDetail;

	constructor(
		code: KubernetesErrorCode,
		message: string,
		options: KubernetesErrorOptions = {},
	) {
		super(
			redactClusterText(message),
			options.cause !== undefined ? { cause: options.cause } : {},
		);
		this.name = "KubernetesProviderError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		if (options.retryAfterMs !== undefined) {
			this.retryAfterMs = options.retryAfterMs;
		}
		this.detail = Object.freeze({ ...options.detail });
	}
}

export function isKubernetesProviderError<T>(
	value: T,
): value is T & KubernetesProviderError {
	return value instanceof KubernetesProviderError;
}

export function contractChanged(
	message: string,
	detail?: KubernetesErrorDetail,
): never {
	throw new KubernetesProviderError("PROVIDER_CONTRACT_CHANGED", message, {
		...(detail !== undefined ? { detail } : undefined),
	});
}
