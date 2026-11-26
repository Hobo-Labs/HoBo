import { describe, expect, it } from "vitest";

import {
	applyFluxDeploy,
	FLUX_PIN,
	FLUX_PROVIDER_TARGET,
	FLUX_RIVET_RUNNER_RECIPE,
	FluxProviderError,
	HOBO_PROVIDER_FLUX_PACKAGE,
	parseFluxDeploySpec,
} from "../src/index.js";

describe("@hobo/provider-flux", () => {
	it("identifies Orbit as a git mode, not a provider", () => {
		expect(HOBO_PROVIDER_FLUX_PACKAGE).toBe("@hobo/provider-flux");
		expect(FLUX_PROVIDER_TARGET).toBe("flux");
		expect(FLUX_PIN.orbit).toContain("orbit.runonflux.com");
		expect(FLUX_RIVET_RUNNER_RECIPE.controlPlane).toBe("trusted-yard");
	});

	it("preview git (Orbit) apply is allowed", () => {
		const spec = parseFluxDeploySpec({
			source: "git",
			gitRepository: "https://github.com/acme/app",
			tier: "community-free",
			environment: "preview",
			primitives: ["web"],
		});
		expect(applyFluxDeploy(spec).orbitMode).toBe(true);
	});

	it("production requires digest, signed webhook, auth logs, paid tier", () => {
		expect(() =>
			applyFluxDeploy(
				parseFluxDeploySpec({
					source: "git",
					tier: "paid-multi-instance",
					environment: "production",
					primitives: ["api"],
					webhookSigned: true,
					statusLogsAuthenticated: true,
				}),
			),
		).toThrow(/digest/);
		expect(() =>
			applyFluxDeploy(
				parseFluxDeploySpec({
					source: "oci",
					imageDigest: "sha256:abc",
					tier: "paid-multi-instance",
					environment: "production",
					primitives: ["api"],
					webhookSigned: false,
					statusLogsAuthenticated: true,
				}),
			),
		).toThrow(FluxProviderError);
		const ok = applyFluxDeploy(
			parseFluxDeploySpec({
				source: "oci",
				imageDigest: "sha256:abc",
				tier: "paid-multi-instance",
				environment: "production",
				primitives: ["web", "api", "service"],
				webhookSigned: true,
				statusLogsAuthenticated: true,
			}),
		);
		expect(ok.applied).toBe(true);
		expect(ok.orbitMode).toBe(false);
	});

	it("rejects actor/data/kv and control plane on community nodes", () => {
		expect(() =>
			parseFluxDeploySpec({
				source: "oci",
				imageDigest: "sha256:abc",
				tier: "paid-multi-instance",
				environment: "preview",
				primitives: ["actor"],
			}),
		).toThrow(/actor/);
		expect(() =>
			parseFluxDeploySpec({
				source: "oci",
				imageDigest: "sha256:abc",
				tier: "community-free",
				environment: "preview",
				primitives: ["service"],
				hostsRivetControlPlane: true,
			}),
		).toThrow(/control plane/);
		expect(() =>
			parseFluxDeploySpec({
				source: "oci",
				imageDigest: "sha256:abc",
				tier: "paid-multi-instance",
				environment: "preview",
				primitives: ["web"],
				apiKeySecretRef: "sk-live-secret",
			}),
		).toThrow(/locator/);
	});
});
