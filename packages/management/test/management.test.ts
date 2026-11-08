import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	brokerStatus,
	connectionAuthorize,
	connectionCreate,
	connectionList,
	createManagementContext,
	HOBO_MANAGEMENT_PACKAGE,
	projectYardSnapshot,
	stationInit,
	stationRailsActivate,
	stationRailsApprove,
	stationRailsList,
	stationRailsPublish,
	stationStatus,
	stationUp,
} from "../src/index.js";

const temps: string[] = [];
afterEach(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
	temps.length = 0;
});

function tempHome(): string {
	const d = mkdtempSync(join(tmpdir(), "hobo-mgmt-"));
	temps.push(d);
	return d;
}

describe("@hobo/management", () => {
	it("exports package id", () => {
		expect(HOBO_MANAGEMENT_PACKAGE).toBe("@hobo/management");
	});

	it("station init + status + up projection path", () => {
		const home = tempHome();
		const ctx = createManagementContext({ hoboHome: home });
		const init = stationInit(ctx, { name: "local", tenant: "local" });
		expect(init.ok).toBe(true);
		expect(init.data?.stationId).toBe("station:local");
		expect(init.data?.bootstrapActive).toBe(true);

		const status = stationStatus(ctx, "station:local");
		expect(status.ok).toBe(true);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		expect((status.data as { status: string }).status).toBe("open");

		const up = stationUp(ctx, "station:local");
		expect(up.ok).toBe(true);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		expect((up.data as { status: string }).status).toBe("occupying");

		const snap = projectYardSnapshot(ctx, { stationId: "station:local" });
		expect(snap.ok).toBe(true);
		expect(snap.data?.occupancy.stationId).toBe("station:local");
		expect(snap.data?.occupyMode).toBe("occupying");
		expect(snap.data?.rails.length).toBeGreaterThan(0);
		expect(snap.data?.doctor.bootstrapActive).toBe(true);
	});

	it("rail publish approve activate updates projection", () => {
		const home = tempHome();
		const ctx = createManagementContext({ hoboHome: home });
		stationInit(ctx, { name: "local", tenant: "local" });
		const pub = stationRailsPublish(ctx, {
			stationId: "station:local",
			id: "rail-prod",
			name: "prod",
			version: "1.0.0",
		});
		expect(pub.ok).toBe(true);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const hash = String((pub.data as { contentHash: string }).contentHash);
		expect(stationRailsApprove(ctx, { hashOrId: hash }).ok).toBe(true);
		expect(stationRailsActivate(ctx, { hashOrId: hash }).ok).toBe(true);
		const list = stationRailsList(ctx, "station:local");
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const rails = (list.data as { rails: { activationStatus: string }[] })
			.rails;
		const active = rails.find((r) => r.activationStatus === "active");
		expect(active).toBeTruthy();
		const snap = projectYardSnapshot(ctx, { stationId: "station:local" });
		expect(snap.data?.occupancy.bootstrapActive).toBe(false);
		expect(snap.data?.occupancy.activeRailHash).toBe(hash);
	});

	it("connection create + authorize flows through management", () => {
		const home = tempHome();
		const ctx = createManagementContext({ hoboHome: home });
		stationInit(ctx, { name: "local", tenant: "local" });
		const created = connectionCreate(ctx, {
			provider: "asana",
			alias: "work",
			stationId: "station:local",
			scopes: ["tasks:read"],
		});
		expect(created.ok).toBe(true);
		const conn =
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
			(created.data as { connection: { status: string; alias?: string } })
				.connection;
		expect(conn.status).toBe("pending");
		expect(conn.alias).toBe("work");

		const auth = connectionAuthorize(ctx, { idOrAlias: "work" });
		expect(auth.ok).toBe(true);
		expect(
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
			(auth.data as { connection: { status: string } }).connection.status,
		).toBe("active");

		const list = connectionList(ctx);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		expect((list.data as { count: number }).count).toBe(1);

		const snap = projectYardSnapshot(ctx, { stationId: "station:local" });
		expect(snap.data?.connections).toHaveLength(1);
		expect(snap.data?.metering.trafficRate).toBeGreaterThan(0);
		// Provenance badges (HIGHBALL "kill or badge"): synthetic/static until
		// real OTLP signals feed the projection.
		expect(snap.data?.metering.trafficRateSource).toBe("synthetic");
		expect(snap.data?.activity[0]?.status).toBe("working");
		expect(snap.data?.activity[0]?.statusSource).toBe("derived-static");
	});

	it("broker status reads station occupancy", () => {
		const home = tempHome();
		const ctx = createManagementContext({ hoboHome: home });
		stationInit(ctx, { name: "local", tenant: "local" });
		const b = brokerStatus(ctx, { stationId: "station:local" });
		expect(b.ok).toBe(true);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		expect((b.data as { ok: boolean }).ok).toBe(true);
	});
});
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: tests narrow known management result shapes. */
