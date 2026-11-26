/**
 * Deterministic string ordering.
 *
 * `localeCompare` is deliberately avoided: its result depends on the host's ICU
 * data and default locale, so two machines could produce differently-ordered
 * IRs from the same schema module and therefore different plan digests. Code
 * unit comparison is boring, total, and identical everywhere, which is the only
 * property that matters for a hashed artifact.
 */

export function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
