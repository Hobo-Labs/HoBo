/**
 * Pure messaging readiness section for `hobo doctor` (ADR-0138).
 * Kept free of @hobo/cli so it is unit-testable without the full CLI graph.
 */

import { diagnoseKafkaReadiness } from "@hobo/provider-kafka";
import { diagnoseDaprReadiness } from "@hobo/runtime-dapr";

export interface MessagingDoctorSection {
	readonly kafka: ReturnType<typeof diagnoseKafkaReadiness>;
	readonly dapr: ReturnType<typeof diagnoseDaprReadiness>;
	readonly defaultRuntime: "in-process-wasm";
	readonly daprOptional: true;
	readonly adr: "ADR-0138";
}

export function buildMessagingDoctorSection(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
) {
	const kafka = diagnoseKafkaReadiness({ env });
	const dapr = diagnoseDaprReadiness({ env });
	const remediation: string[] = [];
	for (const line of kafka.remediation) {
		if (kafka.fidelity === "simulated") remediation.push(line);
	}
	for (const line of dapr.remediation) {
		if (dapr.fidelity === "simulated") {
			remediation.push(`[optional dapr] ${line}`);
		}
	}
	return {
		report: {
			kafka,
			dapr,
			defaultRuntime: "in-process-wasm",
			daprOptional: true,
			adr: "ADR-0138",
		},
		remediation,
	};
}
