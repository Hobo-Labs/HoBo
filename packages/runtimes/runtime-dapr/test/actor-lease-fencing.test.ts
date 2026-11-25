/**
 * Actor leases, fencing, and what a stale holder is not allowed to do.
 *
 * A Dapr actor is a single-writer stream. The lease is what makes that true,
 * and the fence token is what makes it *stay* true after a lease changes
 * hands: a holder that was paused, or partitioned, or simply slow can come
 * back and try to write, and by then someone else owns the actor. Accepting
 * that write would interleave two writers into one stream — exactly the thing
 * an actor exists to prevent — and the corruption would be invisible until
 * something folded the stream and got an impossible state.
 *
 * So every state append is checked against four things, and each is a separate
 * way the same failure arrives:
 *
 * - **the lease still exists** — the actor may never have been acquired;
 * - **it has not been released** — a holder that released cannot write again;
 * - **the fence token matches** — a token from before a re-acquire is stale;
 * - **the holder matches** — a token guessed or copied by another holder is
 *   not the same as holding the lease.
 *
 * And separately: **the lease has not expired.** A holder that stopped
 * renewing has lost the actor to whoever comes next, even though nothing has
 * explicitly taken it.
 *
 * Fence tokens are monotonic across re-acquires, which is what lets a late
 * write be recognised as late rather than merely different.
 *
 * The live path adds a daprd client for placement; these drive it with the
 * in-memory harness client, so the client-present branches run for real
 * without a sidecar.
 */

import { describe, expect, it } from "vitest";
import {
	createDaprActorHost,
	createInMemoryDaprClient,
	DaprLeaseConflictError,
	DaprStaleFenceError,
	defaultDaprRuntimeConfig,
} from "../src/index.js";

const CONFIG = defaultDaprRuntimeConfig("acme", "prod");

/** An actor host over a controllable clock, optionally on the live path. */
function hostFor(options: { live?: boolean; nowMs?: () => number } = {}) {
	return createDaprActorHost({
		config: CONFIG,
		...(options.live ? { client: createInMemoryDaprClient() } : {}),
		...(options.nowMs ? { nowMs: options.nowMs } : {}),
		leaseTtlMs: 30_000,
	});
}

const stateOf = (host: ReturnType<typeof hostFor>, key = "Cart/1") =>
	host.state(key, {
		initialState: { items: 0 },
		fold: (state: { items: number }) => ({ items: state.items + 1 }),
		// SAFETY: the host reads exactly the fields a state request names.
	} as never);

describe("acquiring an actor", () => {
	it("hands the first caller a lease", () => {
		expect(hostFor().acquire("Cart/1", { holderId: "a" })).toMatchObject({
			key: "Cart/1",
			holderId: "a",
			placement: "dapr",
		});
	});

	it("refuses a second holder while the first is live", () => {
		// Single-writer is the whole contract. Two live leases on one actor
		// would interleave two writers into one stream.
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			DaprLeaseConflictError,
		);
	});

	it("names the holder that has it", () => {
		// An operator seeing a conflict needs to know who to look at, not
		// merely that someone holds it.
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			/held by a/,
		);
	});

	it("lets a different actor be acquired independently", () => {
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/2", { holderId: "b" })).not.toThrow();
	});

	it("hands the actor on after a release", () => {
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" }).release();
		expect(() => host.acquire("Cart/1", { holderId: "b" })).not.toThrow();
	});

	it("hands the actor on after the lease expires", () => {
		// A holder that stopped renewing has lost the actor even though nothing
		// explicitly took it — otherwise a crashed holder would strand its
		// actor forever.
		let now = 1_000;
		const host = hostFor({ nowMs: () => now });
		host.acquire("Cart/1", { holderId: "a" });
		now += 31_000;
		expect(() => host.acquire("Cart/1", { holderId: "b" })).not.toThrow();
	});

	it("keeps the lease within its TTL", () => {
		let now = 1_000;
		const host = hostFor({ nowMs: () => now });
		host.acquire("Cart/1", { holderId: "a" });
		now += 29_000;
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			DaprLeaseConflictError,
		);
	});

	it("carries an expiry the holder can see", () => {
		// A holder that cannot tell when its lease ends cannot renew in time.
		const host = hostFor({ nowMs: () => 1_000 });
		expect(host.acquire("Cart/1", { holderId: "a" }).expiresAt).toBe(
			new Date(31_000).toISOString(),
		);
	});

	it("freezes the lease it hands out", () => {
		// The fence token is the authority for every later write; a holder that
		// could rewrite it could forge one.
		expect(
			Object.isFrozen(hostFor().acquire("Cart/1", { holderId: "a" })),
		).toBe(true);
	});
});

describe("fence tokens", () => {
	it("starts at one", () => {
		expect(hostFor().acquire("Cart/1", { holderId: "a" }).fenceToken).toBe(1n);
	});

	it("increases on every re-acquire", () => {
		// Monotonic, which is what lets a late write be recognised as late
		// rather than merely different.
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" }).release();
		expect(host.acquire("Cart/1", { holderId: "b" }).fenceToken).toBe(2n);
	});

	it("keeps counting across an expiry, not just a release", () => {
		// An expiry is a change of ownership too. Restarting the count would
		// make a token from before the expiry look current again.
		let now = 1_000;
		const host = hostFor({ nowMs: () => now });
		host.acquire("Cart/1", { holderId: "a" });
		now += 31_000;
		expect(host.acquire("Cart/1", { holderId: "b" }).fenceToken).toBe(2n);
	});

	it("counts per actor, not globally", () => {
		// A global counter would make one busy actor inflate every other
		// actor's tokens, and a token would stop meaning "this actor's Nth
		// owner".
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" });
		expect(host.acquire("Cart/2", { holderId: "b" }).fenceToken).toBe(1n);
	});
});

describe("appending state", () => {
	it("accepts a write from the current holder", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(stateOf(host).append(lease, { type: "item.Added" })).toMatchObject({
			seq: 1,
		});
	});

	it("numbers writes in order", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		const state = stateOf(host);
		state.append(lease, { type: "item.Added" });
		expect(state.append(lease, { type: "item.Added" }).seq).toBe(2);
	});

	it("refuses a write against an actor never acquired", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(() =>
			stateOf(host, "Cart/2").append(lease, { type: "item.Added" }),
		).toThrow(DaprStaleFenceError);
	});

	it("refuses a write from a holder that released", () => {
		// Releasing is giving the actor up. A write afterwards is the classic
		// paused-then-resumed writer.
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		lease.release();
		expect(() => stateOf(host).append(lease, { type: "item.Added" })).toThrow(
			DaprStaleFenceError,
		);
	});

	it("refuses a write carrying a superseded fence token", () => {
		// The heart of fencing: the old holder is back, and someone else owns
		// the actor now.
		const host = hostFor();
		const stale = host.acquire("Cart/1", { holderId: "a" });
		stale.release();
		host.acquire("Cart/1", { holderId: "b" });
		expect(() => stateOf(host).append(stale, { type: "item.Added" })).toThrow(
			/stale fence/,
		);
	});

	it("refuses a write whose holder does not match the token", () => {
		// A token is not a bearer credential. Holding the number is not the
		// same as holding the lease, so both are checked.
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(() =>
			stateOf(host).append(
				{ ...lease, holderId: "impostor" },
				{ type: "item.Added" },
			),
		).toThrow(DaprStaleFenceError);
	});

	it("refuses a write after the lease expired", () => {
		// Checked separately from the token, because an expired lease still has
		// a matching token and holder — nothing took the actor, the holder just
		// stopped being entitled to it.
		let now = 1_000;
		const host = hostFor({ nowMs: () => now });
		const lease = host.acquire("Cart/1", { holderId: "a" });
		now += 31_000;
		expect(() => stateOf(host).append(lease, { type: "item.Added" })).toThrow(
			/lease expired/,
		);
	});

	it("names the actor in every refusal", () => {
		// One host serves many actors; a bare "stale fence" would not say which
		// stream was protected.
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		lease.release();
		expect(() => stateOf(host).append(lease, { type: "item.Added" })).toThrow(
			/Cart\/1/,
		);
	});
});

describe("reading state", () => {
	it("folds the appended events", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		const state = stateOf(host);
		state.append(lease, { type: "item.Added" });
		state.append(lease, { type: "item.Added" });
		expect(state.read()).toMatchObject({ seq: 2, state: { items: 2 } });
	});

	it("returns the initial state for an actor with no events", () => {
		// Reading is not gated on a lease: a reader is not a writer, and
		// requiring one would make every projection contend for the actor.
		expect(stateOf(hostFor()).read()).toMatchObject({
			seq: 0,
			state: { items: 0 },
		});
	});

	it("addresses the stream by app id and actor key", () => {
		// The stream id is what a projection subscribes to; deriving it from
		// anything else would break a subscriber on an app rename.
		expect(stateOf(hostFor()).read().streamId).toContain("Cart/1");
	});

	it("keeps two actors' streams apart", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		stateOf(host).append(lease, { type: "item.Added" });
		expect(stateOf(host, "Cart/2").read().seq).toBe(0);
	});
});

describe("the live daprd path", () => {
	it("reports live fidelity when a client is injected", () => {
		// Fidelity is a claim about whether placement actually reached daprd.
		// Reporting `live` without a client would overstate the guarantee.
		expect(hostFor({ live: true }).fidelity).toBe("live");
	});

	it("reports simulated fidelity without one", () => {
		expect(hostFor().fidelity).toBe("simulated");
	});

	it("still enforces single-writer on the live path", () => {
		// Placement through daprd does not replace the local check — the host
		// is the writer, and a conflict has to be refused before any state is
		// touched.
		const host = hostFor({ live: true });
		host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			DaprLeaseConflictError,
		);
	});

	it("still fences state writes on the live path", () => {
		const host = hostFor({ live: true });
		const lease = host.acquire("Cart/1", { holderId: "a" });
		lease.release();
		expect(() => stateOf(host).append(lease, { type: "item.Added" })).toThrow(
			DaprStaleFenceError,
		);
	});

	it("handles an actor key with no type separator", () => {
		// `Cart/1` splits into a type and an id; a bare `singleton` has no
		// separator, and the fallback keeps it addressable rather than
		// producing an empty actor type daprd would reject.
		const host = hostFor({ live: true });
		expect(() => host.acquire("singleton", { holderId: "a" })).not.toThrow();
	});

	it("handles an actor key with several separators", () => {
		// Everything after the first segment is the id, so a hierarchical key
		// round-trips instead of being truncated at the second slash.
		const host = hostFor({ live: true });
		expect(() =>
			host.acquire("Cart/tenant-a/1", { holderId: "a" }),
		).not.toThrow();
	});

	it("releases through the client without throwing", () => {
		const host = hostFor({ live: true });
		expect(() =>
			host.acquire("Cart/1", { holderId: "a" }).release(),
		).not.toThrow();
	});

	it("ignores a release from a superseded lease", () => {
		// A stale holder releasing must not passivate the actor out from under
		// its current owner — the release is checked against the fence token
		// exactly as a write is.
		const host = hostFor();
		const stale = host.acquire("Cart/1", { holderId: "a" });
		stale.release();
		const current = host.acquire("Cart/1", { holderId: "b" });
		stale.release();
		expect(() =>
			stateOf(host).append(current, { type: "item.Added" }),
		).not.toThrow();
	});
});

describe("metering", () => {
	it("emits a usage event on activation when a meter is wired", () => {
		// Activations are billable; a host that did not report them would
		// under-bill silently.
		const emitted: unknown[] = [];
		const host = createDaprActorHost({
			config: CONFIG,
			metering: {
				emit: async (event: unknown) => {
					emitted.push(event);
				},
			},
			// SAFETY: the host reads exactly the fields an options bag names.
		} as never);
		host.acquire("Cart/1", { holderId: "a" });
		expect(emitted).toHaveLength(1);
	});

	it("names the actor and the placement on the usage event", () => {
		const emitted: Array<{ resource?: string }> = [];
		const host = createDaprActorHost({
			config: CONFIG,
			metering: {
				emit: async (event: { resource?: string }) => {
					emitted.push(event);
				},
			},
			// SAFETY: the host reads exactly the fields an options bag names.
		} as never);
		host.acquire("Cart/1", { holderId: "a" });
		expect(emitted[0]?.resource).toBe("Cart/1");
	});

	it("activates without one", () => {
		// Metering is optional; a host with no meter still has to serve.
		expect(() => hostFor().acquire("Cart/1", { holderId: "a" })).not.toThrow();
	});
});
