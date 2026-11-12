// Deterministic identifiers of the promotion saga. Ids derive from the tenant
// and the caller's idempotency key, so a repeated command finds its record
// (I12) and replay mints the same ids (I8).
import { canonicalJson, sha256Hex } from "./journal.js";
import type { CampId, PromotionId } from "../ports.js";

function short(parts: Readonly<Record<string, string>>): string {
	return sha256Hex(canonicalJson(parts)).slice(0, 24);
}

export function promotionIdFor(tenant: string, idempotencyKey: string): PromotionId {
	// SAFETY: promotion ids are minted only here, from a stable digest.
	return `promo_${short({ tenant, key: idempotencyKey })}` as PromotionId;
}

export function rollbackIdFor(tenant: string, idempotencyKey: string): PromotionId {
	// SAFETY: rollback promotion ids are minted only here.
	return `rollback_${short({ tenant, key: idempotencyKey })}` as PromotionId;
}

export function previewPromotionIdFor(tenant: string, idempotencyKey: string): PromotionId {
	// SAFETY: preview promotion ids are minted only here.
	return `preview_${short({ tenant, key: idempotencyKey })}` as PromotionId;
}

// public-contract: separator between a source Camp id and a preview suffix.
export const PREVIEW_CAMP_SEPARATOR = "--pv-" as const;

/** The ephemeral Camp a preview clones from `sourceCampId`. */
export function previewCampIdFor(tenant: string, sourceCampId: string, idempotencyKey: string): CampId {
	// SAFETY: preview Camp ids are minted only here, from the source Camp id.
	return `${sourceCampId}${PREVIEW_CAMP_SEPARATOR}${short({ tenant, sourceCampId, key: idempotencyKey }).slice(0, 10)}` as CampId;
}

/** The source Camp of a preview Camp id; undefined for an ordinary Camp. */
export function previewSourceOf(campId: string): CampId | undefined {
	const at = campId.lastIndexOf(PREVIEW_CAMP_SEPARATOR);
	if (at <= 0) return undefined;
	// SAFETY: the prefix of a minted preview Camp id is its source Camp id.
	return campId.slice(0, at) as CampId;
}
