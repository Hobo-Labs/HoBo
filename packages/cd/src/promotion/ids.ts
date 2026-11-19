
import type { CampId, PromotionId } from "../ports.js";
import { canonicalJson, sha256Hex } from "./journal.js";

function short(parts: Readonly<Record<string, string>>): string {
	return sha256Hex(canonicalJson(parts)).slice(0, 24);
}

export function promotionIdFor(
	tenant: string,
	idempotencyKey: string,
): PromotionId {
	return `promo_${short({ tenant, key: idempotencyKey })}` as PromotionId;
}

export function rollbackIdFor(
	tenant: string,
	idempotencyKey: string,
): PromotionId {
	return `rollback_${short({ tenant, key: idempotencyKey })}` as PromotionId;
}

export function previewPromotionIdFor(
	tenant: string,
	idempotencyKey: string,
): PromotionId {
	return `preview_${short({ tenant, key: idempotencyKey })}` as PromotionId;
}

// public-contract: separator between a source Camp id and a preview suffix.
export const PREVIEW_CAMP_SEPARATOR = "--pv-" as const;

export function previewCampIdFor(
	tenant: string,
	sourceCampId: string,
	idempotencyKey: string,
): CampId {
	return `${sourceCampId}${PREVIEW_CAMP_SEPARATOR}${short({ tenant, sourceCampId, key: idempotencyKey }).slice(0, 10)}` as CampId;
}

export function previewSourceOf(campId: string): CampId | undefined {
	const at = campId.lastIndexOf(PREVIEW_CAMP_SEPARATOR);
	if (at <= 0) return undefined;
	return campId.slice(0, at) as CampId;
}
