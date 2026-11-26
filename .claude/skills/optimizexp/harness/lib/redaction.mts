/** Best-effort redaction for evidence transcripts. */
const PATTERNS: RegExp[] = [
	/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bsk-[A-Za-z0-9_-]{20,}\b/g,
	/\b(AIza)[0-9A-Za-z_-]{20,}\b/g,
	/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
	/(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*['"]?[^\s'"]+/gi,
	/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
];

export function redactText(input: string): string {
	let out = input;
	for (const re of PATTERNS) {
		out = out.replace(re, "[REDACTED]");
	}
	return out;
}
