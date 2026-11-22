export function hasBaselineCharges(status: string): boolean {
	return status === "active" || status === "past-due";
}
