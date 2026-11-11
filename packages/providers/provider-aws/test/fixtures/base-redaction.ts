/**
 * `redactAwsText` as it stood on the base branch (9d3fe8c2d723), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */
import type { AwsCredentials } from "@hobo/core/aws-sigv4";

/** Anything long and token-shaped is scrubbed out of provider error text. */
const TOKEN_PATTERN = /[A-Za-z0-9/+=_-]{20,}/gu;

/**
 * Redact provider text before it reaches a message, a diagnostic, or a log.
 * The resolved material is removed by exact match first — that is the part
 * that must never survive — and anything else token-shaped after it, because
 * AWS error bodies echo request context and have carried an access key id.
 */
export function redactAwsText(
	text: string,
	credentials: AwsCredentials | undefined,
	limit = 400,
): string {
	let scrubbed = text;
	for (const material of [
		credentials?.secretAccessKey,
		credentials?.sessionToken,
		credentials?.accessKeyId,
	]) {
		if (material !== undefined && material.length >= 4) {
			scrubbed = scrubbed.split(material).join("[redacted]");
		}
	}
	scrubbed = scrubbed.replace(TOKEN_PATTERN, "[redacted]");
	return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}
