import { describe, expect, it } from "vitest";
import { ComposeError, createCdEngineRegistry } from "../../src/compose/index.js";

describe("@hobo/cd/compose CdEngineRegistry", () => {
	it("registers pluggable pull and push CD engines and resolves them by target and flow kind", () => {
		const registry = createCdEngineRegistry([
			{
				name: "argo-cd",
				provider: "argo-cd",
				supportedFlows: ["gitops-pull", "gitops-pr-pull"],
				pullBased: true,
			},
			{
				name: "flux",
				provider: "flux",
				supportedFlows: ["gitops-pull", "gitops-pr-pull"],
				pullBased: true,
			},
			{
				name: "octopus-deploy",
				provider: "octopus",
				supportedFlows: ["release-orchestrator"],
				pullBased: false,
			},
		]);

		expect(registry.list().map((entry) => entry.name)).toEqual([
			"argo-cd",
			"flux",
			"octopus-deploy",
		]);
		expect(
			registry.listByFlow("gitops-pr-pull").map((entry) => entry.name),
		).toEqual(["argo-cd", "flux"]);
		expect(registry.require("argo-cd").pullBased).toBe(true);
		expect(
			registry.requireForFlow("octopus-deploy", "release-orchestrator")
				.provider,
		).toBe("octopus");
	});

	it("fails closed on missing engines, unsupported flows, and duplicate registrations", () => {
		const registry = createCdEngineRegistry([
			{
				name: "argo-cd",
				provider: "argo-cd",
				supportedFlows: ["gitops-pull"],
				pullBased: true,
			},
		]);

		expect(() => registry.require("missing-engine")).toThrow(ComposeError);
		expect(() => registry.require("missing-engine")).toThrow(
			/compose-engine-missing/,
		);
		expect(() =>
			registry.requireForFlow("argo-cd", "release-orchestrator"),
		).toThrow(/compose-engine-missing/);
		expect(() =>
			registry.register({
				name: "argo-cd",
				provider: "argo-cd",
				supportedFlows: ["gitops-pull"],
				pullBased: true,
			}),
		).toThrow(/compose-engine-duplicate/);
	});
});
