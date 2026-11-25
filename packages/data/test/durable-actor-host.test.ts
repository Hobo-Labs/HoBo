/**
 * The durable ActorHost — the SQLite-backed lease.
 *
 * A lease is what makes single-writer-per-aggregate true (ADR-0135). Two
 * holders believing they hold the same key at once is the failure this exists
 * to prevent, so what matters is not the happy path but the translation layer:
 * this host owns almost no logic, and the logic it does own is *which journal
 * errors mean somebody else has the key*.
 *
 * **A stale fence is a lease conflict, not a crash.** The journal signals a
 * lost race with `StaleFenceError` / `STALE_FENCE`, and a caller that received
 * that verbatim would have to know the storage layer's error vocabulary to
 * retry correctly. Translating it to `LeaseConflictError` is what lets a caller
 * back off without importing the storage package.
 *
 * **Every other error passes through untouched.** A disk failure dressed up as
 * a lease conflict would send a caller into a retry loop against a database
 * that is not coming back — the one thing worse than surfacing the real error.
 *
 * **The fence token comes from the journal, never from here.** It is the
 * monotonic proof of which holder is current; a host that generated or
 * defaulted one would hand out a token that fences nothing.
 *
 * **Release names the fence it holds.** Releasing by key alone would let a
 * holder whose lease already expired and was reacquired release the *new*
 * holder's lease.
 */
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

/** A journal recording what it was asked, answering from a script. */
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
		// The fence is the monotonic proof of which holder is current; a host
		// that generated or defaulted one would hand out a token fencing nothing.
		const j = journal();
		const first = host(j).acquire("order:1", { holderId: "a" });
		expect(first.fenceToken).toBe(1n);
	});

	it("carries the journal's expiry, not a locally computed one", () => {
		// The lease expires against the database's clock. A locally derived
		// expiry that ran ahead would have a holder keep working past it.
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
		// A lease with no expiry is a key a crashed holder keeps forever.
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
		// A caller who could rewrite the fence token on their own lease would
		// defeat fencing entirely.
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
		// An empty key is one shared lease for every aggregate that forgot to
		// name itself — the opposite of single-writer.
		const j = journal();
		expect(() => host(j).acquire("", { holderId: "a" })).toThrow(TypeError);
		expect(j.acquires).toHaveLength(0);
	});

	it("refuses a non-string key", () => {
		const acquire = host().acquire;
		// SAFETY: the test subject is the runtime parse of a non-string key at the host I/O boundary.
		const key = 7 as string;
		expect(() => acquire(key, { holderId: "a" })).toThrow(
			/key must be a non-empty string/u,
		);
	});

	it("refuses an empty holder id", () => {
		// The holder is who the lease is *for*; without it a release cannot be
		// attributed and fencing has nothing to compare.
		expect(() => host().acquire("order:1", { holderId: "" })).toThrow(
			/holderId must be a non-empty string/u,
		);
	});

	it("refuses a missing request object rather than dereferencing it", () => {
		const acquire = host().acquire;
		// SAFETY: missing request object is the I/O-boundary case acquire must refuse.
		const request = undefined as { holderId: string };
		expect(() => acquire("order:1", request)).toThrow(
			/holderId must be a non-empty string/u,
		);
	});

	it("refuses a non-string holder id", () => {
		const acquire = host().acquire;
		// SAFETY: non-string holderId is the I/O-boundary case acquire must refuse.
		const holderId = 1 as string;
		expect(() => acquire("order:1", { holderId })).toThrow(TypeError);
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
		// A caller receiving the storage layer's error verbatim would have to
		// know its vocabulary to retry correctly.
		const error = Object.assign(new Error("fence 3 < 4"), {
			name: "StaleFenceError",
		});
		expect(() =>
			host(stale(error)).acquire("order:1", { holderId: "b" }),
		).toThrow(LeaseConflictError);
	});

	it("translates the STALE_FENCE code too, whatever the error is named", () => {
		// The code is the stable signal; the name is not guaranteed across
		// storage drivers.
		const error = Object.assign(new Error("conflict"), {
			code: "STALE_FENCE",
		});
		expect(() =>
			host(stale(error)).acquire("order:1", { holderId: "b" }),
		).toThrow(LeaseConflictError);
	});

	it("names the key that was contended", () => {
		// A conflict with no key is unactionable when a worker holds several.
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
		// Callers branch on this rather than the message.
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
		// A disk failure dressed as a lease conflict sends a caller into a retry
		// loop against a database that is not coming back.
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
		// Releasing by key alone would let a holder whose lease already expired
		// and was reacquired release the *new* holder's lease.
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

	it("can be called more than once, leaving the journal to decide", () => {
		// Idempotency belongs where the state is; suppressing the second call
		// here would hide a double-release from the layer that can detect it.
		const j = journal();
		const lease = host(j).acquire("order:1", { holderId: "a" });
		lease.release();
		lease.release();
		expect(j.releases).toHaveLength(2);
	});
});
