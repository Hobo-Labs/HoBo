/**
 * No test hands code a made-up path at the filesystem root.
 *
 * A test that wants "a directory that is not there" is tempted to write
 * `hoboHome: "/nonexistent/hobo-home"`. That is only a fixture when the code
 * under test reads or compares the path. A session store, an event journal and
 * a one-time-action store all create the directory they are given, so a run as
 * root (every CI container) makes `/nonexistent/...` on the machine itself and
 * leaves it there. Every later suite that uses `/nonexistent` to mean "missing"
 * (a PATH entry, a binary that must not resolve) then finds a directory.
 * Two shell suites once did this: `/nonexistent/hobo-home-for-*` held chats
 * and a current-session file on every host that had run them.
 *
 * The guard scans test sources rather than checking that `/nonexistent` is
 * absent after a run, for three reasons:
 *  - An ordinary user cannot create a directory at `/`, so the leak is invisible
 *    on a developer's machine and a runtime check would pass there. The scan
 *    fails the same way for every runner.
 *  - A runtime check reads the host. A directory left by an older run would
 *    fail a suite that did nothing wrong, and a new leak would be blamed on
 *    whichever package ran last.
 *  - Each package has its own vitest config, so a teardown would have to be
 *    wired into every one of them. This file runs once, in the root suite.
 *
 * The rule covers every name the tests use for a root that is not there:
 * `/nonexistent`, `/nowhere`, `/no/such`, `/definitely/not`, `/does-not-exist`
 * and `/missing`. A quoted string that opens with one is either replaced by a
 * directory the test makes under `tmpdir()` and removes afterwards, or listed in
 * `ALLOWANCES` with the line of source that shows the code never writes there.
 * The scan finds quoted literals, so a path built from pieces
 * (`join("/", "nonexistent")`) is not seen; that is a limit of the scan, not a
 * licence.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

/** An opening quote or backtick, one of the root names, then the rest of the path. */
const LITERAL =
	/["'`](\/(?:nonexistent|nowhere|no\/such|definitely\/not|does-not-exist|missing)[\w./-]*)/gu;

const TEST_FILE =
	/(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|__tests__)\/.+\.[cm]?[jt]sx?$)/u;

interface Allowance {
	/** Each literal the file holds, with how many times. */
	readonly literals: Readonly<Record<string, number>>;
	/** What the code does with the path, and the line that shows it. */
	readonly why: string;
}

interface Hit {
	readonly file: string;
	readonly line: number;
	readonly literal: string;
}

/** Every root-name literal in `text`, with its 1-based line. */
function literalsIn(text: string): readonly Pick<Hit, "line" | "literal">[] {
	return [...text.matchAll(LITERAL)].map((match) => ({
		line: text.slice(0, match.index).split("\n").length,
		literal: match[1] ?? "",
	}));
}

/** Tracked and not-yet-tracked test sources, outside vendored and built trees. */
function testFiles(): readonly string[] {
	const listed = spawnSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
	);
	expect(listed.status, listed.stderr).toBe(0);
	return listed.stdout
		.split("\0")
		.filter(
			(file) =>
				TEST_FILE.test(file) &&
				!file.startsWith("external/") &&
				!file
					.split("/")
					.some((part) => part === "node_modules" || part === "dist") &&
				file !== SELF &&
				existsSync(join(ROOT, file)),
		);
}

function hitsIn(file: string): readonly Hit[] {
	return literalsIn(readFileSync(join(ROOT, file), "utf8")).map((hit) => ({
		file,
		...hit,
	}));
}

/**
 * The literals that name no directory the code could create. Each entry says
 * what the code does with the path and cites the line that does it. Keyed by
 * file; the counts are exact, so one more literal in a file, or one that was
 * removed, fails below.
 */
const ALLOWANCES = {
	"packages/componentize/test/real-componentize.test.ts": {
		literals: { "/nowhere": 2 },
		why: "the toolchain probe fails first, so componentize rejects without opening sourceRoot (src/real-componentize.ts:137-142)",
	},
	"packages/connectivity/test/config-and-portless.test.ts": {
		literals: {
			"/nonexistent/from/env": 1,
			"/nonexistent/explicit/portless": 1,
			"/nonexistent/x": 1,
		},
		why: "binary paths the probe skips on existsSync or hands to a stub runVersion (src/local/portless.ts:58)",
	},
	"packages/hobo/test/claim-ceremony-verbs.test.ts": {
		literals: { "/nonexistent/elsewhere": 1 },
		why: "a decoy HOBO_HOME that is compared, never opened: ceremony() passes flags.home (test :150), so claim-ceremony.ts:71-72 takes it and defaultHoboHome(env) at :73 does not run",
	},
	"packages/hobo/test/derivative-descriptor-and-conformance.test.ts": {
		literals: { "/nonexistent": 1 },
		why: "the command returns HOBO_NO_RUNTIME (src/derivative-command.ts:354-358) before it reads flags.cwd or context.cwd (:382-385)",
	},
	"packages/hobo/test/local-substrates.test.ts": {
		literals: { "/definitely/not/here": 1 },
		why: "readText wraps readFileSync in a try that returns null (src/local-substrates.ts:209-214)",
	},
	"packages/hobo/test/serve-control-command.test.ts": {
		literals: { "/nonexistent/elsewhere": 1, "/nonexistent/env": 1 },
		why: "decoy home sources that are compared, never opened: serve() always passes hoboHome (test :68), so `deps.hoboHome ??` at src/serve-control-command.ts:45 short-circuits before flags.home and env",
	},
	"packages/hobo/test/station-command.test.ts": {
		literals: { "/nonexistent/elsewhere": 1 },
		why: "a decoy HOBO_HOME that is compared, never opened: run() always passes hoboHome (test :59), so `deps.hoboHome ??` at src/station-command.ts:43 short-circuits before deps.env",
	},
	"packages/iac/iac-crossplane/test/kubectl-cluster.test.ts": {
		literals: { "/nonexistent/kubectl": 2 },
		why: "an executable handed to execFileSync, which must fail to launch (src/kubectl-cluster.ts:72)",
	},
	"packages/iac/iac-pulumi/test/pulumi-automation-api-engine.test.ts": {
		literals: { "/nonexistent": 1 },
		why: "a PATH value so the engine binary cannot be found; the engine reports PULUMI_CLI_MISSING (src/pulumi-automation-api-engine.ts:175)",
	},
	"packages/iac/iac-terraform/test/terraform-cli-engine.test.ts": {
		literals: { "/nonexistent/hcl-binary": 1 },
		why: "an executable handed to execFileSync, which must fail to launch (src/terraform-cli-engine.ts:287)",
	},
	"packages/management/test/projections.test.ts": {
		literals: { "/nowhere": 1 },
		why: "projections.ts never reads ctx.hoboHome; resolveDefaultStationId reaches it only to existsSync and read profile.json (src/context.ts:66-71, 198-205), and the write paths (context.ts:171-181, station-ops.ts:57) are not imported by the test",
	},
	"packages/patterns/test/render-compose-codec.test.ts": {
		literals: { "/nowhere": 1 },
		why: "a catalog root that composePatterns does not open; walkNamed only existsSync-checks and reads (src/catalog.ts:16-20)",
	},
	"packages/patterns/test/sqlite-index-search.test.ts": {
		literals: { "/definitely/not/here.sqlite": 2 },
		why: "openPatternIndex only existsSync-checks the path, then builds an in-memory index (src/sqlite-index.ts:371-379)",
	},
	"packages/rift/test/registry-recovery.test.ts": {
		literals: { "/nowhere": 1 },
		why: "a workspace record's path that rebuildRegistry only existsSync-checks to drop it (src/workspace.ts:196)",
	},
	"packages/runtimes/runtime-oci/test/kubectl-transport.test.ts": {
		literals: { "/nonexistent/kubectl": 1 },
		why: "an executable handed to spawnSync, which must fail to launch (src/kubectl-transport.ts:93)",
	},
	"packages/runtimes/runtime-oci/test/kubernetes-client-surface.test.ts": {
		literals: { "/missing": 1 },
		why: "an HTTP request path on a stubbed transport, never a file",
	},
	"packages/schema-tools/test/discover.test.ts": {
		literals: { "/nonexistent-root": 1, "/nonexistent-root/packages": 1 },
		why: "roots for a read-only walk that returns [] when packagesRoot is absent (src/discover.ts:34)",
	},
	"scripts/test/bootstrap-siblings.test.ts": {
		literals: { "/nonexistent-dir": 1 },
		why: "a --reference the script refuses with a usage error before it runs anything (scripts/bootstrap-siblings.mts:126-134)",
	},
	"packages/adapters/adapter-opensesame/test/child-env.test.ts": {
		literals: { "/nowhere": 1 },
		why: "a PATH entry reduced by trustedPath against the in-memory memoryTrust nodes (src/child-env.ts:157, src/trust.ts:201); no real filesystem is touched",
	},
	"packages/adapters/adapter-opensesame/test/fixtures/fake-opensesame.mts": {
		literals: { "/nonexistent/run-ca.pem": 1 },
		why: "an SSL_CERT_FILE value the fake tool only assigns into the spawned child's env (test/fixtures/fake-opensesame.mts:124); nothing opens or creates it",
	},
	"packages/adapters/adapter-opensesame/test/launch.test.ts": {
		literals: { "/nowhere/parse.mjs": 1 },
		why: "an OPENSESAME_ENV_PARSE bridge path checkBridge refuses through the trust probe before anything starts (src/bridge.ts:51-66)",
	},
	"packages/adapters/adapter-opensesame/test/real-kit.test.ts": {
		literals: { "/nowhere": 2 },
		why: "a cwd the trust rule only realpath-compares as a prefix to keep kits outside the working directory (src/trust.ts:100-103); resolveKit stats the mkdtemp kit dir, never the cwd",
	},
	"packages/adapters/adapter-opensesame/test/trust.test.ts": {
		literals: { "/nowhere": 3 },
		why: "PATH entries filtered by trustedPath against the in-memory memoryTrust nodes (src/trust.ts:201, test/support/trust-fs.ts); no real filesystem is touched",
	},
} satisfies Readonly<Record<string, Allowance>>;

const ALLOWED: ReadonlyMap<string, Allowance> = new Map(
	Object.entries(ALLOWANCES),
);

/** What the scan finds that `ALLOWANCES` do not cover, and what they name that is gone. */
function audit(hits: readonly Hit[]) {
	const offenders: string[] = [];
	const stale: string[] = [];
	const files = new Set([...hits.map((hit) => hit.file), ...ALLOWED.keys()]);
	for (const file of [...files].sort()) {
		const unused = new Map(Object.entries(ALLOWED.get(file)?.literals ?? {}));
		for (const hit of hits.filter((entry) => entry.file === file)) {
			const left = unused.get(hit.literal) ?? 0;
			if (left === 0) offenders.push(`${file}:${hit.line}  ${hit.literal}`);
			else unused.set(hit.literal, left - 1);
		}
		for (const [literal, left] of unused) {
			if (left > 0) stale.push(`${file}  ${literal} x${left}`);
		}
	}
	return { offenders, stale };
}

describe("fixture paths at the filesystem root", () => {
	const files = testFiles();
	const found = audit(files.flatMap(hitsIn));

	it("no test names a made-up root the code could create", () => {
		expect(
			found.offenders,
			[
				"A test hands code a path under /nonexistent, /nowhere, /no/such, /definitely/not, /does-not-exist or /missing.",
				"A run as root creates it on the host.",
				"Make a directory with mkdtempSync(join(tmpdir(), ...)) in beforeAll and remove it in afterAll,",
				"or add the literal to ALLOWANCES in test/fixture-paths-at-root.test.ts with the line that shows the code never writes there.",
			].join("\n"),
		).toEqual([]);
	});

	it("lists only literals the tests still hold", () => {
		expect(
			found.stale,
			"These ALLOWANCES no longer match a literal in their file; remove them.",
		).toEqual([]);
	});

	it("scans the package suites, so an empty scan cannot pass", () => {
		expect(files.length).toBeGreaterThan(500);
		expect(files).toContain("packages/hobo/test/station-command.test.ts");
		expect(files).toContain(
			"packages/patterns/test/render-compose-codec.test.ts",
		);
		expect(files).toContain("packages/schema-tools/test/discover.test.ts");
	});
});

describe("the literal scan", () => {
	it("finds a path in each quoting form, with its line", () => {
		const text = [
			`const a = { hoboHome: "/nonexistent/hobo-home" };`,
			`const b = { cwd: '/nowhere' };`,
			"const c = { home: `/nonexistent/${name}` };",
		].join("\n");
		expect(literalsIn(text)).toEqual([
			{ line: 1, literal: "/nonexistent/hobo-home" },
			{ line: 2, literal: "/nowhere" },
			{ line: 3, literal: "/nonexistent/" },
		]);
	});

	it("finds every root name the tests use", () => {
		const text = [
			`"/nonexistent-root/packages"`,
			`"/nowhere/at/all"`,
			`"/no/such/bin"`,
			`"/definitely/not/here.sqlite"`,
			`"/does-not-exist/x"`,
			`"/missing"`,
		].join("\n");
		expect(literalsIn(text).map((hit) => hit.literal)).toEqual([
			"/nonexistent-root/packages",
			"/nowhere/at/all",
			"/no/such/bin",
			"/definitely/not/here.sqlite",
			"/does-not-exist/x",
			"/missing",
		]);
	});

	it("ignores a word that only contains a name, or a path that is not at the root", () => {
		const text = [
			`const a = "station:nonexistent";`,
			`const b = path.join(root, "nonexistent");`,
			`const c = "/tmp/nonexistent";`,
			`const d = join(root, "does-not-exist");`,
			`const e = "/home/nowhere/else";`,
		].join("\n");
		expect(literalsIn(text)).toEqual([]);
	});

	it("reports a literal the allowances do not cover, an extra copy of one they do, and an allowance with no literal", () => {
		const file =
			"packages/hobo/test/derivative-descriptor-and-conformance.test.ts";
		const { offenders, stale } = audit([
			{
				file: "packages/hobo/test/unlisted.test.ts",
				line: 7,
				literal: "/nowhere",
			},
			{ file, line: 3, literal: "/nonexistent" },
			{ file, line: 9, literal: "/nonexistent" },
			{ file, line: 12, literal: "/nonexistent/other" },
		]);
		expect(offenders).toEqual([
			`${file}:9  /nonexistent`,
			`${file}:12  /nonexistent/other`,
			"packages/hobo/test/unlisted.test.ts:7  /nowhere",
		]);
		expect(stale).toContain(
			"packages/management/test/projections.test.ts  /nowhere x1",
		);
		expect(stale).not.toContain(`${file}  /nonexistent x1`);
	});
});
