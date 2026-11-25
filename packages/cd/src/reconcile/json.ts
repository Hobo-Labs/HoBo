// Canonical JSON for content hashes in the reconcile module.

/**
 * Deterministic JSON: object keys sorted at every depth. This is the
 * serialization boundary for hashing realized resource nodes, whose
 * `realizationParameters` arrive as manifest-plan JSON.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: canonical serializer over arbitrary JSON; it only reads and never narrows the domain.
export function stableJson(value: unknown): string {
	if (value === undefined) return "null";
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: structural walk of a JSON value for canonical key order.
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
