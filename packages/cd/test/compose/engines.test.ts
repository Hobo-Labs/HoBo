import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ReconcileObservationRecordSchema,
	ReconcileStatus,
} from "../../src/_generated/cd_pb.js";
import {
	CD_ENGINE_KIND,
	createCdEngineRegistry,
	gitopsPublisherRegistration,
	LEGACY_PUBLISHER_TARGET,
	registrationsFromPublisherPorts,
} from "../../src/compose/engines.js";
import type { PublisherPort } from "../../src/ports.js";

function fakePublisher(target: string): PublisherPort {
	return Object.freeze({
		target,
		async publish() {
			return { ok: true, value: { revision: "abc" } };
		},
		async observe() {
			return create(ReconcileObservationRecordSchema, {
				status: ReconcileStatus.CONVERGING,
				converged: false,
				reasons: [],
			});
		},
	});
}

describe("CdEngineRegistry", () => {
	it("lists registered engines sorted by name", () => {
		const registry = createCdEngineRegistry([
			gitopsPublisherRegistration("flux", fakePublisher("flux:a")),
			gitopsPublisherRegistration("argo-cd", fakePublisher("argo-cd:b")),
		]);
		expect(registry.names()).toEqual(["argo-cd", "flux"]);
	});

	it("resolves publishers by name and legacy argo alias", () => {
		const registry = createCdEngineRegistry([
			gitopsPublisherRegistration("argo-cd", fakePublisher("argo-cd:main")),
		]);
		const byName = registry.publisher("argo-cd");
		expect(byName.ok).toBe(true);
		if (!byName.ok) throw new Error("expected publisher");
		expect(byName.value.target).toBe("argo-cd:main");

		const legacy = registry.publisher("argo");
		expect(legacy.ok).toBe(true);

		const missing = registry.publisher("octopus");
		expect(missing.ok).toBe(false);
		if (missing.ok) throw new Error("expected refusal");
		expect(missing.reasons[0]?.code).toBe("compose-engine-unknown");
	});

	it("records engine kind", () => {
		const registry = createCdEngineRegistry([
			gitopsPublisherRegistration("flux", fakePublisher("flux:x")),
		]);
		expect(registry.kind("flux")).toBe(CD_ENGINE_KIND.GITOPS_PUBLISHER);
		expect(registry.kind("missing")).toBeUndefined();
	});

	it("builds registrations from publisher ports", () => {
		const regs = registrationsFromPublisherPorts([
			{ name: "argo-cd", port: fakePublisher("t1") },
		]);
		expect(regs[0]?.kind).toBe(CD_ENGINE_KIND.GITOPS_PUBLISHER);
		expect(LEGACY_PUBLISHER_TARGET.get("argo")).toBe("argo-cd");
	});
});
