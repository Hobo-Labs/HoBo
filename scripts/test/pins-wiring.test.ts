/**
 * The pins are only worth having if the entry points reach them: the package
 * scripts, `setup`, the remediation a missing submodule prints, the disabled
 * CI job, and the manifest's agreement with `.gitmodules`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parsePins } from "../lib/pins.ts";
import { gitlinkOf, modulesUrl, sameRepo } from "../lib/pins-git.ts";
import { REPO_ROOT } from "./support/pins-support.ts";

const read = (path: string): string =>
	readFileSync(join(REPO_ROOT, path), "utf8");

/** The body of one top-level job, the way scripts/lint-actions.ts finds it. */
function jobText(workflow: string, job: string): string {
	const lines = workflow.split("\n");
	const rest = lines.slice(lines.indexOf(`  ${job}:`) + 1);
	const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/u.test(line));
	return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

const BOOTSTRAP =
	"node --experimental-strip-types scripts/bootstrap-siblings.mts";

describe("pins wiring", () => {
	const scripts = JSON.parse(read("package.json")).scripts;

	it("pins:status, pins:fetch and pins:bump are the script's three verbs", () => {
		assert.equal(scripts["pins:status"], `${BOOTSTRAP} --status`);
		assert.equal(scripts["pins:fetch"], `${BOOTSTRAP} --fetch`);
		assert.equal(scripts["pins:bump"], `${BOOTSTRAP} --bump`);
	});

	it("setup initialises the pins before it installs, so the submodule exists first", () => {
		const parts = String(scripts.setup).split(" && ");
		assert.equal(parts[0], BOOTSTRAP);
		// The install runs through `corepack pnpm …` — the same command as
		// install:check — instead of `corepack enable pnpm`, which hard-fails
		// when the Node bin directory is not writable (EACCES on the shim
		// symlink) even though corepack could run pnpm perfectly well.
		assert.deepEqual(parts.slice(1), [`corepack ${scripts["install:check"]}`]);
	});

	it("a missing submodule is remedied with pins:fetch, not a hand-typed git command", () => {
		const cli = read("scripts/hobo-cli.ts");
		assert.match(cli, /pnpm run pins:fetch ts-autocode/);
		assert.doesNotMatch(
			cli,
			/git submodule update --init external\/ts-autocode/,
		);
	});

	it("the PR gate checks the pins after checkout and before installing", () => {
		const job = jobText(read(".github/workflows/hobo-ci.yml"), "pr-gate");
		const checkout = job.indexOf("actions/checkout@");
		const status = job.indexOf(`run: ${BOOTSTRAP} --status --offline`);
		const install = job.indexOf("pnpm install");
		assert.ok(checkout >= 0 && status > checkout, "status runs after checkout");
		assert.ok(install > status, "status runs before pnpm install");
		assert.match(job, /runs-on:\s*hobo\b/u);
	});

	it("the setup docs name the three verbs", () => {
		for (const doc of ["README.md", "CONTRIBUTING.md", "AGENTS.md"]) {
			const text = read(doc);
			for (const verb of ["pins:status", "pins:fetch", "pins:bump"]) {
				assert.ok(text.includes(verb), `${doc} mentions ${verb}`);
			}
		}
	});
});

describe("the committed manifest", () => {
	const pins = parsePins(read("tools/pins/siblings.json"));

	it("names every submodule .gitmodules registers, at the same repository", () => {
		for (const [name, pin] of Object.entries(pins.git)) {
			const recorded = modulesUrl(REPO_ROOT, pin.path);
			assert.ok(
				recorded !== null,
				`${name}: ${pin.path} is registered in .gitmodules`,
			);
			assert.ok(
				sameRepo(recorded, pin.repo),
				`${name}: ${recorded} is ${pin.repo}`,
			);
		}
		const registered = read(".gitmodules").match(/^\s*path = (.+)$/gmu) ?? [];
		assert.equal(
			registered.length,
			Object.keys(pins.git).length,
			".gitmodules registers exactly the git pins",
		);
	});

	it("pins ts-autocode at a full commit id in the index", () => {
		assert.match(
			gitlinkOf(REPO_ROOT, "external/ts-autocode"),
			/^[0-9a-f]{40}$/u,
		);
	});
});
