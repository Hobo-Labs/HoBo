// Impedance boundaries for Vercel (ADR-0144 pattern — typed evidence for
// PortabilityReport). A Yard advertises only its provider's products.

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
			code: "no-native-postgres",
			severity: "block",
			message:
				"Vercel has no native Postgres product; declare the database provider in its own Yard and connect the Yards through a Junction",
		});
	}
	const features = input.features ?? [];
	if (features.includes("queue")) {
		findings.push({
			code: "deployment-owned-queue",
			severity: "info",
			message:
				"Vercel Queues are verified as components of the owning Git deployment; an independently provisioned queue is not available",
		});
	}
	return findings;
}
