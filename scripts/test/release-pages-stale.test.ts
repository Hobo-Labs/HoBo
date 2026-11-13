import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadReleaseHoboPullRequestPathFilters } from "../lib/release-hobo-path-filters.mts";
import {
	COMPARE_FILE_LIMIT,
	decidePagesDeploy,
	githubPagesSource,
	type PagesApiRequest,
	type PagesComparison,
	type PagesSource,
	parseDeployedSha,
} from "../lib/release-pages-stale.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const filters = loadReleaseHoboPullRequestPathFilters(root);
const deployed = "93d367d9a7f58bfd2a442ea5b607cf633ffc09f2";
const head = "b13f2846000000000000000000000000000000aa";

function source(
	message: string | undefined,
	comparison?: PagesComparison,
): PagesSource {
	return {
		deployedMessage: async () => message,
		compare: async () => comparison,
	};
}

function ahead(files: readonly string[], truncated = false): PagesComparison {
	return { status: "ahead", files, truncated };
}

describe("parseDeployedSha", () => {
	it("reads the commit the release workflow names", () => {
		expect(parseDeployedSha(`deploy: ${deployed}`)).toBe(deployed);
	});

	it("reads the short commit scripts/deploy-site.mts names", () => {
		expect(parseDeployedSha("deploy: site + media @ 1a2b3c4d5\n\nbody")).toBe(
			"1a2b3c4d5",
		);
	});

	it("finds no commit in a message that names none", () => {
		expect(parseDeployedSha("Initial commit")).toBeUndefined();
		expect(parseDeployedSha("deploy: by hand")).toBeUndefined();
		expect(parseDeployedSha(`chore: mention ${deployed}`)).toBeUndefined();
	});
});

describe("decidePagesDeploy", () => {
	it("publishes a site change no run deployed, however many commits ago it merged", async () => {
		// The #1790 case: its deploy failed, and the commits after it did not
		// touch a release path, so a head-commit-only question never asked again.
		const decision = await decidePagesDeploy({
			head,
			filters,
			source: source(
				`deploy: ${deployed}`,
				ahead(["site/src/pages/index.astro", "packages/ci/src/journal.ts"]),
			),
		});
		expect(decision.deploy).toBe(true);
		expect(decision.deployedSha).toBe(deployed);
	});

	it("skips when nothing on a release path changed since the last deploy", async () => {
		const decision = await decidePagesDeploy({
			head,
			filters,
			source: source(
				`deploy: ${deployed}`,
				ahead(["packages/ci/test/journal.test.ts", "docs/ci/performance.md"]),
			),
		});
		expect(decision).toMatchObject({ deploy: false, deployedSha: deployed });
	});

	it("publishes when the changed-file list was cut off", async () => {
		const decision = await decidePagesDeploy({
			head,
			filters,
			source: source(`deploy: ${deployed}`, ahead(["README.md"], true)),
		});
		expect(decision.deploy).toBe(true);
	});

	it("skips when the published commit is this one", async () => {
		const decision = await decidePagesDeploy({
			head,
			filters,
			source: source(`deploy: ${head}`, { status: "identical" }),
		});
		expect(decision.deploy).toBe(false);
	});

	it("never puts an older commit back over a newer deploy", async () => {
		for (const force of [false, true]) {
			const decision = await decidePagesDeploy({
				head,
				filters,
				force,
				source: source(`deploy: ${deployed}`, { status: "behind" }),
			});
			expect(decision.deploy, `force=${force}`).toBe(false);
		}
	});

	it("publishes when what is published cannot be placed", async () => {
		const cases: readonly PagesSource[] = [
			source(undefined),
			source("Initial commit"),
			source(`deploy: ${deployed}`, undefined),
			source(`deploy: ${deployed}`, { status: "diverged" }),
		];
		for (const candidate of cases) {
			const decision = await decidePagesDeploy({
				head,
				filters,
				source: candidate,
			});
			expect(decision.deploy, decision.reason).toBe(true);
		}
	});

	it("publishes on request without a release path changing", async () => {
		const quiet = ahead(["docs/ci/performance.md"]);
		const asked = await decidePagesDeploy({
			head,
			filters,
			force: true,
			source: source(`deploy: ${deployed}`, quiet),
		});
		expect(asked.deploy).toBe(true);
		const again = await decidePagesDeploy({
			head,
			filters,
			force: true,
			source: source(`deploy: ${head}`, { status: "identical" }),
		});
		expect(again.deploy).toBe(true);
	});
});

describe("githubPagesSource", () => {
	type Answer = { readonly status: number; readonly body?: object };

	function api(routes: Readonly<Record<string, readonly Answer[]>>) {
		const calls: string[] = [];
		const served = new Map<string, number>();
		const request: PagesApiRequest = async (url) => {
			calls.push(url);
			const path = url.replace("https://api.github.com", "");
			const answers = routes[path] ?? [];
			const turn = served.get(path) ?? 0;
			served.set(path, turn + 1);
			const answer = answers[Math.min(turn, answers.length - 1)];
			if (!answer) throw new Error(`unexpected request ${path}`);
			return {
				status: answer.status,
				text: JSON.stringify(answer.body ?? {}),
			};
		};
		return { calls, request };
	}
	const repository = "Hobo-Labs/HoBo";
	const branchPath = `/repos/${repository}/branches/gh-pages`;
	const comparePath = `/repos/${repository}/compare/${deployed}...${head}?per_page=1`;
	const branchBody = {
		name: "gh-pages",
		commit: { sha: "fe6abc96", commit: { message: `deploy: ${deployed}` } },
	};

	it("reads the published commit's message", async () => {
		const { request } = api({
			[branchPath]: [{ status: 200, body: branchBody }],
		});
		const pages = githubPagesSource({ repository, token: "t", request });
		expect(await pages.deployedMessage()).toBe(`deploy: ${deployed}`);
	});

	it("reports a missing branch and an unknown base as absent", async () => {
		const { request } = api({
			[branchPath]: [{ status: 404 }],
			[comparePath]: [{ status: 404 }],
		});
		const pages = githubPagesSource({ repository, token: "t", request });
		expect(await pages.deployedMessage()).toBeUndefined();
		expect(await pages.compare(deployed, head)).toBeUndefined();
	});

	it("lists both sides of a rename and marks a full list as cut off", async () => {
		const many = Array.from({ length: COMPARE_FILE_LIMIT }, (_, i) => ({
			filename: `packages/a/${i}.ts`,
		}));
		const { request } = api({
			[comparePath]: [
				{
					status: 200,
					body: {
						status: "ahead",
						ahead_by: 2,
						files: [
							{ filename: "docs/new.md", previous_filename: "site/old.md" },
						],
					},
				},
				{ status: 200, body: { status: "ahead", files: many } },
			],
		});
		const pages = githubPagesSource({ repository, token: "t", request });
		expect(await pages.compare(deployed, head)).toEqual({
			status: "ahead",
			files: ["docs/new.md", "site/old.md"],
			truncated: false,
		});
		expect(await pages.compare(deployed, head)).toMatchObject({
			truncated: true,
		});
	});

	it("passes on a relation that needs no file list", async () => {
		const { request } = api({
			[comparePath]: [{ status: 200, body: { status: "behind", files: [] } }],
		});
		const pages = githubPagesSource({ repository, token: "t", request });
		expect(await pages.compare(deployed, head)).toEqual({ status: "behind" });
	});

	it("retries a failing request, then gives up loudly", async () => {
		const flaky = api({
			[branchPath]: [{ status: 502 }, { status: 200, body: branchBody }],
		});
		const sleeps: number[] = [];
		const pages = githubPagesSource({
			repository,
			token: "t",
			request: flaky.request,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(await pages.deployedMessage()).toBe(`deploy: ${deployed}`);
		expect(sleeps).toEqual([2000]);

		const down = api({ [branchPath]: [{ status: 503 }] });
		const broken = githubPagesSource({
			repository,
			token: "t",
			request: down.request,
			sleep: async () => {},
		});
		await expect(broken.deployedMessage()).rejects.toThrow(/HTTP 503/);
		expect(down.calls).toHaveLength(3);
	});

	it("refuses an answer that is not the documented shape", async () => {
		const { request } = api({
			[comparePath]: [{ status: 200, body: { status: "sideways" } }],
		});
		const pages = githubPagesSource({
			repository,
			token: "t",
			request,
			sleep: async () => {},
		});
		await expect(pages.compare(deployed, head)).rejects.toThrow(/compare/);
	});
});

describe("check-release-pages-stale CLI", () => {
	const cli = join(root, "scripts/ci/check-release-pages-stale.mts");

	it("rejects a head that is not a full commit sha", () => {
		const result = spawnSync(
			process.execPath,
			["--no-warnings", cli, "--head", "main"],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("usage:");
	});
});

describe("release-hobo pages jobs", () => {
	const workflow = readFileSync(
		join(root, ".github/workflows/release-hobo.yml"),
		"utf8",
	);
	function job(id: string): string {
		const start = workflow.indexOf(`\n  ${id}:\n`);
		expect(start, id).toBeGreaterThan(-1);
		const rest = workflow.slice(start + 1);
		const end = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
		return end < 0 ? rest : rest.slice(0, end + 1);
	}

	it("decides the deploy from what is published, apart from the release train", () => {
		const gate = job("release-pages-gate");
		expect(gate).toContain("scripts/ci/check-release-pages-stale.mts");
		// The train gate installs dotnet and runs vitest; the site must not wait on it.
		expect(gate).toContain("    needs: [route]\n");
		expect(gate).not.toContain("release-main-train-gate");
		const pages = job("release-pages");
		expect(pages).toContain("needs: [release-pages-gate, release-hobo-cli]");
		expect(pages).toContain(
			"needs.release-pages-gate.outputs.deploy == 'true'",
		);
		expect(pages).not.toContain("release-main-train-gate");
	});

	it("checks out every file the gate script loads", () => {
		const gate = job("release-pages-gate");
		for (const path of [
			".github/workflows/release-hobo.yml",
			".github/actions/ci-runner-preflight/hosted-toolchain.sh",
			"scripts/ci/check-release-pages-stale.mts",
			"scripts/lib/release-pages-stale.mts",
			"scripts/lib/release-hobo-path-filters.mts",
		]) {
			expect(gate, path).toContain(`            ${path}\n`);
		}
	});

	it("runs from those files alone, before any pnpm install", () => {
		// The gate and the re-check in release-pages run on a sparse checkout with
		// no node_modules; a package import there fails and Pages never publishes.
		const after =
			job("release-pages-gate").split("sparse-checkout: |\n")[1] ?? "";
		const block = after.split("\n");
		const end = block.findIndex((line) => !/^ {12}\S/.test(line));
		const sparse = block
			.slice(0, end < 0 ? block.length : end)
			.map((line) => line.trim());
		expect(sparse.length).toBeGreaterThan(0);
		const copy = mkdtempSync(join(tmpdir(), "release-pages-gate-"));
		try {
			for (const path of sparse) {
				mkdirSync(dirname(join(copy, path)), { recursive: true });
				copyFileSync(join(root, path), join(copy, path));
			}
			const run = spawnSync(
				process.execPath,
				["--no-warnings", "scripts/ci/check-release-pages-stale.mts"],
				{ cwd: copy, encoding: "utf8" },
			);
			// Exit 2 is the usage error: every import resolved and the script ran.
			expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find/);
			expect(run.status, run.stderr).toBe(2);
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	});

	it("publishes one commit at a time and asks again once it holds the slot", () => {
		const pages = job("release-pages");
		expect(pages).toMatch(
			/concurrency:\n {6}group: hobo-release-pages\n {6}cancel-in-progress: false/,
		);
		const recheck = pages.indexOf("scripts/ci/check-release-pages-stale.mts");
		const build = pages.indexOf("pnpm --filter hobo-site run build");
		expect(recheck).toBeGreaterThan(-1);
		expect(recheck).toBeLessThan(build);
	});

	it("tags whatever this run's publish did, unless it or its gate failed", () => {
		const tag = job("release-tag");
		expect(tag).toContain("!cancelled() &&");
		expect(tag).not.toContain("always()");
		expect(tag).toMatch(
			/needs: \[[^\]]*release-pages-gate, release-pages\b[^\]]*\]/,
		);
		// A failed gate skips the publish; that skip must not read as "nothing to do".
		expect(tag).toContain(
			`contains(fromJSON('["success","skipped"]'), needs.release-pages-gate.result)`,
		);
		// A newer run's publish cancels this one while it waits for the slot.
		expect(tag).toContain(
			`contains(fromJSON('["success","skipped","cancelled"]'), needs.release-pages.result)`,
		);
	});

	it("records the commit it built, not the branch tip the event fired on", () => {
		// The Pages realizer commits `deploy: <HOBO_RELEASE_REVISION>`
		// (scripts/deploy-site.mts), and the publish step pins it to the
		// commit checked out and built here.
		const pages = job("release-pages");
		const step = pages.slice(
			pages.indexOf("Record, promote and publish the Pages site"),
		);
		expect(step).toContain(
			"HOBO_RELEASE_REVISION: ${{ env.HOBO_RELEASE_CHECKOUT_REF }}",
		);
		expect(
			readFileSync(join(root, "scripts/deploy-site.mts"), "utf8"),
		).toContain(
			'"hobo.cd/github.commit-message": `deploy: ${releaseSource(env).commit}`',
		);
	});

	it("publishes the art catalogue with the site, as scripts/deploy-site.mts does", () => {
		const pages = job("release-pages");
		const site = pages.indexOf("pnpm --filter hobo-site run build");
		const media = pages.indexOf("pnpm --filter hobo-media run build");
		const nest = pages.indexOf("cp -a media/dist/. site/dist/media/");
		const deploy = pages.indexOf("deploy-site.mts --release-freight site/dist");
		expect(site).toBeGreaterThan(-1);
		expect(media).toBeGreaterThan(site);
		expect(nest).toBeGreaterThan(media);
		expect(deploy).toBeGreaterThan(nest);
		// The catalogue's base has to agree with where it is nested, or every asset 404s.
		expect(readFileSync(join(root, "media/astro.config.ts"), "utf8")).toContain(
			'base: "/HoBo/media"',
		);
	});

	it("lists its own script and library among the release paths", () => {
		expect(filters).toContain("scripts/lib/release-pages-stale.mts");
		expect(filters).toContain("scripts/test/release-pages-stale.test.ts");
	});
});
