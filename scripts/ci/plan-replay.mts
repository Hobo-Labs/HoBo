/**
 * Replays the dependent-test planner over recent main commits and prints how
 * much each plan runs: one line per commit and a total of whole suites and
 * subsets.
 *
 * Each commit is planned the way CI plans it: its changed paths are
 * `git diff --name-only PARENT COMMIT`, and the root package.json and
 * turbo.json are read at the parent and the commit, as `--base=PARENT` would.
 * Every plan reads the checkout's tree, so the counts compare planners over
 * the same files.
 *
 * `--before=REF` also plans each commit with the planner as it was at REF and
 * prints both. `--check` replays a second import graph, read from the syntax
 * tree by `scripts/lib/test-import-specifiers.mts` and independent of the
 * planner's own edges: every test file whose static or dynamic imports, or its
 * package's vitest config, reach a changed file must be in the plan. An import
 * of a workspace package by name also reaches that package's `package.json`
 * and `tsconfig.json`. The graph holds nothing else: a path literal, a
 * directory or data file a test reads, a spawned program and a tsconfig a
 * script names are edges of the planner that `--check` does not check. A test
 * missing from either plan is printed; the exit status is 1 when the current
 * planner misses one, whatever the planner at `--before` missed.
 *
 * CLI: `node --import tsx scripts/ci/plan-replay.mts [--count=100] [--ref=origin/main] [--before=REF] [--check]`
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { importSpecifiersOf } from "../lib/test-import-specifiers.mts";
import type { ReadRootFile } from "./affected-lanes.mts";
import {
	exportTarget,
	planDependentTests,
	type Repo,
	readRepo,
	type TestPlan,
} from "./dependent-tests.mts";

type Planner = typeof planDependentTests;

const git = (...args: string[]) =>
	execFileSync("git", args, {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
	});

const show = (ref: string, path: string) => {
	try {
		return git("show", `${ref}:${path}`);
	} catch {
		return undefined;
	}
};

/** The planner as it was at `ref`, its sibling imports pointed at this checkout. */
async function plannerAt(ref: string): Promise<Planner> {
	const source = show(ref, "scripts/ci/dependent-tests.mts");
	if (source === undefined) throw new Error(`no planner at ${ref}`);
	const here = new URL(".", import.meta.url);
	const rewritten = source.replace(
		/(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
		(_, open: string, specifier: string, close: string) =>
			`${open}${new URL(specifier, here).href}${close}`,
	);
	const dir = mkdtempSync(join(tmpdir(), "plan-replay-"));
	try {
		const file = join(dir, "dependent-tests.mts");
		writeFileSync(file, rewritten);
		const loaded: { planDependentTests: Planner } = await import(
			pathToFileURL(file).href
		);
		return loaded.planDependentTests;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const VITEST_CONFIGS = ["ts", "mts", "js", "mjs"].map(
	(extension) => `vitest.config.${extension}`,
);

/** Test file → owning package, and file → the files that import it. */
export function importGraph(repo: Repo) {
	const byDepth = [...repo.workspaces].sort(
		(a, b) => b.dir.length - a.dir.length,
	);
	const ownerOf = (path: string) =>
		byDepth.find((ws) => path.startsWith(`${ws.dir}/`));
	const byName = new Map(repo.workspaces.map((ws) => [ws.name, ws]));
	const manifests = new Map<string, Parameters<typeof exportTarget>[0]>();
	const manifestOf = (dir: string) => {
		if (!manifests.has(dir))
			manifests.set(dir, JSON.parse(repo.read(`${dir}/package.json`) ?? "{}"));
		return manifests.get(dir) ?? {};
	};
	const resolveFile = (path: string): string | undefined => {
		const owner = ownerOf(path);
		const bases = [path];
		if (owner && path.startsWith(`${owner.dir}/dist/`))
			bases.push(`${owner.dir}/src/${path.slice(owner.dir.length + 6)}`);
		for (const base of bases) {
			const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
			for (const candidate of [
				base,
				...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"].map(
					(extension) => `${stem}${extension}`,
				),
				`${base}/index.ts`,
				`${base}/index.js`,
			])
				if (repo.files.has(candidate)) return candidate;
		}
		return undefined;
	};
	const importers = new Map<string, Set<string>>();
	const link = (from: string, to: string | undefined) => {
		if (to === undefined) return;
		const set = importers.get(to) ?? new Set<string>();
		set.add(from);
		importers.set(to, set);
	};
	for (const file of repo.files) {
		if (!CODE.test(file) || /(?:^|\/)(?:node_modules|dist)\//.test(file))
			continue;
		const source = repo.read(file);
		if (source === undefined) continue;
		let specifiers: string[];
		try {
			specifiers = importSpecifiersOf(source, file).map((i) => i.specifier);
		} catch {
			continue;
		}
		for (const specifier of specifiers) {
			if (specifier.startsWith(".")) {
				link(
					file,
					resolveFile(
						posix.normalize(posix.join(posix.dirname(file), specifier)),
					),
				);
				continue;
			}
			const parts = specifier.split("/");
			const name = specifier.startsWith("@")
				? parts.slice(0, 2).join("/")
				: (parts[0] ?? "");
			const ws = byName.get(name);
			if (!ws) continue;
			// What the importer gets is also made by the package's manifest and
			// the tsconfig it builds with.
			for (const input of ["package.json", "tsconfig.json"])
				if (repo.files.has(`${ws.dir}/${input}`))
					link(file, `${ws.dir}/${input}`);
			const entry = exportTarget(
				manifestOf(ws.dir),
				`.${specifier.slice(name.length)}`,
			);
			if (entry !== undefined)
				link(file, resolveFile(posix.normalize(posix.join(ws.dir, entry))));
		}
	}
	// A test runs under its package's vitest config: the config's closure is
	// part of every test's.
	const tests = new Map<string, string>();
	for (const file of repo.files) {
		const owner = ownerOf(file);
		if (
			!owner ||
			!TEST_FILE.test(file) ||
			/(?:^|\/)(?:node_modules|dist)\//.test(file)
		)
			continue;
		tests.set(file, owner.dir);
		for (const name of VITEST_CONFIGS)
			if (repo.files.has(`${owner.dir}/${name}`))
				link(file, `${owner.dir}/${name}`);
	}
	/** Every test whose imports reach one of `changed`. */
	const reachedTests = (changed: readonly string[]) => {
		const seen = new Set<string>(changed);
		const queue = [...changed];
		for (let file = queue.shift(); file !== undefined; file = queue.shift())
			for (const importer of importers.get(file) ?? [])
				if (!seen.has(importer)) {
					seen.add(importer);
					queue.push(importer);
				}
		return [...seen].filter((file) => tests.has(file));
	};
	return { tests, reachedTests };
}

/** Tests of `reached` the plan does not run. */
export function missed(
	plan: TestPlan,
	reached: readonly string[],
	tests: ReadonlyMap<string, string>,
): string[] {
	if (plan.mode === "all") return [];
	const full = new Set(plan.full);
	return reached.filter((file) => {
		const dir = tests.get(file) ?? "";
		return (
			!full.has(dir) &&
			!(plan.subsets.get(dir) ?? []).includes(file.slice(dir.length + 1))
		);
	});
}

/** The planner under test is `after`; `before` is only what it is compared with. */
const CURRENT = "after";

/** Whether the replay fails: the current planner missed a test. */
export function replayFailed(
	totals: ReadonlyMap<string, { readonly misses: number }>,
): boolean {
	return (totals.get(CURRENT)?.misses ?? 0) > 0;
}

const size = (plan: TestPlan) =>
	plan.mode === "all"
		? { all: 1, whole: 0, subsets: 0 }
		: { all: 0, whole: plan.full.length, subsets: plan.subsets.size };

const describe = (plan: TestPlan) =>
	plan.mode === "all"
		? `all (${plan.reason})`
		: `${plan.full.length} whole, ${plan.subsets.size} subset(s)`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const option = (name: string) =>
		process.argv
			.find((arg) => arg.startsWith(`--${name}=`))
			?.slice(name.length + 3);
	const count = Number(option("count") ?? "100");
	const ref = option("ref") ?? "origin/main";
	const beforeRef = option("before");
	const check = process.argv.includes("--check");
	const planners: [string, Planner][] = [[CURRENT, planDependentTests]];
	if (beforeRef !== undefined)
		planners.unshift(["before", await plannerAt(beforeRef)]);
	const repo = readRepo();
	const graph = check ? importGraph(repo) : undefined;
	const totals = new Map(
		planners.map(([label]) => [
			label,
			{ all: 0, whole: 0, subsets: 0, misses: 0 },
		]),
	);
	const commits = git("rev-list", "--first-parent", `--max-count=${count}`, ref)
		.split("\n")
		.filter((sha) => sha !== "");
	for (const commit of commits) {
		const parent = `${commit}^`;
		let changed: string[];
		try {
			changed = git("diff", "--name-only", parent, commit).split("\n");
		} catch {
			continue;
		}
		const readRoot: ReadRootFile = (path, side) =>
			show(side === "base" ? parent : commit, path);
		const reached = graph?.reachedTests(
			changed.filter((path) => repo.files.has(path)),
		);
		const columns: string[] = [];
		for (const [label, plan] of planners) {
			const result = plan(changed, repo, readRoot);
			const total = totals.get(label);
			if (!total) continue;
			const counted = size(result);
			total.all += counted.all;
			total.whole += counted.whole;
			total.subsets += counted.subsets;
			columns.push(`${label}: ${describe(result)}`);
			if (graph && reached) {
				const miss = missed(result, reached, graph.tests);
				total.misses += miss.length;
				for (const file of miss) columns.push(`${label} MISSES ${file}`);
			}
		}
		console.log(`${commit.slice(0, 8)}  ${columns.join("  |  ")}`);
	}
	for (const [label, total] of totals)
		console.log(
			`${label}: ${commits.length} commits, ${total.all} whole-workspace, ${total.whole} whole suites, ${total.subsets} subsets${graph ? `, ${total.misses} missed tests` : ""}`,
		);
	if (replayFailed(totals)) process.exitCode = 1;
}
