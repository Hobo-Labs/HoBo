import {
	createProviderRedactor,
	type ProviderRedactionProfile,
} from "@hobo/provider-redaction";

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
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly detail?: KubernetesErrorDetail;
	readonly cause?: Error;
};

export const KUBERNETES_REDACTION_PROFILE: ProviderRedactionProfile = {
	patterns: [
		/\b(?:client-key-data|client-certificate-data|certificate-authority-data)\s*[=:]\s*\S+/gi,
		/"auths"\s*:\s*\{[^}]*\}?/gu,
	],
};

const clusterRedactor = createProviderRedactor(KUBERNETES_REDACTION_PROFILE);

export function redactClusterText(text: string, maxLength = 256): string {
	return clusterRedactor(text, maxLength);
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
