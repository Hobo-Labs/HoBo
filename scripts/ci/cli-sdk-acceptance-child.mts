import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type CommandRunner = {
	run(args: string[], options: { cwd: string }): Promise<CommandResult>;
};
type BudgetRuntime = {
	defaultHostingBudgetId: string;
	hostingPlanBinding: () => Promise<Record<string, never>>;
	hostingBudgetAuthority: {
		persistence: string;
		resolve: () => Promise<{
			budget: { tenantId: string; budgetId: string };
			budgetPolicy: Record<string, never>;
		}>;
	};
};
type CliApi = {
	parseArgv(args: string[]): void;
	CliError: new (...args: string[]) => Error;
	CANONICAL_VERBS: readonly string[];
	runHobo(args: string[], options: { cwd: string }): Promise<CommandResult>;
	createHoboCli(): CommandRunner;
	planHostingAuthoritatively(
		runtime: BudgetRuntime,
		bindle: { value: Record<string, never> },
		options: { deploymentId: string; session: { tenant: string } },
	): Promise<{ ok: boolean; remediations: { code: string }[] }>;
};
type ArgvApi = Pick<CliApi, "parseArgv" | "CANONICAL_VERBS">;
type CoreApi = {
	parseBudgetPolicy(value: Record<string, never>): void;
	BudgetPolicyError: new (...args: string[]) => Error;
};

const core: CoreApi = await import(["@hobo-labs", "core"].join("/"));
const cli: CliApi = await import(["@hobo-labs", "cli"].join("/"));
const argv: ArgvApi = await import(["@hobo-labs", "cli", "argv"].join("/"));

const workspace = process.argv[2];
if (!workspace) throw new Error("Workspace path is required");
const baseline: CliApi = await import(
	pathToFileURL(join(workspace, "packages/cli/dist/index.js")).href
);
const baselineArgv: ArgvApi = await import(
	pathToFileURL(join(workspace, "packages/cli/dist/argv.js")).href
);
const {
	writeFixtureProject,
}: {
	writeFixtureProject(root: string): Promise<void>;
} = await import(
	pathToFileURL(join(workspace, "packages/cli/dist/codegen/fixture.js")).href
);

assert.deepEqual(Object.keys(cli).sort(), Object.keys(baseline).sort());
assert.deepEqual(Object.keys(argv).sort(), Object.keys(baselineArgv).sort());
assert.equal(cli.parseArgv, argv.parseArgv);
assert.equal(cli.CANONICAL_VERBS, argv.CANONICAL_VERBS);
assert.deepEqual(argv.CANONICAL_VERBS, baselineArgv.CANONICAL_VERBS);
assert.throws(() => argv.parseArgv(["up", "--bad"]), cli.CliError);
assert.throws(() => core.parseBudgetPolicy({}), core.BudgetPolicyError);

const scratch = await mkdtemp(join(tmpdir(), "hobo-cli-acceptance-"));
async function fileBytes(root: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) await walk(file);
			else if (entry.isFile())
				files.set(
					relative(root, file),
					(await readFile(file)).toString("base64"),
				);
			else throw new Error(`Unexpected generated file: ${file}`);
		}
	}
	await walk(root);
	return files;
}
try {
	for (const args of [
		["--help"],
		["plan", "--help"],
		["plann"],
		["plan", "--wat"],
	]) {
		const before = await baseline.runHobo(args, { cwd: scratch });
		const after = await cli.runHobo(args, { cwd: scratch });
		assert.deepEqual(
			{ exitCode: after.exitCode, stdout: after.stdout, stderr: after.stderr },
			{
				exitCode: before.exitCode,
				stdout: before.stdout,
				stderr: before.stderr,
			},
		);
	}
	for (const template of ["todo", "api", "agent", "fullstack"]) {
		const before = join(scratch, `before-${template}`);
		const after = join(scratch, `after-${template}`);
		await mkdir(before);
		await mkdir(after);
		const args = ["new", "proof-app", "-t", template, "--json"];
		assert.equal((await baseline.runHobo(args, { cwd: before })).exitCode, 0);
		assert.equal((await cli.runHobo(args, { cwd: after })).exitCode, 0);
		assert.deepEqual(
			await fileBytes(join(after, "proof-app")),
			await fileBytes(join(before, "proof-app")),
		);
	}
	const before = join(scratch, "codegen-before");
	const after = join(scratch, "codegen-after");
	await mkdir(before);
	await mkdir(after);
	await writeFixtureProject(before);
	await writeFixtureProject(after);
	for (const args of [
		["codegen", "--json"],
		["codegen", "--check", "--json"],
	]) {
		const a = await baseline.createHoboCli().run(args, { cwd: before });
		const b = await cli.createHoboCli().run(args, { cwd: after });
		assert.equal(a.exitCode, 0);
		assert.equal(b.exitCode, 0);
		assert.equal(
			a.stdout.replaceAll(before, "<root>"),
			b.stdout.replaceAll(after, "<root>"),
		);
	}
	assert.deepEqual(await fileBytes(before), await fileBytes(after));
	const bad = 'export function* rankFeed() { "use training"; yield 1; }\n';
	await writeFile(join(before, "src/rank.ts"), bad);
	await writeFile(join(after, "src/rank.ts"), bad);
	const a = await baseline
		.createHoboCli()
		.run(["codegen", "--json"], { cwd: before });
	const b = await cli
		.createHoboCli()
		.run(["codegen", "--json"], { cwd: after });
	assert.equal(a.exitCode, 1);
	assert.equal(b.exitCode, 1);
	assert.equal(
		a.stdout.replaceAll(before, "<root>"),
		b.stdout.replaceAll(after, "<root>"),
	);
	const runtime = {
		defaultHostingBudgetId: "hosting",
		hostingPlanBinding: async () => ({}),
		hostingBudgetAuthority: {
			persistence: "durable-cas",
			resolve: async () => ({
				budget: { tenantId: "tenant", budgetId: "hosting" },
				budgetPolicy: {},
			}),
		},
	};
	const plan = await cli.planHostingAuthoritatively(
		runtime,
		{ value: {} },
		{ deploymentId: "one", session: { tenant: "tenant" } },
	);
	assert.equal(plan.ok, false);
	assert.equal(plan.remediations.at(0)?.code, "budget.policy.invalid");
	console.log(
		"CLI exports, identity, help, scaffold bytes, codegen and error handling verified",
	);
} finally {
	await rm(scratch, { recursive: true, force: true });
}
