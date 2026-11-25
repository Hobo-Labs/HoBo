/**
 * Nightly plan: RESTler sequences + Toxiproxy/Testcontainers around
 * simulators. Never Azure/AWS/GCP/paid SaaS.
 */
import { dockerAvailable, schemathesisAvailable } from "./env.js";

export interface NightlyPlan {
	readonly property: "required";
	readonly jazzer: "optional";
	readonly schemathesis: "optional";
	readonly restler: "docker-gated";
	readonly toxiproxy: "docker-gated";
	readonly testcontainers: "docker-gated";
	readonly liveClouds: "forbidden";
	readonly docker: boolean;
	readonly schemathesisBinary: boolean;
	readonly skipped: readonly string[];
}

export function describeNightlyPlan(): NightlyPlan {
	const docker = dockerAvailable();
	const schemathesisBinary = schemathesisAvailable();
	const skipped: string[] = [];
	if (!schemathesisBinary) skipped.push("schemathesis");
	if (!docker) {
		skipped.push("restler", "toxiproxy", "testcontainers");
	}
	return {
		property: "required",
		jazzer: "optional",
		schemathesis: "optional",
		restler: "docker-gated",
		toxiproxy: "docker-gated",
		testcontainers: "docker-gated",
		liveClouds: "forbidden",
		docker,
		schemathesisBinary,
		skipped,
	};
}
