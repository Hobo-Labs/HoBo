export function hasV2BaselineCharges(status: string): boolean {
	return status === "active" || status === "past-due";
}
