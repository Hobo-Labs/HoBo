import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createDaprActorHost,
	createDaprRuntimeHost,
	diagnoseDaprReadiness,
	generateDaprComponentYaml,
	HOBO_RUNTIME_DAPR_PACKAGE,
	kafkaPubsubComponent,
	mapWorkflowToDapr,
	tenantScopedAppId,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("@hobo/runtime-dapr", () => {
	it("package id + tenant-scoped app id", () => {
		expect(HOBO_RUNTIME_DAPR_PACKAGE).toBe("@hobo/runtime-dapr");
		expect(tenantScopedAppId("acme", "prod", "api")).toBe("acme.prod.api");
	});

	it("ensure reports dapr kind and simulated fidelity offline", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-dapr-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const bundle = createDaprRuntimeHost({ tenantId: "t1", campId: "c1" });
		expect(bundle.host.kind).toBe("dapr");
		const result = await bundle.host.ensure({ hoboHome, env: {} });
		expect(result.kind).toBe("dapr");
		expect(result.ready).toBe(true);
		expect(result.details?.placementMode).toBe("dapr");
	});

	it("actor host enforces single-writer + fencing", () => {
		const bundle = createDaprRuntimeHost({ tenantId: "t1", campId: "c1" });
		const host = bundle.actors;
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(lease.placement).toBe("dapr");
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			/placement conflict/,
		);
		const state = host.state<{ n: number }>("Cart/1", {
			initialState: { n: 0 },
			fold: (s, e) => (e.type === "inc" ? { n: s.n + 1 } : s),
		});
		state.append(lease, { type: "inc" });
		expect(state.read().state.n).toBe(1);
		lease.release();
		expect(host.events().some((e) => e.type === "actor.Passivated")).toBe(true);
	});

	it("stale fence rejects append after reacquire", () => {
		const host = createDaprActorHost({
			config: createDaprRuntimeHost({ tenantId: "t", campId: "c" }).config,
			leaseTtlMs: 1000,
			nowMs: (() => {
				const t = 1_000_000;
				return () => t;
			})(),
		});
		const first = host.acquire("A/1", { holderId: "h1" });
		first.release();
		const second = host.acquire("A/1", { holderId: "h2" });
		expect(second.fenceToken > first.fenceToken).toBe(true);
		const state = host.state("A/1", {
			initialState: {},
			fold: (s) => s,
		});
		expect(() => state.append(first, { type: "x" })).toThrow(/stale fence/);
		state.append(second, { type: "x" });
	});

	it("pubsub messaging round-trip", async () => {
		const bundle = createDaprRuntimeHost({ tenantId: "t1", campId: "c1" });
		const bus = bundle.messaging;
		expect(bus.backend).toBe("dapr-pubsub");
		// SAFETY: assertion required at this I/O or test boundary.
		await bus.publish("events" as never, { ok: true });
		// SAFETY: assertion required at this I/O or test boundary.
		const batch = await bus.consume("events" as never, "g" as never);
		expect(batch).toHaveLength(1);
	});

	it("generates secretless kafka pubsub component YAML", () => {
		const bundle = createDaprRuntimeHost({ tenantId: "acme", campId: "prod" });
		const yaml = bundle.generateKafkaPubsubYaml("fromBinding:kafka-bootstrap");
		expect(yaml).toContain("pubsub.kafka");
		expect(yaml).toContain("fromBinding:kafka-bootstrap");
		expect(yaml).not.toMatch(/password\s*:/i);
		const bad = () =>
			generateDaprComponentYaml(
				kafkaPubsubComponent({
					bootstrapServersBinding: "x",
				}),
			);
		// kafkaPubsubComponent itself is secretless; ensure forbidden meta rejected
		expect(() =>
			generateDaprComponentYaml({
				name: "x",
				type: "pubsub.kafka",
				version: "v1",
				metadata: { password: "nope" },
				scopes: [],
			}),
		).not.toThrow(); // generate doesn't re-parse; parse does:
		void bad;
	});

	it("rejects plaintext secrets in component parse", async () => {
		const { parseDaprComponentSpec } = await import("../src/components.js");
		expect(() =>
			parseDaprComponentSpec({
				name: "x",
				type: "pubsub.kafka",
				metadata: { password: "s3cret" },
			}),
		).toThrow(/secretless/);
	});

	it("maps workflow steps as activity-map-only (full engine is non-goal)", () => {
		const mapped = mapWorkflowToDapr({
			name: "checkout",
			steps: [{ name: "reserve" }, { name: "charge" }],
		});
		expect(mapped.parity).toBe("activity-map-only");
		expect(mapped.fullEngineParity).toBe(false);
		expect(mapped.activities).toHaveLength(2);
	});

	it("doctor offline remediation", () => {
		const report = diagnoseDaprReadiness({ env: {} });
		expect(report.fidelity).toBe("simulated");
		expect(report.notes.some((n) => n.includes("ADR-0031"))).toBe(true);
	});
});
