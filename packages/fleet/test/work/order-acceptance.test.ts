/**
 * O44: an order runs only when every acceptance rule of §6.9 step 6 holds.
 * One refusing case per rule, each naming its rule in `detail.check`,
 * including a repository, ref or workflow digest the fleet policy does not
 * allow; and residency (§6.13): an undeclared, unmapped or disallowed region
 * is excluded by the dispatcher (its claim is not entitled, and the device
 * itself does not claim) and refused by the device.
 */
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CoordinationMode,
	DeviceClass,
	ResidencyRuleSchema,
	Role,
	SandboxTier,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	TrustClass,
	WorkOrderSchema,
} from "../../src/_generated/fleet_pb.js";
import { OFFER_CONTEXT, ORDER_CONTEXT } from "../../src/contexts.js";
import { parseWorkDigest, type WorkDigest } from "../../src/ids.js";
import { signEnvelope } from "../../src/keys/index.js";
import type { RegistryView } from "../../src/ports.js";
import { createMemoryBus } from "../../src/testing/plumbing/index.js";
import {
	checkClaim,
	checkOrder,
	createDispatcher,
	createExecutor,
	workDigest,
} from "../../src/work/index.js";
import {
	authorityKey,
	claimFor,
	type Device,
	device,
	FLEET,
	fleetRecord,
	iso,
	NOW,
	offer,
	openPolicy,
	orderFor,
	publishObservation,
	registry,
	seedBus,
	submission,
} from "./fixtures.js";
import {
	capacity,
	egress,
	fakeDriver,
	recorder,
	reports,
	testRunner,
	testSource,
	upstream,
} from "./harness.js";

const ORDER_ID = "0123456789abcdef0123456789abcdef";

async function world(fleetPolicy = openPolicy()) {
	const authority = authorityKey();
	const dispatcher = await device({ roles: [Role.DISPATCHER] });
	const executor = await device({
		roles: [Role.EXECUTOR],
		deviceClass: DeviceClass.EPHEMERAL,
	});
	const bystander = await device({ roles: [Role.EXECUTOR] });
	const fleets = [fleetRecord(fleetPolicy)];
	const view = registry(
		[dispatcher.record, executor.record, bystander.record],
		fleets,
		authority,
	);
	const work = offer(dispatcher.keys.memberId);
	return { authority, dispatcher, executor, bystander, view, work };
}

type Context = Readonly<{
	self: Device;
	view: RegistryView;
	held?: readonly WorkDigest[];
	seen?: readonly string[];
	nowMs?: number;
}>;

async function refusal(order: SignedEnvelope, context: Context) {
	const outcome = await checkOrder(order, {
		self: context.self.record,
		registry: context.view,
		heldClaims: new Set(context.held ?? []),
		seenOrderIds: new Set(context.seen ?? []),
		nowMs: context.nowMs ?? NOW,
	});
	return outcome.ok
		? "accepted"
		: `${outcome.error.code}/${outcome.error.detail?.check ?? ""}`;
}

const digestOf = (work: { workDigest: string }) =>
	parseWorkDigest(work.workDigest);

describe("checkOrder: every rule of §6.9 step 6", () => {
	it("accepts an order that satisfies every rule, with the class the device derives", async () => {
		const w = await world();
		const order = await orderFor(w.dispatcher.keys, w.executor, w.work, {
			sandboxTier: SandboxTier.S1_CONTAINER,
		});
		const outcome = await checkOrder(order, {
			self: w.executor.record,
			registry: w.view,
			heldClaims: new Set([digestOf(w.work)]),
			seenOrderIds: new Set(),
			nowMs: NOW,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.order.orderId).toBe(ORDER_ID);
		expect(outcome.value.trust).toBe(TrustClass.ORG);
		expect(outcome.value.tier).toBe(SandboxTier.S1_CONTAINER);
	});

	it("the envelope verifies against the SIGN key of a dispatcher of the order's fleet", async () => {
		const w = await world();
		const context = {
			self: w.executor,
			view: w.view,
			held: [digestOf(w.work)],
		};
		const good = await orderFor(w.dispatcher.keys, w.executor, w.work);
		expect(
			await refusal(
				create(SignedEnvelopeSchema, { ...good, context: OFFER_CONTEXT }),
				context,
			),
		).toBe("order-invalid/context");
		const bytes = good.signature.slice();
		bytes[0] = (bytes[0] ?? 0) ^ 1;
		expect(
			await refusal(
				create(SignedEnvelopeSchema, { ...good, signature: bytes }),
				context,
			),
		).toBe("order-invalid/signer");
		const stranger = await device({ roles: [Role.DISPATCHER] });
		expect(
			await refusal(
				await orderFor(
					stranger.keys,
					w.executor,
					offer(stranger.keys.memberId),
				),
				context,
			),
		).toBe("order-invalid/signer");
		// An executor of the fleet is not a dispatcher of it.
		expect(
			await refusal(
				await orderFor(
					w.bystander.keys,
					w.executor,
					offer(w.bystander.keys.memberId),
				),
				{ ...context, held: [digestOf(offer(w.bystander.keys.memberId))] },
			),
		).toBe("order-invalid/dispatcher");
		// A dispatcher signing an offer another dispatcher made.
		expect(
			await refusal(
				await orderFor(
					w.dispatcher.keys,
					w.executor,
					offer(w.bystander.keys.memberId),
				),
				context,
			),
		).toBe("order-invalid/dispatcher");
		const garbage = await signEnvelope(
			w.dispatcher.keys.sign,
			ORDER_CONTEXT,
			new Uint8Array([0xff, 0xff, 0xff]),
		);
		expect(await refusal(garbage, context)).toBe("order-invalid/payload");
		const empty = await signEnvelope(
			w.dispatcher.keys.sign,
			ORDER_CONTEXT,
			toBinary(WorkOrderSchema, create(WorkOrderSchema, {})),
		);
		expect(await refusal(empty, context)).toBe("order-invalid/payload");
	});

	it("the order names this device", async () => {
		const w = await world();
		const order = await orderFor(w.dispatcher.keys, w.bystander, w.work);
		expect(
			await refusal(order, {
				self: w.executor,
				view: w.view,
				held: [digestOf(w.work)],
			}),
		).toBe("order-invalid/recipient");
	});

	it("this device holds the claim for that work digest, and the digest is the work's", async () => {
		const w = await world();
		const order = await orderFor(w.dispatcher.keys, w.executor, w.work);
		expect(await refusal(order, { self: w.executor, view: w.view })).toBe(
			"order-invalid/claim",
		);
		const lying = offer(w.dispatcher.keys.memberId, {
			workDigest: workDigest("github-actions-job", "job-other"),
		});
		expect(
			await refusal(await orderFor(w.dispatcher.keys, w.executor, lying), {
				self: w.executor,
				view: w.view,
				held: [digestOf(lying)],
			}),
		).toBe("order-invalid/digest");
	});

	it("the order id has not been seen before", async () => {
		const w = await world();
		const order = await orderFor(w.dispatcher.keys, w.executor, w.work);
		const context = {
			self: w.executor,
			view: w.view,
			held: [digestOf(w.work)],
		};
		expect(await refusal(order, { ...context, seen: [ORDER_ID] })).toBe(
			"order-invalid/replayed",
		);
		expect(
			await refusal(
				await orderFor(w.dispatcher.keys, w.executor, w.work, {
					orderId: "not-hex",
				}),
				context,
			),
		).toBe("order-invalid/replayed");
	});

	it("the offer inside is unexpired", async () => {
		const w = await world();
		const order = await orderFor(w.dispatcher.keys, w.executor, w.work);
		expect(
			await refusal(order, {
				self: w.executor,
				view: w.view,
				held: [digestOf(w.work)],
				nowMs: NOW + 11 * 60_000,
			}),
		).toBe("order-invalid/expired");
		const stale = await orderFor(w.dispatcher.keys, w.executor, w.work, {
			expiresAt: iso(NOW - 1),
		});
		expect(
			await refusal(stale, {
				self: w.executor,
				view: w.view,
				held: [digestOf(w.work)],
			}),
		).toBe("order-invalid/expired");
	});

	it("the fleet is known, many-active, and this device executes in it", async () => {
		const w = await world();
		const order = await orderFor(w.dispatcher.keys, w.executor, w.work);
		const held = [digestOf(w.work)];
		const noFleet = registry(
			[w.dispatcher.record, w.executor.record],
			[],
			w.authority,
		);
		expect(
			await refusal(order, { self: w.executor, view: noFleet, held }),
		).toBe("order-invalid/fleet");
		const oneActive = registry(
			[w.dispatcher.record, w.executor.record],
			[
				{
					...fleetRecord(),
					coordination: CoordinationMode.ONE_ACTIVE,
				},
			],
			w.authority,
		);
		expect(
			await refusal(order, { self: w.executor, view: oneActive, held }),
		).toBe("order-invalid/fleet");
		const observer = await device({ roles: [Role.OBSERVER] });
		const toObserver = await orderFor(w.dispatcher.keys, observer, w.work);
		expect(
			await refusal(toObserver, {
				self: observer,
				view: registry(
					[w.dispatcher.record, observer.record],
					[fleetRecord()],
					w.authority,
				),
				held,
			}),
		).toBe("order-invalid/fleet");
	});

	it("kind, repository, ref and workflow digest are allowed by the device's own copy of fleet policy", async () => {
		const strict = openPolicy({
			workKinds: ["github-actions-job"],
			repositories: [
				{
					repository: "acme/app",
					refs: ["refs/heads/main"],
					workflowDigests: ["sha256:good"],
				},
			],
		});
		const w = await world(strict);
		const cases: [Parameters<typeof offer>[1], string][] = [
			[{ kind: "shell", workflowDigest: "sha256:good" }, "kind"],
			[{ repository: "evil/app", workflowDigest: "sha256:good" }, "repository"],
			[{ ref: "refs/heads/feature", workflowDigest: "sha256:good" }, "ref"],
			[{ workflowDigest: "sha256:bad" }, "workflow"],
			[{ workflowDigest: "sha256:good" }, ""],
		];
		for (const [init, rule] of cases) {
			const work = offer(w.dispatcher.keys.memberId, init);
			const order = await orderFor(w.dispatcher.keys, w.executor, work, {
				sandboxTier: SandboxTier.S1_CONTAINER,
			});
			expect(
				await refusal(order, {
					self: w.executor,
					view: w.view,
					held: [digestOf(work)],
				}),
			).toBe(rule === "" ? "accepted" : `order-invalid/${rule}`);
		}
		// Work that names a repository needs a rule for it: an empty list allows none.
		const bare = await world(openPolicy({ repositories: [] }));
		const work = offer(bare.dispatcher.keys.memberId);
		expect(
			await refusal(await orderFor(bare.dispatcher.keys, bare.executor, work), {
				self: bare.executor,
				view: bare.view,
				held: [digestOf(work)],
			}),
		).toBe("order-invalid/repository");
	});

	it("submitted work carries a WorkSubmission that verifies against the authority", async () => {
		const w = await world();
		const submitted = (signed: SignedEnvelope | undefined) =>
			offer(w.dispatcher.keys.memberId, {
				kind: "oci-command",
				workKey: "sub-1",
				// The dispatcher copies the submitter into the offer.
				author: "github:1",
				repository: "",
				ref: "",
				submission: signed,
			});
		const verdict = async (signed: SignedEnvelope | undefined) => {
			const work = submitted(signed);
			return refusal(
				await orderFor(w.dispatcher.keys, w.executor, work, {
					sandboxTier: SandboxTier.S1_CONTAINER,
				}),
				{ self: w.executor, view: w.view, held: [digestOf(work)] },
			);
		};
		expect(await verdict(await submission(w.authority))).toBe("accepted");
		expect(await verdict(undefined)).toBe("order-invalid/submission");
		expect(await verdict(await submission(authorityKey()))).toBe(
			"order-invalid/submission",
		);
		expect(
			await verdict(await submission(w.authority, { fleet: "other" })),
		).toBe("order-invalid/submission");
		expect(
			await verdict(await submission(w.authority, { author: "github:9" })),
		).toBe("order-invalid/submission");
		expect(
			await verdict(await submission(w.authority, { expiresAt: iso(NOW - 1) })),
		).toBe("order-invalid/submission");
	});

	it("the sandbox tier is at least what §6.11 requires for the class this device derives", async () => {
		const w = await world();
		const personal = await device({ deviceClass: DeviceClass.PERSONAL });
		const view = registry(
			[w.dispatcher.record, personal.record],
			[fleetRecord()],
			w.authority,
		);
		const held = [digestOf(w.work)];
		const s1 = await orderFor(w.dispatcher.keys, personal, w.work, {
			sandboxTier: SandboxTier.S1_CONTAINER,
		});
		expect(await refusal(s1, { self: personal, view, held })).toBe(
			"sandbox-inadequate/sandbox",
		);
		const s3 = await orderFor(w.dispatcher.keys, personal, w.work, {
			sandboxTier: SandboxTier.S3_MICROVM,
		});
		expect(await refusal(s3, { self: personal, view, held })).toBe("accepted");
		// A dispatcher cannot raise the class: OWN asserted for a stranger's work stays ORG.
		const asserted = offer(w.dispatcher.keys.memberId, {
			trustClass: TrustClass.OWN,
			author: "github:2",
		});
		const own = await orderFor(w.dispatcher.keys, personal, asserted, {
			sandboxTier: SandboxTier.S1_CONTAINER,
		});
		expect(
			await refusal(own, { self: personal, view, held: [digestOf(asserted)] }),
		).toBe("sandbox-inadequate/sandbox");
		const fork = offer(w.dispatcher.keys.memberId, {
			trustClass: TrustClass.UNTRUSTED,
		});
		expect(
			await refusal(await orderFor(w.dispatcher.keys, personal, fork), {
				self: personal,
				view,
				held: [digestOf(fork)],
			}),
		).toBe("sandbox-inadequate/sandbox");
		const needsS3 = offer(w.dispatcher.keys.memberId, {
			needs: { minSandbox: SandboxTier.S3_MICROVM },
		});
		expect(
			await refusal(
				await orderFor(w.dispatcher.keys, w.executor, needsS3, {
					sandboxTier: SandboxTier.S1_CONTAINER,
				}),
				{ self: w.executor, view: w.view, held: [digestOf(needsS3)] },
			),
		).toBe("sandbox-inadequate/sandbox");
	});
});

describe("residency (§6.13)", () => {
	const eu = create(ResidencyRuleSchema, { allowedJurisdictions: ["eu"] });

	it("the device refuses an order outside the fleet's or the offer's rule", async () => {
		for (const region of ["us-east-1", "", "atlantis"]) {
			const w = await world(openPolicy({ residency: eu }));
			const here = await device({ region });
			const view = registry(
				[w.dispatcher.record, here.record],
				[fleetRecord(openPolicy({ residency: eu }))],
				w.authority,
			);
			expect(
				await refusal(await orderFor(w.dispatcher.keys, here, w.work), {
					self: here,
					view,
					held: [digestOf(w.work)],
				}),
			).toBe("residency-denied/residency");
		}
		const w = await world();
		const us = await device({ region: "us-east-1" });
		const ruled = offer(w.dispatcher.keys.memberId, { residency: eu });
		expect(
			await refusal(await orderFor(w.dispatcher.keys, us, ruled), {
				self: us,
				view: registry(
					[w.dispatcher.record, us.record],
					[fleetRecord()],
					w.authority,
				),
				held: [digestOf(ruled)],
			}),
		).toBe("residency-denied/residency");
		const de = await device({ region: "eu-central-1" });
		expect(
			await refusal(await orderFor(w.dispatcher.keys, de, ruled), {
				self: de,
				view: registry(
					[w.dispatcher.record, de.record],
					[fleetRecord()],
					w.authority,
				),
				held: [digestOf(ruled)],
			}),
		).toBe("accepted");
	});

	it("the dispatcher treats a claim from outside the rule as not entitled", async () => {
		const w = await world(openPolicy({ residency: eu }));
		for (const region of ["us-east-1", "", "atlantis"]) {
			const here = await device({ region });
			const view = registry(
				[w.dispatcher.record, here.record],
				[fleetRecord(openPolicy({ residency: eu }))],
			);
			expect(
				await checkClaim(
					await claimFor(here.keys, w.work),
					{ fleet: FLEET, digest: digestOf(w.work) },
					w.work,
					{ registry: view, ranked: [], nowMs: NOW, stepMs: 20_000 },
				),
			).toBe("not-entitled");
		}
	});

	describe("on the bus", () => {
		beforeEach(() => {
			vi.useFakeTimers({ now: NOW });
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("a device outside the rule does not claim, and the one inside runs the work", async () => {
			const authority = authorityKey();
			const bus = createMemoryBus(() => Date.now());
			const fleetPolicy = openPolicy({ residency: eu });
			const dispatcher = await device({ roles: [Role.DISPATCHER] });
			const outside = await device({ region: "us-east-1" });
			const inside = await device({ region: "eu-west-1" });
			await seedBus(
				bus,
				authority,
				[dispatcher.record, outside.record, inside.record],
				[fleetRecord(fleetPolicy)],
			);
			// The outside device would be first for this work if residency were ignored.
			await publishObservation(bus, outside, NOW, {
				capacity: { freeSlots: 64 },
			});
			await publishObservation(bus, inside, NOW, {
				capacity: { freeSlots: 1 },
			});
			const logs = recorder();
			const runners = [testRunner(), testRunner()];
			const executors = [outside, inside].map((member, index) =>
				createExecutor({
					self: member.keys,
					state: member.store,
					bus,
					runners: [runners[index] ?? testRunner()],
					sandboxes: [fakeDriver(SandboxTier.S1_CONTAINER)],
					egress: egress(),
					capacity: capacity(index === 0 ? 64 : 1),
					now: () => Date.now(),
					log: logs.log,
				}),
			);
			for (const executor of executors) executor.start();
			await vi.advanceTimersByTimeAsync(10);
			const source = testSource();
			source.queue.push(upstream("job-1", NOW));
			const dispatch = createDispatcher({
				self: dispatcher.keys,
				bus,
				sources: [source],
				report: reports().report,
				now: () => Date.now(),
				log: () => undefined,
			});
			dispatch.start();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(runners[0]?.ran).toHaveLength(0);
			expect(runners[1]?.ran.map((run) => run.workKey)).toEqual(["job-1"]);
			expect(
				logs.lines.some(
					(line) =>
						line.event === "hobo_fleet_offer_unfit" &&
						line.fields.reason === "residency",
				),
			).toBe(true);
			await dispatch.stop();
			for (const executor of executors) await executor.stop();
		});
	});
});
