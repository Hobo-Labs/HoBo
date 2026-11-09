/**
 * Stable HoBo error codes for the Kubernetes placement driver.
 *
 * Apiserver text is never interpolated verbatim. A `Status` message routinely
 * quotes the object that caused it, and the objects this driver sends near a
 * failure path include ServiceAccount tokens, imagePullSecrets and, on an
 * adopted namespace, whatever the operator already put there.
 */

import {
	createProviderRedactor,
	type ProviderRedactionProfile,
} from "@hobo/core/provider-redaction";

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

/** The provider's own patterns, on top of the shared ones. */
export const KUBERNETES_REDACTION_PROFILE: ProviderRedactionProfile = {
	patterns: [
		/\b(?:client-key-data|client-certificate-data|certificate-authority-data)\s*[=:]\s*\S+/giu,
		// .dockerconfigjson, the usual imagePullSecret payload: to its first
		// closing brace, or to the end of the text when there is none.
		/"auths"\s*:\s*\{[^}]*\}?/gu,
	],
};

const clusterRedactor = createProviderRedactor(KUBERNETES_REDACTION_PROFILE);

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters so apiserver text cannot forge a log record. The shared redactor
 * (`@hobo/core/provider-redaction`) holds the shapes, the window and the cut;
 * Kubernetes adds the kubeconfig's embedded blobs and the dockerconfigjson an
 * imagePullSecret carries.
 */
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
