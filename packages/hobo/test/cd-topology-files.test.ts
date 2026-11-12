// Repo-declared topology reaches `hobo deploy` (plan 0024): Yards from a Yard
// module and Camps from a delivery module, parsed once with the generated
// cd_topology schemas, then resolved by `camp list`, `pipeline apply` and
// `agent token`.
//
// The parse runs in-process on the data-models fixtures (a @hobo/yards Yard
// in JSON form, a runner-fleet Camp record). The repository's real Yard and
// delivery modules load in the BUILT binary (a child process per command):
// they load through tsx and @hobo/yards, whose module state is process-wide,
// and this file shares its worker with the rest of the suite.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampManagement } from "@hobo/cd";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadTopologyFiles,
	parseTopologyExports,
	topologyFilesOf,
} from "../src/cd-topology.js";

const PACKAGE = join(import.meta.dirname, "..");
const REPO = join(PACKAGE, "..", "..");
const BIN = join(PACKAGE, "dist", "bin", "hobo.js");
const RELAY_YARD = "packages/ci-vercel/deploy/yard.ts";
const RELAY_DELIVERY = "packages/ci-vercel/deploy/delivery.ts";
const RUNNER_FLEET =
	"packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});

async function freshHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "cd-topology-"));
	homes.push(home);
	return home;
}

type Envelope = Readonly<{
	ok: boolean;
	code?: string;
	message?: string;
	data?: object;
}>;

/** One `hobo deploy … --json` run of the built binary from the repo root. */
function deploy(
	home: string,
	argv: readonly string[],
	env: Readonly<Record<string, string>> = {},
): Promise<Envelope> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BIN, "deploy", ...argv, "--json"], {
			cwd: REPO,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				HOBO_HOME: home,
				NODE_NO_WARNINGS: "1",
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", () => {
			try {
				// SAFETY: --json prints one envelope; the fields read here are its own.
				resolve(JSON.parse(stdout) as Envelope);
			} catch {
				reject(new Error(`no JSON envelope: ${stdout}\n${stderr}`));
			}
		});
	});
}

const FIXTURES = join(PACKAGE, "data-models", "fixtures", "cd_topology");
const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(join(FIXTURES, "valid", name), "utf8"));
// The relay's Yard as `yard()` builds it, extra members included (the parse
// reads only what the topology needs).
const RELAY = {
	...(fixture("relay-yard.json") as object),
	require: [],
	bindings: [{ profile: "api.http", productId: "vercel.function/v1" }],
	properties: { project: "hobo-ci" },
};

describe("topology files (parse once with the generated schemas)", () => {
	it("projects a @hobo/yards Yard's Camps, Yard-scoped", () => {
		const parsed = parseTopologyExports(
			{ default: RELAY },
			{ stationId: "local", source: "yard.ts" },
		);
		expect(parsed.ok, parsed.ok ? "" : parsed.message).toBe(true);
		if (!parsed.ok) return;
		const byId = new Map(parsed.value.map((c) => [c.campId, c]));
		const preview = byId.get("hobo-ci-relay/hobo-ci-relay/preview");
		const production = byId.get("hobo-ci-relay/hobo-ci-relay/production");
		expect(preview?.envType).toBe("preview");
		expect(production?.provider).toBe("vercel");
		expect(production?.regions).toEqual(["iad1"]);
		expect(production?.management).toBe(CampManagement.MANAGED);
		expect(production?.stationId).toBe("local");
	});

	it("parses a runner fleet Camp record (runnerFleetTopology's form)", () => {
		const parsed = parseTopologyExports(
			{ camps: [fixture("runner-camp.json")] },
			{ stationId: "local", source: "hobo.delivery.ts" },
		);
		expect(parsed.ok, parsed.ok ? "" : parsed.message).toBe(true);
		if (!parsed.ok) return;
		const box = parsed.value.find((c) => c.campId === "hobo-ci-runners/box");
		expect(box?.labels["hobo.ci/runner-fleet"]).toBe("true");
		expect(box?.stationId).toBe("local");
		expect(box?.management).toBe(CampManagement.MANAGED);
	});

	it("refuses a malformed Camp record", () => {
		const parsed = parseTopologyExports(
			{ camps: [{ campId: "x/y", yardId: "x", envTyp: "ci" }] },
			{ stationId: "local", source: "bad.ts" },
		);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.code).toBe("cd-topology-invalid");
		expect(parsed.message).toContain("camps[0]");
		expect(parsed.remediation).not.toBe("");
	});

	it("refuses a Camp id that is not Yard-scoped", () => {
		const parsed = parseTopologyExports(
			{
				camps: [
					{ campId: "box", yardId: "runners", provider: "x", envType: "ci" },
				],
			},
			{ stationId: "local", source: "bad.ts" },
		);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.code).toBe("cd-topology-invalid");
	});

	it("refuses a yards export that is not a @hobo/yards Yard", () => {
		const parsed = parseTopologyExports(
			{ yards: [{ kind: "station", name: "x", providerId: "vercel" }] },
			{ stationId: "local", source: "bad.ts" },
		);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.code).toBe("cd-topology-invalid");
	});

	it("refuses a Camp another Station declares", () => {
		const parsed = parseTopologyExports(
			{
				camps: [
					{
						campId: "edge/prod",
						yardId: "edge",
						stationId: "elsewhere",
						provider: "vercel",
						envType: "production",
					},
				],
			},
			{ stationId: "local", source: "camps.ts" },
		);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.code).toBe("cd-topology-station-mismatch");
	});

	it("names files by HOBO_CD_TOPOLOGY, then --yard", () => {
		expect(
			topologyFilesOf({ yard: "a.ts,b.ts" }, { HOBO_CD_TOPOLOGY: "c.ts" }),
		).toEqual(["c.ts", "a.ts", "b.ts"]);
		expect(topologyFilesOf({}, {})).toEqual([]);
	});

	it("an unreadable topology file is a typed refusal", async () => {
		const loaded = await loadTopologyFiles(["does/not/exist.ts"], {
			cwd: REPO,
			stationId: "local",
		});
		expect(loaded.ok).toBe(false);
		if (!loaded.ok) expect(loaded.code).toBe("cd-topology-unreadable");
	});

	it("loads a JSON topology file", async () => {
		const home = await freshHome();
		await writeFile(
			join(home, "camps.json"),
			JSON.stringify({ default: RELAY }),
		);
		const loaded = await loadTopologyFiles(["camps.json"], {
			cwd: home,
			stationId: "local",
		});
		expect(loaded.ok && loaded.value.map((c) => c.campId)).toEqual([
			"hobo-ci-relay/hobo-ci-relay/preview",
			"hobo-ci-relay/hobo-ci-relay/production",
		]);
	});
});

describe.skipIf(!existsSync(BIN))(
	"hobo deploy resolves repo-declared Camps (built binary)",
	{ timeout: 120_000 },
	() => {
		it("camp list shows the relay's preview and production Camps from its Yard module", async () => {
			const home = await freshHome();
			const listed = await deploy(home, ["camp", "list", "--yard", RELAY_YARD]);
			expect(listed.ok, listed.message).toBe(true);
			const text = JSON.stringify(listed.data);
			expect(text).toContain("hobo-ci-relay/hobo-ci-relay/preview");
			expect(text).toContain("hobo-ci-relay/hobo-ci-relay/production");
		});

		it("pipeline apply of the relay's delivery resolves its Camps only with its Yard", async () => {
			const home = await freshHome();
			const without = await deploy(home, [
				"pipeline",
				"apply",
				"--file",
				RELAY_DELIVERY,
			]);
			expect(without.ok).toBe(false);
			expect(without.code).toBe("pipeline-unknown-camp");
			const applied = await deploy(home, [
				"pipeline",
				"apply",
				"--file",
				RELAY_DELIVERY,
				"--yard",
				RELAY_YARD,
			]);
			expect(applied.ok, applied.message).toBe(true);
		});

		it("the runner fleet's module declares its Camps; camp list and agent token resolve the Camp set", async () => {
			const home = await freshHome();
			const applied = await deploy(home, [
				"pipeline",
				"apply",
				"--file",
				RUNNER_FLEET,
			]);
			expect(applied.ok, applied.message).toBe(true);
			const env = { HOBO_CD_TOPOLOGY: RUNNER_FLEET };
			const listed = await deploy(
				home,
				["camp", "list", "--campset", "hobo-ci-runner-fleet"],
				env,
			);
			expect(listed.ok, listed.message).toBe(true);
			expect(JSON.stringify(listed.data)).toContain("hobo-ci-runners/box");
			const token = await deploy(
				home,
				[
					"agent",
					"token",
					"--camp-set",
					"hobo-ci-runner-fleet",
					"--camp",
					"hobo-ci-runners/box",
				],
				env,
			);
			expect(token.ok, token.message).toBe(true);
			const unscoped = await deploy(home, [
				"agent",
				"token",
				"--camp-set",
				"hobo-ci-runner-fleet",
				"--camp",
				"hobo-ci-runners/box",
			]);
			expect(unscoped.ok).toBe(false);
		});

		it("a malformed topology file refuses the command with its code", async () => {
			const home = await freshHome();
			const file = join(home, "bad.delivery.json");
			await writeFile(file, JSON.stringify({ camps: [{ campId: 3 }] }));
			const refused = await deploy(home, ["camp", "list", "--yard", file]);
			expect(refused.ok).toBe(false);
			expect(refused.code).toBe("cd-topology-invalid");
		});
	},
);
