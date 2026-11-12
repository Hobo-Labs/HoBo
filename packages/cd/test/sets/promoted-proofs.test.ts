// Promoted proof semantics (AGENTS.md § Draft-proof promotion policy). The
// frozen proofs stay untouched; their claims that belong to Sets/Deltas are
// restated here against @hobo/cd/sets.
//   - src/draft/technical-proofs/delta-set-apply-reconcile-contract
//   - docs/design/proofs/hobo-50-deployment-set-delta
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ChangeKind,
	DeltaRecordSchema,
	SetOrigin,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import {
	createDesiredState,
	diffResolvedSets,
	encodeResolvedSetBlob,
	verifyResolvedSet,
} from "../../src/sets/index.js";
import {
	camp,
	createFakeArtifactStore,
	createFakeEventStore,
	ctxAt,
	deltaId,
	resolvedFor,
	reverseTopLevelKeys,
	SHOP_V1,
	SHOP_V2,
	T0,
} from "./fakes.js";

const PROD = camp("prod-aws");

function setup() {
	const store = createFakeEventStore();
	const artifacts = createFakeArtifactStore();
	return {
		store,
		artifacts,
		desired: createDesiredState({
			store,
			artifacts,
			tenant: "acme",
			now: () => T0,
		}),
	};
}

async function step(
	desired: ReturnType<typeof setup>["desired"],
	id: string,
	resources: typeof SHOP_V1,
	intent: string,
	origin: SetOrigin,
) {
	const current = await desired.current(PROD);
	const before = current ? await desired.resolved(current) : undefined;
	const resolved = resolvedFor("prod-aws", resources);
	const opened = await desired.open(
		create(DeltaRecordSchema, {
			deltaId: id,
			campId: "prod-aws",
			intent,
			baseSetId: current?.setId ?? "",
			changes: diffResolvedSets(before, resolved),
		}),
		ctxAt(T0),
	);
	if (!opened.ok) throw new Error(opened.reasons[0]?.code);
	const applied = await desired.apply(
		{ deltaId: deltaId(id), gateDecisionId: `gate-${id}`, resolved, origin },
		ctxAt(T0),
	);
	if (!applied.ok) throw new Error(applied.reasons[0]?.code);
	return applied.value;
}

describe("delta-set-apply-reconcile-contract", () => {
	it("delta.Applied produces a new immutable, content-addressed Set (set.Created last)", async () => {
		const { desired, store } = setup();
		await step(desired, "d1", SHOP_V1, "up", SetOrigin.UP);
		const set = await step(
			desired,
			"d2",
			SHOP_V2,
			"promote",
			SetOrigin.PROMOTION,
		);
		expect(set.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(store.log.at(-1)?.event.type).toBe(CD_EVENTS.SetCreated);
		expect(Object.isFrozen(set)).toBe(true);
	});

	it("an empty Delta is an explicit no-op and mints no Set", async () => {
		const { desired, store } = setup();
		const set = await step(desired, "d1", SHOP_V1, "up", SetOrigin.UP);
		const again = await step(
			desired,
			"d2",
			SHOP_V1,
			"config",
			SetOrigin.CONFIG,
		);
		expect(again.setId).toBe(set.setId);
		expect(
			store.log.filter((e) => e.event.type === CD_EVENTS.SetCreated),
		).toHaveLength(1);
	});

	it("only changed nodes appear in the Delta; unchanged resources emit nothing", () => {
		const changes = diffResolvedSets(
			resolvedFor("prod-aws", SHOP_V1),
			resolvedFor("prod-aws", SHOP_V2),
		);
		expect(changes.map((c) => `${ChangeKind[c.kind]}:${c.resource}`)).toEqual([
			"UPDATE:shop.api",
			"REMOVE:shop.cache",
			"ADD:shop.worker",
		]);
	});

	it("a desired Set with a missing dependency fails closed", () => {
		expect(() =>
			encodeResolvedSetBlob(
				resolvedFor("prod-aws", [{ name: "shop.api", deps: ["shop.db"] }]),
			),
		).toThrow(/missing dependency shop\.db/);
	});

	it("rollback re-applies the prior Set's content as a new Set through the same ledger (D12)", async () => {
		const { desired } = setup();
		const v1 = await step(desired, "d1", SHOP_V1, "up", SetOrigin.UP);
		const v2 = await step(
			desired,
			"d2",
			SHOP_V2,
			"promote",
			SetOrigin.PROMOTION,
		);
		const back = await step(
			desired,
			"d3",
			SHOP_V1,
			"rollback",
			SetOrigin.ROLLBACK,
		);
		expect(back.contentHash).toBe(v1.contentHash);
		expect(back.setId).not.toBe(v1.setId);
		expect(back.predecessorSetId).toBe(v2.setId);
		expect(back.origin).toBe(SetOrigin.ROLLBACK);
	});
});

describe("hobo-50-deployment-set-delta", () => {
	it("folding set.Created + delta.* yields the expected Set and Delta projections", async () => {
		const { desired } = setup();
		const v1 = await step(desired, "d1", SHOP_V1, "up", SetOrigin.UP);
		const v2 = await step(
			desired,
			"d2",
			SHOP_V2,
			"promote",
			SetOrigin.PROMOTION,
		);
		const spec = await desired.spec(PROD);
		expect(spec.current?.setId).toBe(v2.setId);
		expect(spec.current?.predecessorSetId).toBe(v1.setId);
		expect(spec.deltas.get("d2")?.status).toBe("applied");
		expect(spec.deltas.get("d2")?.decision?.setId).toBe(v2.setId);
		const resolved = await desired.resolved(v2);
		expect(resolved.plan.resources.map((r) => r.name)).toEqual([
			"shop.api",
			"shop.db",
			"shop.worker",
		]);
	});

	it("Set content addresses are stable across object key order", () => {
		const resolved = resolvedFor("prod-aws", SHOP_V2);
		const reordered = reverseTopLevelKeys(resolved);
		expect(verifyResolvedSet(reordered).contentHash).toBe(
			verifyResolvedSet(resolved).contentHash,
		);
	});

	it("a Delta cannot update or remove a resource absent from the base Set", async () => {
		const { desired } = setup();
		const v1 = await step(desired, "d1", SHOP_V1, "up", SetOrigin.UP);
		const outcome = await desired.open(
			create(DeltaRecordSchema, {
				deltaId: "d2",
				campId: "prod-aws",
				intent: "promote",
				baseSetId: v1.setId,
				changes: [
					{
						$typeName: "hobo.cd.v1.ResourceChange",
						resource: "shop.ghost",
						kind: ChangeKind.REMOVE,
						provider: "",
						productId: "",
						beforeHash: "",
						afterHash: "",
					},
				],
			}),
			ctxAt(T0),
		);
		expect(outcome.ok ? "ok" : outcome.reasons[0]?.code).toBe(
			"delta-absent-resource",
		);
	});
});
