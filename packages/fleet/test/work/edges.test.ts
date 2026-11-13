/**
 * Edges of the work lane that the outcome suites do not reach: the pure
 * rules (digest, ref globs, policy, residency, version floors), envelope
 * helpers, offers an executor must ignore or cannot fit, orders it must
 * refuse after holding the claim, and the dispatcher's failure paths.
 */
import { createHash } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CoordinationMode,
	DeviceClass,
	KeyBundleSchema,
	MemberRecordSchema,
	ReceiptStatus,
	ResidencyRuleSchema,
	Role,
	SandboxTier,
	SignedEnvelopeSchema,
	WorkOfferSchema,
	WorkOrigin,
	type WorkReceipt,
	WorkReceiptSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	KEY_BUNDLE_CONTEXT,
	OFFER_CONTEXT,
	WORK_SUBMISSION_CONTEXT,
} from "../../src/contexts.js";
import { parseWorkDigest } from "../../src/ids.js";
import { signEnvelope } from "../../src/keys/index.js";
import type { FleetBus, WorkSource } from "../../src/ports.js";
import { createMemoryBus } from "../../src/testing/plumbing/index.js";
import {
	checkOrder,
	createDispatcher,
	createExecutor,
	workDigest,
} from "../../src/work/index.js";
import {
	policyRefusal,
	refMatches,
	residencyAllows,
	versionAtLeast,
} from "../../src/work/rules.js";
import { authoritySigned, bundleOf, signerOf } from "../../src/work/signed.js";
import {
	authorityKey,
	type Device,
	device,
	FLEET,
	fleetRecord,
	NOW,
	offer,
	openPolicy,
	orderFor,
	publishObservation,
	registry,
	seedBus,
	signOffer,
	submission,
	trustRecord,
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

const now = () => Date.now();

describe("rules", () => {
	it("the work digest is the first 32 hex of sha256(kind ‖ 0x00 ‖ work_key)", () => {
		const expected = createHash("sha256")
			.update(Buffer.from("k\u0000w", "utf8"))
			.digest("hex")
			.slice(0, 32);
		expect(workDigest("k", "w")).toBe(expected);
		expect(workDigest("a", "bc")).not.toBe(workDigest("ab", "c"));
	});

	it("ref globs: * stays inside one segment, ** crosses them, everything else is literal", () => {
		expect(refMatches("refs/heads/main", "refs/heads/main")).toBe(true);
		expect(refMatches("refs/heads/*", "refs/heads/main")).toBe(true);
		expect(refMatches("refs/heads/*", "refs/heads/a/b")).toBe(false);
		expect(refMatches("refs/heads/**", "refs/heads/a/b")).toBe(true);
		expect(refMatches("refs/tags/v1.0", "refs/tags/v1x0")).toBe(false);
		expect(refMatches("refs/(x)+", "refs/(x)+")).toBe(true);
	});

	it("policy: an empty kind list allows any kind; work without a repository skips the repository rules", () => {
		const policy = openPolicy();
		expect(
			policyRefusal(policy, {
				kind: "anything",
				repository: "",
				ref: "",
				workflowDigest: "",
			}),
		).toBeUndefined();
		expect(
			policyRefusal(openPolicy({ workKinds: ["oci-command"] }), {
				kind: "github-actions-job",
				repository: "",
				ref: "",
				workflowDigest: "",
			}),
		).toBe("kind");
		expect(
			policyRefusal(
				openPolicy({ repositories: [{ repository: "acme/app", refs: [] }] }),
				{
					kind: "k",
					repository: "acme/app",
					ref: "refs/heads/main",
					workflowDigest: "",
				},
			),
		).toBe("ref");
	});

	it("residency: no rule admits everyone; any rule needs a mapped, allowed region; a broken rule excludes", () => {
		expect(residencyAllows("", [undefined])).toBe(true);
		expect(residencyAllows("", [create(ResidencyRuleSchema, {})])).toBe(true);
		const eu = create(ResidencyRuleSchema, { allowedJurisdictions: ["eu"] });
		expect(residencyAllows("eu-west-1", [eu])).toBe(true);
		expect(residencyAllows("us-east-1", [eu])).toBe(false);
		expect(
			residencyAllows("eu-west-1", [
				eu,
				create(ResidencyRuleSchema, {
					deniedJurisdictions: ["eu"],
					allowedJurisdictions: ["global"],
				}),
			]),
		).toBe(false);
		expect(
			residencyAllows("eu-west-1", [
				create(ResidencyRuleSchema, {
					allowedJurisdictions: ["NOT A JURISDICTION"],
				}),
			]),
		).toBe(false);
		expect(
			residencyAllows("eu-west-1", [
				create(ResidencyRuleSchema, { classifications: ["pii"] }),
			]),
		).toBe(false);
	});

	it("version floors: dotted numbers, missing parts are 0, an unreadable floor places none", () => {
		expect(versionAtLeast("1.2.3", "")).toBe(true);
		expect(versionAtLeast("1.2.3", "1.2.3")).toBe(true);
		expect(versionAtLeast("1.2", "1.2.0")).toBe(true);
		expect(versionAtLeast("v1.10.0", "1.9.9")).toBe(true);
		expect(versionAtLeast("1.2.3-rc1", "1.2.4")).toBe(false);
		expect(versionAtLeast("garbage", "1.0.0")).toBe(false);
		expect(versionAtLeast("1.0.0", "x.y")).toBe(true);
	});
});

describe("envelope helpers", () => {
	it("signerOf takes only <member>#sign key ids", async () => {
		const { keys } = await device();
		expect(signerOf(`${keys.memberId}#sign`)).toBe(keys.memberId);
		expect(signerOf(`${keys.memberId}#seal`)).toBeUndefined();
		expect(signerOf("dev_nothex#sign")).toBeUndefined();
		expect(signerOf("")).toBeUndefined();
	});

	it("bundleOf refuses a missing, foreign, mislabelled or undecodable bundle", async () => {
		const { keys, record } = await device();
		expect(bundleOf(record)?.memberId).toBe(keys.memberId);
		expect(
			bundleOf(create(MemberRecordSchema, { ...record, keyBundle: undefined })),
		).toBeUndefined();
		const other = await device();
		expect(
			bundleOf(
				create(MemberRecordSchema, {
					...record,
					keyBundle: other.record.keyBundle,
				}),
			),
		).toBeUndefined();
		const foreign = await signEnvelope(
			keys.identity,
			KEY_BUNDLE_CONTEXT,
			toBinary(
				KeyBundleSchema,
				create(KeyBundleSchema, { memberId: other.keys.memberId }),
			),
		);
		expect(
			bundleOf(create(MemberRecordSchema, { ...record, keyBundle: foreign })),
		).toBeUndefined();
		const garbage = await signEnvelope(
			keys.identity,
			KEY_BUNDLE_CONTEXT,
			new Uint8Array([0xff, 0xff]),
		);
		expect(
			bundleOf(create(MemberRecordSchema, { ...record, keyBundle: garbage })),
		).toBeUndefined();
	});

	it("authoritySigned needs the submission context and a listed authority key", async () => {
		const authority = authorityKey();
		const signed = await submission(authority);
		expect(authoritySigned(signed, trustRecord(authority))).toBe(true);
		expect(
			authoritySigned(
				create(SignedEnvelopeSchema, { ...signed, context: OFFER_CONTEXT }),
				trustRecord(authority),
			),
		).toBe(false);
		expect(authoritySigned(signed, trustRecord(authorityKey(2)))).toBe(false);
		expect(WORK_SUBMISSION_CONTEXT).toBe(signed.context);
	});

	it("checkOrder refuses an offer naming an invalid fleet id", async () => {
		const dispatcher = await device({
			roles: [Role.DISPATCHER],
			fleet: "BAD FLEET",
		});
		const self = await device({ fleet: "BAD FLEET" });
		const work = offer(dispatcher.keys.memberId, { fleet: "BAD FLEET" });
		const outcome = await checkOrder(
			await orderFor(dispatcher.keys, self, work),
			{
				self: self.record,
				registry: registry([dispatcher.record, self.record], []),
				heldClaims: new Set([parseWorkDigest(work.workDigest)]),
				seenOrderIds: new Set(),
				nowMs: NOW,
			},
		);
		expect(outcome.ok ? "" : outcome.error.detail?.check).toBe("fleet");
	});
});

describe("loops at the edges", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function world(
		options: Readonly<{
			self?: Parameters<typeof device>[0];
			policy?: ReturnType<typeof openPolicy>;
		}> = {},
	) {
		const authority = authorityKey();
		const bus = createMemoryBus(now);
		const dispatcher = await device({ roles: [Role.DISPATCHER] });
		const self = await device(options.self ?? {});
		const bystander = await device();
		await seedBus(
			bus,
			authority,
			[dispatcher.record, self.record, bystander.record],
			[fleetRecord(options.policy ?? openPolicy())],
		);
		const receipts: WorkReceipt[] = [];
		bus.events.subscribe(["receipt"], "start", async (event) => {
			receipts.push(fromBinary(WorkReceiptSchema, event.payload));
		});
		const logs = recorder();
		return { authority, bus, dispatcher, self, bystander, receipts, logs };
	}

	function executorOf(
		w: Awaited<ReturnType<typeof world>>,
		options: Readonly<{
			drivers?: readonly SandboxTier[];
			bus?: FleetBus;
			proxyFails?: boolean;
		}> = {},
	) {
		const proxies = egress();
		return createExecutor({
			self: w.self.keys,
			state: w.self.store,
			bus: options.bus ?? w.bus,
			runners: [testRunner()],
			sandboxes: (options.drivers ?? [SandboxTier.S1_CONTAINER]).map((tier) =>
				fakeDriver(tier),
			),
			egress: options.proxyFails
				? {
						async open() {
							throw new Error("no proxy");
						},
					}
				: proxies,
			capacity: capacity(8),
			now,
			log: w.logs.log,
		});
	}

	const reasons = (w: Awaited<ReturnType<typeof world>>) =>
		w.logs.lines
			.filter((line) => line.event === "hobo_fleet_offer_unfit")
			.map((line) => line.fields.reason);

	it("an executor ignores offers it may not trust and logs those it cannot fit", async () => {
		const w = await world({
			self: { deviceClass: DeviceClass.PERSONAL, agentVersion: "0.9.0" },
		});
		const executor = executorOf(w);
		executor.start();
		executor.start();
		await vi.advanceTimersByTimeAsync(10);
		const publish = async (signer: Device, init: Parameters<typeof offer>[1]) =>
			w.bus.offers.publish(
				await signOffer(signer.keys, offer(signer.keys.memberId, init)),
				FLEET,
			);
		// Signed by an executor, not a dispatcher; garbage; a lying digest; expired.
		await publish(w.bystander, {});
		await w.bus.offers.publish(
			await signEnvelope(
				w.dispatcher.keys.sign,
				OFFER_CONTEXT,
				new Uint8Array([0xff]),
			),
			FLEET,
		);
		await publish(w.dispatcher, { workDigest: workDigest("x", "y") });
		await publish(w.dispatcher, { workDigest: "nope" });
		await publish(w.dispatcher, {
			expiresAt: new Date(NOW - 1).toISOString(),
			workKey: "old",
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(reasons(w)).toEqual([]);
		// No runner for the kind; a policy refusal; outdated agent.
		await publish(w.dispatcher, { kind: "shell", workKey: "a" });
		await publish(w.dispatcher, { repository: "evil/app", workKey: "b" });
		await vi.advanceTimersByTimeAsync(100);
		expect(reasons(w)).toEqual(["kind", "policy-repository"]);
		await executor.stop();
	});

	it("an outdated agent is told to update and does not claim; tiers it lacks are unfit", async () => {
		const policy = openPolicy({ minAgentVersion: "2.0.0" });
		const w = await world({ self: { agentVersion: "1.0.0" }, policy });
		const executor = executorOf(w);
		executor.start();
		await vi.advanceTimersByTimeAsync(10);
		await w.bus.offers.publish(
			await signOffer(w.dispatcher.keys, offer(w.dispatcher.keys.memberId)),
			FLEET,
		);
		await vi.advanceTimersByTimeAsync(100);
		expect(
			w.logs.lines.some((line) => line.event === "hobo_fleet_update_required"),
		).toBe(true);
		await executor.stop();

		const personal = await world({
			self: { deviceClass: DeviceClass.PERSONAL },
		});
		const onlyS1 = executorOf(personal);
		onlyS1.start();
		await vi.advanceTimersByTimeAsync(10);
		const fork = offer(personal.dispatcher.keys.memberId, {
			origin: WorkOrigin.FORK,
			workKey: "fork",
		});
		await personal.bus.offers.publish(
			await signOffer(personal.dispatcher.keys, fork),
			FLEET,
		);
		const org = offer(personal.dispatcher.keys.memberId, { workKey: "org" });
		await personal.bus.offers.publish(
			await signOffer(personal.dispatcher.keys, org),
			FLEET,
		);
		await vi.advanceTimersByTimeAsync(100);
		expect(reasons(personal)).toEqual(["sandbox", "sandbox"]);
		await onlyS1.stop();
	});

	it("an executor not ranked for the offer never claims it", async () => {
		const w = await world();
		// The board says this executor is full; the bystander has room and is ranked alone.
		await publishObservation(w.bus, w.self, NOW, {
			capacity: { freeSlots: 0 },
		});
		await publishObservation(w.bus, w.bystander, NOW, {
			capacity: { freeSlots: 4 },
			agentVersion: "1.0.0",
		});
		const executor = executorOf(w);
		executor.start();
		await vi.advanceTimersByTimeAsync(10);
		await w.bus.offers.publish(
			await signOffer(w.dispatcher.keys, offer(w.dispatcher.keys.memberId)),
			FLEET,
		);
		await vi.advanceTimersByTimeAsync(200_000);
		expect(
			w.logs.lines.some((line) => line.event === "hobo_fleet_work_claimed"),
		).toBe(false);
		await executor.stop();
	});

	it("refuses an order it holds the claim for when the tier, secret or proxy fails it", async () => {
		const w = await world();
		const source = testSource();
		source.setWanted(false);
		const executor = executorOf(w, { proxyFails: true });
		executor.start();
		await vi.advanceTimersByTimeAsync(10);
		const dispatcher = createDispatcher({
			self: w.dispatcher.keys,
			bus: w.bus,
			sources: [source],
			report: reports().report,
			now,
			log: () => undefined,
		});
		const keys = ["s3", "nosecret", "badsecret", "proxy"];
		for (const key of keys) source.queue.push(upstream(key, NOW));
		dispatcher.start();
		await vi.advanceTimersByTimeAsync(1_000);
		await dispatcher.stop();
		expect(
			w.logs.lines.filter((line) => line.event === "hobo_fleet_work_claimed"),
		).toHaveLength(4);
		// The dispatcher no longer wants them; this test orders by hand while the executor still holds the claims.
		const work = (key: string) =>
			offer(w.dispatcher.keys.memberId, { workKey: key });
		const orders = [
			await orderFor(w.dispatcher.keys, w.self, work("s3"), {
				orderId: "1".repeat(32),
				sandboxTier: SandboxTier.S3_MICROVM,
			}),
			await orderFor(w.dispatcher.keys, w.self, work("nosecret"), {
				orderId: "2".repeat(32),
				sandboxTier: SandboxTier.S1_CONTAINER,
				secret: undefined,
			}),
			// Sealed to another device's key.
			await orderFor(w.dispatcher.keys, w.bystander, work("badsecret"), {
				orderId: "3".repeat(32),
				memberId: w.self.keys.memberId,
				sandboxTier: SandboxTier.S1_CONTAINER,
			}),
			await orderFor(w.dispatcher.keys, w.self, work("proxy"), {
				orderId: "4".repeat(32),
				sandboxTier: SandboxTier.S1_CONTAINER,
			}),
		];
		for (const order of orders)
			await w.bus.orders.deliver(order, w.self.keys.memberId);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(
			w.receipts.map((receipt) => [
				receipt.orderId[0],
				ReceiptStatus[receipt.status],
				receipt.reason,
			]),
		).toEqual([
			["1", "REFUSED", "sandbox-inadequate"],
			["2", "REFUSED", "order-invalid"],
			["3", "REFUSED", "order-invalid"],
			["4", "ABANDONED", "unavailable"],
		]);
		await executor.stop();
	});

	it("the dispatcher survives a failing source and a refused preparation, and a dispatcher of no many-active fleet offers nothing", async () => {
		const w = await world();
		const failing: WorkSource = {
			kind: "github-actions-job",
			poll: async () => {
				throw new Error("upstream down");
			},
			prepare: async () => ({
				ok: false,
				error: { code: "unavailable", message: "x" },
			}),
			stillWanted: async () => true,
		};
		const refusing = testSource();
		refusing.prepare = async () => ({
			ok: false,
			error: { code: "unavailable", message: "no registration" },
		});
		refusing.queue.push(upstream("job-1", NOW));
		const executor = executorOf(w);
		executor.start();
		await vi.advanceTimersByTimeAsync(10);
		const logs = recorder();
		const dispatcher = createDispatcher({
			self: w.dispatcher.keys,
			bus: w.bus,
			sources: [failing, refusing],
			report: reports().report,
			now,
			log: logs.log,
		});
		dispatcher.start();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(
			logs.lines.some(
				(line) =>
					line.event === "hobo_fleet_claim_discarded" &&
					line.fields.reason === "unavailable",
			),
		).toBe(true);
		await dispatcher.stop();
		await executor.stop();

		// A dispatcher the registry does not know, or whose fleet is one-active, offers nothing.
		const stranger = await device({ roles: [Role.DISPATCHER] });
		const offers: string[] = [];
		w.bus.offers.subscribe([FLEET], "new", async (envelope) => {
			offers.push(fromBinary(WorkOfferSchema, envelope.payload).workKey);
		});
		const unknown = createDispatcher({
			self: stranger.keys,
			bus: w.bus,
			sources: [testSource()],
			report: reports().report,
			now,
			log: () => undefined,
		});
		unknown.start();
		await vi.advanceTimersByTimeAsync(11_000);
		await unknown.stop();
		const oneActive = createMemoryBus(now);
		await seedBus(
			oneActive,
			w.authority,
			[w.dispatcher.record],
			[{ ...fleetRecord(), coordination: CoordinationMode.ONE_ACTIVE }],
		);
		const source = testSource();
		source.queue.push(upstream("job-9", NOW));
		const quiet = createDispatcher({
			self: w.dispatcher.keys,
			bus: oneActive,
			sources: [source],
			report: reports().report,
			now,
			log: () => undefined,
		});
		quiet.start();
		await vi.advanceTimersByTimeAsync(11_000);
		await quiet.stop();
		expect(offers).toEqual([]);
	});
});
