/** Agreements whose existing charges are part of a V2 baseline. */
export function hasV2BaselineCharges(status: string): boolean {
	return status === "active" || status === "past-due";
}
