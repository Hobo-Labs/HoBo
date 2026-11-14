/**
 * Station occupancy fold + on-disk Station client.
 *
 * The fold is the only thing that decides which Rail is *active*, and the
 * client is the only thing that turns a directory under HOBO_HOME back into
 * that answer. Both are replayed on every CLI invocation, so a branch that is
 * wrong here is wrong for every receipt the Station ever stamps — which is why
 * the assertions below are written against the failure each one prevents
 * rather than against the shape the code happens to produce today.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	STATION_EVENTS,
	type StationEvent,
	stationEvent,
} from "../src/events.js";
import { asJsonObject, isJsonString, type JsonValue } from "../src/json.js";
import { createBootstrapRail, createRail } from "../src/rail.js";
import {
	assertConnectionStationAccess,
	createStationClient,
	initStation,
	listStationIds,
	loadStationEvents,
	persistStationEvents,
	resolveStationContext,
	stationEventsPath,
	stationRoot,
} from "../src/station-client.js";
import { foldStationEvents, StationService } from "../src/station-service.js";
import type { StationIsolation } from "../src/types.js";

const STATION_ID = "station:fold-suite";
const ISOLATION: StationIsolation = Object.freeze({
	tenant: "acme",
	residency: "local",
	airgap: false,
	trustDomain: "acme.hobo.local",
});

// HOBO-825: nothing in this file may write outside a temp directory. Every home
// is minted here and torn down in afterEach, so a test that leaks a path fails
// its own cleanup rather than someone else's checkout.
const homes: string[] = [];
function newHome(): string {
	const home = mkdtempSync(join(tmpdir(), "hobo-station-"));
	homes.push(home);
	return home;
}

afterEach(() => {
	while (homes.length > 0) {
		const home = homes.pop();
		if (home !== undefined) rmSync(home, { recursive: true, force: true });
	}
});

function evt<T>(
	type: StationEvent["type"],
	seq: number,
	data?: T,
	time = `2026-01-0${Math.min(seq, 9)}T00:00:00.000Z`,
): StationEvent {
	// Event bodies cross the JSON document boundary, as they do on disk.
	return stationEvent(type, STATION_ID, seq, asJsonObject(data ?? {}), time);
}

function created(seq = 1): StationEvent {
	const bootstrap = createBootstrapRail(STATION_ID, "2026-01-01T00:00:00.000Z");
	return evt(STATION_EVENTS.Created, seq, {
		name: "local",
		isolation: ISOLATION,
		dataDir: "/tmp/does-not-need-to-exist",
		bootstrapRailHash: bootstrap.contentHash,
		bootstrapRail: bootstrap,
	});
}

function isSha256(value: JsonValue | undefined): value is `sha256:${string}` {
	return isJsonString(value) && value.startsWith("sha256:");
}

function bootstrapHashOf(event: StationEvent): `sha256:${string}` {
	const hash = event.data.bootstrapRailHash;
	if (!isSha256(hash)) {
		throw new Error("Created event carries no sha256 bootstrapRailHash");
	}
	return hash;
}

describe("foldStationEvents — establishing occupancy", () => {
	it("returns null for an empty stream so callers cannot mistake 'no station' for 'default station'", () => {
		// A Station that was never created and a Station created with all-default
		// fields would be indistinguishable if this returned a zero-value state,
		// and `initStation` decides whether to create based on exactly this.
		expect(foldStationEvents([])).toBeNull();
	});

	it("returns null when the stream contains only post-create events", () => {
		// Events can legitimately arrive out of order from a truncated log. Every
		// non-Created case guards on `occupancy`; if any of them constructed one,
		// a partial log would fold into a Station with no isolation.
		const state = foldStationEvents([
			evt(STATION_EVENTS.Configured, 2, { connectionCount: 3 }),
			evt(STATION_EVENTS.Closed, 3),
			evt(STATION_EVENTS.IdentityRotated, 4),
			evt(STATION_EVENTS.RailDeactivated, 5, { contentHash: "sha256:ghost" }),
		]);
		expect(state).toBeNull();
	});

	it("seeds occupancy from Created, including the bootstrap Rail as the active one", () => {
		const create = created();
		const state = foldStationEvents([create]);
		expect(state).not.toBeNull();
		const hash = bootstrapHashOf(create);
		// A freshly created Station is *usable*: bootstrapActive true and the
		// bootstrap hash set as active, so `pins()` can answer without a second
		// activation step. Losing this makes `hobo station init` produce a Station
		// that immediately fails `activeRail()`.
		expect(state?.occupancy.activeRailHash).toBe(hash);
		expect(state?.occupancy.bootstrapRailHash).toBe(hash);
		expect(state?.occupancy.bootstrapActive).toBe(true);
		expect(state?.occupancy.status).toBe("open");
		expect(state?.occupancy.connectionCount).toBe(0);
		expect(state?.occupancy.isolation).toEqual(ISOLATION);
		expect(state?.rails[hash]?.isBootstrap).toBe(true);
	});

	it("tolerates a Created event with no bootstrap Rail at all", () => {
		// Both the hash and the embedded rail are optional in the fold. An older
		// log (or a hand-written one) that carries neither must still produce a
		// Station rather than throwing on an absent property.
		const state = foldStationEvents([
			evt(STATION_EVENTS.Created, 1, {
				name: "bare",
				isolation: ISOLATION,
				dataDir: "/tmp/bare",
			}),
		]);
		expect(state?.occupancy.activeRailHash).toBeUndefined();
		expect(state?.occupancy.bootstrapRailHash).toBeUndefined();
		expect(state?.rails).toEqual({});
	});

	it("defaults dataDir to the empty string rather than the literal 'undefined'", () => {
		// `String(data.dataDir ?? "")` is easy to write as `String(data.dataDir)`,
		// which yields the four-character string "undefined" — a path that would
		// be created relative to the process cwd by anything that mkdir's it.
		const state = foldStationEvents([
			evt(STATION_EVENTS.Created, 1, { name: "n", isolation: ISOLATION }),
		]);
		expect(state?.occupancy.dataDir).toBe("");
	});

	it("carries createdAt from the Created event and advances updatedAt independently", () => {
		const state = foldStationEvents([
			created(1),
			evt(STATION_EVENTS.IdentityRotated, 2, {}, "2026-06-06T00:00:00.000Z"),
		]);
		// createdAt is the Station's birth certificate; a fold that reassigns it on
		// every event would make Station age unknowable from the log.
		expect(state?.occupancy.createdAt).toBe("2026-01-01T00:00:00.000Z");
		expect(state?.occupancy.updatedAt).toBe("2026-06-06T00:00:00.000Z");
		expect(state?.occupancy.seq).toBe(2);
	});
});

describe("foldStationEvents — occupancy mutations", () => {
	it("applies a numeric connectionCount and ignores a non-numeric one", () => {
		const withNumber = foldStationEvents([
			created(1),
			evt(STATION_EVENTS.Configured, 2, { connectionCount: 7 }),
		]);
		expect(withNumber?.occupancy.connectionCount).toBe(7);

		const withGarbage = foldStationEvents([
			created(1),
			evt(STATION_EVENTS.Configured, 2, { connectionCount: "7" }),
		]);
		// A string count would flow into arithmetic and quota checks downstream.
		// The typeof guard keeps the last known-good number instead.
		expect(withGarbage?.occupancy.connectionCount).toBe(0);
		// The event still counts as activity — seq and updatedAt move even when
		// the payload was unusable, so the stream head stays correct for CAS.
		expect(withGarbage?.occupancy.seq).toBe(2);
	});

	it("marks the Station closed and keeps it closed", () => {
		const state = foldStationEvents([
			created(1),
			evt(STATION_EVENTS.Closed, 2),
			evt(STATION_EVENTS.Configured, 3, { connectionCount: 1 }),
		]);
		// Nothing but a (nonexistent) reopen event should clear `closed`. If a
		// later Configured reset the status, a closed Station would silently
		// accept connections again.
		expect(state?.occupancy.status).toBe("closed");
	});

	it("treats IdentityRotated as a touch: no occupancy field changes but the head advances", () => {
		const before = foldStationEvents([created(1)]);
		const after = foldStationEvents([
			created(1),
			evt(STATION_EVENTS.IdentityRotated, 2, { spiffeId: "spiffe://x" }),
		]);
		expect(after?.occupancy.activeRailHash).toBe(
			before?.occupancy.activeRailHash,
		);
		expect(after?.occupancy.status).toBe("open");
		// Rotation is a never-compact audit fact; the fold must not swallow it,
		// or a replay would disagree with the persisted stream length.
		expect(after?.occupancy.seq).toBe(2);
	});

	it("ignores an event type the fold does not know", () => {
		// A newer writer's event as read back from its JSON line: well-formed in
		// every field except a type outside this build's StationEventType.
		const fromNewerWriter: StationEvent = JSON.parse(
			JSON.stringify({
				...evt(STATION_EVENTS.Closed, 2),
				type: "station.Unknown",
			}),
		);
		const state = foldStationEvents([created(1), fromNewerWriter]);
		// Forward compatibility: a newer writer's event must not close the Station
		// by falling into a neighbouring case, and must not throw.
		expect(state?.occupancy.status).toBe("open");
		// The default branch does not touch occupancy, so the head stays at 1 even
		// though the stream is two long — the fold reports what it understood.
		expect(state?.occupancy.seq).toBe(1);
	});
});

describe("foldStationEvents — rail catalog", () => {
	function nonBootstrap(id: string) {
		return createRail({
			id,
			name: id,
			version: "1.0.0",
			stationId: STATION_ID,
			now: "2026-02-01T00:00:00.000Z",
		});
	}

	it("indexes published and approved rails by content hash", () => {
		const rail = nonBootstrap("rail-a");
		const state = foldStationEvents([
			created(1),
			evt(STATION_EVENTS.RailPublished, 2, { rail }),
			evt(STATION_EVENTS.RailApproved, 3, {
				rail: { ...rail, activationStatus: "approved" },
			}),
		]);
		// Content addressing is the point: republishing the same body must not
		// create a second catalog entry, or activation by hash becomes ambiguous.
		expect(Object.keys(state?.rails ?? {})).toHaveLength(2); // bootstrap + rail-a
		expect(state?.rails[rail.contentHash]?.activationStatus).toBe("approved");
	});

	it("skips a rail payload with no content hash", () => {
		const state = foldStationEvents([
			created(1),
			evt(STATION_EVENTS.RailPublished, 2, { rail: { id: "no-hash" } }),
		]);
		// Indexing by `undefined` would put a rail under the literal key
		// "undefined" and make `rails["undefined"]` activatable.
		expect(Object.keys(state?.rails ?? {})).toHaveLength(1);
		expect(state?.occupancy.seq).toBe(2);
	});

	it("records a published rail even before the Station exists", () => {
		// The rail branches deliberately index outside the occupancy guard, so a
		// log whose Created line was lost still yields a catalog — but no state,
		// because occupancy is what makes the fold return non-null.
		const rail = nonBootstrap("rail-orphan");
		expect(
			foldStationEvents([evt(STATION_EVENTS.RailPublished, 1, { rail })]),
		).toBeNull();
	});

	it("activation promotes the named rail and demotes the previously active one", () => {
		const create = created(1);
		const rail = nonBootstrap("rail-b");
		const state = foldStationEvents([
			create,
			evt(STATION_EVENTS.RailPublished, 2, { rail }),
			evt(STATION_EVENTS.RailActivated, 3, {
				contentHash: rail.contentHash,
				isBootstrap: false,
			}),
		]);
		expect(state?.occupancy.activeRailHash).toBe(rail.contentHash);
		expect(state?.rails[rail.contentHash]?.activationStatus).toBe("active");
		// Exactly one active Rail, always. The bootstrap rail arrived from
		// `createBootstrapRail` already marked "active"; if the demotion loop
		// missed it, two rails would claim activation and receipts could pin
		// either one.
		expect(state?.rails[bootstrapHashOf(create)]?.activationStatus).toBe(
			"approved",
		);
		// bootstrapActive is what `assertNotBootstrapOnlyInProd` reads; activating
		// a real Rail is precisely the thing that clears the production block.
		expect(state?.occupancy.bootstrapActive).toBe(false);
	});

	it("activation of an unknown hash still moves the pointer", () => {
		// Deliberate: the fold trusts the writer, and `StationService.activateRail`
		// is the guard that refuses unknown hashes. Pinning this keeps the
		// division of labour explicit — the *client* is what surfaces the
		// dangling pointer, as the next test shows.
		const state = foldStationEvents([
			created(1),
			evt(STATION_EVENTS.RailActivated, 2, {
				contentHash: "sha256:not-in-catalog",
				isBootstrap: false,
			}),
		]);
		expect(state?.occupancy.activeRailHash).toBe("sha256:not-in-catalog");
		expect(state?.rails["sha256:not-in-catalog"]).toBeUndefined();
	});

	it("activation with no hash leaves the pointer untouched", () => {
		const create = created(1);
		const state = foldStationEvents([
			create,
			evt(STATION_EVENTS.RailActivated, 2, { isBootstrap: false }),
		]);
		// A malformed activation must not un-pin the current Rail: a Station with
		// no active Rail refuses every deploy.
		expect(state?.occupancy.activeRailHash).toBe(bootstrapHashOf(create));
		expect(state?.occupancy.bootstrapActive).toBe(true);
	});

	it("deactivation clears the pointer and returns the rail to approved", () => {
		const create = created(1);
		const hash = bootstrapHashOf(create);
		const state = foldStationEvents([
			create,
			evt(STATION_EVENTS.RailDeactivated, 2, { contentHash: hash }),
		]);
		expect(state?.occupancy.activeRailHash).toBeUndefined();
		// Deactivated, not retired: the rail stays a candidate for reactivation.
		expect(state?.rails[hash]?.activationStatus).toBe("approved");
		// With no active Rail there is no bootstrap Rail active either — the
		// recomputation must not leave the flag stuck true from Created.
		expect(state?.occupancy.bootstrapActive).toBe(false);
	});

	it("retirement marks the rail retired", () => {
		const create = created(1);
		const hash = bootstrapHashOf(create);
		const state = foldStationEvents([
			create,
			evt(STATION_EVENTS.RailRetired, 2, { contentHash: hash }),
		]);
		// The status distinguishes retired from deactivated so `activateRail` can
		// refuse the former; collapsing them would make retirement reversible.
		expect(state?.rails[hash]?.activationStatus).toBe("retired");
		expect(state?.occupancy.activeRailHash).toBeUndefined();
	});

	it("deactivating a rail that is not the active one leaves the pointer alone", () => {
		const create = created(1);
		const rail = nonBootstrap("rail-c");
		const state = foldStationEvents([
			create,
			evt(STATION_EVENTS.RailPublished, 2, { rail }),
			evt(STATION_EVENTS.RailDeactivated, 3, { contentHash: rail.contentHash }),
		]);
		// Retiring a stale draft must never knock the live Rail out from under a
		// running Station.
		expect(state?.occupancy.activeRailHash).toBe(bootstrapHashOf(create));
		expect(state?.occupancy.bootstrapActive).toBe(true);
	});

	it("deactivating an unknown hash is inert apart from the head", () => {
		const create = created(1);
		const state = foldStationEvents([
			create,
			evt(STATION_EVENTS.RailDeactivated, 2, { contentHash: "sha256:nope" }),
		]);
		expect(state?.occupancy.activeRailHash).toBe(bootstrapHashOf(create));
		expect(state?.occupancy.seq).toBe(2);
	});

	it("deactivation with no hash at all does not clear the pointer", () => {
		const create = created(1);
		const state = foldStationEvents([
			create,
			evt(STATION_EVENTS.RailDeactivated, 2, {}),
		]);
		// `hash !== undefined &&` is the guard under test: without it, an absent
		// hash would compare equal to an absent activeRailHash on a Station that
		// had none, and the recomputation below would be reached with garbage.
		expect(state?.occupancy.activeRailHash).toBe(bootstrapHashOf(create));
	});

	it("recomputes bootstrapActive when the bootstrap Rail is reactivated", () => {
		const create = created(1);
		const boot = bootstrapHashOf(create);
		const rail = nonBootstrap("rail-d");
		const state = foldStationEvents([
			create,
			evt(STATION_EVENTS.RailPublished, 2, { rail }),
			evt(STATION_EVENTS.RailActivated, 3, {
				contentHash: rail.contentHash,
				isBootstrap: false,
			}),
			evt(STATION_EVENTS.RailActivated, 4, {
				contentHash: boot,
				isBootstrap: true,
			}),
		]);
		// Rolling back to bootstrap has to re-arm the production guard, or a
		// Station that fell back to least-privilege would still pass
		// `assertNotBootstrapOnlyInProd`.
		expect(state?.occupancy.bootstrapActive).toBe(true);
		expect(state?.rails[rail.contentHash]?.activationStatus).toBe("approved");
	});

	it("freezes the returned state, catalog and event list", () => {
		const state = foldStationEvents([created(1)]);
		expect(Object.isFrozen(state)).toBe(true);
		expect(Object.isFrozen(state?.occupancy)).toBe(true);
		expect(Object.isFrozen(state?.rails)).toBe(true);
		// The events array is copied before freezing, so a caller mutating its own
		// input afterwards cannot retroactively change a folded snapshot.
		expect(Object.isFrozen(state?.events)).toBe(true);
	});

	it("reports the last applied seq on occupancy, even when it goes backwards", () => {
		const state = foldStationEvents([
			created(5),
			evt(STATION_EVENTS.IdentityRotated, 2),
		]);
		// Pinning what the fold actually does rather than what would be safer.
		// The local `seq` accumulator uses `Math.max`, but every case assigns
		// `occupancy.seq = event.seq` outright, so an out-of-order log lowers the
		// occupancy head. It is only ever read back by callers as "the seq of the
		// event that last touched this Station", and `persistStationEvents`
		// rewrites the whole log rather than appending under CAS, so nothing today
		// depends on monotonicity here — but anything that starts using
		// `occupancy.seq` as an optimistic `expectedSeq` needs to know this test
		// exists, because a single out-of-order line would collide.
		expect(state?.occupancy.seq).toBe(2);
	});

	it("skips a rail hash carried as a non-string", () => {
		const create = created(1);
		const state = foldStationEvents([
			create,
			evt(STATION_EVENTS.RailActivated, 2, {
				contentHash: 42,
				isBootstrap: false,
			}),
		]);
		// `42` is truthy, so it reaches the pointer — pin that this is what the
		// cast-based read actually does rather than assuming a type guard exists.
		expect(state?.occupancy.activeRailHash).toBe(42);
	});
});

describe("StationService", () => {
	const now = () => "2026-03-03T00:00:00.000Z";

	it("creates a Station once and refuses a second create", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		const { occupancy, bootstrap } = svc.create({
			name: "local",
			isolation: ISOLATION,
			dataDir: "/tmp/x",
		});
		expect(occupancy.activeRailHash).toBe(bootstrap.contentHash);
		// Re-creating would append a second Created event, and the fold takes the
		// *last* one — silently replacing isolation and tenancy on a live Station.
		expect(() =>
			svc.create({ name: "again", isolation: ISOLATION, dataDir: "/tmp/y" }),
		).toThrowError(/already initialized/u);
		try {
			svc.create({ name: "again", isolation: ISOLATION, dataDir: "/tmp/y" });
		} catch (error) {
			expect(error).toHaveProperty("code", "station-already-exists");
		}
	});

	it("assigns monotonically increasing seqs starting at 1", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		svc.setConnectionCount(2);
		svc.close();
		// Seq 0 is reserved for "no events"; the fold's null check and the CAS
		// append both depend on the first real event being 1.
		expect(svc.events.map((e) => e.seq)).toEqual([1, 2, 3]);
	});

	it("stamps every event with the injected clock", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		// Determinism: with a fixed clock the bootstrap rail body — and therefore
		// its content hash — is reproducible across runs.
		expect(svc.events.every((e) => e.time === now())).toBe(true);
	});

	it("defaults to the wall clock when none is injected", () => {
		const before = Date.now();
		const svc = new StationService({ stationId: STATION_ID });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		const stamped = Date.parse(svc.events[0]?.time ?? "");
		// The default arm of `options.now ?? ...` is otherwise only exercised by
		// production; a broken default would emit `Invalid Date` strings.
		expect(Number.isNaN(stamped)).toBe(false);
		expect(stamped).toBeGreaterThanOrEqual(before - 1000);
	});

	it("publishes a rail as a draft by default and honours an explicit status", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		const draft = svc.publishRail({
			id: "r1",
			name: "r1",
			version: "1.0.0",
			stationId: "ignored-overridden",
		});
		expect(draft.activationStatus).toBe("draft");
		// The service overrides whatever stationId the caller passed. Publishing a
		// rail *into another Station* through this API would breach tenancy.
		expect(draft.stationId).toBe(STATION_ID);

		const approved = svc.publishRail({
			id: "r2",
			name: "r2",
			version: "1.0.0",
			stationId: STATION_ID,
			activationStatus: "approved",
		});
		expect(approved.activationStatus).toBe("approved");
	});

	it("approves a published rail and refuses an unknown hash", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		const rail = svc.publishRail({
			id: "r1",
			name: "r1",
			version: "1.0.0",
			stationId: STATION_ID,
		});
		svc.approveRail(rail.contentHash);
		expect(svc.snapshot()?.rails[rail.contentHash]?.activationStatus).toBe(
			"approved",
		);
		// Approving by hash is how a human blesses a Rail; accepting an unknown
		// hash would let an approval event exist for a body nobody ever reviewed.
		expect(() => svc.approveRail("sha256:unknown")).toThrowError(/not found/u);
	});

	it("activates an approved rail, refuses an unknown one, and refuses a retired one", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		const rail = svc.publishRail({
			id: "r1",
			name: "r1",
			version: "1.0.0",
			stationId: STATION_ID,
		});
		svc.approveRail(rail.contentHash);
		svc.activateRail(rail.contentHash);
		expect(svc.activeRail()?.id).toBe("r1");

		expect(() => svc.activateRail("sha256:unknown")).toThrowError(/not found/u);

		svc.retireRail(rail.contentHash);
		// Retirement is meant to be terminal — a retired Rail may encode revoked
		// provider approvals, so reactivating it would restore policy somebody
		// deliberately withdrew.
		try {
			svc.activateRail(rail.contentHash);
			expect.unreachable("retired rail must not be activatable");
		} catch (error) {
			expect(error).toHaveProperty("code", "rail-retired");
		}
	});

	it("retireRail appends without checking the catalog", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		// Deliberately unguarded: retiring is a safety operation and must succeed
		// even for a hash whose body was never persisted, so an operator can wall
		// off a Rail referenced only by a receipt.
		expect(() => svc.retireRail("sha256:never-seen")).not.toThrow();
		expect(svc.events.at(-1)?.type).toBe(STATION_EVENTS.RailRetired);
	});

	it("activeRail returns null when no Rail is pinned", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		const boot = svc.snapshot()?.occupancy.bootstrapRailHash;
		expect(boot).toBeDefined();
		svc.events.push(
			stationEvent(
				STATION_EVENTS.RailDeactivated,
				STATION_ID,
				99,
				{ contentHash: boot },
				now(),
			),
		);
		// Null, not a throw: the service is the *library* view and callers like
		// the doctor check want to report "no active Rail" rather than crash.
		expect(svc.activeRail()).toBeNull();
	});

	it("activeRail returns null when the pinned hash has no body", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		svc.events.push(
			stationEvent(
				STATION_EVENTS.RailActivated,
				STATION_ID,
				99,
				{ contentHash: "sha256:dangling", isBootstrap: false },
				now(),
			),
		);
		// `?? null` rather than `undefined`: a dangling pointer and an unpinned
		// Station must be indistinguishable to a caller doing a null check.
		expect(svc.activeRail()).toBeNull();
	});

	it("snapshot returns null before create", () => {
		expect(
			new StationService({ stationId: STATION_ID, now }).snapshot(),
		).toBeNull();
	});

	it("assertNotBootstrapOnlyInProd blocks only production with bootstrap active", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		// Dev is the whole point of the bootstrap Rail — blocking it there would
		// make a fresh checkout undeployable.
		expect(() => svc.assertNotBootstrapOnlyInProd("dev")).not.toThrow();
		try {
			svc.assertNotBootstrapOnlyInProd("production");
			expect.unreachable("bootstrap-active production must be refused");
		} catch (error) {
			expect(error).toHaveProperty("code", "bootstrap-rail-forbidden");
		}

		const rail = svc.publishRail({
			id: "r1",
			name: "r1",
			version: "1.0.0",
			stationId: STATION_ID,
		});
		svc.approveRail(rail.contentHash);
		svc.activateRail(rail.contentHash);
		expect(() => svc.assertNotBootstrapOnlyInProd("production")).not.toThrow();
	});

	it("assertNotBootstrapOnlyInProd is silent on an uninitialized Station", () => {
		// `state?.occupancy.bootstrapActive === true` short-circuits on null. That
		// is correct: there is no Station to be unsafe about yet, and throwing
		// here would mask the real "station-missing" error the caller gets next.
		const svc = new StationService({ stationId: STATION_ID, now });
		expect(() => svc.assertNotBootstrapOnlyInProd("production")).not.toThrow();
	});

	it("fromEvents rehydrates the seq so the next append does not collide", () => {
		const svc = new StationService({ stationId: STATION_ID, now });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		svc.setConnectionCount(1);
		const rehydrated = StationService.fromEvents([...svc.events], {
			stationId: STATION_ID,
			now,
		});
		rehydrated.close();
		// Restarting the CLI must not reuse seq 1. A collision would make two
		// different events share an id and silently overwrite in any keyed store.
		expect(rehydrated.events.at(-1)?.seq).toBe(3);
		expect(rehydrated.snapshot()?.occupancy.status).toBe("closed");
	});

	it("fromEvents on an empty stream yields a service that can still create", () => {
		const svc = StationService.fromEvents([], { stationId: STATION_ID, now });
		expect(svc.snapshot()).toBeNull();
		expect(() =>
			svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" }),
		).not.toThrow();
	});
});

describe("station-client paths and persistence", () => {
	it("sanitizes a station id into a directory name", () => {
		// Station ids carry colons (`station:local`) and may come from user flags.
		// Anything outside the safe class becomes `_` so an id can never contain a
		// path separator and escape HOBO_HOME.
		expect(stationRoot("/home", "station:local")).toBe(
			join("/home", "stations", "station:local"),
		);
		// `.` is *inside* the safe class, so the dots of `..` survive — only the
		// separators are replaced. That is still escape-proof, and this pins why:
		// what makes traversal impossible is that no path separator can remain,
		// not that dots are stripped. A future "tighten the regex" change that
		// removes `.` from the class would break legitimate ids like
		// `station:v1.2` for no security gain.
		expect(stationRoot("/home", "a/../b")).toBe(
			join("/home", "stations", "a_.._b"),
		);
		// A dots-only id is the one shape that still escapes after separators are
		// gone, because `join` normalizes it: `stations/..` is HOBO_HOME. Without
		// the containment step below it, `persistStationEvents(home, "..", …)`
		// wrote `HOBO_HOME/events.jsonl`, clobbering whatever lived there.
		expect(stationRoot("/home", "..")).toBe(join("/home", "stations", "__"));
		expect(stationRoot("/home", ".")).toBe(join("/home", "stations", "_"));
		expect(stationRoot("/home", "../..")).toBe(
			join("/home", "stations", ".._.."),
		);
		expect(stationEventsPath("/home", "s")).toBe(
			join("/home", "stations", "s", "events.jsonl"),
		);
	});

	it("keeps every station id inside HOBO_HOME/stations", () => {
		const home = newHome();
		const base = join(home, "stations");
		for (const id of ["..", ".", "../..", "a/../..", "..\\..", "station:ok"]) {
			const root = stationRoot(home, id);
			// The property, stated once for all shapes: whatever a `--station`
			// flag says, the durable state for it lives under this one directory.
			// Asserting on `base + sep` and not just `base` is deliberate — a
			// sibling `stations-evil` would otherwise pass a prefix check.
			expect(root.startsWith(`${base}/`)).toBe(true);
		}
	});

	it("returns no events for a station that was never written", () => {
		// The existsSync arm: a missing log is "no station", not an ENOENT crash,
		// because `initStation` calls this to decide whether to create.
		expect(loadStationEvents(newHome(), "station:absent")).toEqual([]);
	});

	it("round-trips events through the JSONL log", () => {
		const home = newHome();
		const svc = new StationService({ stationId: STATION_ID });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		persistStationEvents(home, STATION_ID, svc.events);
		const reloaded = loadStationEvents(home, STATION_ID);
		// The Station's whole state is derived from this file; a lossy round trip
		// would change the folded active Rail after a restart.
		expect(reloaded).toEqual(JSON.parse(JSON.stringify(svc.events)));
	});

	it("drops blank lines rather than parsing them", () => {
		const home = newHome();
		mkdirSync(stationRoot(home, STATION_ID), { recursive: true });
		const create = created(1);
		writeFileSync(
			stationEventsPath(home, STATION_ID),
			`${JSON.stringify(create)}\n\n\n`,
			"utf8",
		);
		// `persistStationEvents` always writes a trailing newline, so the filter
		// is load-bearing on every single read — not an edge case.
		expect(loadStationEvents(home, STATION_ID)).toHaveLength(1);
	});

	it("creates the station directory on first persist", () => {
		const home = newHome();
		persistStationEvents(home, "station:new", [created(1)]);
		expect(listStationIds(home)).toEqual(["station:new"]);
	});
});

describe("createStationClient", () => {
	function seed() {
		const home = newHome();
		const svc = new StationService({ stationId: STATION_ID });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		persistStationEvents(home, STATION_ID, svc.events);
		return { home };
	}

	it("loads occupancy, active rail and pins from disk", () => {
		const { home } = seed();
		const client = createStationClient({
			hoboHome: home,
			stationId: STATION_ID,
		});
		expect(client.dataDir).toBe(stationRoot(home, STATION_ID));
		expect(client.occupancy().status).toBe("open");
		const rail = client.activeRail();
		const pins = client.pins();
		// Pins are stamped into receipts. `railHash` must be the hash of the rail
		// body the client actually resolved — deriving it from occupancy instead
		// would let a dangling pointer be pinned as if it were real.
		expect(pins).toEqual({
			stationId: STATION_ID,
			railHash: rail.contentHash,
			bootstrapActive: true,
		});
		expect(Object.isFrozen(pins)).toBe(true);
	});

	it("fails with a remediation when the station does not exist", () => {
		const home = newHome();
		const client = createStationClient({
			hoboHome: home,
			stationId: "station:ghost",
		});
		try {
			client.load();
			expect.unreachable("missing station must throw");
		} catch (error) {
			// The CLI prints `remediation` verbatim; losing it turns a fixable
			// first-run error into a bare stack trace.
			expect(error).toHaveProperty("code", "station-missing");
			expect(error).toHaveProperty("remediation", "hobo station init");
		}
	});

	it("fails closed when no Rail is active", () => {
		const home = newHome();
		const svc = new StationService({ stationId: STATION_ID });
		const { bootstrap } = svc.create({
			name: "local",
			isolation: ISOLATION,
			dataDir: "/tmp/x",
		});
		svc.events.push(
			stationEvent(STATION_EVENTS.RailDeactivated, STATION_ID, 2, {
				contentHash: bootstrap.contentHash,
			}),
		);
		persistStationEvents(home, STATION_ID, svc.events);
		const client = createStationClient({
			hoboHome: home,
			stationId: STATION_ID,
		});
		try {
			client.pins();
			expect.unreachable("pins must not be mintable with no active Rail");
		} catch (error) {
			// Deploying under "whatever policy was last seen" is exactly the
			// failure this refusal exists to prevent.
			expect(error).toHaveProperty("code", "rail-inactive");
		}
	});

	it("fails when the active Rail body is missing from the catalog", () => {
		const home = newHome();
		const svc = new StationService({ stationId: STATION_ID });
		svc.create({ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" });
		svc.events.push(
			stationEvent(STATION_EVENTS.RailActivated, STATION_ID, 2, {
				contentHash: "sha256:dangling",
				isBootstrap: false,
			}),
		);
		persistStationEvents(home, STATION_ID, svc.events);
		const client = createStationClient({
			hoboHome: home,
			stationId: STATION_ID,
		});
		try {
			client.activeRail();
			expect.unreachable("dangling active pointer must throw");
		} catch (error) {
			// Distinct code from `rail-inactive`: this one means log corruption,
			// not an operator who forgot to activate.
			expect(error).toHaveProperty("code", "rail-not-found");
		}
	});
});

describe("initStation", () => {
	it("creates a Station and persists it", () => {
		const home = newHome();
		const result = initStation({ hoboHome: home, name: "local" });
		expect(result.created).toBe(true);
		expect(result.stationId).toBe("station:local");
		expect(result.dataDir).toBe(stationRoot(home, "station:local"));
		expect(result.occupancy.isolation).toEqual({
			tenant: "local",
			residency: "local",
			airgap: false,
			trustDomain: "local.hobo.local",
		});
		// A Station that is not on disk after init would silently re-create with a
		// different bootstrap hash on the next command.
		expect(loadStationEvents(home, "station:local").length).toBeGreaterThan(0);
		expect(result.activatedRailHash).toBeUndefined();
	});

	it("honours an explicit id and isolation overrides", () => {
		const home = newHome();
		const result = initStation({
			hoboHome: home,
			id: "station:custom",
			name: "eu",
			tenant: "acme",
			residency: "eu-west",
			airgap: true,
			trustDomain: "acme.example",
		});
		// Residency and airgap feed `evaluateResidency`, which is fail-closed;
		// dropping either would silently widen where workloads may land.
		expect(result.occupancy.isolation).toEqual({
			tenant: "acme",
			residency: "eu-west",
			airgap: true,
			trustDomain: "acme.example",
		});
		expect(result.stationId).toBe("station:custom");
	});

	it("is idempotent: a second init returns the existing Station", () => {
		const home = newHome();
		const first = initStation({ hoboHome: home, name: "local" });
		const second = initStation({ hoboHome: home, name: "local" });
		expect(second.created).toBe(false);
		// Same bootstrap hash, or every re-init would rewrite the Station's
		// identity and invalidate receipts pinned to the old one.
		expect(second.bootstrap.contentHash).toBe(first.bootstrap.contentHash);
		expect(second.occupancy.createdAt).toBe(first.occupancy.createdAt);
	});

	it("imports and activates a policy document when one is supplied", () => {
		const home = newHome();
		const doc = join(home, "hobo.broker.json");
		writeFileSync(
			doc,
			JSON.stringify({
				brokerId: "acme",
				billing: { quota: "deploys/week", quotaLimit: 5 },
				delivery: { engine: "argo", syncMode: "manual", prune: true },
			}),
			"utf8",
		);
		const result = initStation({
			hoboHome: home,
			name: "local",
			importRailDocPath: doc,
		});
		expect(result.activatedRailHash).toBeDefined();
		expect(result.activatedRailHash).not.toBe(result.bootstrap.contentHash);
		const client = createStationClient({
			hoboHome: home,
			stationId: result.stationId,
		});
		const rail = client.activeRail();
		// The imported document's policy must survive the round trip through the
		// event log — otherwise `hobo station init` would report an import that
		// did not actually change the effective Rail.
		expect(rail.isBootstrap).toBe(false);
		expect(rail.deliveryPolicy).toMatchObject({
			reconcilerMode: "publisher",
			publisher: "argo-cd",
		});
		expect(rail.billingPolicy.quotaLimit).toBe(5);
		// And the production guard is satisfied, which is the reason to import.
		expect(client.occupancy().bootstrapActive).toBe(false);
	});

	it("ignores an importRailDocPath that does not exist", () => {
		const home = newHome();
		// The `existsSync` arm: a stale path in a profile must not abort init and
		// leave the user with no Station at all.
		const result = initStation({
			hoboHome: home,
			name: "local",
			importRailDocPath: join(home, "absent.json"),
		});
		expect(result.created).toBe(true);
		expect(result.activatedRailHash).toBeUndefined();
	});

	it("reports the imported Rail on re-init", () => {
		const home = newHome();
		const doc = join(home, "hobo.broker.json");
		writeFileSync(doc, JSON.stringify({ brokerId: "acme" }), "utf8");
		const first = initStation({
			hoboHome: home,
			name: "local",
			importRailDocPath: doc,
		});
		const again = initStation({ hoboHome: home, name: "local" });
		// The re-init branch recomputes `activatedRailHash` by comparing against
		// the bootstrap hash rather than remembering it, so this pins that the two
		// paths agree.
		expect(again.created).toBe(false);
		expect(again.activatedRailHash).toBe(first.activatedRailHash);
	});

	it("throws on a corrupt event log", () => {
		const home = newHome();
		mkdirSync(stationRoot(home, "station:local"), { recursive: true });
		writeFileSync(
			stationEventsPath(home, "station:local"),
			`${JSON.stringify(evt(STATION_EVENTS.Configured, 1, { connectionCount: 1 }))}\n`,
			"utf8",
		);
		// Events but no Created: folding yields null. Re-creating over the top
		// would append a Created at seq 1 alongside the existing one.
		expect(() => initStation({ hoboHome: home, name: "local" })).toThrowError(
			/corrupt station event log/u,
		);
	});

	it("throws when the log has no bootstrap Rail", () => {
		const home = newHome();
		persistStationEvents(home, "station:local", [
			stationEvent(
				STATION_EVENTS.Created,
				"station:local",
				1,
				{ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" },
				"2026-01-01T00:00:00.000Z",
			),
		]);
		// Every Station is supposed to retain its sealed bootstrap Rail as a
		// fallback; a log without one cannot be rolled back to least privilege.
		expect(() => initStation({ hoboHome: home, name: "local" })).toThrowError(
			/missing bootstrap rail/u,
		);
	});

	it("recovers the bootstrap Rail by flag when the hash pointer is absent", () => {
		const home = newHome();
		const bootstrap = createBootstrapRail(
			"station:local",
			"2026-01-01T00:00:00.000Z",
		);
		persistStationEvents(home, "station:local", [
			stationEvent(
				STATION_EVENTS.Created,
				"station:local",
				1,
				{ name: "local", isolation: ISOLATION, dataDir: "/tmp/x" },
				"2026-01-01T00:00:00.000Z",
			),
			stationEvent(
				STATION_EVENTS.RailPublished,
				"station:local",
				2,
				{ rail: bootstrap },
				"2026-01-01T00:00:00.000Z",
			),
		]);
		// The `?? Object.values(...).find(isBootstrap)` fallback: the catalog is
		// the source of truth, so a Station whose occupancy lost the pointer is
		// still recoverable rather than permanently broken.
		const result = initStation({ hoboHome: home, name: "local" });
		expect(result.created).toBe(false);
		expect(result.bootstrap.contentHash).toBe(bootstrap.contentHash);
	});
});

describe("listStationIds", () => {
	it("returns nothing when HOBO_HOME has no stations directory", () => {
		expect(listStationIds(newHome())).toEqual([]);
	});

	it("lists directories only, sorted", () => {
		const home = newHome();
		persistStationEvents(home, "station:b", [created(1)]);
		persistStationEvents(home, "station:a", [created(1)]);
		writeFileSync(join(home, "stations", "README"), "not a station", "utf8");
		// A stray file in the stations directory would otherwise be offered as a
		// Station id and fail confusingly on load.
		expect(listStationIds(home)).toEqual(["station:a", "station:b"]);
	});
});

describe("resolveStationContext", () => {
	function seedStation(home: string, id: string): void {
		const svc = new StationService({ stationId: id });
		svc.create({ name: id, isolation: ISOLATION, dataDir: "/tmp/x" });
		persistStationEvents(home, id, svc.events);
	}

	it("prefers the flag over env and profile", () => {
		const home = newHome();
		seedStation(home, "station:flag");
		seedStation(home, "station:env");
		seedStation(home, "station:profile");
		const resolved = resolveStationContext({
			hoboHome: home,
			stationFlag: "station:flag",
			stationEnv: "station:env",
			profileStationId: "station:profile",
		});
		// Precedence order is a user-facing contract: an explicit `--station` must
		// win, or a stale env var would silently redirect a deploy.
		expect(resolved.stationId).toBe("station:flag");
	});

	it("falls through to env, then profile, skipping candidates with no log", () => {
		const home = newHome();
		seedStation(home, "station:env");
		expect(
			resolveStationContext({
				hoboHome: home,
				stationFlag: "station:nonexistent",
				stationEnv: "station:env",
			}).stationId,
		).toBe("station:env");

		const home2 = newHome();
		seedStation(home2, "station:profile");
		expect(
			resolveStationContext({
				hoboHome: home2,
				profileStationId: "station:profile",
			}).stationId,
		).toBe("station:profile");
	});

	it("ignores empty-string candidates", () => {
		const home = newHome();
		seedStation(home, "station:only");
		// An unset env var read as `""` must not count as a candidate; the filter
		// on `length > 0` is what lets the single-station fallback still fire.
		const resolved = resolveStationContext({
			hoboHome: home,
			stationFlag: "",
			stationEnv: "",
		});
		expect(resolved.stationId).toBe("station:only");
	});

	it("falls back to the sole Station on disk", () => {
		const home = newHome();
		seedStation(home, "station:only");
		const resolved = resolveStationContext({ hoboHome: home });
		expect(resolved.stationId).toBe("station:only");
		expect(resolved.client.occupancy().status).toBe("open");
	});

	it("recovers the real id when the directory name was escaped", () => {
		const home = newHome();
		// `a/b` sanitizes to `a_b` on disk, so the directory name is not the id.
		// Resolving by directory name would produce a client that reads a
		// different (empty) path than the one it just found.
		seedStation(home, "a/b");
		const resolved = resolveStationContext({ hoboHome: home });
		expect(resolved.stationId).toBe("a/b");
		expect(resolved.client.occupancy().status).toBe("open");
	});

	it("refuses to guess when more than one Station exists", () => {
		const home = newHome();
		seedStation(home, "station:one");
		seedStation(home, "station:two");
		try {
			resolveStationContext({ hoboHome: home });
			expect.unreachable("ambiguous Station context must not be guessed");
		} catch (error) {
			// Picking one would deploy into an arbitrary tenant. The error names
			// all three ways to disambiguate.
			expect(error).toHaveProperty("code", "station-missing");
			expect(error).toHaveProperty(
				"message",
				expect.stringMatching(/--station/u),
			);
		}
	});

	it("refuses when the sole directory holds an empty log", () => {
		const home = newHome();
		mkdirSync(join(home, "stations", "station:empty"), { recursive: true });
		writeFileSync(
			join(home, "stations", "station:empty", "events.jsonl"),
			"",
			"utf8",
		);
		// `firstLine === undefined` and the `first !== undefined` guard both fire
		// here. An empty log must fail closed, not resolve to a Station with no
		// isolation attached.
		expect(() => resolveStationContext({ hoboHome: home })).toThrowError(
			/no Station context/u,
		);
	});

	it("refuses when the sole directory has no events file", () => {
		const home = newHome();
		mkdirSync(join(home, "stations", "station:bare"), { recursive: true });
		expect(() => resolveStationContext({ hoboHome: home })).toThrowError(
			/no Station context/u,
		);
	});

	it("never auto-creates state while resolving", () => {
		const home = newHome();
		expect(() => resolveStationContext({ hoboHome: home })).toThrow();
		// Silent auto-create is the documented anti-goal: it would mint a Station
		// with default tenancy behind the operator's back.
		expect(listStationIds(home)).toEqual([]);
	});
});

describe("assertConnectionStationAccess", () => {
	it("allows a same-Station Connection", () => {
		expect(() =>
			assertConnectionStationAccess({
				connectionStationId: "station:a",
				requestStationId: "station:a",
				federationGrant: false,
			}),
		).not.toThrow();
	});

	it("denies a cross-Station Connection without a grant", () => {
		try {
			assertConnectionStationAccess({
				connectionStationId: "station:a",
				requestStationId: "station:b",
				federationGrant: false,
			});
			expect.unreachable("cross-Station use must fail closed");
		} catch (error) {
			// Connections carry credentials scoped to their Station. Allowing this
			// by default is a straightforward tenancy breach.
			expect(error).toHaveProperty("code", "connection-cross-station-denied");
			expect(error).toHaveProperty(
				"message",
				expect.stringContaining("station:a → station:b"),
			);
		}
	});

	it("allows a cross-Station Connection only for an explicit true grant", () => {
		expect(() =>
			assertConnectionStationAccess({
				connectionStationId: "station:a",
				requestStationId: "station:b",
				federationGrant: true,
			}),
		).not.toThrow();
		// `=== true`, not truthiness: a grant flag that arrived as a non-empty
		// string from a config file must not authorize federation.
		// The grant is decoded from config text, as a config loader would hand it
		// over, so the non-boolean string reaches the guard untouched.
		const fromConfig: Parameters<typeof assertConnectionStationAccess>[0] =
			JSON.parse(
				'{"connectionStationId":"station:a","requestStationId":"station:b","federationGrant":"yes"}',
			);
		expect(() => assertConnectionStationAccess(fromConfig)).toThrowError(
			/federation grant required/u,
		);
	});
});
