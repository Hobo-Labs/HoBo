/**
 * `fleet:outcome <id>` runs one outcome of the fleet design: it fails an
 * outcome whose named test file is missing, one with a skipped test and one
 * whose threshold is not met, and applies the fallback threshold only for an
 * assumption listed in `fleet-fallbacks.json`. Commands are run through an
 * injected runner that writes the vitest JSON report a real run would.
 *
 * The same file holds the tests of `fleet:contracts`, the one command O26
 * runs: the emitted declarations equal the snapshots, and no snapshot or fleet
 * record changed outside a `Fleet-Contract:` commit. Each of those cases is a
 * throwaway git repository whose `emit-fleet-contracts.mts` is a stub that
 * passes or fails on demand.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkFleetContracts } from "../check-fleet-contracts.mts";
import {
	type CommandRunner,
	namedFiles,
	OUTCOMES,
	type OutcomeSpec,
	readFallbacks,
	runOutcome,
} from "../fleet-outcome.mts";

const repoRoot = join(import.meta.dirname, "..", "..");
const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
	const result = spawnSync(
		"git",
		[
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd: dir, encoding: "utf8" },
	);
	if (result.status !== 0)
		throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

function put(dir: string, path: string, text: string): void {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
}

const STUB = `import { existsSync } from "node:fs";
if (existsSync("emit-differs")) {
	console.error("fleet contract snapshots differ from the sources:");
	process.exit(1);
}
console.log("fleet contract snapshots match");
`;

/** A repository whose last commit is the contract commit. */
function repository(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-fleet-contracts-"));
	made.push(dir);
	git(dir, "init", "-q", "-b", "main");
	put(dir, "scripts/emit-fleet-contracts.mts", STUB);
	put(
		dir,
		"packages/fleet/contracts/api.snapshot.d.ts",
		"export declare const a: 1;\n",
	);
	put(
		dir,
		"packages/fleet-nats/contracts/api.snapshot.d.ts",
		"export declare const b: 1;\n",
	);
	put(dir, "packages/fleet/data-models/fleet.proto", 'syntax = "proto3";\n');
	put(dir, "packages/fleet/src/index.ts", "export const a = 1;\n");
	git(dir, "add", "-A");
	git(
		dir,
		"commit",
		"-q",
		"-m",
		"feat(fleet): contract commit\n\nFleet-Contract: initial",
	);
	return dir;
}

function commit(dir: string, message: string): void {
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
}

describe("checkFleetContracts", () => {
	it("passes when the emitter matches and nothing changed since the contract commit", () => {
		const dir = repository();
		put(
			dir,
			"packages/fleet/src/index.ts",
			"export const a = 1;\nconst b = 2;\n",
		);
		commit(dir, "feat(fleet): implementation only");
		const report = checkFleetContracts(dir);
		expect(report.pass).toBe(true);
		expect(report.emit.exitCode).toBe(0);
		expect(report.provenance.changed).toEqual([]);
	});

	it("fails when the emitted declarations differ from a snapshot", () => {
		const dir = repository();
		put(dir, "emit-differs", "");
		const report = checkFleetContracts(dir);
		expect(report.pass).toBe(false);
		expect(report.emit.exitCode).toBe(1);
	});

	it("fails when a snapshot changed in a commit without the trailer", () => {
		const dir = repository();
		put(
			dir,
			"packages/fleet-nats/contracts/api.snapshot.d.ts",
			"export declare const b: 2;\n",
		);
		commit(dir, "feat(fleet-nats): sneak a contract change");
		const report = checkFleetContracts(dir);
		expect(report.pass).toBe(false);
		expect(report.provenance.changed).toEqual([
			"packages/fleet-nats/contracts/api.snapshot.d.ts",
		]);
	});

	it("fails when a fleet record changed, even uncommitted", () => {
		const dir = repository();
		put(
			dir,
			"packages/fleet/data-models/fleet.proto",
			'syntax = "proto3";\nmessage X {}\n',
		);
		const report = checkFleetContracts(dir);
		expect(report.pass).toBe(false);
		expect(report.provenance.changed).toEqual([
			"packages/fleet/data-models/fleet.proto",
		]);
	});

	it("compares against the newest amendment commit", () => {
		const dir = repository();
		put(
			dir,
			"packages/fleet/contracts/api.snapshot.d.ts",
			"export declare const a: 2;\n",
		);
		commit(
			dir,
			"feat(fleet): amend the contract\n\nFleet-Contract: amendment 1",
		);
		const report = checkFleetContracts(dir);
		expect(report.pass).toBe(true);
		expect(report.provenance.base).toBe(git(dir, "rev-parse", "HEAD").trim());
	});

	it("fails when no commit carries the trailer", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-fleet-contracts-"));
		made.push(dir);
		git(dir, "init", "-q", "-b", "main");
		put(dir, "scripts/emit-fleet-contracts.mts", STUB);
		commit(dir, "chore: no contract yet");
		const report = checkFleetContracts(dir);
		expect(report.pass).toBe(false);
		expect(report.provenance.base).toBeUndefined();
	});
});

describe("fleet:contracts command", () => {
	it("exits 1 and names the changed snapshot", () => {
		const dir = repository();
		put(
			dir,
			"packages/fleet/contracts/api.snapshot.d.ts",
			"export declare const a: 3;\n",
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				join(repoRoot, "scripts/check-fleet-contracts.mts"),
				`--root=${dir}`,
				"--no-build",
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"packages/fleet/contracts/api.snapshot.d.ts",
		);
	});
});

// ── fleet:outcome ───────────────────────────────────────────────────────────

function root(files: ReadonlyMap<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-fleet-outcome-"));
	made.push(dir);
	for (const [path, text] of files) put(dir, path, text);
	return dir;
}

type Assertion = Readonly<{ title: string; status: string }>;

/** A runner that records commands and answers each vitest run with `assertions`. */
function runner(
	assertions: readonly Assertion[],
	exitCodes: ReadonlyMap<string, number> = new Map(),
): CommandRunner & { readonly ran: string[] } {
	const ran: string[] = [];
	const exec = (command: string): number => {
		ran.push(command);
		const output = /--outputFile=(\S+)/u.exec(command)?.[1];
		if (output !== undefined)
			writeFileSync(
				output,
				JSON.stringify({ testResults: [{ assertionResults: assertions }] }),
			);
		const prefix = [...exitCodes.keys()].find((key) => command.startsWith(key));
		return prefix === undefined ? 0 : (exitCodes.get(prefix) ?? 0);
	};
	return Object.assign(exec, { ran });
}

function spec(id: string): OutcomeSpec {
	const found = OUTCOMES.find((outcome) => outcome.id === id);
	if (found === undefined) throw new Error(`no outcome ${id}`);
	return found;
}

const passing: readonly Assertion[] = [{ title: "holds", status: "passed" }];

describe("fleet:outcome", () => {
	it("holds every outcome of the design once, O1 to O45", () => {
		const ids = OUTCOMES.map((outcome) => outcome.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(
			Array.from({ length: 45 }, (_, index) => `O${index + 1}`).sort(),
		);
		for (const outcome of OUTCOMES)
			if (outcome.fallbackThreshold !== undefined)
				expect(outcome.assumptions.length).toBeGreaterThan(0);
	});

	it("passes when every command exits zero and nothing skipped", () => {
		const dir = root(new Map([["packages/fleet/test/keys/trust.test.ts", ""]]));
		const exec = runner(passing);
		const result = runOutcome(spec("O14"), { root: dir, fallbacks: [], exec });
		expect(result).toMatchObject({ id: "O14", pass: true, fallbacks: [] });
		expect(result.command).toBe(
			"pnpm exec vitest run packages/fleet/test/keys/trust.test.ts",
		);
		expect(result.measured).toMatchObject({ tests: 1, skipped: 0 });
		expect(exec.ran[0]).toMatch(/--reporter=json --outputFile=\S+$/u);
	});

	it("fails an outcome whose named test file is missing, without running it", () => {
		const exec = runner(passing);
		const result = runOutcome(spec("O13"), {
			root: root(new Map([["packages/fleet/test/audit/chain.test.ts", ""]])),
			fallbacks: [],
			exec,
		});
		expect(result.pass).toBe(false);
		expect(result.evidence).toContain(
			"missing: packages/fleet/test/audit/witness.test.ts",
		);
		expect(exec.ran).toEqual([]);
	});

	it("fails an outcome with a skipped or todo test", () => {
		const dir = root(new Map([["packages/fleet/test/keys/trust.test.ts", ""]]));
		for (const status of ["skipped", "todo", "pending"]) {
			const result = runOutcome(spec("O14"), {
				root: dir,
				fallbacks: [],
				exec: runner([...passing, { title: "later", status }]),
			});
			expect(result.pass).toBe(false);
			expect(result.evidence).toContain("skipped: later");
			expect(result.measured.skipped).toBe(1);
		}
	});

	it("fails on a nonzero exit and runs nothing after it", () => {
		const dir = root(
			new Map([
				["packages/fleet-authority/test/status/status-feed.test.ts", ""],
			]),
		);
		const exec = runner(passing, new Map([["pnpm run fleet:soak", 1]]));
		const result = runOutcome(spec("O20"), { root: dir, fallbacks: [], exec });
		expect(result.pass).toBe(false);
		expect(exec.ran).toEqual(["pnpm run fleet:soak"]);
	});

	it("fails an outcome whose threshold is not met, and passes when it is", () => {
		const soak = {
			duration_s: 600,
			callout_p99_ms: 120,
			first_claim_p95_ms: 900,
			events_expected: 40,
			events_recorded: 40,
			recovery_s: 31,
			new_connection_failures: 0,
			availability_expected: 20,
			availability_recorded: 20,
		};
		const files = (figures: Readonly<Record<string, number>>) =>
			new Map([
				["packages/fleet-authority/test/status/status-feed.test.ts", ""],
				["fleet-soak.json", JSON.stringify(figures)],
			]);
		const met = runOutcome(spec("O20"), {
			root: root(files(soak)),
			fallbacks: [],
			exec: runner(passing),
		});
		expect(met.pass).toBe(true);
		expect(met.measured).toMatchObject({ callout_p99_ms: 120, recovery_s: 31 });

		const slow = runOutcome(spec("O20"), {
			root: root(files({ ...soak, callout_p99_ms: 300 })),
			fallbacks: [],
			exec: runner(passing),
		});
		expect(slow.pass).toBe(false);
		expect(slow.evidence).toContain(
			"soak threshold not met: callout_p99_ms < 300",
		);

		const lost = runOutcome(spec("O20"), {
			root: root(files({ ...soak, events_recorded: 39 })),
			fallbacks: [],
			exec: runner(passing),
		});
		expect(lost.pass).toBe(false);

		const unwritten = runOutcome(spec("O20"), {
			root: root(
				new Map([
					["packages/fleet-authority/test/status/status-feed.test.ts", ""],
				]),
			),
			fallbacks: [],
			exec: runner(passing),
		});
		expect(unwritten.pass).toBe(false);
		expect(unwritten.evidence).toContain("fleet-soak.json was not written");
	});

	it("applies the fallback threshold only for an assumption listed in fleet-fallbacks.json", () => {
		const dir = root(
			new Map([
				["packages/connectivity/test/minters/minters.test.ts", ""],
				["packages/connectivity/test/minters/minters.pact.test.ts", ""],
			]),
		);
		const assertions: readonly Assertion[] = [
			...passing,
			{
				title: "[A13] tailscale minter honours the provider contract",
				status: "skipped",
			},
		];
		const without = runOutcome(spec("O45"), {
			root: dir,
			fallbacks: [],
			exec: runner(assertions),
		});
		expect(without.pass).toBe(false);
		expect(without.fallbacks).toEqual([]);

		const other = runOutcome(spec("O45"), {
			root: dir,
			fallbacks: ["A14"],
			exec: runner(assertions),
		});
		expect(other.pass).toBe(false);

		const listed = runOutcome(spec("O45"), {
			root: dir,
			fallbacks: ["A13", "A14"],
			exec: runner(assertions),
		});
		expect(listed.pass).toBe(true);
		expect(listed.fallbacks).toEqual(["A13"]);
		expect(listed.evidence[0]).toContain("fallback A13");

		const unprefixed = runOutcome(spec("O45"), {
			root: dir,
			fallbacks: ["A13"],
			exec: runner([...passing, { title: "a plain skip", status: "skipped" }]),
		});
		expect(unprefixed.pass).toBe(false);
	});

	it("does not pass an outcome checked at cutover or by the deferred lane", () => {
		const dir = root(new Map());
		for (const id of ["O21", "O23"]) {
			const exec = runner(passing);
			const result = runOutcome(spec(id), { root: dir, fallbacks: [], exec });
			expect(result.pass).toBe(false);
			expect(exec.ran).toEqual([]);
		}
	});

	it("reads the files a check names, and only from commands that name files", () => {
		expect(
			namedFiles(
				"pnpm exec vitest run packages/fleet/test/assignment packages/x/y.test.ts",
			),
		).toEqual(["packages/fleet/test/assignment", "packages/x/y.test.ts"]);
		expect(
			namedFiles(
				"pnpm run test:behavior -- features/fleet/enroll-and-run.feature",
			),
		).toEqual(["features/fleet/enroll-and-run.feature"]);
		expect(
			namedFiles("docker compose -f deploy/fleet/compose.ha.yml config -q"),
		).toEqual(["deploy/fleet/compose.ha.yml"]);
		expect(
			namedFiles(
				"test ! -d packages/ci/src/mesh && test ! -d packages/ci/src/fleet",
			),
		).toEqual([]);
		expect(namedFiles("pnpm exec turbo run test --filter @hobo/ci")).toEqual(
			[],
		);
	});

	it("reads fleet-fallbacks.json, and none when it is absent", () => {
		expect(readFallbacks(root(new Map()))).toEqual([]);
		expect(
			readFallbacks(root(new Map([["fleet-fallbacks.json", '["A13", "A8"]']]))),
		).toEqual(["A13", "A8"]);
	});
});

describe("fleet:outcome command", () => {
	function cli(...args: string[]) {
		return spawnSync(
			process.execPath,
			["--import", "tsx", join(repoRoot, "scripts/fleet-outcome.mts"), ...args],
			{ cwd: repoRoot, encoding: "utf8" },
		);
	}

	it("prints one verification object and exits 1 when a named file is missing", () => {
		const result = cli("--", "O6", `--root=${root(new Map())}`);
		expect(result.status).toBe(1);
		// SAFETY: the command's own single-line JSON output.
		const record = JSON.parse(result.stdout) as Record<string, string>;
		expect(Object.keys(record)).toEqual([
			"id",
			"pass",
			"command",
			"evidence",
			"measured",
			"fallbacks",
		]);
		expect(record).toMatchObject({ id: "O6", pass: false, fallbacks: [] });
	});

	it("exits 2 on an unknown outcome", () => {
		expect(cli("O99").status).toBe(2);
	});
});
