import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { authLogin } from "../src/auth.js";
import { loopbackFetchUrl } from "../src/occupancy-endpoints.js";
import {
	attachStationSidecars,
	formatSidecarStrap,
	readStationSidecars,
	sidecarsEnabled,
	startStationSidecars,
	stopStationSidecars,
} from "../src/station-sidecars.js";
import { killProcessGroup } from "./subprocess-cleanup.js";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes) {
		const evidencePid = readStationSidecars(home, "station:local")?.evidencePid;
		await stopStationSidecars(home, "station:local").catch(() => {});
		if (evidencePid !== undefined) killProcessGroup(evidencePid);
		rmSync(home, { recursive: true, force: true });
	}
	homes.length = 0;
});

function tempHome(): string {
	const home = mkdtempSync(join(tmpdir(), "hobo-code-sidecars-"));
	homes.push(home);
	return home;
}

describe("station occupancy sidecars", () => {
	it("refuses to start when logged out", async () => {
		await expect(
			startStationSidecars({
				hoboHome: tempHome(),
				ensureLocalLogin: false,
			}),
		).rejects.toThrow(/not logged in/i);
	});

	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	it("starts dashboard and evidence as Station sidecars and serves them", async () => {
		const hoboHome = tempHome();
		authLogin({ hoboHome, tenant: "camp-west", autoInitLocal: true });
		const sidecars = await startStationSidecars({
			hoboHome,
			projectRoot: hoboHome,
			env: { HOBO_ENV: "local-dev" },
			dashboardPort: 0,
			evidencePort: 0,
			otlpHttpPort: 0,
			otlpGrpcPort: 0,
		});
		try {
			expect(sidecars.stationId).toBe("station:local");
			expect(sidecars.environment).toBe("local-dev");
			expect(sidecars.dashboardUrl).toMatch(/\.hobo\.localhost(?::\d+)?\/?$/);
			expect(sidecars.evidenceUrl).toMatch(
				/evidence\.code\..*\.hobo\.localhost/,
			);
			expect(sidecars.dashboardUrl).not.toMatch(/127\.0\.0\.1/);
			expect(sidecars.evidenceUrl).not.toMatch(/127\.0\.0\.1/);
			const dash = await fetch(loopbackFetchUrl(sidecars.dashboardUrl));
			expect(dash.status).toBe(200);
			expect(await dash.text()).toMatch(/hobo-code · resources/);
			const resources = await fetch(
				new URL("/api/resources", loopbackFetchUrl(sidecars.dashboardUrl)),
			);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const inventory = (await resources.json()) as { ok: boolean };
			expect(inventory.ok).toBe(true);
			const evidence = await fetch(loopbackFetchUrl(sidecars.evidenceUrl));
			expect(evidence.status).toBe(200);
			expect(sidecars.evidenceReportUrl).toMatch(/__hobo\/evidence/);
			const disk = readStationSidecars(hoboHome, "station:local");
			expect(disk?.dashboardUrl).toBe(sidecars.dashboardUrl);
			expect(disk?.evidenceUrl).toBe(sidecars.evidenceUrl);
			expect(formatSidecarStrap(sidecars).join(" ")).toMatch(
				/dash:dashboard\.code\./,
			);
			expect(formatSidecarStrap(sidecars).join(" ")).toMatch(
				/evidence:evidence\.code\./,
			);
			expect(sidecars.evalsUrl).toMatch(/evals\.code\..*\.hobo\.localhost/);
			const evals = await fetch(loopbackFetchUrl(sidecars.evalsUrl ?? ""));
			expect(evals.status).toBe(200);
			expect(await evals.json()).toMatchObject({
				name: "evals",
				live: true,
			});
			expect(sidecars.rolloutUrl).toMatch(/rollout\.code\..*\.hobo\.localhost/);
			expect(sidecars.rolloutUrl).not.toMatch(/127\.0\.0\.1/);
			const rollout = await fetch(loopbackFetchUrl(sidecars.rolloutUrl ?? ""));
			expect(rollout.status).toBe(200);
			expect(await rollout.json()).toMatchObject({
				name: "rollout",
				hosting: "station",
				live: true,
				fidelity: "real",
				engine: "OpenDeliveryEngine",
			});
			expect(formatSidecarStrap(sidecars).join(" ")).toMatch(
				/rollout:rollout\.code\./,
			);
			expect(sidecars.experimentUrl).toMatch(
				/experiment\.code\..*\.hobo\.localhost/,
			);
			expect(sidecars.experimentUrl).not.toMatch(/127\.0\.0\.1/);
			const experiment = await fetch(
				loopbackFetchUrl(sidecars.experimentUrl ?? ""),
			);
			expect(experiment.status).toBe(200);
			expect(await experiment.json()).toMatchObject({
				name: "experiment",
				hosting: "station",
				live: true,
				fidelity: "real",
				engine: "OpenExperimentEngine",
			});
			expect(formatSidecarStrap(sidecars).join(" ")).toMatch(
				/experiment:experiment\.code\./,
			);
			expect(sidecars.kmsUrl).toMatch(/kms\.code\..*\.hobo\.localhost/);
			expect(sidecars.kmsUrl).not.toMatch(/127\.0\.0\.1/);
			const kms = await fetch(loopbackFetchUrl(sidecars.kmsUrl ?? ""));
			expect(kms.status).toBe(200);
			expect(await kms.json()).toMatchObject({
				name: "kms",
				hosting: "station",
				live: true,
				engine: "StationKms",
			});
			expect(formatSidecarStrap(sidecars).join(" ")).toMatch(/kms:kms\.code\./);
			expect(sidecars.historyUrl).toMatch(/history\.code\..*\.hobo\.localhost/);
			const history = await fetch(loopbackFetchUrl(sidecars.historyUrl ?? ""));
			expect(history.status).toBe(200);
			expect(await history.json()).toMatchObject({
				name: "history",
				hosting: "station",
				live: true,
				engine: "SessionShellStore",
			});
		} finally {
			await sidecars.close();
		}
		expect(readStationSidecars(hoboHome, "station:local")).toBeNull();
	}, 20_000);

	it("startCodeSession launches both sidecars by default", async () => {
		const { startCodeSession } = await import("../src/session.js");
		const hoboHome = tempHome();
		const project = mkdtempSync(join(tmpdir(), "hobo-code-sidecar-proj-"));
		homes.push(project);
		const session = await startCodeSession({
			projectRoot: project,
			hoboHome,
			autoInitStation: true,
		});
		try {
			expect(session.sidecars).toBeDefined();
			const dash = await fetch(
				loopbackFetchUrl(session.sidecars?.dashboardUrl ?? ""),
			);
			expect(dash.status).toBe(200);
			const evidence = await fetch(
				loopbackFetchUrl(session.sidecars?.evidenceUrl ?? ""),
			);
			expect(evidence.status).toBe(200);
		} finally {
			await session.complete(true, ["sidecars"]);
			await stopStationSidecars(hoboHome, "station:local");
		}
	}, 20_000);

	it("keeps Station Evidence up after the hobo session completes", async () => {
		const { startCodeSession } = await import("../src/session.js");
		const hoboHome = tempHome();
		const project = mkdtempSync(join(tmpdir(), "hobo-code-sidecar-keep-"));
		homes.push(project);
		const session = await startCodeSession({
			projectRoot: project,
			hoboHome,
			autoInitStation: true,
		});
		const evidenceUrl = session.sidecars?.evidenceUrl ?? "";
		expect(evidenceUrl).toMatch(/evidence\.code\..*\.hobo\.localhost/);
		expect(evidenceUrl).not.toMatch(/127\.0\.0\.1/);
		await session.complete(true, ["session-end"]);
		const still = await fetch(loopbackFetchUrl(evidenceUrl));
		expect(still.status).toBe(200);
		const disk = readStationSidecars(hoboHome, "station:local");
		expect(disk?.evidenceUrl).toBe(evidenceUrl);
		await stopStationSidecars(hoboHome, "station:local");
		await expect(fetch(loopbackFetchUrl(evidenceUrl))).rejects.toThrow();
	}, 20_000);

	it("keeps Evidence up after /dev closes", async () => {
		const hoboHome = tempHome();
		authLogin({ hoboHome, tenant: "camp-west", autoInitLocal: true });
		const sidecars = await startStationSidecars({
			hoboHome,
			projectRoot: hoboHome,
			env: { HOBO_ENV: "local-dev" },
			dashboardPort: 0,
			evidencePort: 0,
			otlpHttpPort: 0,
			otlpGrpcPort: 0,
		});
		const attached = await attachStationSidecars({
			hoboHome,
			projectRoot: hoboHome,
			env: { HOBO_ENV: "local-dev" },
		});
		expect(attached.evidenceUrl).toBe(sidecars.evidenceUrl);
		await attachStationSidecars({
			hoboHome,
			projectRoot: hoboHome,
			env: { HOBO_ENV: "local-dev" },
		});
		const still = await fetch(loopbackFetchUrl(sidecars.evidenceUrl));
		expect(still.status).toBe(200);
		await sidecars.close();
		await expect(
			fetch(loopbackFetchUrl(sidecars.evidenceUrl)),
		).rejects.toThrow();
	}, 20_000);

	it("honours HOBO_CODE_SIDECARS=0", () => {
		expect(sidecarsEnabled({ HOBO_CODE_SIDECARS: "0" })).toBe(false);
		expect(sidecarsEnabled({})).toBe(true);
	});
});
