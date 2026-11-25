import { type CapabilitySlot, capability } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_REGIONS,
	KUBERNETES_DEFAULT_BINDINGS,
	kubernetesYardSpec,
} from "../src/index.js";

/**
 * Every published capability profile, derived from `@hobo/core`'s catalog
 * rather than restated here.
 *
 * This used to be a hand-written list, and it drifted the moment a factory was
 * pointed at a more specific profile — the test failed for the list's reason,
 * not the catalog's. Deriving it means a profile the core vocabulary adds is
 * automatically legal, and a profile it does not define still fails.
 */
const REAL_PROFILES: readonly string[] = Object.values(capability).flatMap(
	(family) => Object.values(family),
);

/** Entries declared for one slot, or an empty list when the slot is absent. */
function slotEntries(slot: CapabilitySlot) {
	return KUBERNETES_DEFAULT_BINDINGS[slot] ?? [];
}

describe("the Kubernetes Yard is an allocatable catalog", () => {
	it.each([
		["web", "web.hosted/v1", "kubernetes.deployment/v1"],
		["api", "api.http/v1", "kubernetes.service/v1"],
		["service", "service.batch/v1", "kubernetes.job/v1"],
		["bucket", "bucket.filesystem/v1", "kubernetes.persistent-volume-claim/v1"],
		["secretRef", "secret-ref.runtime-projection/v1", "kubernetes.secret/v1"],
	] as const)("declares %s from the landed factories", (slot, profile, productId) => {
		const entries = slotEntries(slot);
		expect(entries.map((entry) => entry.profile)).toContain(profile);
		expect(entries.map((entry) => entry.productId)).toContain(productId);
	});

	it("holds a non-empty list per slot", () => {
		for (const entries of Object.values(KUBERNETES_DEFAULT_BINDINGS)) {
			expect(Array.isArray(entries)).toBe(true);
			expect(entries.length).toBeGreaterThan(0);
		}
	});

	/**
	 * The load-bearing honesty test. Kubernetes provides no database, cache,
	 * queue or topic — those arrive through operators, which are third-party
	 * software this package cannot see, let alone install. A row for one would
	 * be a claim about somebody else's software.
	 */
	it("leaves the slots that need an operator empty", () => {
		for (const slot of ["data", "kv", "queue", "topic"] as const) {
			expect(slotEntries(slot)).toEqual([]);
		}
	});

	/**
	 * A cluster offers several distinct controllers for the same capability and
	 * a workload picks between them for reasons only it knows — stable identity
	 * for a StatefulSet, one-pod-per-node for a DaemonSet. Every one of them is
	 * a row.
	 */
	it("declares every built-in controller that satisfies a capability", () => {
		expect(slotEntries("web").map((entry) => entry.productId)).toEqual(
			expect.arrayContaining([
				"kubernetes.deployment/v1",
				"kubernetes.statefulset/v1",
			]),
		);
		expect(slotEntries("service").map((entry) => entry.productId)).toEqual(
			expect.arrayContaining([
				"kubernetes.deployment/v1",
				"kubernetes.statefulset/v1",
				"kubernetes.daemonset/v1",
				"kubernetes.job/v1",
				"kubernetes.cronjob/v1",
			]),
		);
	});

	it("declares both ways a cluster can front an HTTP capability", () => {
		expect(slotEntries("api").map((entry) => entry.productId)).toEqual(
			expect.arrayContaining([
				"kubernetes.service/v1",
				"kubernetes.ingress/v1",
			]),
		);
	});

	it("files every entry under the slot the binding itself names", () => {
		for (const [slot, entries] of Object.entries(KUBERNETES_DEFAULT_BINDINGS)) {
			for (const entry of entries ?? []) {
				expect(entry.slot).toBe(slot);
			}
		}
	});

	it("names only published capability profiles", () => {
		for (const entries of Object.values(KUBERNETES_DEFAULT_BINDINGS)) {
			for (const entry of entries ?? []) {
				expect(REAL_PROFILES).toContain(entry.profile);
			}
		}
	});

	it("invents no properties on a catalog entry", () => {
		for (const entries of Object.values(KUBERNETES_DEFAULT_BINDINGS)) {
			for (const entry of entries ?? []) {
				expect(entry.properties).toEqual({});
			}
		}
	});

	it("freezes the catalog and its slot lists", () => {
		expect(Object.isFrozen(KUBERNETES_DEFAULT_BINDINGS)).toBe(true);
		for (const entries of Object.values(KUBERNETES_DEFAULT_BINDINGS)) {
			expect(Object.isFrozen(entries)).toBe(true);
		}
	});
});

describe("kubernetesYardSpec emits raw, canonical rows", () => {
	it("carries the provider id and the published topology labels", () => {
		const spec = kubernetesYardSpec();
		expect(spec.provider).toBe("kubernetes");
		expect(spec.regions).toEqual(DEFAULT_REGIONS);
	});

	it("takes the caller's topology labels without reordering them", () => {
		expect(
			kubernetesYardSpec({ regions: ["eu-west-1a", "eu-west-1b"] }).regions,
		).toEqual(["eu-west-1a", "eu-west-1b"]);
	});

	it("emits one row per catalog entry, dropping none", () => {
		const declared = Object.values(KUBERNETES_DEFAULT_BINDINGS).reduce(
			(total, entries) => total + (entries?.length ?? 0),
			0,
		);
		expect(kubernetesYardSpec().bindings).toHaveLength(declared);
	});

	/**
	 * `deployment()` and `deploymentWorker()` emit the same productId under
	 * different profiles. Rows key on `(profile, productId, connectivityId)`,
	 * so both survive — a dedup on productId alone would silently drop one.
	 */
	it("keeps one product reached through two profiles as two rows", () => {
		const rows = kubernetesYardSpec().bindings.filter(
			(row) => row.productId === "kubernetes.deployment/v1",
		);
		expect(rows.map((row) => row.profile).sort()).toEqual([
			"service.worker/v1",
			"web.hosted/v1",
		]);
	});

	it("sorts rows by (profile, productId, connectivityId)", () => {
		const keys = kubernetesYardSpec().bindings.map(
			(row) =>
				`${row.profile} ${row.productId ?? ""} ${row.connectivityId ?? ""}`,
		);
		expect(keys).toEqual([...keys].sort());
	});

	it("carries no duplicate (profile, productId, connectivityId) triple", () => {
		const keys = kubernetesYardSpec().bindings.map(
			(row) =>
				`${row.profile}|${row.productId ?? ""}|${row.connectivityId ?? ""}`,
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("omits the slot from a row, because rows key on the profile", () => {
		for (const row of kubernetesYardSpec().bindings) {
			expect("slot" in row).toBe(false);
		}
	});

	it("is deterministic and frozen", () => {
		expect(kubernetesYardSpec()).toEqual(kubernetesYardSpec());
		const spec = kubernetesYardSpec();
		expect(Object.isFrozen(spec)).toBe(true);
		expect(Object.isFrozen(spec.bindings)).toBe(true);
		expect(Object.isFrozen(spec.regions)).toBe(true);
	});
});
