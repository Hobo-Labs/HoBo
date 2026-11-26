import type { KafkaClusterSpec, KafkaDoctorReport } from "./types.js";

export interface KafkaDoctorInput {
	readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	readonly cluster?: KafkaClusterSpec;
	/** Injected probe for live broker reachability (tests). */
	readonly probeBrokers?: (servers: readonly string[]) => boolean;
	readonly probeRedpandaCli?: () => boolean;
}

/**
 * Readiness diagnostic for Kafka / Redpanda. Never prints credential values.
 * Used by `hobo doctor` and Gatekeeper can-deploy reasons.
 */
export function diagnoseKafkaReadiness(
	input: KafkaDoctorInput = {},
): KafkaDoctorReport {
	const env = input.env ?? process.env;
	const notes: string[] = [];
	const remediation: string[] = [];

	const redpandaEnv =
		env.HOBO_REDPANDA_URL ||
		env.REDPANDA_BROKERS ||
		env.KAFKA_BOOTSTRAP_SERVERS;
	const redpandaCli = input.probeRedpandaCli?.() ?? false;
	const redpandaAvailable = Boolean(redpandaEnv) || redpandaCli;

	const servers =
		input.cluster?.bootstrapServers ??
		(redpandaEnv !== undefined && redpandaEnv.length > 0
			? redpandaEnv.split(",")
			: []);
	const brokersReachable =
		servers.length > 0 ? (input.probeBrokers?.(servers) ?? false) : false;

	if (!redpandaAvailable && !input.cluster) {
		notes.push(
			"Kafka/Redpanda not detected — messaging falls back to simulated native-kafka adapter.",
		);
		remediation.push(
			"Set HOBO_REDPANDA_URL or KAFKA_BOOTSTRAP_SERVERS, or run local Redpanda (docker compose / rpk).",
		);
	} else if (!brokersReachable && servers.length > 0) {
		notes.push(
			`Bootstrap servers declared (${servers.join(",")}) but not confirmed reachable (fidelity=simulated).`,
		);
		remediation.push(
			"Verify broker connectivity and secretless credential binding.",
		);
	} else if (brokersReachable) {
		notes.push("Kafka brokers reachable — live fidelity available.");
	} else {
		notes.push("Kafka resource definition present; live probe not configured.");
	}

	if (input.cluster && !input.cluster.credentialBindingRef) {
		remediation.push(
			"Provide secretless credentialBindingRef (fromBinding / federation).",
		);
	}

	const fidelity: "simulated" | "live" =
		brokersReachable && redpandaAvailable ? "live" : "simulated";

	return Object.freeze({
		redpandaAvailable,
		brokersReachable,
		fidelity,
		notes,
		remediation,
	});
}
