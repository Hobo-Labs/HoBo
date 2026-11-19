import { describe, expect, it } from "vitest";

import { LeaseConflictError } from "../src/actor-host.js";
import {
	type ActorLeaseGrant,
	type ActorLeaseJournal,
	createDurableActorHost,
	type DurableActorHostOptions,
} from "../src/durable-actor-host.js";

type AcquireCall = {
	key: string;
	holderId: string;
	leaseTtlMs: number;
};

interface FakeJournal {
	acquires: AcquireCall[];
	releases: [string, string, bigint][];
	impl: ActorLeaseJournal;
}

interface JournalBehaviour {
	onAcquire?: (call: AcquireCall) => ActorLeaseGrant;
}

function journal(behaviour: JournalBehaviour = {}): FakeJournal {
	const acquires: AcquireCall[] = [];
	const releases: [string, string, bigint][] = [];
	let fence = 0n;
	const impl: ActorLeaseJournal = {
		acquireActorLease(call: AcquireCall) {
			acquires.push(call);
			const scripted = behaviour.onAcquire?.(call);
			if (scripted !== undefined) return scripted;
			fence += 1n;
			return {
				key: call.key,
				holderId: call.holderId,
				fenceToken: fence,
				expiresAt: "2030-01-01T00:00:00.000Z",
			};
		},
		releaseActorLease(key: string, holderId: string, fenceToken: bigint) {
			releases.push([key, holderId, fenceToken]);
		},
	};
	return { acquires, releases, impl };
}

function host(j = journal(), leaseTtlMs?: number) {
	const options: DurableActorHostOptions = { journal: j.impl };
	if (leaseTtlMs !== undefined) options.leaseTtlMs = leaseTtlMs;
	return createDurableActorHost(options);
}

describe("acquiring a lease", () => {
	it("returns the lease the journal granted", () => {
		const lease = host().acquire("order:1", { holderId: "worker-a" });
		expect(lease).toMatchObject({ key: "order:1", holderId: "worker-a" });
	});

	it("carries the journal's fence token unchanged", () => {
		const j = journal();
		const first = host(j).acquire("order:1", { holderId: "a" });
		expect(first.fenceToken).toBe(1n);
	});

	it("carries the journal's expiry, not a locally computed one", () => {
		expect(host().acquire("order:1", { holderId: "a" }).expiresAt).toBe(
			"2030-01-01T00:00:00.000Z",
		);
	});

	it("passes the key and holder through to the journal", () => {
		const j = journal();
		host(j).acquire("order:1", { holderId: "worker-a" });
		expect(j.acquires[0]).toMatchObject({
			key: "order:1",
			holderId: "worker-a",
		});
	});

	it("applies a default TTL rather than leaving the lease unbounded", () => {
		const j = journal();
		host(j).acquire("order:1", { holderId: "a" });
		expect(j.acquires[0]?.leaseTtlMs).toBeGreaterThan(0);
	});

	it("uses a configured TTL", () => {
		const j = journal();
		host(j, 5_000).acquire("order:1", { holderId: "a" });
		expect(j.acquires[0]?.leaseTtlMs).toBe(5_000);
	});

	it("freezes the lease it hands out", () => {
		expect(Object.isFrozen(host().acquire("order:1", { holderId: "a" }))).toBe(
			true,
		);
	});

	it("freezes the host", () => {
		expect(Object.isFrozen(host())).toBe(true);
	});

	it("takes a fresh fence for each acquisition", () => {
		const j = journal();
		const h = host(j);
		expect(h.acquire("order:1", { holderId: "a" }).fenceToken).not.toBe(
			h.acquire("order:2", { holderId: "b" }).fenceToken,
		);
	});
});

describe("refusals before the journal is touched", () => {
	it("refuses an empty key", () => {
		const j = journal();
		expect(() => host(j).acquire("", { holderId: "a" })).toThrow(TypeError);
		expect(j.acquires).toHaveLength(0);
	});

	it("refuses a non-string key", () => {
		expect(() => {
			// @ts-expect-error
			host().acquire(7, { holderId: "a" });
		}).toThrow(/key must be a non-empty string/u);
	});

	it("refuses an empty holder id", () => {
		expect(() => host().acquire("order:1", { holderId: "" })).toThrow(
			/holderId must be a non-empty string/u,
		);
	});

	it("refuses a missing request object rather than dereferencing it", () => {
		expect(() => {
			// @ts-expect-error
			host().acquire("order:1", undefined);
		}).toThrow(/holderId must be a non-empty string/u);
	});

	it("refuses a non-string holder id", () => {
		expect(() => {
			// @ts-expect-error
			host().acquire("order:1", { holderId: 1 });
		}).toThrow(TypeError);
	});
});

describe("losing the race", () => {
	const stale = (error: Error) =>
		journal({
			onAcquire: () => {
				throw error;
			},
		});

	it("translates a StaleFenceError into a lease conflict", () => {
		const error = Object.assign(new Error("fence 3 < 4"), {
			name: "StaleFenceError",
		});
		expect(() =>
			host(stale(error)).acquire("order:1", { holderId: "b" }),
		).toThrow(LeaseConflictError);
	});

	it("translates the STALE_FENCE code too, whatever the error is named", () => {
		const error = Object.assign(new Error("conflict"), {
			code: "STALE_FENCE",
		});
		expect(() =>
			host(stale(error)).acquire("order:1", { holderId: "b" }),
		).toThrow(LeaseConflictError);
	});

	it("names the key that was contended", () => {
		const error = Object.assign(new Error("fence"), {
			name: "StaleFenceError",
		});
		expect(() =>
			host(stale(error)).acquire("order:1", { holderId: "b" }),
		).toThrow(/lease conflict for order:1/u);
	});

	it("keeps the journal's own explanation in the message", () => {
		const error = Object.assign(new Error("held by worker-a until 12:00"), {
			name: "StaleFenceError",
		});
		expect(() =>
			host(stale(error)).acquire("order:1", { holderId: "b" }),
		).toThrow(/held by worker-a/u);
	});

	it("tags the conflict with a stable code", () => {
		const error = Object.assign(new Error("fence"), { code: "STALE_FENCE" });
		const thrown = (() => {
			try {
				host(stale(error)).acquire("order:1", { holderId: "b" });
			} catch (err) {
				if (err instanceof LeaseConflictError) return err;
				throw err;
			}
			return null;
		})();
		expect(thrown?.code).toBe("LEASE_CONFLICT");
	});

	it("passes any other failure through untouched", () => {
		const error = Object.assign(new Error("disk I/O error"), {
			code: "SQLITE_IOERR",
		});
		expect(() =>
			host(stale(error)).acquire("order:1", { holderId: "b" }),
		).toThrow(/disk I\/O error/u);
		expect(() =>
			host(stale(error)).acquire("order:1", { holderId: "b" }),
		).not.toThrow(LeaseConflictError);
	});

	it("passes a thrown non-Error through rather than mislabelling it", () => {
		const j = journal({
			onAcquire: () => {
				throw "database is locked";
			},
		});
		expect(() => host(j).acquire("order:1", { holderId: "b" })).toThrow();
	});
});

describe("releasing a lease", () => {
	it("releases the key it holds", () => {
		const j = journal();
		host(j).acquire("order:1", { holderId: "a" }).release();
		expect(j.releases[0]?.[0]).toBe("order:1");
	});

	it("names the holder, so a release is attributable", () => {
		const j = journal();
		host(j).acquire("order:1", { holderId: "worker-a" }).release();
		expect(j.releases[0]?.[1]).toBe("worker-a");
	});

	it("names the fence it was granted", () => {
		const j = journal();
		host(j).acquire("order:1", { holderId: "a" }).release();
		expect(j.releases[0]?.[2]).toBe(1n);
	});

	it("releases the lease's own fence, not the journal's latest", () => {
		const j = journal();
		const h = host(j);
		const first = h.acquire("order:1", { holderId: "a" });
		h.acquire("order:2", { holderId: "b" });
		first.release();
		expect(j.releases[0]?.[2]).toBe(1n);
	});

	it("releases the originally granted lease if the journal reuses its result", () => {
		const grant = {
			key: "order:1",
			holderId: "worker-a",
			fenceToken: 1n,
			expiresAt: "2030-01-01T00:00:00.000Z",
		};
		const j = journal({ onAcquire: () => grant });
		const lease = host(j).acquire("order:1", { holderId: "worker-a" });
		grant.key = "order:2";
		grant.holderId = "worker-b";
		grant.fenceToken = 2n;
		lease.release();
		expect(j.releases).toEqual([["order:1", "worker-a", 1n]]);
	});

	it("can be called more than once, leaving the journal to decide", () => {
		const j = journal();
		const lease = host(j).acquire("order:1", { holderId: "a" });
		lease.release();
		lease.release();
		expect(j.releases).toHaveLength(2);
	});
});
