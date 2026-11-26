/**
 * The parse boundary: what an authored option bag has to survive before any
 * manifest exists.
 */

import { describe, expect, it } from "vitest";
import {
	formatMemoryQuantity,
	isKubernetesProviderError,
	kubernetes,
	parseCpuMillicores,
	parseMemoryBytes,
	parseWorkloadPlacement,
	renderDeploymentManifest,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

const VALID = {
	name: "try-site",
	namespace: "hobo-try-site",
	image:
		"ghcr.io/hobo/try-site@sha256:221b467378d5ca6ae498f03408d3b19d3b762bb8b078a99a014b61c33d1f1240",
};

function rejects(input: JsonValue): Error {
	try {
		parseWorkloadPlacement(input);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	throw new Error("expected the placement to be rejected");
}

describe("Kubernetes quantities", () => {
	it("reads the three CPU spellings into one unit", () => {
		expect(parseCpuMillicores("250m", "cpu")).toBe(250);
		expect(parseCpuMillicores("0.25", "cpu")).toBe(250);
		expect(parseCpuMillicores(0.25, "cpu")).toBe(250);
	});

	it("keeps the binary and decimal memory suffixes apart", () => {
		// 1M is 1,000,000 bytes and 1Mi is 1,048,576. Treating them alike
		// under-provisions by 4.8% at gibibyte scale.
		expect(parseMemoryBytes("128Mi", "memory")).toBe(134_217_728);
		expect(parseMemoryBytes("128M", "memory")).toBe(128_000_000);
	});

	it("renders bytes back into the largest exact binary suffix", () => {
		expect(formatMemoryQuantity(134_217_728)).toBe("128Mi");
		expect(formatMemoryQuantity(1_073_741_824)).toBe("1Gi");
		expect(formatMemoryQuantity(128_000_000)).toBe("125000Ki");
	});

	it("refuses a quantity it does not recognise rather than guessing zero", () => {
		expect(() => parseMemoryBytes("128 megabytes", "memory")).toThrow();
		expect(() => parseCpuMillicores("half", "cpu")).toThrow();
	});
});

describe("parseWorkloadPlacement", () => {
	it("fills the documented defaults", () => {
		const placement = parseWorkloadPlacement(VALID);

		expect(placement.replicas).toBe(1);
		expect(placement.containerPort).toBe(8080);
		expect(placement.requests.cpuMillicores).toBe(250);
		expect(placement.limits.memoryBytes).toBe(268_435_456);
	});

	it("rejects a name that is not an RFC 1123 label", () => {
		const error = rejects({ ...VALID, name: "Try_Site" });

		expect(isKubernetesProviderError(error)).toBe(true);
		// SAFETY: assertion to `error as { code: string }` is required at this boundary.
		expect((error as { code: string }).code).toBe("PLACEMENT_REJECTED");
	});

	it("rejects an unqualified image reference", () => {
		// `nginx` resolves through whatever default registry the node is
		// configured with, which is nobody's placement decision.
		expect(() =>
			parseWorkloadPlacement({ ...VALID, image: "nginx" }),
		).toThrow();
		expect(() =>
			parseWorkloadPlacement({ ...VALID, image: "ghcr.io/hobo/try-site" }),
		).toThrow();
	});

	it("rejects a limit below its request, which the apiserver would accept", () => {
		const error = rejects({
			...VALID,
			requests: { cpu: "500m", memory: "256Mi" },
			limits: { cpu: "250m", memory: "256Mi" },
		});

		// SAFETY: assertion to `error as { message: string }` is required at this boundary.
		expect((error as { message: string }).message).toContain(
			"cpu limit is below the cpu request",
		);
	});

	it("rejects an attempt to overwrite the labels cleanup depends on", () => {
		const error = rejects({
			...VALID,
			labels: { "app.kubernetes.io/managed-by": "someone-else" },
		});

		// SAFETY: assertion to `error as { message: string }` is required at this boundary.
		expect((error as { message: string }).message).toContain(
			"owned by this provider",
		);
	});

	it("bounds replicas", () => {
		expect(() => parseWorkloadPlacement({ ...VALID, replicas: 0 })).toThrow();
		expect(() => parseWorkloadPlacement({ ...VALID, replicas: 101 })).toThrow();
		expect(() => parseWorkloadPlacement({ ...VALID, replicas: 1.5 })).toThrow();
	});
});

describe("kubernetes.with.workload", () => {
	it("parses the option bag at authoring time, not at deploy time", () => {
		const block = kubernetes.with.workload({ ...VALID, replicas: 3 });

		expect(block.providerId).toBe("kubernetes");
		expect(block.negotiation).toBe("require");
		expect(block.placement.replicas).toBe(3);
	});

	it("refuses to produce a block for a placement no cluster would accept", () => {
		expect(() => kubernetes.with.workload({ ...VALID, port: 0 })).toThrow();
	});
});

describe("renderDeploymentManifest", () => {
	it("drops every capability and mounts no service account token", () => {
		// SAFETY: assertion to `renderDeploymentManifest( parseWorkloadPlacement(VALID), ) as { spec: { template: { spec: { automountServiceAccountToken` is required at this boundary.
		const manifest = renderDeploymentManifest(
			parseWorkloadPlacement(VALID),
		) as {
			spec: {
				template: {
					spec: {
						automountServiceAccountToken: boolean;
						containers: readonly {
							securityContext: { capabilities: { drop: readonly string[] } };
						}[];
					};
				};
			};
		};
		const podSpec = manifest.spec.template.spec;

		expect(podSpec.automountServiceAccountToken).toBe(false);
		expect(podSpec.containers[0]?.securityContext.capabilities.drop).toEqual([
			"ALL",
		]);
	});
});
