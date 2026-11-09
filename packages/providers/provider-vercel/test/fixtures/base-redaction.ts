/**
 * `redactProviderText` as it stood on the base branch (169d87fcf819), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */

/**
 * How much of a text the shapes below are searched in: its first
 * REDACTION_WINDOW characters, or four times `maxLength` when that is more, and
 * the rest of the run of non-whitespace that cut falls in (`windowOf`). An
 * error message is cut far shorter than this, so a longer text only costs time:
 * a hostile body of a megabyte with whitespace in it is searched no further than
 * this, and one without is searched in linear time.
 */
const REDACTION_WINDOW = 8192;

/**
 * Shapes that must never survive into an error message, log line, or receipt.
 * Each is linear in the text: none can start again inside a run it has already
 * scanned to its end.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	// Prisma Postgres hands out prisma+postgres://…?api_key=… as well as a
	// direct postgres:// string, so both shapes are stripped.
	/prisma\+postgres:\/\/\S+/giu,
	/postgres(?:ql)?:\/\/\S+/giu,
	/\bapi[_-]?key\s*[=:]\s*\S+/giu,
	/\bBearer\s+\S+/giu,
	/\b(?:password|pgpassword|pwd)\s*[=:]\s*\S+/giu,
	// Vercel claim/transfer codes are bearer authority on this path.
	/\bcode\s*[=:]\s*[A-Za-z0-9-]{8,}/giu,
	/\b(?:sk|pk)[-_][A-Za-z0-9_-]{8,}/giu,
	// A JWT starts only where a run of base64url characters starts, so
	// `-ey-ey-ey…` is one search, not one from every `ey` to the end.
	/(?<![A-Za-z0-9_-])ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.\S*/giu,
	// A private key, from its BEGIN line to its own END line (another END line,
	// such as a certificate's, inside it does not end it), or to the next BEGIN
	// line, or to the end of the text when there is neither (as when the text
	// was cut inside the key): never a search from every BEGIN to the end. The
	// END line is looked for only where `-----END ` starts, and its label's run
	// is read once there.
	/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN |-----END [A-Z ]*PRIVATE KEY-----)[\s\S])*(?:-----END [A-Z ]*PRIVATE KEY-----)?/giu,
];

/**
 * `text` cut at `window` characters, or, when that cut falls inside a run of
 * non-whitespace, at the end of that run. Every shape above but the private
 * key ends at whitespace, so none is cut through and a credential leaves
 * nothing behind; a private key cut after its BEGIN line is redacted to the
 * end of what is searched. A long body with no whitespace, such as compact
 * JSON, is then searched whole (the shapes are linear in it), and its start is
 * still shown, redacted.
 */
function windowOf(text: string, window: number): string {
	if (text.length <= window) return text;
	const whitespace = /\s/gu;
	whitespace.lastIndex = window;
	const next = whitespace.exec(text);
	return next === null ? text : text.slice(0, next.index);
}

// Each C0 control character and DEL as a space. Copied a stretch at a time,
// not a character at a time: a text searched whole can be a megabyte.
function flattenControlChars(text: string): string {
	let out = "";
	let from = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code <= 31 || code === 127) {
			out += `${text.slice(from, index)} `;
			from = index + 1;
		}
	}
	return from === 0 ? text : out + text.slice(from);
}

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters so provider text cannot forge a log record. Only the window
 * (REDACTION_WINDOW) is searched and kept; a text longer than it is marked cut.
 */
export function redactProviderText(text: string, maxLength = 256): string {
	const searched = windowOf(text, Math.max(REDACTION_WINDOW, 4 * maxLength));
	let out = searched;
	for (const pattern of CREDENTIAL_PATTERNS)
		out = out.replace(pattern, "[redacted]");
	out = flattenControlChars(out).trim();
	return out.length > maxLength || searched.length < text.length
		? `${out.slice(0, maxLength)}…`
		: out;
}
