import { isJsonString } from "./json.js";
import type { DaprDoctorReport, DaprRuntimeConfig } from "./types.js";

export interface DaprDoctorInput {
	readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	readonly config?: DaprRuntimeConfig;
	readonly probeCli?: () => boolean;
	readonly probeRuntime?: (endpoint: string) => boolean;
}

export function diagnoseDaprReadiness(
	input: DaprDoctorInput = {},
): DaprDoctorReport {
	const env = input.env ?? process.env;
	const notes: string[] = [];
	const remediation: string[] = [];

	const cliHint =
		env.DAPR_HTTP_PORT || env.DAPR_HOST_IP || env.HOBO_DAPR_ENDPOINT;
	const daprCliAvailable = input.probeCli?.() ?? Boolean(cliHint);
	const endpoint =
		input.config?.httpEndpoint ??
		(isJsonString(env.HOBO_DAPR_ENDPOINT)
			? env.HOBO_DAPR_ENDPOINT
			: "http://127.0.0.1:3500");
	const runtimeReachable = input.probeRuntime?.(endpoint) ?? false;

	if (!daprCliAvailable && !runtimeReachable) {
		notes.push(
			"Dapr runtime not detected — Camp dapr backend will use simulated fidelity.",
		);
		remediation.push(
			'Install dapr CLI (`dapr init`) or set HOBO_DAPR_ENDPOINT; select Camp runtimeRequirements: ["dapr"] only when intended.',
		);
	} else if (!runtimeReachable) {
		notes.push("Dapr CLI/env present but runtime endpoint not confirmed.");
		remediation.push(`Ensure daprd is reachable at ${endpoint}.`);
	} else {
		notes.push("Dapr runtime reachable — live fidelity available.");
	}

	notes.push(
		"ADR-0031: in-process wasm remains default; Dapr is opt-in Camp runtime.",
	);

	const fidelity: "simulated" | "live" = runtimeReachable
		? "live"
		: "simulated";

	return Object.freeze({
		daprCliAvailable,
		runtimeReachable,
		fidelity,
		notes,
		remediation,
	});
}
