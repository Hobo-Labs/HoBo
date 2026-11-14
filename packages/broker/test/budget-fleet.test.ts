import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type AssignmentAcceptOutcome,
	assignmentKey,
	createImmutableJournal,
	type FleetAssignment,
	ImmutableJournalError,
	type ImmutableJournalMember,
	type ImmutableJournalReplica,
} from "@hobo/backend-fleet";
import { describe, expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	HostingQuoteSchema,
} from "../src/budget-authority.js";
import { createFleetBudgetAdmissionAuthority } from "../src/budget-fleet.js";
import { createOperationalFleetBudgetAdmissionAuthority } from "../src/budget-fleet-operational.js";
import { createRecoveryActorFixture } from "./support/recovery-actor.js";

const NOW = "2026-10-30T12:00:00Z",
	UNTIL = "2026-10-31T00:00:00Z";
class Replica implements ImmutableJournalReplica {
	readonly rows: FleetAssignment[] = [];
	readonly documents = new Map<string, string>();
	available = true;
	afterAccept?: () => void;
	constructor(readonly id: string) {}
	async read(limit?: number) {
		if (!this.available) throw new Error("provider unavailable");
		return this.rows.slice(-(limit ?? this.rows.length));
	}
	async accept(value: FleetAssignment): Promise<AssignmentAcceptOutcome> {
		if (!this.available) throw new Error("provider unavailable");
		const held = this.rows.find((row) => row.epoch === value.epoch);
		if (held)
			return assignmentKey(held) === assignmentKey(value)
				? "duplicate"
				: "conflict";
		if ((this.rows.at(-1)?.epoch ?? 0) !== value.epoch - 1) return "gap";
		this.rows.push(value);
		this.afterAccept?.();
		return "accepted";
	}
	async readDocument(digest: string) {
		if (!this.available) throw new Error("provider unavailable");
		return this.documents.get(digest);
	}
	async writeDocument(digest: string, value: string) {
		if (!this.available) throw new Error("provider unavailable");
		const held = this.documents.get(digest);
		if (held !== undefined && held !== value)
			throw new Error("immutable conflict");
		this.documents.set(digest, value);
	}
}
function fixture() {
	const replicas = [
		new Replica("a"),
		new Replica("b"),
		new Replica("c"),
	] as const;
	const members: readonly ImmutableJournalMember[] = replicas.map(({ id }) => ({
		id,
		provider: `provider-${id}`,
		accountId: `account-${id}`,
		resourceId: `resource-${id}`,
		incarnation: `incarnation-${id}`,
	}));
	const fleetId = "budget-fleet";
	const anchorDigest = createHash("sha256")
		.update(
			JSON.stringify({
				contract: "hobo.immutable-journal-anchor/v1",
				fleetId,
				members,
			}),
		)
		.digest("hex");
	const snapshot = create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId: "budget",
			periodId: "p1",
			policyRevision: "r1",
		},
		limitMicros: 100,
		observedAt: NOW,
		validUntil: UNTIL,
	});
	const snapshotIdentity = snapshot.identity;
	if (!snapshotIdentity) throw new Error("missing budget identity");
	let authorized = true;
	let recoveryFunded = true;
	let recoveryCount = 0;
	const actorHost = createRecoveryActorFixture(NOW).host;
	const actions: string[] = [];
	const open = () =>
		createImmutableJournal({
			fleetId,
			members,
			anchorDigest,
			replicas,
			maxEntryBytes: 64_000,
			maxEntries: 100,
			authorize: async (action) => {
				actions.push(action);
				if (!authorized) throw new Error("funding revoked");
			},
		});
	const authority = (journal = open()) =>
		createFleetBudgetAdmissionAuthority({ journal, snapshot, now: () => NOW });
	const operational = (journal = open()) =>
		createOperationalFleetBudgetAdmissionAuthority({
			journal,
			snapshot,
			recoveryIdentity: snapshotIdentity,
			now: () => NOW,
			actorHost,
			async authorizeRecovery() {
				recoveryCount++;
				return async () => {
					if (!recoveryFunded) throw new Error("recovery funding revoked");
				};
			},
		});
	return {
		replicas,
		snapshot,
		open,
		authority,
		operational,
		actorHost,
		recoveries: () => recoveryCount,
		denyRecovery: () => {
			recoveryFunded = false;
		},
		actions,
		revoke: () => {
			authorized = false;
		},
	};
}
function request(
	snapshot: ReturnType<typeof fixture>["snapshot"],
	id: string,
	amount = 60,
) {
	if (!snapshot.identity) throw new Error("missing identity");
	return {
		reservationId: id,
		requestDigest: id,
		identity: snapshot.identity,
		expectedSeq: snapshot.seq,
		now: NOW,
		quote: create(HostingQuoteSchema, {
			quoteId: `quote:${id}`,
			yardId: "yard",
			providerId: "provider",
			ownerTenantId: "tenant",
			currency: "USD",
			totalMicros: amount,
			liabilityBoundMicros: amount,
			observedAt: NOW,
			validUntil: UNTIL,
			components: [{ name: "complete", costMicros: amount }],
			requestDigest: id,
		}),
	};
}

describe("majority journal financial authority", () => {
	it("recovers interrupted initialization only after every voter is verified", async () => {
		const f = fixture(),
			initial = f.open(),
			first = f.authority(initial);
		await initial.bootstrap(async () => {});
		f.replicas[0].afterAccept = () => {
			f.replicas[0].afterAccept = undefined;
			f.replicas[1].available = false;
			f.replicas[2].available = false;
		};
		await expect(first.initializeFresh(async () => {})).rejects.toThrow();
		f.replicas[1].available = true;
		f.replicas[2].available = true;
		const reopened = f.authority();
		await expect(
			reopened.initializeFresh(async () => {
				throw new ImmutableJournalError("freshness-unverified");
			}),
		).rejects.toThrow("bootstrap-recovery-unverified");
		f.replicas[2].available = false;
		const before = f.replicas.map((replica) => replica.rows.length);
		await expect(reopened.initializeFresh(async () => {})).rejects.toThrow(
			"bootstrap-recovery-unverified",
		);
		expect(f.replicas.map((replica) => replica.rows.length)).toEqual(before);
		f.replicas[2].available = true;
		const previous = f.replicas[2].rows[0];
		if (!previous) throw new Error("genesis missing");
		f.replicas[2].rows[0] = { ...previous, reason: "foreign" };
		await expect(reopened.initializeFresh(async () => {})).rejects.toThrow(
			"bootstrap-recovery-unverified",
		);
		f.replicas[2].rows[0] = previous;
		await reopened.initializeFresh(async () => {});
		expect(await reopened.read(NOW)).toMatchObject({
			seq: 0,
			reservedMicros: 0,
		});
		expect((await f.open().read()).length).toBe(1);
	});

	it("does not finish an unrelated financial tail during fresh initialization", async () => {
		const f = fixture(),
			first = f.authority();
		await first.initializeFresh(async () => {});
		await first.reserve(request(f.snapshot, "one"));
		const next = request(await first.read(NOW), "two", 40);
		f.replicas[0].afterAccept = () => {
			f.replicas[0].afterAccept = undefined;
			f.replicas[1].available = false;
			f.replicas[2].available = false;
		};
		await expect(first.reserve(next)).rejects.toThrow();
		f.replicas[1].available = true;
		f.replicas[2].available = true;
		const before = f.replicas.map((replica) => replica.rows.length);
		await expect(f.authority().initializeFresh(async () => {})).rejects.toThrow(
			"bootstrap-recovery-unverified",
		);
		expect(f.replicas.map((replica) => replica.rows.length)).toEqual(before);
		expect((await f.operational().reserve(next)).status).toBe("held");
	});

	it("serializes competing holds and preserves policy across independent clients", async () => {
		const f = fixture(),
			first = f.authority(),
			second = f.authority();
		await first.initializeFresh(async () => {});
		const results = await Promise.allSettled([
			first.reserve(request(f.snapshot, "one")),
			second.reserve(request(f.snapshot, "two")),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const current = await second.read(NOW);
		expect(current).toMatchObject({ seq: 1, reservedMicros: 60 });
		await expect(second.reserve(request(current, "third"))).rejects.toThrow(
			"budget exhausted",
		);
		expect((await f.open().read()).length).toBe(2);
	});

	it("retains holds through a member outage and reopened authority", async () => {
		const f = fixture(),
			first = f.authority();
		await first.initializeFresh(async () => {});
		await first.reserve(request(f.snapshot, "one"));
		f.replicas[0].available = false;
		const readOnly = f.authority();
		const before = f.replicas.map((replica) => replica.rows.length);
		await expect(readOnly.read(NOW)).rejects.toThrow("quorum-unavailable");
		expect(f.replicas.map((replica) => replica.rows.length)).toEqual(before);
		const reopened = f.operational();
		const current = await reopened.read(NOW);
		expect(f.recoveries()).toBe(1);
		await reopened.reserve(request(current, "two", 40));
		expect(await reopened.read(NOW)).toMatchObject({
			seq: 2,
			reservedMicros: 100,
		});
		expect((await reopened.lookup("one"))?.status).toBe("held");
	});
	it("reconciles a lost commit response without duplicating a hold", async () => {
		const f = fixture(),
			underlying = f.open();
		let loseResponse = false;
		const wrapper = {
			...underlying,
			async append(...args: Parameters<typeof underlying.append>) {
				const result = await underlying.append(...args);
				if (loseResponse) {
					loseResponse = false;
					throw new Error("commit response lost");
				}
				return result;
			},
		};
		const first = f.authority(wrapper);
		await first.initializeFresh(async () => {});
		const intent = request(f.snapshot, "one");
		loseResponse = true;
		await expect(first.reserve(intent)).rejects.toThrow("commit response lost");
		expect((await f.authority().reserve(intent)).status).toBe("held");
		expect(await f.authority().read(NOW)).toMatchObject({
			seq: 1,
			reservedMicros: 60,
		});
		expect((await underlying.read()).length).toBe(2);
	});
	it("finishes an interrupted financial decision before replaying it", async () => {
		const f = fixture(),
			first = f.authority();
		await first.initializeFresh(async () => {});
		f.replicas[0].afterAccept = () => {
			f.replicas[0].afterAccept = undefined;
			f.replicas[1].available = false;
			f.replicas[2].available = false;
		};
		const intent = request(f.snapshot, "one");
		await expect(first.reserve(intent)).rejects.toThrow();
		f.replicas[1].available = true;
		f.replicas[2].available = true;
		const reopened = f.operational();
		const before = f.replicas.map((replica) => replica.rows.length);
		await expect(f.authority().read(NOW)).rejects.toThrow("quorum-unavailable");
		expect(f.replicas.map((replica) => replica.rows.length)).toEqual(before);
		expect((await reopened.reserve(intent)).status).toBe("held");
		expect(await reopened.read(NOW)).toMatchObject({
			seq: 1,
			reservedMicros: 60,
		});
		expect(f.actions).toContain("recover");
	});
	it("does not repair or change a hold when separate recovery funding is denied", async () => {
		const f = fixture(),
			first = f.authority();
		await first.initializeFresh(async () => {});
		await first.reserve(request(f.snapshot, "one"));
		f.replicas[0].available = false;
		const before = f.replicas.map((replica) => replica.rows.length);
		f.denyRecovery();
		await expect(f.operational().read(NOW)).rejects.toThrow(
			"recovery funding revoked",
		);
		expect(f.replicas.map((replica) => replica.rows.length)).toEqual(before);
		expect(f.actions).not.toContain("recover");
	});
	it("does not repair after its recovery actor has lost the lease", async () => {
		const f = fixture(),
			first = f.authority();
		await first.initializeFresh(async () => {});
		await first.reserve(request(f.snapshot, "one"));
		f.replicas[0].available = false;
		const before = f.replicas.map((replica) => replica.rows.length);
		let replacement:
			| Awaited<ReturnType<typeof f.actorHost.acquire>>
			| undefined;
		const actorHost = {
			async acquire(key: string, input: { holderId: string }) {
				const old = await f.actorHost.acquire(key, input);
				return {
					...old,
					async revalidate() {
						if (!replacement) {
							await old.release();
							replacement = await f.actorHost.acquire(key, {
								holderId: "replacement",
							});
						}
						await old.revalidate();
					},
				};
			},
		};
		if (!f.snapshot.identity) throw new Error("missing budget identity");
		const operational = createOperationalFleetBudgetAdmissionAuthority({
			journal: f.open(),
			snapshot: f.snapshot,
			recoveryIdentity: f.snapshot.identity,
			now: () => NOW,
			actorHost,
			authorizeRecovery: async () => async () => {},
		});
		try {
			await expect(operational.read(NOW)).rejects.toThrow();
			expect(f.replicas.map((replica) => replica.rows.length)).toEqual(before);
			expect(f.actions).not.toContain("recover");
		} finally {
			await replacement?.release();
		}
	});
	it("preserves the same hold after authority expires following a completed recovery", async () => {
		const f = fixture(),
			first = f.authority();
		await first.initializeFresh(async () => {});
		await first.reserve(request(f.snapshot, "one"));
		f.replicas[0].available = false;
		let validations = 0;
		if (!f.snapshot.identity) throw new Error("missing budget identity");
		const operational = createOperationalFleetBudgetAdmissionAuthority({
			journal: f.open(),
			snapshot: f.snapshot,
			recoveryIdentity: f.snapshot.identity,
			now: () => NOW,
			actorHost: f.actorHost,
			authorizeRecovery: async () => async () => {
				if (++validations > 1) throw new Error("funding expired");
			},
		});
		await expect(operational.read(NOW)).rejects.toThrow("funding expired");
		const reopened = f.operational();
		expect(await reopened.read(NOW)).toMatchObject({
			seq: 1,
			reservedMicros: 60,
		});
		expect((await reopened.lookup("one"))?.status).toBe("held");
		expect(
			(await f.open().read()).filter((entry) => entry.position > 1),
		).toHaveLength(1);
	});
	it("shares one funded recovery among concurrent operational readers", async () => {
		const f = fixture(),
			first = f.authority();
		await first.initializeFresh(async () => {});
		await first.reserve(request(f.snapshot, "one"));
		f.replicas[0].available = false;
		if (!f.snapshot.identity) throw new Error("missing budget identity");
		let release!: () => void,
			started!: () => void,
			calls = 0;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const operational = createOperationalFleetBudgetAdmissionAuthority({
			journal: f.open(),
			snapshot: f.snapshot,
			recoveryIdentity: f.snapshot.identity,
			now: () => NOW,
			actorHost: f.actorHost,
			async authorizeRecovery() {
				calls++;
				started();
				await gate;
				return async () => {};
			},
		});
		const firstRead = operational.read(NOW),
			secondRead = operational.read(NOW);
		try {
			await ready;
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			release();
		}
		const results = await Promise.all([firstRead, secondRead]);
		expect(calls).toBe(1);
		expect(results.map((row) => row.reservedMicros)).toEqual([60, 60]);
	});
	it("refuses uninitialized, foreign, unfunded and quorum-lost journals", async () => {
		const f = fixture(),
			first = f.authority();
		await expect(first.read(NOW)).rejects.toThrow();
		await first.initializeFresh(async () => {});
		const foreign = create(BudgetLedgerSnapshotSchema, {
			...f.snapshot,
			identity: { ...f.snapshot.identity, budgetId: "other" },
		});
		const other = createFleetBudgetAdmissionAuthority({
			journal: f.open(),
			snapshot: foreign,
			now: () => NOW,
		});
		await expect(other.read(NOW)).rejects.toThrow("another budget");
		f.replicas[0].available = false;
		f.replicas[1].available = false;
		await expect(first.read(NOW)).rejects.toThrow();
		f.replicas[0].available = true;
		f.replicas[1].available = true;
		f.revoke();
		await expect(first.read(NOW)).rejects.toThrow("authorization-unavailable");
	});
});
