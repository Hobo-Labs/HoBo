import { describe, expect, it } from "vitest";
import { SetOrigin } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import { createDesiredState, foldLegacyDeployment, LEGACY_EVENTS } from "../../src/sets/index.js";
import { camp, createFakeArtifactStore, createFakeEventStore, createRecordingTelemetry, ctxAt, OPERATOR, planOf, SHOP_V1, T0 } from "./fakes.js";

const plan = planOf(SHOP_V1);

async function legacyDeployment(
	store: ReturnType<typeof createFakeEventStore>,
	deploymentId: string,
	outcome: "deployed" | "rolled-back" | "planned",
	config: Record<string, unknown> = {},
) {
	const events = [
		{ type: LEGACY_EVENTS.requested, data: { deploymentId, bindleHash: "sha256:bindle", tenant: "acme", config } },
		...SHOP_V1.map((resource) => ({
			type: LEGACY_EVENTS.matchDecided,
			data: {
				deploymentId,
				resource: resource.name,
				winner: `${resource.name}-def`,
				providerId: "aws",
				port: "hobo:runtime/workflow",
				rationale: "cheapest",
			},
		})),
		{ type: LEGACY_EVENTS.planned, data: { deploymentId, planHash: "sha256:legacy-plan", plan } },
		...(outcome === "deployed"
			? [{ type: LEGACY_EVENTS.deployed, data: { deploymentId, setId: `${deploymentId}-set`, resourceIds: SHOP_V1.map((r) => r.name) } }]
			: outcome === "rolled-back"
				? [{ type: LEGACY_EVENTS.rolledBack, data: { deploymentId, targetSetId: `${deploymentId}-previous-set`, reason: "no-go" } }]
				: []),
	];
	await store.append(`deployment:${deploymentId}`, events, { expectedSeq: 0, actor: OPERATOR, tenant: "acme" });
}

describe("legacy fold: deployment.Planned/Deployed/RolledBack → Sets", () => {
	it("legacy estates get a current Set with SET_ORIGIN_LEGACY_FOLD and a verifiable blob", async () => {
		const store = createFakeEventStore();
		const telemetry = createRecordingTelemetry();
		await legacyDeployment(store, "shop", "deployed");
		const desired = createDesiredState({ store, artifacts: createFakeArtifactStore(), tenant: "acme", now: () => T0, telemetry });
		expect(await desired.current(camp("shop"))).toBeUndefined();
		const { adopted, skipped } = await desired.adoptLegacy(ctxAt(T0));
		expect(adopted).toHaveLength(1);
		expect(skipped).toEqual([]);
		const current = await desired.current(camp("shop"));
		expect(current?.origin).toBe(SetOrigin.LEGACY_FOLD);
		expect(current?.gateDecisionId).toBe("legacy:deployment:shop@5");
		expect(current?.predecessorSetId).toBe("");
		const resolved = await desired.resolved(current ?? adopted[0]!);
		expect(resolved.plan.resources.map((r) => r.name)).toEqual(["shop.api", "shop.cache", "shop.db"]);
		expect(resolved.matches.map((m) => m.providerId)).toEqual(["aws", "aws", "aws"]);
		expect(store.log.filter((e) => e.event.streamId === CD_STREAMS.campSpec("shop")).map((e) => e.event.type)).toEqual([
			CD_EVENTS.SetCreated,
		]);
		expect(telemetry.points.some((p) => p.name === "hobo.cd.sets.legacy_adopted")).toBe(true);
	});

	it("is idempotent and never overwrites a Camp that already has desired state", async () => {
		const store = createFakeEventStore();
		await legacyDeployment(store, "shop", "deployed");
		const desired = createDesiredState({ store, artifacts: createFakeArtifactStore(), tenant: "acme", now: () => T0 });
		await desired.adoptLegacy(ctxAt(T0));
		expect((await desired.adoptLegacy(ctxAt(T0 + 1))).adopted).toEqual([]);
		expect(store.log.filter((e) => e.event.type === CD_EVENTS.SetCreated)).toHaveLength(1);
	});

	it("a rolled-back or merely planned deployment yields no current Set", async () => {
		const store = createFakeEventStore();
		await legacyDeployment(store, "rolled", "rolled-back");
		await legacyDeployment(store, "planned", "planned");
		const desired = createDesiredState({ store, artifacts: createFakeArtifactStore(), tenant: "acme", now: () => T0 });
		expect((await desired.adoptLegacy(ctxAt(T0))).adopted).toEqual([]);
		expect(await desired.current(camp("rolled"))).toBeUndefined();
	});

	it("maps a legacy deployment to config.campId when one was recorded", async () => {
		const store = createFakeEventStore();
		await legacyDeployment(store, "shop", "deployed", { campId: "prod-aws", environment: "production" });
		const desired = createDesiredState({ store, artifacts: createFakeArtifactStore(), tenant: "acme", now: () => T0 });
		await desired.adoptLegacy(ctxAt(T0));
		const set = await desired.current(camp("prod-aws"));
		expect(set?.environment).toBe("production");
		expect(await desired.current(camp("shop"))).toBeUndefined();
	});

	it("only adopts the caller's tenant", async () => {
		const store = createFakeEventStore();
		await legacyDeployment(store, "shop", "deployed");
		const desired = createDesiredState({ store, artifacts: createFakeArtifactStore(), tenant: "other", now: () => T0 });
		expect((await desired.adoptLegacy({ ...ctxAt(T0), tenant: "other" })).adopted).toEqual([]);
	});

	it("foldLegacyDeployment is a pure fold over one deployment stream", () => {
		const envelope = (type: string, data: unknown, seq: number) => ({
			id: `e${seq}`,
			type,
			v: 1,
			streamId: "deployment:x",
			seq,
			ts: "2026-11-12T00:00:00.000Z",
			actor: OPERATOR,
			tenant: "acme",
			data,
		});
		const folded = foldLegacyDeployment([
			envelope(LEGACY_EVENTS.requested, { deploymentId: "x", tenant: "acme", config: {} }, 1),
			envelope(LEGACY_EVENTS.planned, { deploymentId: "x", planHash: "sha256:p", plan }, 2),
			envelope(LEGACY_EVENTS.deployed, { deploymentId: "x", setId: "x-set", resourceIds: [] }, 3),
		]);
		expect(folded?.campId).toBe("x");
		expect(folded?.state).toBe("deployed");
		expect(folded?.deployedAtSeq).toBe(3);
		expect(foldLegacyDeployment([])).toBeUndefined();
	});
});
