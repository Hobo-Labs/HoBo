export function retiredRelayDeployRedactNoise(text: string): string {
	return text
		.replaceAll(/bearer\s+[A-Za-z0-9._~+/=-]+/giu, "bearer [redacted]")
		.replaceAll(
			/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,
			"[jwt redacted]",
		)
		.trim();
}
