const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/\bBearer\s+\S+/giu,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
	/\b(?:client-key-data|client-certificate-data|certificate-authority-data|token)\s*[=:]\s*\S+/giu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
	/"auths"\s*:\s*\{[\s\S]*?\}/gu,
];

const CONTROL_CHARS = new RegExp(
	`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
	"gu",
);

export function redactClusterText(text: string, maxLength = 256): string {
	let out = text;
	for (const pattern of CREDENTIAL_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	out = out.replace(CONTROL_CHARS, " ").trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
