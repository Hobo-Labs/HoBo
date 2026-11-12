// Repo-declared topology reaches `hobo deploy` (plan 0024): Yards from a Yard
// module and Camps from a delivery module, parsed once with the generated
// cd_topology schemas, then resolved by `camp list`, `pipeline apply` and
// `agent token` through the shell (so flag parsing is exercised too).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampManagement } from "@hobo/cd";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadTopologyFiles,
	parseTopologyExports,
	topologyFilesOf,
} from "../src/cd-topology.js";
import { createDeployCommand } from "../src/deploy-command.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RELAY_YARD = "packages/ci-vercel/deploy/yard.ts";
const RELAY_DELIVERY = "packages/ci-vercel/deploy/delivery.ts";
const RUNNER_FLEET = "packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts";

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

function deployCli(home: string, env: NodeJS.ProcessEnv = {}) {
	return createHoboCli({
		commands: { deploy: createDeployCommand({ env, hoboHome: home }) },
	});
}

async function deployJson(
	home: string,
	argv: readonly string[],
	env: NodeJS.ProcessEnv = {},
) {
	const result = await deployCli(home, env).run(
		["deploy", ...argv, "--json"],
		{ cwd: REPO, env },
	);
	const envelope = JSON.parse(result.stdout) as {
		ok: boolean;
		code?: string;
		message?: string;
		data?: Record<string, unknown>;
	};
	return { result, envelope };
}

describe("topology files (parse once with the generated schemas)", () => {
	it("loads the relay's preview and production Camps from its Yard module", async () => {
		const loaded = await loadTopologyFiles([RELAY_YARD], {
			cwd: REPO,
			stationId: "local",
		});
		expect(loaded.ok, loaded.ok ? "" : loaded.message).toBe(true);
		if (!loaded.ok) return;
		const byId = new Map(loaded.value.map((c) => [c.campId, c]));
		const preview = byId.get("hobo-ci-relay/hobo-ci-relay/preview");
		const production = byId.get("hobo-ci-relay/hobo-ci-relay/production");
		expect(preview?.envType).toBe("preview");
		expect(production?.envType).toBe("production");
		expect(production?.provider).toBe("vercel");
		expect(production?.regions).toEqual(["iad1"]);
		expect(production?.management).toBe(CampManagement.MANAGED);
		expect(production?.stationId).toBe("local");
	});

	it("loads the runner Camp set from the runner fleet's delivery module", async () => {
		const loaded = await loadTopologyFiles([RUNNER_FLEET], {
			cwd: REPO,
			stationId: "local",
		});
		expect(loaded.ok, loaded.ok ? "" : loaded.message).toBe(true);
		if (!loaded.ok) return;
		const box = loaded.value.find((c) => c.campId === "hobo-ci-runners/box");
		expect(box?.labels["hobo.ci/runner-fleet"]).toBe("true");
		expect(box?.yardId).toBe("hobo-ci-runners");
	});

	it("refuses a malformed Camp record before anything is composed", () => {
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

	it("names files by --yard and HOBO_CD_TOPOLOGY", () => {
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
});

// Each command opens the SQLite journal and loads TypeScript modules via tsx.
describe("hobo deploy resolves repo-declared Camps", { timeout: 30_000 }, () => {
	it("camp list shows the relay's Camps from --yard", async () => {
		const home = await freshHome();
		const { envelope } = await deployJson(home, [
			"camp",
			"list",
			"--yard",
			RELAY_YARD,
		]);
		expect(envelope.ok, envelope.message).toBe(true);
		const text = JSON.stringify(envelope.data);
		expect(text).toContain("hobo-ci-relay/hobo-ci-relay/preview");
		expect(text).toContain("hobo-ci-relay/hobo-ci-relay/production");
	});

	it("the runner fleet's module declares its Camps; agent token resolves the Camp set", async () => {
		const home = await freshHome();
		const applied = await deployJson(home, [
			"pipeline",
			"apply",
			"--file",
			RUNNER_FLEET,
		]);
		// placements may fail closed on Rail providers; the Camp set and Camps
		// must not be the reason.
		expect(applied.envelope.message ?? "").not.toMatch(/unknown-camp/);
		const env = { HOBO_CD_TOPOLOGY: RUNNER_FLEET };
		const listed = await deployJson(
			home,
			["camp", "list", "--campset", "hobo-ci-runner-fleet"],
			env,
		);
		expect(listed.envelope.ok, listed.envelope.message).toBe(true);
		expect(JSON.stringify(listed.envelope.data)).toContain(
			"hobo-ci-runners/box",
		);
		const token = await deployJson(
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
		expect(token.envelope.ok, token.envelope.message).toBe(true);
	});

	it("a malformed topology file refuses the command with its code", async () => {
		const home = await freshHome();
		const file = join(home, "bad.delivery.json");
		await writeFile(file, JSON.stringify({ camps: [{ campId: 3 }] }));
		const { envelope } = await deployJson(home, [
			"camp",
			"list",
			"--yard",
			file,
		]);
		expect(envelope.ok).toBe(false);
		expect(envelope.code).toBe("cd-topology-invalid");
	});

	it("pipeline apply of the relay's delivery resolves its preview and production Camps", async () => {
		const home = await freshHome();
		const without = await deployJson(home, [
			"pipeline",
			"apply",
			"--file",
			RELAY_DELIVERY,
		]);
		expect(without.envelope.ok).toBe(false);
		expect(without.envelope.code).toBe("pipeline-unknown-camp");
		const applied = await deployJson(home, [
			"pipeline",
			"apply",
			"--file",
			RELAY_DELIVERY,
			"--yard",
			RELAY_YARD,
		]);
		expect(applied.envelope.ok, applied.envelope.message).toBe(true);
	});
});
