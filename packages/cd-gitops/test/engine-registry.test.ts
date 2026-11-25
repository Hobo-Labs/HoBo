import { create } from "@bufbuild/protobuf";
import type { PublisherPort } from "@hobo/cd";
import { ReconcileObservationRecordSchema, ReconcileStatus } from "@hobo/cd";
import { CD_ENGINE_KIND } from "@hobo/cd/compose";
import { describe, expect, it } from "vitest";
import {
	cdEngineRegistrations,
	createCdEngineRegistryFromGitops,
} from "../src/engine-registry.js";

const port = (name: string): PublisherPort =>
	Object.freeze({
		target: `${name}:stub`,
		publish: async () => ({ ok: true, value: { revision: "0" } }),
		observe: async () =>
			create(ReconcileObservationRecordSchema, {
				status: ReconcileStatus.CONVERGING,
				converged: false,
				reasons: [],
			}),
	});

describe("cd engine registry bridge", () => {
	it("maps gitops publishers into compose registrations", () => {
		const regs = cdEngineRegistrations([
			{ name: "argo-cd", port: port("argo-cd") },
		]);
		expect(regs[0]?.kind).toBe(CD_ENGINE_KIND.GITOPS_PUBLISHER);
		const registry = createCdEngineRegistryFromGitops([
			{ name: "argo-cd", port: port("argo-cd") },
		]);
		expect(registry.publisher("argo").ok).toBe(true);
	});
});
