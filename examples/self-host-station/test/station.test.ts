import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadStationEvents } from "@hobo/stations";
import { afterEach, describe, expect, it } from "vitest";

import {
	openSelfHostedStation,
	SELF_HOST_STATION_ID,
	SELF_HOST_STATION_NAME,
	selfHostStationTopology,
} from "../src/station.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

async function freshHome(): Promise<string> {
	const hoboHome = await mkdtemp(path.join(tmpdir(), "self-host-station-"));
	cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
	return hoboHome;
}

describe("self-host-station composition", () => {
	it("authors topology without touching disk", () => {
		const topology = selfHostStationTopology();
		expect(topology.kind).toBe("station");
		expect(topology.name).toBe(SELF_HOST_STATION_NAME);
	});

	it("init creates durable Station under HOBO_HOME and returns pins", async () => {
		const hoboHome = await freshHome();
		const hosted = openSelfHostedStation({ hoboHome });
		cleanups.push(hosted.close);

		expect(hosted.created).toBe(true);
		expect(hosted.stationId).toBe(SELF_HOST_STATION_ID);
		expect(existsSync(hosted.dataDir)).toBe(true);
		expect(existsSync(path.join(hosted.dataDir, "events.jsonl"))).toBe(true);

		const pins = hosted.pins();
		expect(pins.stationId).toBe(SELF_HOST_STATION_ID);
		expect(pins.railHash).toMatch(/^sha256:/);
		expect(pins.bootstrapActive).toBe(true);

		const status = hosted.status();
		expect(status.isolation.tenant).toBe(SELF_HOST_STATION_NAME);
		expect(status.knownStations.length).toBeGreaterThanOrEqual(1);
	});

	it("reopen is idempotent and preserves pins across process restart", async () => {
		const hoboHome = await freshHome();

		const first = openSelfHostedStation({ hoboHome });
		const firstPins = first.pins();
		const eventCount = loadStationEvents(hoboHome, first.stationId).length;
		expect(first.created).toBe(true);
		expect(eventCount).toBeGreaterThan(0);
		first.close();

		const second = openSelfHostedStation({ hoboHome });
		cleanups.push(second.close);
		expect(second.created).toBe(false);
		expect(second.stationId).toBe(first.stationId);
		expect(second.pins()).toEqual(firstPins);
		expect(loadStationEvents(hoboHome, second.stationId).length).toBe(
			eventCount,
		);
	});

	it("occupancy reports isolation boundary on disk", async () => {
		const hoboHome = await freshHome();
		const hosted = openSelfHostedStation({
			hoboHome,
			tenant: "acme",
			residency: "us",
			trustDomain: "acme.hobo.local",
		});
		cleanups.push(hosted.close);

		const occ = hosted.client.occupancy();
		expect(occ.isolation.tenant).toBe("acme");
		expect(occ.isolation.residency).toBe("us");
		expect(occ.isolation.trustDomain).toBe("acme.hobo.local");
		expect(occ.bootstrapRailHash).toMatch(/^sha256:/);
	});
});
