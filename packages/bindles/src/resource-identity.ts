import { isJsonString } from "./json.js";
import {
	type BindleDefinition,
	CATALOG_ROWS,
	type ResourceIdentityEntry,
	type ResourceIdentityLedger,
	type ResourceKind,
} from "./types.js";

export interface ResourceIdentity {
	readonly generatedId: string;
	readonly occurrence: number;
}

export function createResourceIdentityAllocator(
	bindleName: string,
	ledger: ResourceIdentityLedger | undefined,
) {
	const entries = new Map<string, string>();
	const usedIds = new Set<string>();
	const counts = new Map<ResourceKind, number>();
	if (ledger !== undefined) {
		if (ledger.bindleName !== bindleName || !Array.isArray(ledger.entries)) {
			throw new TypeError("resource identity ledger must match the Bindle");
		}
		for (const entry of ledger.entries) {
			if (
				!entry ||
				!CATALOG_ROWS.some((row) => row.factory === entry.kind) ||
				!Number.isSafeInteger(entry.occurrence) ||
				entry.occurrence < 1 ||
				!validGeneratedId(entry.kind, entry.generatedId)
			) {
				throw new TypeError("invalid resource identity ledger entry");
			}
			const key = `${entry.kind}:${entry.occurrence}`;
			if (entries.has(key) || usedIds.has(entry.generatedId)) {
				throw new TypeError(
					"resource identity ledger contains duplicate entries",
				);
			}
			entries.set(key, entry.generatedId);
			usedIds.add(entry.generatedId);
		}
	}
	return {
		allocate(kind: ResourceKind): ResourceIdentity {
			const occurrence = (counts.get(kind) ?? 0) + 1;
			counts.set(kind, occurrence);
			const key = `${kind}:${occurrence}`;
			const generatedId =
				ledger === undefined
					? `res_${kind.replaceAll("-", "_")}_${String(occurrence).padStart(4, "0")}`
					: entries.get(key);
			if (generatedId === undefined) {
				throw new TypeError(`resource identity ledger is missing ${key}`);
			}
			entries.delete(key);
			return { generatedId, occurrence };
		},
		assertComplete(): void {
			if (entries.size > 0) {
				throw new TypeError("resource identity ledger contains unused entries");
			}
		},
	};
}

function validGeneratedId(kind: ResourceKind, generatedId: string): boolean {
	const prefix = `res_${kind.replaceAll("-", "_")}_`;
	if (!isJsonString(generatedId) || !generatedId.startsWith(prefix))
		return false;
	const suffix = generatedId.slice(prefix.length);
	return /^\d{4,}$/u.test(suffix) && Number(suffix) > 0;
}

export function resourceIdentityLedger(
	definition: BindleDefinition,
): ResourceIdentityLedger {
	const entries: ResourceIdentityEntry[] = Object.values(
		definition.resources,
	).map((record) => {
		if (
			record.generatedId === undefined ||
			record.identityOccurrence === undefined
		) {
			throw new TypeError(
				"Bindle resources do not include identity allocation data",
			);
		}
		return Object.freeze({
			kind: record.kind,
			occurrence: record.identityOccurrence,
			generatedId: record.generatedId,
		});
	});
	entries.sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.occurrence - b.occurrence,
	);
	return Object.freeze({
		bindleName: definition.name,
		entries: Object.freeze(entries),
	});
}
