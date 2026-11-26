import type { SlotBindingError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	cronJob,
	type DeploymentOptions,
	daemonSet,
	deployment,
	deploymentWorker,
	ingress,
	job,
	persistentVolumeClaim,
	secret,
	service,
	statefulSet,
	statefulSetWorker,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

/** The code core refused a call with, or undefined if it did not refuse. */
function refusalCode(call: () => void): string | undefined {
	try {
		call();
		return undefined;
	} catch (error) {
		// SAFETY: assertion to `error as SlotBindingError` is required at this boundary.
		return (error as SlotBindingError).code;
	}
}

/** Every factory, called with no options, plus the triple it must emit. */
const NO_ARG_FACTORIES = [
	[
		"deployment",
		() => deployment(),
		"web",
		"web.hosted/v1",
		"kubernetes.deployment/v1",
	],
	[
		"deploymentWorker",
		() => deploymentWorker(),
		"service",
		"service.worker/v1",
		"kubernetes.deployment/v1",
	],
	["service", () => service(), "api", "api.http/v1", "kubernetes.service/v1"],
	["ingress", () => ingress(), "api", "api.http/v1", "kubernetes.ingress/v1"],
	["job", () => job(), "service", "service.batch/v1", "kubernetes.job/v1"],
	[
		"cronJob",
		() => cronJob(),
		"service",
		"service.scheduled/v1",
		"kubernetes.cronjob/v1",
	],
	[
		"statefulSet",
		() => statefulSet(),
		"web",
		"web.hosted/v1",
		"kubernetes.statefulset/v1",
	],
	[
		"statefulSetWorker",
		() => statefulSetWorker(),
		"service",
		"service.worker/v1",
		"kubernetes.statefulset/v1",
	],
	[
		"daemonSet",
		() => daemonSet(),
		"service",
		"service.worker/v1",
		"kubernetes.daemonset/v1",
	],
	[
		"persistentVolumeClaim",
		() => persistentVolumeClaim(),
		"bucket",
		"bucket.filesystem/v1",
		"kubernetes.persistent-volume-claim/v1",
	],
	[
		"secret",
		() => secret(),
		"secretRef",
		"secret-ref.runtime-projection/v1",
		"kubernetes.secret/v1",
	],
] as const;

describe("Kubernetes slot factories emit the documented triple", () => {
	it.each(
		NO_ARG_FACTORIES,
	)("%s binds slot/profile/product without arguments", (_name, call, slot, profile, productId) => {
		const binding = call();
		expect(binding.slot).toBe(slot);
		expect(binding.profile).toBe(profile);
		expect(binding.productId).toBe(productId);
	});

	it.each(
		NO_ARG_FACTORIES,
	)("%s yields empty properties when called with no options", (_name, call) => {
		expect(call().properties).toEqual({});
	});

	it("reaches the same Deployment product through two profiles", () => {
		expect(deployment().productId).toBe(deploymentWorker().productId);
		expect(deployment().profile).not.toBe(deploymentWorker().profile);
	});
});

describe("options land in properties and omitted options stay absent", () => {
	it("deployment keeps only the options the caller passed", () => {
		const binding = deployment({ replicas: 3 });
		expect(binding.properties).toEqual({ replicas: 3 });
		expect(Object.keys(binding.properties)).toEqual(["replicas"]);
		expect("image" in binding.properties).toBe(false);
		expect("namespace" in binding.properties).toBe(false);
	});

	it("deployment keeps nested quantity keys sparse", () => {
		const binding = deployment({ limits: { cpu: "500m" } });
		expect(binding.properties).toEqual({ limits: { cpu: "500m" } });
		expect("requests" in binding.properties).toBe(false);
		// SAFETY: assertion to `binding.properties.limits as JsonObject` is required at this boundary.
		const limits = binding.properties.limits as JsonObject;
		expect("memory" in limits).toBe(false);
	});

	it("persistentVolumeClaim invents no storage class or access mode", () => {
		const binding = persistentVolumeClaim({ storage: "10Gi" });
		expect(binding.properties).toEqual({ storage: "10Gi" });
		expect("storageClassName" in binding.properties).toBe(false);
		expect("accessMode" in binding.properties).toBe(false);
	});

	it("cronJob invents no concurrency policy when only the schedule is set", () => {
		const binding = cronJob({ schedule: "0 3 * * *" });
		expect(binding.properties).toEqual({ schedule: "0 3 * * *" });
		expect("concurrencyPolicy" in binding.properties).toBe(false);
	});

	it("service invents no port when only the type is set", () => {
		const binding = service({ type: "ClusterIP" });
		expect(binding.properties).toEqual({ type: "ClusterIP" });
		expect("port" in binding.properties).toBe(false);
	});
});

describe("the core parse boundary still applies", () => {
	it("refuses a credential-shaped option key that bypassed the types", () => {
		// SAFETY: assertion to `{ apiKey: "x" } as DeploymentOptions` is required at this boundary.
		const smuggled = { apiKey: "x" } as DeploymentOptions;
		expect(refusalCode(() => deployment(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	/**
	 * A Secret row names *where* material lives. Putting material on the row
	 * itself is refused by the same screen as anywhere else, which is what makes
	 * `secret-ref.locator/v1` a locator rather than a container.
	 */
	it("refuses material on the Secret locator row itself", () => {
		// SAFETY: assertion to `{ token: "abc" } as Parameters< typeof secret >[0]` is required at this boundary.
		const smuggled = { token: "abc" } as Parameters<typeof secret>[0];
		expect(refusalCode(() => secret(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	it("forwards an undeclared key instead of silently dropping it", () => {
		// SAFETY: assertion to `{ unknownKnob: 1 } as DeploymentOptions` is required at this boundary.
		const smuggled = { unknownKnob: 1 } as DeploymentOptions;
		expect(deployment(smuggled).properties).toEqual({ unknownKnob: 1 });
	});
});

describe("factories are deterministic and hand back frozen records", () => {
	it.each(NO_ARG_FACTORIES)("%s is deep-equal across calls", (_name, call) => {
		expect(call()).toEqual(call());
	});

	it("repeats identical output for identical options", () => {
		const options = {
			replicas: 3,
			limits: { cpu: "1", memory: "1Gi" },
		} as const;
		expect(deployment(options)).toEqual(deployment(options));
	});

	it.each(NO_ARG_FACTORIES)("%s returns a frozen record", (_name, call) => {
		const binding = call();
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.properties)).toBe(true);
	});
});
