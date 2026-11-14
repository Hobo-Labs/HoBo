import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	createRegistryFromProviders,
	type IacProgram,
	type IacProvider,
} from "@hobo/cloud";
import { createInMemoryActorHost } from "@hobo/data";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createDownCommand,
	createHoboCli,
	createLifecycleFamilyCommand,
	createPlanCommand,
	createUpCommand,
	type LifecycleFamilySpec,
	parseLifecycleArgs,
	resolveFamilyProject,
	type YardRuntime,
} from "../src/index.js";
import { isJsonObject, parseJsonObject } from "../src/json.js";

// Normalized lifecycles: `hobo cd up|down|plan|status` is the same engine as
// `hobo up|down|plan`, pointed at the family's own project. Idempotent re-run,
// what-if, and down-then-up all hold through the family surface.

const BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions", "assets"],
		},
		sessions: { type: "data.v1", port: "kv" },
		assets: { type: "data.v1", port: "objectStore" },
	},
};

let stores: RuntimeLocalEventStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const store of stores) store.close();
	stores = [];
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

interface Recording extends IacProvider {
	readonly calls: string[];
}

function recordingIac(): Recording {
	const calls: string[] = [];
	return {
		id: "mock-local-container",
		calls,
		async preview(program: IacProgram) {
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program: IacProgram) {
			calls.push(`apply:${program.resourceId}`);
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy(program: IacProgram) {
			calls.push(`destroy:${program.resourceId}`);
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
}

function runtimeWith(iac: IacProvider): YardRuntime {
	const store = createRuntimeLocalEventStore({
		dataDir: path.join(
			tmpdir(),
			`hobo-family-${Math.random().toString(36).slice(2)}`,
		),
		clock: createManualClock(),
	});
	stores.push(store);
	return {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac }),
		broker: createInProcessCredentialBroker(),
		registry: createRegistryFromProviders([createCloudflareProvider()]),
	};
}

async function project(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-family-project-"));
	dirs.push(dir);
	await writeFile(path.join(dir, "hobo.bindle.json"), JSON.stringify(BINDLE));
	return dir;
}

function familyCli(
	runtime: YardRuntime,
	projectDir: string,
	prepare?: LifecycleFamilySpec["prepare"],
) {
	return createHoboCli({
		commands: {
			cd: createLifecycleFamilyCommand({
				family: "cd",
				resolveProject: (input, flags) =>
					resolveFamilyProject({
						family: "cd",
						flags,
						cwd: input.context.cwd,
						env: {},
						bundled: projectDir,
					}),
				up: createUpCommand({ runtime }),
				down: createDownCommand({ runtime }),
				plan: createPlanCommand({ runtime }),
				...(prepare !== undefined ? { prepare } : undefined),
			}),
		},
	});
}

async function run(cli: ReturnType<typeof createHoboCli>, args: string[]) {
	const result = await cli.run([...args, "--json"], { cwd: tmpdir() });
	return {
		exitCode: result.exitCode,
		envelope: parseJsonObject(result.stdout),
	};
}

function dataOf(envelope: ReturnType<typeof parseJsonObject>) {
	const data = envelope.data;
	if (!isJsonObject(data)) throw new Error("envelope has no data");
	return data;
}

describe("parseLifecycleArgs", () => {
	it("accepts the shared nomenclature and refuses anything else", () => {
		const parsed = parseLifecycleArgs(["--dry-run", "--mode=complete", "-y"]);
		expect(parsed).toEqual({
			ok: true,
			flags: { whatIf: true, mode: "complete", project: null, yes: true },
		});
		expect(parseLifecycleArgs(["--preview"]).ok).toBe(true);
		expect(parseLifecycleArgs(["--mode", "replace"]).ok).toBe(false);
		expect(parseLifecycleArgs(["--force"]).ok).toBe(false);
	});
});

describe("hobo <family> lifecycle", () => {
	it("converges, is idempotent on re-run, and re-creates after down", async () => {
		const iac = recordingIac();
		const cli = familyCli(runtimeWith(iac), await project());

		const status = await run(cli, ["cd", "status"]);
		expect(status.exitCode).toBe(0);
		const changes = dataOf(status.envelope).changes;
		expect(JSON.stringify(changes)).toContain('"create":3');
		expect(iac.calls).toEqual([]);

		const up = await run(cli, ["cd", "up"]);
		expect(up.exitCode).toBe(0);
		expect(String(up.envelope.message)).toMatch(/^hobo cd up deployed/);
		expect(dataOf(up.envelope).family).toBe("cd");
		const applied = iac.calls.length;
		expect(applied).toBe(3);

		// Idempotent deployment: same declaration, no provider call.
		const again = await run(cli, ["cd", "up"]);
		expect(again.exitCode).toBe(0);
		expect(iac.calls.length).toBe(applied);

		const whatIf = await run(cli, ["cd", "up", "--what-if"]);
		expect(JSON.stringify(dataOf(whatIf.envelope).changes)).toContain(
			'"converged":true',
		);

		const downWhatIf = await run(cli, ["cd", "down", "--dry-run"]);
		expect(dataOf(downWhatIf.envelope).wouldDestroy).toHaveLength(3);
		expect(iac.calls.length).toBe(applied);

		const down = await run(cli, ["cd", "down"]);
		expect(down.exitCode).toBe(0);
		expect(iac.calls.filter((c) => c.startsWith("destroy:"))).toHaveLength(3);

		// The project can create itself again after destroying itself.
		const recreated = await run(cli, ["cd", "up"]);
		expect(recreated.exitCode).toBe(0);
		expect(iac.calls.filter((c) => c.startsWith("apply:"))).toHaveLength(6);
	});

	it("runs prepare before up and stops when it refuses", async () => {
		const iac = recordingIac();
		const cli = familyCli(runtimeWith(iac), await project(), async () => ({
			kind: "refused",
			result: {
				ok: false,
				status: "needs-connection",
				code: "HOBO_CONNECTION_REQUIRED",
				message: "connect the provider first",
			},
		}));
		const up = await run(cli, ["cd", "up"]);
		expect(up.exitCode).not.toBe(0);
		expect(up.envelope.code).toBe("HOBO_CONNECTION_REQUIRED");
		expect(iac.calls).toEqual([]);
	});

	it("reports prepared steps beside the converged result", async () => {
		const cli = familyCli(
			runtimeWith(recordingIac()),
			await project(),
			async () => ({
				kind: "ready",
				steps: [
					{ id: "vercel", outcome: "unchanged", detail: "already connected" },
				],
			}),
		);
		const up = await run(cli, ["cd", "up"]);
		expect(up.exitCode).toBe(0);
		expect(JSON.stringify(dataOf(up.envelope).prepared)).toContain("unchanged");
	});

	it("refuses unknown subcommands and flags with the lifecycle usage", async () => {
		const cli = familyCli(runtimeWith(recordingIac()), await project());
		const unknown = await run(cli, ["cd", "ship"]);
		expect(unknown.envelope.code).toBe("HOBO_USAGE");
		const badFlag = await run(cli, ["cd", "up", "--force"]);
		expect(badFlag.envelope.code).toBe("HOBO_USAGE");
	});
});

describe("resolveFamilyProject", () => {
	it("prefers --project, then HOBO_<FAMILY>_PROJECT, then the bundled project", async () => {
		const a = await project();
		const b = await project();
		const flags = { whatIf: false, mode: null, project: null, yes: false };
		expect(
			resolveFamilyProject({
				family: "ci",
				flags: { ...flags, project: a },
				cwd: "/",
				env: { HOBO_CI_PROJECT: b },
				bundled: b,
			}),
		).toMatchObject({ ok: true, projectDir: a, source: "--project" });
		expect(
			resolveFamilyProject({
				family: "ci",
				flags,
				cwd: "/",
				env: { HOBO_CI_PROJECT: b },
				bundled: a,
			}),
		).toMatchObject({ ok: true, projectDir: b, source: "HOBO_CI_PROJECT" });
		expect(
			resolveFamilyProject({
				family: "ci",
				flags,
				cwd: "/",
				env: {},
				bundled: undefined,
			}),
		).toMatchObject({ ok: false });
	});
});
