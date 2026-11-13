/**
 * O9: the trust class cannot be raised by a dispatcher. Every cell of the
 * table of §6.11 for every device class; the class a device derives from the
 * facts it can check (a dispatcher's `OWN` is ignored); the start fence; and a
 * mislabelled fork job stopped by the fence before any step runs (fake
 * sandbox, real executor and dispatcher on the memory bus).
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DeviceClass,
	ReceiptStatus,
	Role,
	SandboxTier,
	TrustClass,
	WorkOrderSchema,
	WorkOrigin,
	WorkReceiptSchema,
} from "../../src/_generated/fleet_pb.js";
import { createMemoryBus } from "../../src/testing/plumbing/index.js";
import {
	checkAssignment,
	createDispatcher,
	createExecutor,
	deriveTrustClass,
	requiredSandbox,
} from "../../src/work/index.js";
import {
	authorityKey,
	device,
	fleetRecord,
	NOW,
	offer,
	openPolicy,
	policy,
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

const { S1_CONTAINER: S1, S2_USER_KERNEL: S2, S3_MICROVM: S3 } = SandboxTier;
const { PERSONAL, DEDICATED, EPHEMERAL } = DeviceClass;

describe("requiredSandbox: the table of §6.11", () => {
	const plain = policy();
	const lowered = openPolicy({ orgMinSandbox: S1 });
	const cells: [TrustClass, DeviceClass, SandboxTier | "never"][] = [
		[TrustClass.OWN, PERSONAL, S1],
		[TrustClass.OWN, DEDICATED, S1],
		[TrustClass.OWN, EPHEMERAL, S1],
		[TrustClass.ORG, PERSONAL, S3],
		[TrustClass.ORG, DEDICATED, S3],
		[TrustClass.ORG, EPHEMERAL, S1],
		[TrustClass.UNTRUSTED, PERSONAL, "never"],
		[TrustClass.UNTRUSTED, DEDICATED, "never"],
		[TrustClass.UNTRUSTED, EPHEMERAL, S3],
	];
	for (const [trust, deviceClass, tier] of cells)
		it(`${TrustClass[trust]} on ${DeviceClass[deviceClass]} needs ${tier === "never" ? "never" : SandboxTier[tier]}`, () => {
			expect(requiredSandbox(trust, deviceClass, plain, "acme/app")).toBe(tier);
		});

	it("a dedicated device takes ORG work in S1 or S2 only where the fleet lowers org_min_sandbox and names the repository", () => {
		expect(
			requiredSandbox(TrustClass.ORG, DEDICATED, lowered, "acme/app"),
		).toBe(S1);
		expect(
			requiredSandbox(
				TrustClass.ORG,
				DEDICATED,
				openPolicy({ orgMinSandbox: S2 }),
				"acme/app",
			),
		).toBe(S2);
		expect(
			requiredSandbox(TrustClass.ORG, DEDICATED, lowered, "acme/other"),
		).toBe(S3);
		expect(requiredSandbox(TrustClass.ORG, PERSONAL, lowered, "acme/app")).toBe(
			S3,
		);
		expect(
			requiredSandbox(TrustClass.UNTRUSTED, DEDICATED, lowered, "acme/app"),
		).toBe("never");
	});

	it("an unspecified class or trust is treated as the strictest", () => {
		expect(
			requiredSandbox(
				TrustClass.ORG,
				DeviceClass.UNSPECIFIED,
				lowered,
				"acme/app",
			),
		).toBe(S3);
		expect(
			requiredSandbox(TrustClass.UNSPECIFIED, EPHEMERAL, plain, "acme/app"),
		).toBe(S3);
		expect(
			requiredSandbox(TrustClass.UNSPECIFIED, PERSONAL, plain, "acme/app"),
		).toBe("never");
	});
});

describe("deriveTrustClass", () => {
	it("is UNTRUSTED when the offer says so or the origin is not INTERNAL", async () => {
		const { record } = await device();
		expect(
			deriveTrustClass(
				offer("d", { trustClass: TrustClass.UNTRUSTED }),
				record,
			),
		).toBe(TrustClass.UNTRUSTED);
		for (const origin of [
			WorkOrigin.FORK,
			WorkOrigin.UNKNOWN,
			WorkOrigin.UNSPECIFIED,
		])
			expect(deriveTrustClass(offer("d", { origin }), record)).toBe(
				TrustClass.UNTRUSTED,
			);
	});

	it("is OWN only for an author among the owner's linked identities in the device's own record", async () => {
		const { record } = await device({
			owner: "oidc:alice",
			aliases: ["github:1"],
		});
		expect(deriveTrustClass(offer("d", { author: "github:1" }), record)).toBe(
			TrustClass.OWN,
		);
		expect(deriveTrustClass(offer("d", { author: "oidc:alice" }), record)).toBe(
			TrustClass.OWN,
		);
		expect(deriveTrustClass(offer("d", { author: "github:2" }), record)).toBe(
			TrustClass.ORG,
		);
		expect(deriveTrustClass(offer("d", { author: "" }), record)).toBe(
			TrustClass.ORG,
		);
	});

	it("ignores a dispatcher's OWN: the offer's class is only a ceiling", async () => {
		const { record } = await device({ aliases: ["github:1"] });
		expect(
			deriveTrustClass(
				offer("d", { trustClass: TrustClass.OWN, author: "github:2" }),
				record,
			),
		).toBe(TrustClass.ORG);
	});

	it("takes the author of submitted work from the authority's submission", async () => {
		const authority = authorityKey();
		const { record } = await device({ aliases: ["github:1"] });
		const signed = await submission(authority, { author: "github:1" });
		expect(
			deriveTrustClass(
				offer("d", { author: "github:2", submission: signed }),
				record,
			),
		).toBe(TrustClass.OWN);
		const other = await submission(authority, { author: "github:3" });
		expect(
			deriveTrustClass(
				offer("d", { author: "github:1", submission: other }),
				record,
			),
		).toBe(TrustClass.ORG);
		const garbage = { ...signed, payload: new Uint8Array([0xff, 0xff]) };
		expect(deriveTrustClass(offer("d", { submission: garbage }), record)).toBe(
			TrustClass.UNTRUSTED,
		);
	});
});

describe("checkAssignment: the start fence", () => {
	const order = (init = {}) =>
		create(WorkOrderSchema, {
			orderId: "a".repeat(32),
			offer: offer("d", init),
			sandboxTier: S1,
		});
	const facts = (init = {}) => ({
		workKey: "job-1",
		repository: "acme/app",
		ref: "refs/heads/main",
		author: "github:2",
		origin: WorkOrigin.INTERNAL,
		...init,
	});

	it("allows the job GitHub reports when the repository, ref and tier hold", async () => {
		const { record } = await device({ deviceClass: EPHEMERAL });
		expect(checkAssignment(order(), facts(), record, openPolicy(), S1)).toBe(
			true,
		);
		// A different job of the same label is allowed when it passes the same checks.
		expect(
			checkAssignment(
				order(),
				facts({ workKey: "job-9" }),
				record,
				openPolicy(),
				S1,
			),
		).toBe(true);
	});

	it("refuses another repository, a ref policy does not allow, or a fork in a tier too weak", async () => {
		const { record } = await device({ deviceClass: EPHEMERAL });
		expect(
			checkAssignment(
				order(),
				facts({ repository: "evil/app" }),
				record,
				openPolicy(),
				S1,
			),
		).toBe(false);
		expect(
			checkAssignment(
				order(),
				facts({ ref: "refs/heads/feature" }),
				record,
				openPolicy(),
				S1,
			),
		).toBe(false);
		expect(
			checkAssignment(
				order(),
				facts({ origin: WorkOrigin.FORK }),
				record,
				openPolicy(),
				S1,
			),
		).toBe(false);
		expect(
			checkAssignment(
				order(),
				facts({ origin: WorkOrigin.FORK }),
				record,
				openPolicy(),
				S3,
			),
		).toBe(true);
		expect(
			checkAssignment(
				create(WorkOrderSchema, {}),
				facts(),
				record,
				openPolicy(),
				S3,
			),
		).toBe(false);
	});

	it("re-derives OWN from the observed author and never above the dispatcher's ceiling", async () => {
		const { record } = await device({
			deviceClass: PERSONAL,
			aliases: ["github:1"],
		});
		expect(
			checkAssignment(
				order(),
				facts({ author: "github:1" }),
				record,
				openPolicy(),
				S1,
			),
		).toBe(true);
		expect(
			checkAssignment(
				order(),
				facts({ author: "github:2" }),
				record,
				openPolicy(),
				S1,
			),
		).toBe(false);
		expect(
			checkAssignment(
				order({ trustClass: TrustClass.UNTRUSTED }),
				facts({ author: "github:1" }),
				record,
				openPolicy(),
				S1,
			),
		).toBe(false);
	});

	it("honours the work's own minimum tier", async () => {
		const { record } = await device({ deviceClass: EPHEMERAL });
		expect(
			checkAssignment(
				order({ needs: { minSandbox: S3 } }),
				facts(),
				record,
				openPolicy(),
				S1,
			),
		).toBe(false);
	});
});

describe("a mislabelled fork job is stopped by the fence before a step runs", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("the fake sandbox runs the fence and nothing else, and the receipt says assignment-mismatch", async () => {
		const authority = authorityKey();
		const bus = createMemoryBus(() => Date.now());
		const dispatcher = await device({
			roles: [Role.DISPATCHER],
			deviceClass: DEDICATED,
		});
		const executor = await device({
			roles: [Role.EXECUTOR],
			deviceClass: EPHEMERAL,
		});
		await seedBus(
			bus,
			authority,
			[dispatcher.record, executor.record],
			[fleetRecord(openPolicy())],
		);
		const driver = fakeDriver(S1);
		const runner = testRunner("github-actions-job", async (input) => {
			const output: Uint8Array[] = [];
			const fence = await input.sandbox.exec({
				argv: [
					"curl",
					"-sf",
					"--data-binary",
					"@-",
					`${input.sandbox.controlUrl}/fence`,
				],
				env: {},
				// What GitHub's job context says: a fork pull request, not the internal job offered.
				stdin: new TextEncoder().encode(
					JSON.stringify({
						workKey: "job-1",
						repository: "acme/app",
						ref: "refs/pull/7/merge",
						author: "github:666",
						origin: "WORK_ORIGIN_FORK",
					}),
				),
				signal: input.signal,
				onOutput: (chunk) => output.push(chunk),
			});
			if (fence.exitCode !== 0)
				return {
					status: ReceiptStatus.FAILED,
					reason: "assignment-mismatch",
					outputDigest: "",
					observedWorkKey: "job-1",
				};
			await input.sandbox.exec({
				argv: ["run-step", "1"],
				env: {},
				signal: input.signal,
				onOutput: () => undefined,
			});
			return {
				status: ReceiptStatus.SUCCEEDED,
				reason: "",
				outputDigest: "",
				observedWorkKey: "job-1",
			};
		});
		const exec = createExecutor({
			self: executor.keys,
			state: executor.store,
			bus,
			runners: [runner],
			sandboxes: [driver],
			egress: egress(),
			capacity: capacity(1),
			now: () => Date.now(),
			log: recorder().log,
		});
		const source = testSource();
		source.queue.push(upstream("job-1", NOW));
		const dispatch = createDispatcher({
			self: dispatcher.keys,
			bus,
			sources: [source],
			report: reports().report,
			now: () => Date.now(),
			log: recorder().log,
		});
		exec.start();
		await vi.advanceTimersByTimeAsync(10);
		dispatch.start();
		await vi.advanceTimersByTimeAsync(5_000);
		const receipts: ReceiptStatus[] = [];
		const reasons: string[] = [];
		bus.events.subscribe(["receipt"], "start", async (event) => {
			const receipt = fromBinary(WorkReceiptSchema, event.payload);
			receipts.push(receipt.status);
			reasons.push(receipt.reason);
		});
		await vi.advanceTimersByTimeAsync(10);
		expect(runner.ran).toHaveLength(1);
		expect(driver.runs).toHaveLength(1);
		expect(driver.runs[0]).toContain("/fence");
		expect(driver.runs.some((line) => line.includes("run-step"))).toBe(false);
		expect(receipts).toEqual([ReceiptStatus.STARTED, ReceiptStatus.FAILED]);
		expect(reasons[1]).toBe("assignment-mismatch");
		await dispatch.stop();
		await exec.stop();
	});
});
