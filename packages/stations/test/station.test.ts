import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertConnectionStationAccess,
	createBootstrapRail,
	createRail,
	createStationClient,
	foldStationEvents,
	initStation,
	resolveStationContext,
	StationService,
	station,
} from "../src/index.js";

const temps: string[] = [];
afterEach(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
	temps.length = 0;
});

function tempHome(): string {
	const d = mkdtempSync(join(tmpdir(), "hobo-station-"));
	temps.push(d);
	return d;
}

describe("@hobo/stations", () => {
	it("station() is control-plane occupancy, not yard parent", () => {
		const s = station("acme", {
			isolation: {
				tenant: "acme",
				residency: "us",
				trustDomain: "acme.hobo.local",
			},
			rails: ["rail-prod"],
		});
		expect(s.kind).toBe("station");
		expect(s.id).toBe("station:acme");
		expect(s.isolation.tenant).toBe("acme");
		expect(s.railRefs).toEqual(["rail-prod"]);
	});

	it("bootstrap rail is content-addressed and least-privilege", () => {
		const a = createBootstrapRail("station:x");
		const b = createBootstrapRail("station:x");
		expect(a.contentHash).toBe(b.contentHash);
		expect(a.isBootstrap).toBe(true);
		expect(a.placementDefaults.allowedProviders).toEqual(["local"]);
		expect(a.contentHash.startsWith("sha256:")).toBe(true);
	});

	it("initStation is idempotent and folds rebuild-from-zero", () => {
		const home = tempHome();
		const first = initStation({ hoboHome: home, name: "local", tenant: "t1" });
		expect(first.created).toBe(true);
		expect(first.occupancy.bootstrapActive).toBe(true);
		const second = initStation({ hoboHome: home, name: "local", tenant: "t1" });
		expect(second.created).toBe(false);
		expect(second.stationId).toBe(first.stationId);

		const client = createStationClient({
			hoboHome: home,
			stationId: first.stationId,
		});
		const pins = client.pins();
		expect(pins.stationId).toBe(first.stationId);
		expect(pins.railHash).toBe(first.bootstrap.contentHash);
		expect(pins.bootstrapActive).toBe(true);
	});

	it("rail publish/approve/activate pins active hash; production forbids bootstrap-only", () => {
		const home = tempHome();
		const { stationId } = initStation({ hoboHome: home, name: "prod" });
		const events = must(
			createStationClient({ hoboHome: home, stationId }).load(),
			"createStationClient({ hoboHome: home, stationId }).load()",
		).events;
		const svc = StationService.fromEvents(events, { stationId });
		const rail = svc.publishRail({
			id: "rail-prod",
			name: "prod",
			version: "1.0.0",
			stationId,
			approvedProviders: ["local"],
		});
		svc.approveRail(rail.contentHash);
		svc.activateRail(rail.contentHash);
		const snap = must(svc.snapshot());
		expect(snap.occupancy.activeRailHash).toBe(rail.contentHash);
		expect(snap.occupancy.bootstrapActive).toBe(false);
		svc.assertNotBootstrapOnlyInProd("production");

		const bootOnly = StationService.fromEvents(events, { stationId });
		expect(() => bootOnly.assertNotBootstrapOnlyInProd("production")).toThrow(
			/bootstrap-rail-forbidden|bootstrap Rail/,
		);
	});

	it("cross-Station Connection use fails closed without federation grant", () => {
		expect(() =>
			assertConnectionStationAccess({
				connectionStationId: "station:a",
				requestStationId: "station:b",
				federationGrant: false,
			}),
		).toThrow(/cross-Station/);
		expect(() =>
			assertConnectionStationAccess({
				connectionStationId: "station:a",
				requestStationId: "station:b",
				federationGrant: false,
			}),
		).toThrow(/cross-Station/);
		expect(() =>
			assertConnectionStationAccess({
				connectionStationId: "station:a",
				requestStationId: "station:b",
				federationGrant: true,
			}),
		).not.toThrow();
	});

	it("resolveStationContext fails with remediation when missing", () => {
		const home = tempHome();
		expect(() => resolveStationContext({ hoboHome: home })).toThrow(
			/hobo station init/,
		);
	});

	it("pins always include stationId and railHash", () => {
		const home = tempHome();
		const { stationId } = initStation({ hoboHome: home, name: "local" });
		const pins = createStationClient({ hoboHome: home, stationId }).pins();
		expect(pins.stationId).toBe(stationId);
		expect(pins.railHash.startsWith("sha256:")).toBe(true);
	});

	it("imports hobo.broker.json as approved rail under station", () => {
		const home = tempHome();
		const brokerPath = join(home, "hobo.broker.json");
		writeFileSync(
			brokerPath,
			JSON.stringify({
				schemaVersion: "hobo.broker/v1",
				brokerId: "local-conductor",
				placementPolicies: [],
				billing: {
					quota: "deployments/day",
					quotaUsed: 0,
					quotaLimit: 100,
					budgetUsd: 0,
					spendCapUsd: 0,
				},
				delivery: { engine: "in-proc", syncMode: "auto", prune: false },
				requiredConnectorKinds: [],
			}),
		);
		const result = initStation({
			hoboHome: home,
			name: "local",
			importRailDocPath: brokerPath,
		});
		expect(result.activatedRailHash).toBeTruthy();
		const state = must(
			createStationClient({
				hoboHome: home,
				stationId: result.stationId,
			}).load(),
			"createStationClient({ hoboHome: home, stationId: result.stationId, }).load()",
		);
		expect(Object.keys(state.rails).length).toBeGreaterThan(1);
	});

	it("createRail requires stationId", () => {
		expect(() =>
			createRail({
				id: "r",
				name: "r",
				version: "1",
				stationId: "",
			}),
		).toThrow(/stationId/);
	});

	it("fold empty is null", () => {
		expect(foldStationEvents([])).toBeNull();
	});
});
