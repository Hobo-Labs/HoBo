// WP22 CampInventory: Station-derived conditions, automatic taints, the NO_RUN
// rule, claims that narrow but never grant, Camp sets and a digest-stable
// snapshot (D19, D20, I18, I19; §10 rows owned by WP22).
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampClaimRecordSchema,
	CampConditionRecordSchema,
	CampConditionType,
	CampManagement,
	CampSetRecordSchema,
	type CampStatusRecord,
	ConditionStatus,
	ReconcileObservationRecordSchema,
	SelectorRecordSchema,
	SignalSource,
	TaintEffect,
	TaintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import {
	AUTO_TAINTS,
	createCampInventory,
	mergeContact,
} from "../../src/inventory/index.js";
import {
	AGENT,
	camp,
	clock,
	context,
	FakeAuthorizer,
	FakeDesired,
	FakeRails,
	FakeTopology,
	MemoryEventStore,
	MINUTE,
	OPERATOR,
	RecordingTelemetry,
	railDelivery,
	SECOND,
	STATION,
	TENANT,
	topology,
} from "./fakes.js";

function harness(
	declared = [topology("eu-1"), topology("us-1", { regions: ["us-east-1"] })],
) {
	const store = new MemoryEventStore();
	const time = clock();
	const topo = new FakeTopology(declared);
	const rails = new FakeRails();
	const desired = new FakeDesired();
	const authorizer = new FakeAuthorizer();
	const telemetry = new RecordingTelemetry();
	const make = () =>
		createCampInventory({
			store,
			tenant: TENANT,
			now: time.now,
			topology: topo,
			rails,
			desired,
			authorizer,
			telemetry,
		});
	const inventory = make();
	return {
		store,
		time,
		topo,
		rails,
		desired,
		authorizer,
		telemetry,
		inventory,
		make,
		ops: context(time.now),
		station: context(time.now, STATION),
		agent: context(time.now, AGENT),
	};
}

function condition(
	status: CampStatusRecord | undefined,
	type: CampConditionType,
	source = SignalSource.STATION,
) {
	return status?.conditions.find(
		(entry) => entry.type === type && entry.source === source,
	);
}

function taintKeys(
	status: CampStatusRecord | undefined,
	effect: TaintEffect,
): string[] {
	return (status?.taints ?? [])
		.filter((taint) => taint.effect === effect)
		.map((taint) => taint.key);
}

/** Cold-start the scan, then record Station-observed contact for each Camp. */
async function contact(h: ReturnType<typeof harness>, ...campIds: string[]) {
	await h.inventory.tick(h.station);
	for (const id of campIds) await h.store.reconcileEvent(id);
	await h.inventory.tick(h.station);
}

describe("CampInventory derivation (D19)", () => {
	it("a declared Camp never contacted is REACHABLE=UNKNOWN and NO_PLACE (fail closed)", async () => {
		const h = harness();
		const status = await h.inventory.status(camp("eu-1"));
		expect(condition(status, CampConditionType.REACHABLE)?.status).toBe(
			ConditionStatus.UNKNOWN,
		);
		expect(taintKeys(status, TaintEffect.NO_PLACE)).toContain(
			AUTO_TAINTS.unreachable,
		);
	});

	it("Station-observed reconcile activity derives REACHABLE and LEASED and clears the automatic taint", async () => {
		const h = harness();
		await contact(h, "eu-1");
		const status = await h.inventory.status(camp("eu-1"));
		expect(condition(status, CampConditionType.REACHABLE)?.status).toBe(
			ConditionStatus.TRUE,
		);
		expect(condition(status, CampConditionType.LEASED)?.status).toBe(
			ConditionStatus.TRUE,
		);
		expect(taintKeys(status, TaintEffect.NO_PLACE)).toEqual([]);
		expect(
			h.store
				.events(CD_STREAMS.campInventory("eu-1"))
				.some((event) => event.type === CD_EVENTS.CampUntainted),
		).toBe(true);
	});

	it("journal activity present before a cold start is not contact now", async () => {
		const h = harness();
		await h.store.reconcileEvent("eu-1");
		await h.inventory.tick(h.station);
		await h.inventory.tick(h.station);
		const status = await h.inventory.status(camp("eu-1"));
		expect(condition(status, CampConditionType.REACHABLE)?.status).toBe(
			ConditionStatus.UNKNOWN,
		);
	});

	it("loses the lease after the lease TTL and becomes unreachable after 90 s without contact", async () => {
		const h = harness();
		await contact(h, "eu-1");
		h.time.advance(CD_DEFAULTS.leaseTtlMs + SECOND);
		await h.inventory.tick(h.station);
		let status = await h.inventory.status(camp("eu-1"));
		expect(condition(status, CampConditionType.LEASED)?.status).toBe(
			ConditionStatus.FALSE,
		);
		expect(condition(status, CampConditionType.REACHABLE)?.status).toBe(
			ConditionStatus.TRUE,
		);
		expect(taintKeys(status, TaintEffect.NO_PLACE)).toEqual([
			AUTO_TAINTS.leaseLost,
		]);
		h.time.advance(CD_DEFAULTS.unreachableAfterMs);
		await h.inventory.tick(h.station);
		status = await h.inventory.status(camp("eu-1"));
		expect(condition(status, CampConditionType.REACHABLE)?.status).toBe(
			ConditionStatus.FALSE,
		);
		expect(taintKeys(status, TaintEffect.NO_PLACE).sort()).toEqual(
			[AUTO_TAINTS.leaseLost, AUTO_TAINTS.unreachable].sort(),
		);
		await h.store.reconcileEvent("eu-1");
		await h.inventory.tick(h.station);
		status = await h.inventory.status(camp("eu-1"));
		expect(taintKeys(status, TaintEffect.NO_PLACE)).toEqual([]);
	});

	it("a silent SVID refresh failure surfaces as CREDENTIAL_VALID=false within one tick", async () => {
		const h = harness();
		await contact(h, "eu-1");
		const expiresAt = new Date(
			h.time.now() + CD_DEFAULTS.svidTtlMs,
		).toISOString();
		const issued = await h.inventory.observe(
			{
				campId: camp("eu-1"),
				source: SignalSource.STATION,
				conditions: [
					create(CampConditionRecordSchema, {
						type: CampConditionType.CREDENTIAL_VALID,
						status: ConditionStatus.TRUE,
						reason: `expires-at:${expiresAt}`,
					}),
				],
				claims: [],
			},
			h.station,
		);
		expect(issued.ok).toBe(true);
		expect(
			condition(
				issued.ok ? issued.value : undefined,
				CampConditionType.CREDENTIAL_VALID,
			)?.status,
		).toBe(ConditionStatus.TRUE);
		// The agent never refreshes and nothing reports the failure. Keep the
		// Camp otherwise healthy so only the credential can trip.
		for (
			let elapsed = 0;
			elapsed < CD_DEFAULTS.svidTtlMs - CD_DEFAULTS.credentialWarningMs;
			elapsed += CD_DEFAULTS.serviceTickMs * 30
		) {
			await h.store.reconcileEvent("eu-1");
			h.time.advance(CD_DEFAULTS.serviceTickMs * 30);
		}
		await h.store.reconcileEvent("eu-1");
		await h.inventory.tick(h.station);
		const status = await h.inventory.status(camp("eu-1"));
		expect(condition(status, CampConditionType.CREDENTIAL_VALID)?.status).toBe(
			ConditionStatus.FALSE,
		);
		expect(
			condition(status, CampConditionType.CREDENTIAL_VALID)?.reason,
		).toMatch(/^svid-expiring-unrefreshed:/u);
		expect(taintKeys(status, TaintEffect.NO_PLACE)).toEqual([
			AUTO_TAINTS.credentialInvalid,
		]);
	});

	it("a reported refresh failure is FALSE at once and a later refresh clears it", async () => {
		const h = harness();
		await contact(h, "eu-1");
		const report = (status: ConditionStatus) =>
			h.inventory.observe(
				{
					campId: camp("eu-1"),
					source: SignalSource.STATION,
					conditions: [
						create(CampConditionRecordSchema, {
							type: CampConditionType.CREDENTIAL_VALID,
							status,
						}),
					],
					claims: [],
				},
				h.station,
			);
		const failed = await report(ConditionStatus.FALSE);
		expect(
			condition(
				failed.ok ? failed.value : undefined,
				CampConditionType.CREDENTIAL_VALID,
			)?.reason,
		).toBe("svid-refresh-failed");
		const refreshed = await report(ConditionStatus.TRUE);
		expect(
			condition(
				refreshed.ok ? refreshed.value : undefined,
				CampConditionType.CREDENTIAL_VALID,
			)?.status,
		).toBe(ConditionStatus.TRUE);
	});

	it("conductor-mode Camps (no SVID) carry no CREDENTIAL_VALID condition", async () => {
		const h = harness();
		await contact(h, "eu-1");
		expect(
			condition(
				await h.inventory.status(camp("eu-1")),
				CampConditionType.CREDENTIAL_VALID,
			),
		).toBeUndefined();
	});
});

describe("claims narrow, never grant (I19)", () => {
	it("a claim of region=eu-west-1 on a Camp declared in us-east-1 sets CLAIMS_CONSISTENT=false and taints it NO_PLACE", async () => {
		const h = harness();
		await contact(h, "us-1");
		const result = await h.inventory.observe(
			{
				campId: camp("us-1"),
				source: SignalSource.RECONCILER,
				conditions: [],
				claims: [
					create(CampClaimRecordSchema, { name: "region", value: "eu-west-1" }),
				],
			},
			h.agent,
		);
		expect(result.ok).toBe(true);
		const status = result.ok ? result.value : undefined;
		expect(condition(status, CampConditionType.CLAIMS_CONSISTENT)?.status).toBe(
			ConditionStatus.FALSE,
		);
		expect(condition(status, CampConditionType.CLAIMS_CONSISTENT)?.reason).toBe(
			"contradicts-topology:region=eu-west-1",
		);
		expect(taintKeys(status, TaintEffect.NO_PLACE)).toEqual([
			AUTO_TAINTS.claimsInconsistent,
		]);
		expect(status?.claims[0]?.reportedBy).toBe("agent:agent-7");
	});

	it("claims in the latest reconcile observation are merged on the next tick", async () => {
		const h = harness();
		await h.inventory.tick(h.station);
		h.desired.observations.set(
			"us-1",
			create(ReconcileObservationRecordSchema, {
				campId: "us-1",
				reconcilerId: "rec-9",
				claims: [
					create(CampClaimRecordSchema, { name: "region", value: "eu-west-1" }),
					create(CampClaimRecordSchema, { name: "platform", value: "linux" }),
				],
			}),
		);
		await h.store.reconcileEvent("us-1");
		await h.inventory.tick(h.station);
		const status = await h.inventory.status(camp("us-1"));
		expect(
			status?.claims.map(
				(claim) => `${claim.name}=${claim.value}@${claim.reportedBy}`,
			),
		).toEqual([
			"platform=linux@reconciler:rec-9",
			"region=eu-west-1@reconciler:rec-9",
		]);
		expect(taintKeys(status, TaintEffect.NO_PLACE)).toEqual([
			AUTO_TAINTS.claimsInconsistent,
		]);
	});

	it("consistent claims keep CLAIMS_CONSISTENT=true", async () => {
		const h = harness();
		await contact(h, "eu-1");
		const result = await h.inventory.observe(
			{
				campId: camp("eu-1"),
				source: SignalSource.RECONCILER,
				conditions: [],
				claims: [
					create(CampClaimRecordSchema, { name: "region", value: "eu-west-1" }),
					create(CampClaimRecordSchema, { name: "provider", value: "aws" }),
				],
			},
			h.agent,
		);
		expect(
			condition(
				result.ok ? result.value : undefined,
				CampConditionType.CLAIMS_CONSISTENT,
			)?.status,
		).toBe(ConditionStatus.TRUE);
	});
});

describe("NO_RUN only from an operator or a Rail rule (D19)", () => {
	it("an agent reporting itself unreachable 100 times adds no NO_RUN, even with Rail automation on", async () => {
		const h = harness();
		h.rails.delivery = railDelivery({ automatic: true });
		await contact(h, "eu-1");
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const result = await h.inventory.observe(
				{
					campId: camp("eu-1"),
					source: SignalSource.RECONCILER,
					conditions: [
						create(CampConditionRecordSchema, {
							type: CampConditionType.REACHABLE,
							status: ConditionStatus.FALSE,
							reason: "self-report",
						}),
						create(CampConditionRecordSchema, {
							type: CampConditionType.READY,
							status: ConditionStatus.FALSE,
						}),
					],
					claims: [],
				},
				h.agent,
			);
			expect(result.ok).toBe(true);
			await h.inventory.tick(h.station);
		}
		const status = await h.inventory.status(camp("eu-1"));
		expect(taintKeys(status, TaintEffect.NO_RUN)).toEqual([]);
		expect(condition(status, CampConditionType.REACHABLE)?.status).toBe(
			ConditionStatus.TRUE,
		);
		expect(
			condition(status, CampConditionType.REACHABLE, SignalSource.RECONCILER)
				?.status,
		).toBe(ConditionStatus.FALSE);
	});

	it("an agent principal cannot report as the Station", async () => {
		const h = harness();
		const result = await h.inventory.observe(
			{
				campId: camp("eu-1"),
				source: SignalSource.STATION,
				conditions: [
					create(CampConditionRecordSchema, {
						type: CampConditionType.REACHABLE,
						status: ConditionStatus.FALSE,
					}),
				],
				claims: [],
			},
			h.agent,
		);
		expect(result.ok ? "" : result.reasons[0]?.code).toBe(
			"source-not-permitted",
		);
	});

	it("a Rail rule adds NO_RUN with two independent signals, one Station-observed", async () => {
		const h = harness();
		h.rails.delivery = railDelivery({ automatic: true, requiredSignals: 2 });
		await contact(h, "eu-1");
		await h.inventory.observe(
			{
				campId: camp("eu-1"),
				source: SignalSource.HEALTH_SOURCE,
				conditions: [
					create(CampConditionRecordSchema, {
						type: CampConditionType.READY,
						status: ConditionStatus.FALSE,
						reason: "5xx",
					}),
				],
				claims: [],
			},
			h.station,
		);
		expect(
			taintKeys(await h.inventory.status(camp("eu-1")), TaintEffect.NO_RUN),
		).toEqual([]);
		h.time.advance(CD_DEFAULTS.unreachableAfterMs + SECOND);
		await h.inventory.tick(h.station);
		const status = await h.inventory.status(camp("eu-1"));
		expect(taintKeys(status, TaintEffect.NO_RUN)).toEqual([AUTO_TAINTS.failed]);
		expect(
			status?.taints.find((taint) => taint.effect === TaintEffect.NO_RUN)
				?.reason,
		).toBe("rail-rule:signals=STATION+HEALTH_SOURCE");
	});

	it("without Rail automation the same signals add no NO_RUN", async () => {
		const h = harness();
		await contact(h, "eu-1");
		await h.inventory.observe(
			{
				campId: camp("eu-1"),
				source: SignalSource.HEALTH_SOURCE,
				conditions: [
					create(CampConditionRecordSchema, {
						type: CampConditionType.READY,
						status: ConditionStatus.FALSE,
					}),
				],
				claims: [],
			},
			h.station,
		);
		h.time.advance(CD_DEFAULTS.unreachableAfterMs + SECOND);
		await h.inventory.tick(h.station);
		expect(
			taintKeys(await h.inventory.status(camp("eu-1")), TaintEffect.NO_RUN),
		).toEqual([]);
	});

	it("an operator adds and removes NO_RUN; a non-human OPERATOR source is refused", async () => {
		const h = harness();
		const added = await h.inventory.taint(
			{
				campId: camp("eu-1"),
				taint: create(TaintRecordSchema, {
					key: "maintenance",
					value: "rack-7",
					effect: TaintEffect.NO_RUN,
					reason: "planned",
				}),
			},
			h.ops,
		);
		expect(added.ok).toBe(true);
		expect(
			added.ok
				? added.value.taints.find((taint) => taint.key === "maintenance")
						?.addedBy
				: "",
		).toBe("user:ops@acme");
		expect(h.authorizer.calls.at(-1)?.action).toBe("camp.taint");
		const service = await h.inventory.taint(
			{
				campId: camp("eu-1"),
				taint: create(TaintRecordSchema, {
					key: "other",
					effect: TaintEffect.NO_RUN,
					source: SignalSource.OPERATOR,
				}),
			},
			h.station,
		);
		expect(service.ok ? "" : service.reasons[0]?.code).toBe(
			"no-run-not-permitted",
		);
		const removed = await h.inventory.untaint(
			{ campId: camp("eu-1"), key: "maintenance", effect: TaintEffect.NO_RUN },
			h.ops,
		);
		expect(
			removed.ok ? taintKeys(removed.value, TaintEffect.NO_RUN) : ["x"],
		).toEqual([]);
	});

	it("a Station NO_RUN taint without the Rail rule is refused", async () => {
		const h = harness();
		const result = await h.inventory.taint(
			{
				campId: camp("eu-1"),
				taint: create(TaintRecordSchema, {
					key: "zone-down",
					effect: TaintEffect.NO_RUN,
					source: SignalSource.STATION,
				}),
			},
			h.station,
		);
		expect(result.ok ? "" : result.reasons[0]?.code).toBe(
			"no-run-not-permitted",
		);
	});

	it("taints are governed: denied, proposal-only agents, reserved keys and automatic untaints are refused", async () => {
		const h = harness();
		const agent = await h.inventory.taint(
			{
				campId: camp("eu-1"),
				taint: create(TaintRecordSchema, {
					key: "x",
					effect: TaintEffect.NO_PLACE,
				}),
			},
			h.agent,
		);
		expect(agent.ok ? "" : agent.reasons[0]?.code).toBe("proposal-only");
		h.authorizer.denied.add("camp.taint");
		const denied = await h.inventory.taint(
			{
				campId: camp("eu-1"),
				taint: create(TaintRecordSchema, {
					key: "x",
					effect: TaintEffect.NO_PLACE,
				}),
			},
			h.ops,
		);
		expect(denied.ok ? "" : denied.reasons[0]?.code).toBe("policy-denied");
		const reserved = await h.inventory.taint(
			{
				campId: camp("eu-1"),
				taint: create(TaintRecordSchema, {
					key: "hobo.cd/unreachable",
					effect: TaintEffect.NO_PLACE,
				}),
			},
			h.ops,
		);
		expect(reserved.ok ? "" : reserved.reasons[0]?.code).toBe("taint-reserved");
		const automatic = await h.inventory.untaint(
			{
				campId: camp("eu-1"),
				key: AUTO_TAINTS.unreachable,
				effect: TaintEffect.NO_PLACE,
			},
			h.ops,
		);
		expect(automatic.ok ? "" : automatic.reasons[0]?.remediation).toMatch(
			/underlying condition/u,
		);
	});

	it("taint is idempotent: the same taint twice appends once", async () => {
		const h = harness();
		const command = {
			campId: camp("eu-1"),
			taint: create(TaintRecordSchema, {
				key: "pin",
				value: "v",
				effect: TaintEffect.NO_PLACE,
			}),
		};
		await h.inventory.taint(command, h.ops);
		const before = h.store.events(CD_STREAMS.campInventory("eu-1")).length;
		await h.inventory.taint(command, h.ops);
		expect(h.store.events(CD_STREAMS.campInventory("eu-1")).length).toBe(
			before,
		);
	});
});

describe("management, sets and snapshot (D20)", () => {
	it("manage switches a Camp to OBSERVE_ONLY under camp.manage", async () => {
		const h = harness();
		const result = await h.inventory.manage(
			{ campId: camp("eu-1"), management: CampManagement.OBSERVE_ONLY },
			h.ops,
		);
		expect(result.ok ? result.value.management : 0).toBe(
			CampManagement.OBSERVE_ONLY,
		);
		expect(
			h.store
				.events(CD_STREAMS.campInventory("eu-1"))
				.map((event) => event.type),
		).toContain(CD_EVENTS.CampManagementChanged);
		expect(h.authorizer.calls.at(-1)?.action).toBe("camp.manage");
	});

	it("defineSet records membership by selector and id, idempotently", async () => {
		const h = harness([
			topology("eu-1", { labels: { tier: "web" } }),
			topology("eu-2"),
			topology("us-1", { regions: ["us-east-1"], labels: { tier: "web" } }),
		]);
		const set = create(CampSetRecordSchema, {
			name: "web",
			selector: create(SelectorRecordSchema, { labels: { tier: "web" } }),
			campIds: ["eu-2"],
		});
		const first = await h.inventory.defineSet(set, h.ops);
		expect(first.ok ? first.value.definedBy : "").toBe("user:ops@acme");
		await h.inventory.defineSet(set, h.ops);
		expect(h.store.events(CD_STREAMS.campSet("web"))).toHaveLength(1);
		expect(
			(await h.inventory.list({ campSets: ["web"] })).map(
				(view) => view.topology.campId,
			),
		).toEqual(["eu-1", "eu-2", "us-1"]);
		const eu = create(CampSetRecordSchema, {
			name: "eu",
			selector: create(SelectorRecordSchema, { jurisdictions: ["eu"] }),
		});
		await h.inventory.defineSet(eu, h.ops);
		expect(
			(await h.inventory.list({ campSets: ["eu"] })).map(
				(view) => view.topology.campId,
			),
		).toEqual(["eu-1", "eu-2"]);
		expect((await h.inventory.sets()).map((entry) => entry.name)).toEqual([
			"eu",
			"web",
		]);
		expect(
			h.authorizer.calls.every((call) => call.action === "campset.define"),
		).toBe(true);
	});

	it("defineSet refuses empty definitions and bindle selectors with remediation", async () => {
		const h = harness();
		const empty = await h.inventory.defineSet(
			create(CampSetRecordSchema, { name: "none" }),
			h.ops,
		);
		expect(empty.ok ? "" : empty.reasons[0]?.code).toBe("campset-empty");
		const bindles = await h.inventory.defineSet(
			create(CampSetRecordSchema, {
				name: "b",
				selector: create(SelectorRecordSchema, { bindles: ["shop"] }),
			}),
			h.ops,
		);
		expect(bindles.ok ? "" : bindles.reasons[0]?.code).toBe(
			"selector-unsupported",
		);
		expect(bindles.ok ? "" : bindles.reasons[0]?.remediation).not.toBe("");
	});

	it("snapshot is canonical and digest-stable across topology order and instances", async () => {
		const declared = [
			topology("b", { regions: ["us-east-1", "eu-west-1"] }),
			topology("a"),
			topology("c"),
		];
		const h = harness(declared);
		await h.inventory.defineSet(
			create(CampSetRecordSchema, { name: "all", campIds: ["a", "b", "c"] }),
			h.ops,
		);
		await contact(h, "a", "b");
		const first = await h.inventory.snapshot(["all"]);
		h.topo.declared = [...declared].reverse();
		const again = await h.make().snapshot(["all", "all"]);
		expect(again.digest).toBe(first.digest);
		expect(first.camps.map((view) => view.topology.campId)).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(first.camps[1]?.topology.regions).toEqual([
			"eu-west-1",
			"us-east-1",
		]);
		await h.inventory.taint(
			{
				campId: camp("a"),
				taint: create(TaintRecordSchema, {
					key: "pin",
					effect: TaintEffect.NO_PLACE,
				}),
			},
			h.ops,
		);
		expect((await h.inventory.snapshot(["all"])).digest).not.toBe(first.digest);
	});

	it("rebuilds every Camp's status from the journal alone", async () => {
		const h = harness();
		await contact(h, "eu-1");
		await h.inventory.taint(
			{
				campId: camp("eu-1"),
				taint: create(TaintRecordSchema, {
					key: "pin",
					effect: TaintEffect.NO_PLACE,
				}),
			},
			h.ops,
		);
		const live = await h.inventory.status(camp("eu-1"));
		const rebuilt = await h.make().status(camp("eu-1"));
		expect(rebuilt).toEqual(live);
	});

	it("retries a command after a concurrent writer moves the stream head", async () => {
		const h = harness();
		const other = h.make();
		h.store.beforeAppend = async () => {
			await other.taint(
				{
					campId: camp("eu-1"),
					taint: create(TaintRecordSchema, {
						key: "first",
						effect: TaintEffect.NO_PLACE,
					}),
				},
				h.ops,
			);
		};
		const result = await h.inventory.taint(
			{
				campId: camp("eu-1"),
				taint: create(TaintRecordSchema, {
					key: "second",
					effect: TaintEffect.NO_PLACE,
				}),
			},
			h.ops,
		);
		expect(
			result.ok ? taintKeys(result.value, TaintEffect.NO_PLACE).sort() : [],
		).toEqual(["first", "second", AUTO_TAINTS.unreachable].sort());
	});

	it("emits taint and fleet gauges through the TelemetrySink", async () => {
		const h = harness();
		await contact(h, "eu-1");
		expect(h.telemetry.count("hobo.cd.inventory.taints")).toBeGreaterThan(0);
		const gauges = h.telemetry.points.filter(
			(point) =>
				point.name === "hobo.cd.inventory.camps" &&
				point.attributes.taint === "NO_PLACE",
		);
		expect(gauges.at(-1)?.value).toBe(1);
	});

	it("observations for an undeclared Camp are refused", async () => {
		const h = harness();
		const result = await h.inventory.observe(
			{
				campId: camp("ghost"),
				source: SignalSource.HEALTH_SOURCE,
				conditions: [],
				claims: [],
			},
			h.station,
		);
		expect(result.ok ? "" : result.reasons[0]?.code).toBe("camp-unknown");
	});

	it("advancing past the unreachable threshold keeps a minute-old OPERATOR condition", async () => {
		const h = harness();
		await h.inventory.observe(
			{
				campId: camp("eu-1"),
				source: SignalSource.OPERATOR,
				conditions: [
					create(CampConditionRecordSchema, {
						type: CampConditionType.READY,
						status: ConditionStatus.TRUE,
					}),
				],
				claims: [],
			},
			context(h.time.now, OPERATOR),
		);
		h.time.advance(MINUTE);
		await h.inventory.tick(h.station);
		expect(
			condition(
				await h.inventory.status(camp("eu-1")),
				CampConditionType.READY,
				SignalSource.OPERATOR,
			)?.status,
		).toBe(ConditionStatus.TRUE);
	});
});

describe("replica contact merge", () => {
	it("keeps the newest contact of each kind and the latest credential report", () => {
		const merged = mergeContact(
			{
				lastContactMs: 10,
				lastLeaseMs: 5,
				credentialReportedMs: 3,
				credentialFailedMs: 3,
			},
			{
				lastContactMs: 7,
				lastLeaseMs: 9,
				credentialReportedMs: 4,
				credentialExpiresMs: 100,
			},
		);
		expect(merged).toEqual({
			lastContactMs: 10,
			lastLeaseMs: 9,
			unreachableReportedMs: undefined,
			leaseLostMs: undefined,
			credentialReportedMs: 4,
			credentialExpiresMs: 100,
		});
	});
});
