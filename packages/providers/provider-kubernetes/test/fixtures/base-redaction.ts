/**
 * `redactClusterText` as it stood on the base branch (9d3fe8c2d723), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */

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
