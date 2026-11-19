import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openCdRuntime } from "../src/cd-runtime.js";
import { startCdServer } from "../src/cd-serve.js";
import { openCdStore } from "../src/cd-store.js";

const marker = "synthetic-private-marker";

async function inFixture(
	run: (home: string) => Promise<void>,
): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), `${marker}-`));
	try {
		await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function expectRefusal(
	result: Awaited<ReturnType<typeof openCdRuntime>>,
	expected: Readonly<{ code: string; message: string; remediation: string }>,
): void {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reasons[0]?.code).toBe(expected.code);
	expect(result.reasons[0]?.message).toBe(expected.message);
	expect(result.reasons[0]?.remediation).toContain(expected.remediation);
	expect(JSON.stringify(result)).not.toContain(marker);
}

describe("CD runtime startup privacy", () => {
	it("does not return an imported topology module's exception or path", async () => {
		await inFixture(async (home) => {
			const file = join(home, "topology.mjs");
			await writeFile(file, `throw new Error("${marker}");\n`);
			const result = await openCdRuntime({
				env: {},
				home,
				cwd: home,
				simulate: true,
				topologyFiles: [file],
			});
			expectRefusal(result, {
				code: "cd-topology-unreadable",
				message: "A CD topology file could not be read.",
				remediation: "Check the path",
			});
			if (result.ok) await result.value.close();
		});
	});

	it.each([
		{
			exports: { camps: [{ campId: marker }] },
			code: "cd-topology-invalid",
			message: "A CD topology declaration is invalid.",
			remediation: "A topology file",
		},
		{
			exports: { rails: [{ [marker]: true }] },
			code: "cd-topology-invalid",
			message: "A CD Rail declaration could not be read or validated.",
			remediation: "Export `rails`",
		},
		{
			exports: {
				camps: Array.from({ length: 2 }, () => ({
					campId: `${marker}/box`,
					yardId: marker,
					stationId: marker,
					provider: "self-hosted",
					regions: [],
					envType: "ci",
					management: "CAMP_MANAGEMENT_MANAGED",
				})),
			},
			code: "cd-topology-duplicate-camp",
			message: "A CD Camp is declared by more than one topology source.",
			remediation: "rename the Camp",
		},
		{
			exports: {
				camps: [
					{
						campId: `${marker}/box`,
						yardId: marker,
						stationId: "another-station",
						provider: "self-hosted",
						regions: [],
						envType: "ci",
						management: "CAMP_MANAGEMENT_MANAGED",
					},
				],
			},
			code: "cd-topology-station-mismatch",
			message: "A CD topology Camp belongs to another Station.",
			remediation: "Declare the Camp for this Station",
		},
		{
			exports: {
				rails: ["1", "2"].map((version) => ({
					id: marker,
					name: marker,
					version,
					approvedProviders: ["self-hosted"],
				})),
			},
			code: "cd-rail-conflict",
			message: "The CD topology declares conflicting Rails.",
			remediation: "Declare one Rail per Station",
		},
	])("does not echo private topology details for $code", async (fixture) => {
		await inFixture(async (home) => {
			const file = join(home, "topology.json");
			await writeFile(file, JSON.stringify(fixture.exports));
			const result = await openCdRuntime({
				env: { HOBO_STATION: marker },
				home,
				cwd: home,
				simulate: true,
				topologyFiles: [file],
			});
			expectRefusal(result, fixture);
			if (result.ok) await result.value.close();
		});
	});

	it("does not return a Kubernetes fleet file path or provider error", async () => {
		await inFixture(async (home) => {
			const result = await openCdRuntime({
				env: { HOBO_CD_KUBE_FLEET: join(home, `${marker}.json`) },
				home,
				cwd: home,
				simulate: true,
			});
			expectRefusal(result, {
				code: "cd-kube-fleet-invalid",
				message: "The Kubernetes fleet could not be read or initialized.",
				remediation: "Fix the HOBO_CD_KUBE_FLEET file",
			});
			if (result.ok) await result.value.close();
		});
	});

	it("does not expose Camp identifiers in a conductor conflict", async () => {
		await inFixture(async (home) => {
			const topologyFile = join(home, "topology.json");
			const fleetFile = join(home, "fleet.json");
			await writeFile(
				topologyFile,
				JSON.stringify({
					camps: [
						{
							campId: `${marker}/package`,
							yardId: marker,
							stationId: "local",
							provider: "npm",
							regions: [],
							envType: "production",
							management: "CAMP_MANAGEMENT_MANAGED",
						},
					],
				}),
			);
			await writeFile(
				fleetFile,
				JSON.stringify({
					ocm: {
						schemaVersion: "hobo.cd-kube-fleet.ocm/v1",
						hub: {
							schemaVersion: "hobo.cd-kube-fleet.hub/v1",
							name: "fixture-hub",
							kind: "HUB_KIND_OCM",
							apiBaseUrl: "https://hub.fixture.invalid",
							credentialRef: "env://FIXTURE_CREDENTIAL",
							auth: "KUBE_AUTH_BEARER",
						},
						clusters: [{ campId: "fixture/cluster", cluster: "fixture" }],
						departureAction: "DEPARTURE_ACTION_ORPHAN_DATA",
					},
				}),
			);
			const result = await openCdRuntime({
				env: { HOBO_CD_KUBE_FLEET: fleetFile },
				home,
				cwd: home,
				simulate: false,
				topologyFiles: [topologyFile],
				openStore: () => openCdStore({ backend: "memory" }, { now: Date.now }),
			});
			expectRefusal(result, {
				code: "cd-conductor-conflict",
				message:
					"Publication Camps and a Kubernetes fleet both need the conductor realizer.",
				remediation: "in separate hobo deploy runs",
			});
			if (result.ok) await result.value.close();
		});
	});

	it("sanitizes a topology reader failure during service startup and closes the journal", async () => {
		await inFixture(async (home) => {
			const journal = await openCdStore({ backend: "memory" }, { now: Date.now });
			let closed = false;
			const opened = await openCdRuntime({
				env: {},
				home,
				cwd: home,
				simulate: true,
				openStore: async () => ({
					...journal,
					close: async () => {
						closed = true;
						await journal.close();
					},
				}),
				topology: [
					{
						camps: async () => {
							throw new Error(marker);
						},
						camp: async () => undefined,
					},
				],
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			await expect(
				startCdServer({
					runtime: opened.value,
					host: "127.0.0.1",
					port: 0,
					log: () => {},
				}),
			).rejects.toThrow("The CD service topology could not be read.");
			expect(closed).toBe(true);
		});
	});
});
