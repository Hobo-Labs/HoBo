/**
 * The rule six providers' redactors were before they took the shared one
 * (Azure, Cloudflare, DigitalOcean, GCP, Hetzner and Hostinger at 9d3fe8c2d723,
 * each the same two lines): anything long and token-shaped is scrubbed, and the
 * text is cut at a limit. The oracle `LONG_TOKEN_RUN_PROFILE` is held to. Not
 * edited by hand; do not import it from src.
 */

const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}/gu;

export function redactLongTokens(text: string, limit = 400): string {
	const scrubbed = text.replace(TOKEN_PATTERN, "[redacted]");
	return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}
