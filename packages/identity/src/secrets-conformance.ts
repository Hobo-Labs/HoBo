/**
 * Conformance oracle: no plaintext secrets in events, agent context, IaC, logs.
 * ADR-0027 acceptance criterion.
 */
// Value side must not be a scrubbed placeholder ([OK]) or short enum/config token.
import { isJsonString } from "./json.js";

const PLAINTEXT_PATTERNS: readonly RegExp[] = Object.freeze([
	/"password"\s*:\s*"(?!\[OK\])[^"]{4,}"/i,
	/"secret"\s*:\s*"(?!\[OK\])[^"]{8,}"/i,
	/"api[_-]?key"\s*:\s*"(?!\[OK\])[^"]{8,}"/i,
	/"private[_-]?key"\s*:\s*"(?!\[OK\])[^"]{8,}"/i,
	/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
	/AKIA[0-9A-Z]{16}/,
]);

export type PlaintextScanHit = Readonly<{
	pattern: string;
	snippet: string;
	surface: string;
}>;

export type PlaintextConformanceResult = Readonly<{
	ok: boolean;
	hits: readonly PlaintextScanHit[];
}>;

/**
 * Scan agent context, events, IaC state, and logs for plaintext secret patterns.
 * Known REDACTED placeholders and secref/tokenref URIs are allowed.
 */
export function assertNoPlaintextConformance(surfaces: {
	readonly agentContext?: unknown;
	readonly events?: unknown;
	readonly iacState?: unknown;
	readonly logs?: unknown;
	/** Optional known-benign substrings (e.g. fixture ids). */
	readonly allowSubstrings?: readonly string[];
}): PlaintextConformanceResult {
	const hits: PlaintextScanHit[] = [];
	const allow = surfaces.allowSubstrings ?? [];

	const check = <T>(surface: string, value: T) => {
		if (value === undefined) return;
		let json = isJsonString(value) ? value : JSON.stringify(value);
		for (const a of allow) {
			json = json.split(a).join("[ALLOWED]");
		}
		// Strip redacted placeholders and reference URIs before pattern scan.
		const scrubbed = json
			.replace(/\[REDACTED:[^\]]+\]/g, "[OK]")
			.replace(
				/(secref|tokenref|staticref|vault|openbao|aws-sm|azure-kv):\/\/[^\s"]+/g,
				"[OK]",
			);
		for (const re of PLAINTEXT_PATTERNS) {
			const m = re.exec(scrubbed);
			if (m) {
				hits.push({
					pattern: re.source,
					snippet: m[0].slice(0, 80),
					surface,
				});
			}
		}
	};

	check("agentContext", surfaces.agentContext);
	check("events", surfaces.events);
	check("iacState", surfaces.iacState);
	check("logs", surfaces.logs);

	return Object.freeze({
		ok: hits.length === 0,
		hits: Object.freeze(hits),
	});
}

/** Throw if any surface leaks plaintext (for tests / can-deploy hooks). */
export function requireNoPlaintextConformance(
	surfaces: Parameters<typeof assertNoPlaintextConformance>[0],
): void {
	const result = assertNoPlaintextConformance(surfaces);
	if (!result.ok) {
		throw Object.assign(
			new Error(
				`plaintext secret conformance failed on ${result.hits.map((h) => h.surface).join(",")}`,
			),
			{ code: "plaintext-conformance-failed", hits: result.hits },
		);
	}
}
