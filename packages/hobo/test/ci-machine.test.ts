import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type MachineAdvert,
	type MachineRegistry,
	receiveMachineAdvert,
	registryMachineCandidates,
	signMachineAdvert,
} from "@hobo/ci";
import { generateMeshIdentity } from "@hobo/ci/mesh";
import { SqliteMachineRegistry } from "@hobo/ci/runner-order/machine-registry-sqlite";
import {
	InMemoryMachineRegistry,
	testMachineAdvert,
} from "@hobo/ci/runner-order/testing";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import type { CiCommandContext } from "../src/ci-commands.js";
import {
	createCiMachineCommand,
	LOCAL_MACHINE_ACCOUNT,
	localMachineRegistryPath,
} from "../src/ci-machine.js";

const NOW = 1_763_337_600_000;
const studioKey = generateMeshIdentity().identity;
const thiefKey = generateMeshIdentity().identity;

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

function advert(
	init: Partial<Omit<MachineAdvert, "$typeName" | "$unknown">> = {},
): MachineAdvert {
	return testMachineAdvert({ lastSeenMs: NOW, ...init });
}

function cliOver(registry: MachineRegistry, env: NodeJS.ProcessEnv = {}) {
	const command = createCiMachineCommand({
		openRegistry: async () => ({
			registry,
			where: "memory",
			close: () => {},
		}),
	});
	return createHoboCli({
		commands: {
			ci: createCiCommand({
				env: { USER: "octocat", HOBO_CI_ACCOUNT_ID: "acct-1", ...env },
				now: () => NOW,
				commands: [command],
			}),
		},
	});
}

async function run(
	registry: MachineRegistry,
	args: readonly string[],
	env: NodeJS.ProcessEnv = {},
) {
	const result = await cliOver(registry, env).run(["ci", "machine", ...args], {
		cwd: tmpdir(),
	});
	return { ...result, output: result.stdout + result.stderr };
}

async function runJson(registry: MachineRegistry, args: readonly string[]) {
	const result = await run(registry, [...args, "--json"]);
	return { ...result, envelope: JSON.parse(result.stdout) };
}

async function registryWith(
	...adverts: readonly MachineAdvert[]
): Promise<InMemoryMachineRegistry> {
	const registry = new InMemoryMachineRegistry();
	for (const machine of adverts) await registry.put(machine);
	return registry;
}

describe("hobo ci machine status", () => {
	it("lists the account's machines with their state", async () => {
		const registry = await registryWith(
			advert({ id: "m-1", name: "studio", slots: 2, busy: 1 }),
			advert({ id: "m-2", name: "attic", paused: true }),
			advert({ id: "m-3", name: "cellar", lastSeenMs: NOW - 91_000 }),
			advert({ id: "m-9", accountId: "acct-2", name: "elsewhere" }),
		);
		const result = await run(registry, ["status"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("studio (m-1) · online · 1/2 busy");
		expect(result.output).toContain("attic (m-2) · paused");
		expect(result.output).toContain("cellar (m-3) · offline");
		expect(result.output).not.toContain("elsewhere");
	});

	it("gives the same as data with --json", async () => {
		const registry = await registryWith(advert({ slots: 2, busy: 1 }));
		const { envelope } = await runJson(registry, ["status"]);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.account).toBe("acct-1");
		expect(envelope.data.machines).toHaveLength(1);
		expect(envelope.data.machines[0].online).toBe(true);
		expect(envelope.data.machines[0].advert.id).toBe("m-1");
		expect(envelope.data.machines[0].advert.slots).toBe(2);
	});

	it("says when one machine is not there", async () => {
		const result = await run(new InMemoryMachineRegistry(), ["status", "m-7"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("No machine m-7 is connected");
	});

	it("shows help with no action and refuses an unknown one", async () => {
		const registry = new InMemoryMachineRegistry();
		expect((await run(registry, [])).output).toContain(
			"hobo ci machine pause <id>",
		);
		const unknown = await run(registry, ["explode"]);
		expect(unknown.exitCode).not.toBe(0);
		expect(unknown.output).toContain("Unknown machine command explode");
	});
});

describe("hobo ci machine pause and resume (M05)", () => {
	it("pauses, resumes and repeats safely; the walk follows", async () => {
		const registry = await registryWith(advert({ slots: 2, busy: 1 }));
		const candidates = async () =>
			registryMachineCandidates(registry, {
				accountId: "acct-1",
				nowMs: NOW,
				readers: new Set(["42"]),
			});
		const paused = await runJson(registry, ["pause", "m-1"]);
		expect(paused.envelope.data.changed).toBe(true);
		expect(paused.envelope.data.event.type).toBe("machine.paused");
		expect(paused.envelope.data.event.by).toBe("octocat");
		expect((await candidates())[0]?.paused).toBe(true);
		expect((await registry.list("acct-1"))[0]?.busy).toBe(1);

		const again = await run(registry, ["pause", "m-1"]);
		expect(again.exitCode).toBe(0);
		expect(again.output).toContain("is already paused; nothing changed");

		const resumed = await runJson(registry, ["resume", "m-1"]);
		expect(resumed.envelope.data.event.type).toBe("machine.resumed");
		expect((await candidates())[0]?.paused).toBe(false);
	});

	it("refuses a machine of another account, and a missing id", async () => {
		const registry = await registryWith(advert({ accountId: "acct-2" }));
		const other = await run(registry, ["pause", "m-1"]);
		expect(other.exitCode).not.toBe(0);
		expect(other.output).toContain("No machine m-1 is connected");
		expect((await registry.list("acct-2"))[0]?.paused).toBe(false);
		const bare = await run(registry, ["pause"]);
		expect(bare.exitCode).not.toBe(0);
		expect(bare.output).toContain("needs a machine id");
	});
});

describe("hobo ci machine share (M06)", () => {
	it("switches between only_me and anyone", async () => {
		const registry = await registryWith(advert());
		const shared = await runJson(registry, ["share", "m-1", "anyone"]);
		expect(shared.envelope.data.event.type).toBe("machine.sharing_changed");
		expect((await registry.list("acct-1"))[0]?.sharing).toBe("anyone");
		const back = await run(registry, ["share", "m-1", "only_me"]);
		expect(back.output).toContain("its owner only");
		expect((await registry.list("acct-1"))[0]?.sharing).toBe("only_me");
	});

	it("refuses a sharing it does not know", async () => {
		const registry = await registryWith(advert());
		const result = await run(registry, ["share", "m-1", "everyone"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("only_me or anyone");
	});
});

describe("hobo ci machine remove (M08, M09)", () => {
	it("removes a machine for the next decision and frees its id for a new key", async () => {
		const registry = new InMemoryMachineRegistry();
		const context = {
			accountId: "acct-1",
			ownerId: "42",
			ownerLogin: "octocat",
			nowMs: NOW,
		};
		await receiveMachineAdvert(
			registry,
			signMachineAdvert(advert(), studioKey),
			context,
		);
		const takeover = await receiveMachineAdvert(
			registry,
			signMachineAdvert(advert(), thiefKey),
			context,
		);
		expect(takeover.kind).toBe("refused");
		expect(takeover.events.map((event) => event.type)).toEqual([
			"machine.taken_over",
		]);

		const removed = await runJson(registry, ["remove", "m-1"]);
		expect(removed.envelope.data.event.type).toBe("machine.removed");
		expect(
			await registryMachineCandidates(registry, {
				...context,
				readers: new Set(["42"]),
			}),
		).toEqual([]);

		const again = await run(registry, ["remove", "m-1"]);
		expect(again.exitCode).toBe(0);
		expect(again.output).toContain("nothing to remove");

		const reconnect = await receiveMachineAdvert(
			registry,
			signMachineAdvert(advert(), thiefKey),
			context,
		);
		expect(reconnect.kind).toBe("accepted");
	});
});

describe("the local registry", () => {
	it("keeps machines in a SQLite file under HOBO_HOME across runs", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-ci-machine-"));
		directories.push(home);
		const env = { HOBO_HOME: home };
		const path = localMachineRegistryPath(env);
		expect(path).toBe(join(home, "ci", "machines.sqlite"));
		const command = createCiMachineCommand();
		const context = (args: readonly string[]): CiCommandContext => ({
			args,
			flags: {
				json: false,
				camp: null,
				cwd: home,
				verbose: false,
				quiet: false,
				help: false,
				to: null,
				rollback: false,
				seed: false,
				restore: null,
				strategy: null,
				target: null,
				check: false,
			},
			emitProgress: () => {},
			env,
			fetch,
			now: () => NOW,
			localRepository: async () => ({ root: home, repository: undefined }),
		});
		const empty = await command.run(context(["status"]));
		expect(empty.message).toContain(
			`No machine is connected for account ${LOCAL_MACHINE_ACCOUNT}`,
		);
		expect(existsSync(path)).toBe(true);

		const writer = new DatabaseSync(path);
		await new SqliteMachineRegistry(writer).put(
			advert({ accountId: LOCAL_MACHINE_ACCOUNT }),
		);
		writer.close();
		const paused = await command.run(context(["pause", "m-1"]));
		expect(paused.data?.changed).toBe(true);

		const reader = new DatabaseSync(path);
		const kept = await new SqliteMachineRegistry(reader).list(
			LOCAL_MACHINE_ACCOUNT,
		);
		reader.close();
		expect(kept.map((machine) => [machine.id, machine.paused])).toEqual([
			["m-1", true],
		]);
	});

	it("names another file with HOBO_CI_MACHINE_REGISTRY", () => {
		expect(
			localMachineRegistryPath({
				HOBO_HOME: "/h",
				HOBO_CI_MACHINE_REGISTRY: "/elsewhere/m.sqlite",
			}),
		).toBe("/elsewhere/m.sqlite");
	});
});
