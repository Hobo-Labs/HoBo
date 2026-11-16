// Impedance boundaries for Vercel (ADR-0144 pattern — typed evidence for
// PortabilityReport). Marketplace Neon/Upstash are integration-backed.

// public-contract: versions provider impedance reports.
export const VERCEL_IMPEDANCE_SCHEMA = "hobo.provider-impedance/v1";

export const VERCEL_LIMITS = Object.freeze({
	edgeMaxDurationSeconds: 15,
	serverlessMaxDurationSeconds: 60,
} as const);

export interface ImpedanceFinding {
	readonly code: string;
	readonly severity: "info" | "warn" | "block";
	readonly message: string;
}

export function vercelImpedanceFindings(input: {
	readonly paradigm?: string;
	readonly features?: readonly string[];
}): readonly ImpedanceFinding[] {
	const findings: ImpedanceFinding[] = [];
	if (input.paradigm === "relational" || input.paradigm === "postgres") {
		findings.push({
			code: "integration-backed-database",
			severity: "warn",
			message:
				"native postgres on Vercel is marketplace Neon (integration-backed); declare integration or match another provider",
		});
	}
	const features = input.features ?? [];
	if (features.includes("queue")) {
		findings.push({
			code: "no-native-queue",
			severity: "block",
			message:
				"Vercel has no native queue port; prefer in-memory degrade or select a provider that advertises queue",
		});
	}
	return findings;
}
