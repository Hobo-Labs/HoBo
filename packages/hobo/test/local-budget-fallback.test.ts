import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv } from "@hobo/cli";
import fc from "fast-check";
import { expect, it } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { createBrokerAwareUpCommand } from "../src/broker-up-command.js";

interface BudgetRuntimeFixture {
	hostingBudgetRequired: boolean;
	defaultHostingBudgetId?: string;
}

async function withUncollectableBindle(
	run: (cwd: string, hoboHome: string) => Promise<void>,
) {
	const cwd = await mkdtemp(join(tmpdir(), "hobo-budget-fallback-"));
	const hoboHome = join(cwd, "home");
	try {
		await mkdir(join(cwd, "src"));
		// The loader accepts this Bindle, but collection refuses the missing edge.
		await writeFile(
			join(cwd, "src/bindle.mjs"),
			`export default {name:'sample', resources:{web:{name:'web',kind:'web',stableId:'web:web',annotations:[],dependsOn:[],declaredAllow:[]}},edges:[{from:'web',to:'missing'}],requirements:{require:[],prefer:[],runtimes:[],labels:{}},entrypoint:()=>undefined};`,
		);
		initBareMetalYard({ hoboHome, componentHost: "local" });
		await run(cwd, hoboHome);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function request(
	cwd: string,
	hoboHome: string,
	preview = false,
	budget = false,
) {
	const args = ["up", "--home", hoboHome];
	if (preview) args.push("--what-if");
	if (budget) args.push("--budget-id", "requested-budget");
	const parsed = parseArgv(args, { cwd });
	return {
		context: {
			cwd,
			projectDir: cwd,
			identity: null,
			clients: { readApi: "local", runtime: "local" },
		},
		flags: { ...parsed.flags },
		args: parsed.args,
		verb: "up",
		emitProgress: (_message: string) => {},
	};
}

function command(runtime: BudgetRuntimeFixture, onStart: () => never) {
	return createBrokerAwareUpCommand({
		// SAFETY: collection returns a stub before the Yard reads any other runtime fields.
		runtime: runtime as never,
		env: {},
		persistentLocal: true,
		startLocalDeployment: async () => onStart(),
	});
}

it("refuses budget-required local fallback when the Yard returns a stub", async () => {
	await withUncollectableBindle(async (cwd, hoboHome) => {
		let starts = 0;
		const result = await command({ hostingBudgetRequired: true }, () => {
			starts++;
			throw new Error("local start reached");
		}).run(request(cwd, hoboHome));
		expect(result.code).toBe("HOBO_HOSTING_AUTHORITY_REQUIRED");
		expect(starts).toBe(0);
	});
}, 300_000);

it("keeps all budget sources from falling through to a stub preview or local start", async () => {
	await withUncollectableBindle(async (cwd, hoboHome) => {
		const check = async (
			required: boolean,
			defaultBudget: boolean,
			flagBudget: boolean,
			preview: boolean,
		) => {
			let starts = 0;
			const runtime: BudgetRuntimeFixture = { hostingBudgetRequired: required };
			if (defaultBudget) runtime.defaultHostingBudgetId = "default-budget";
			const result = await command(runtime, () => {
				starts++;
				throw new Error("local start reached");
			}).run(request(cwd, hoboHome, preview, flagBudget));
			if (required || defaultBudget || flagBudget) {
				expect(result.code).toBe("HOBO_HOSTING_AUTHORITY_REQUIRED");
				expect(starts).toBe(0);
			} else if (preview) {
				expect(result.code).toBe("HOBO_OK");
				expect(starts).toBe(0);
			} else {
				expect(result.code).toBe("HOBO_UP_FAILED");
				expect(starts).toBe(1);
			}
		};
		await check(false, false, false, false);
		await check(false, false, false, true);
		await check(true, false, false, false);
		await check(true, false, false, true);
		await fc.assert(
			fc.asyncProperty(
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				check,
			),
			{ seed: 614532, numRuns: 32 },
		);
	});
}, 300_000);

it.each([
	"runtime-required",
	"default-budget",
	"flag-budget",
])("refuses when %s appears during local placement", async (source) => {
	await withUncollectableBindle(async (cwd, hoboHome) => {
		let starts = 0;
		let changed = false;
		const runtime: BudgetRuntimeFixture = { hostingBudgetRequired: false };
		const input = request(cwd, hoboHome);
		input.emitProgress = (message: string) => {
			if (!message.includes("yard-first placement")) return;
			changed = true;
			if (source === "runtime-required") runtime.hostingBudgetRequired = true;
			if (source === "default-budget")
				runtime.defaultHostingBudgetId = "default-budget";
			if (source === "flag-budget") input.flags.budgetId = "requested-budget";
		};
		const result = await command(runtime, () => {
			starts++;
			throw new Error("local start reached");
		}).run(input);
		expect(changed).toBe(true);
		expect(result.code).toBe("HOBO_HOSTING_AUTHORITY_REQUIRED");
		expect(starts).toBe(0);
	});
}, 300_000);
