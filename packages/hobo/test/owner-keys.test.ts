import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTrustedVault } from "@hobo/core";
import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { afterEach, describe, expect, it } from "vitest";
import { createFileOneTimeActionStore } from "../src/one-time-action-store-file.js";
import {
	CLAIM_ACTION_KEY,
	loadOwnerKeys,
	ownerKeysFor,
	PULUMI_STATE_KEY,
} from "../src/owner-keys.js";

// The owner's keys live in their secret store and reach the composed process
// only through its trusted vault: provisioned once and reused by later runs,
// including on another machine that signs in to the same store.

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0))
		await rm(dir, { recursive: true, force: true });
});

function memoryStore() {
	const port = createMemorySecretsPort({ id: "memory" });
	const store: OpenedSecretStore = {
		id: "infisical",
		port,
		reference: (name) => `infisical://proj/prod/hobo-cd/${name}`,
	};
	return { store, port, open: async () => store };
}

const live = (workdir: string) => ({
	HOBO_PULUMI_LIVE: "1",
	HOBO_PULUMI_WORKDIR: workdir,
});

describe("ownerKeysFor", () => {
	it("reads only the keys the verb uses", () => {
		expect(ownerKeysFor({ env: {}, verb: "up", subcommand: "" })).toEqual([]);
		expect(
			ownerKeysFor({ env: {}, verb: "claim", subcommand: "open" }),
		).toEqual([CLAIM_ACTION_KEY]);
		expect(
			ownerKeysFor({ env: live("/w"), verb: "up", subcommand: "" }),
		).toEqual([PULUMI_STATE_KEY]);
		// A disposable workspace keeps its key in memory; no store is needed.
		expect(
			ownerKeysFor({
				env: { HOBO_PULUMI_LIVE: "1" },
				verb: "up",
				subcommand: "",
			}),
		).toEqual([]);
	});
});

describe("loadOwnerKeys", () => {
	it("loads the same pre-provisioned key on each machine", async () => {
		const workdir = await mkdtemp(path.join(tmpdir(), "hobo-owner-keys-"));
		directories.push(workdir);
		const { port, open } = memoryStore();
		await port.put(PULUMI_STATE_KEY, "owner-provisioned-passphrase");
		const first = createTrustedVault();
		const input = {
			env: live(workdir),
			cwd: workdir,
			verb: "up",
			subcommand: "",
			open,
		};
		expect(await loadOwnerKeys({ ...input, vault: first })).toEqual({
			kind: "loaded",
			keys: [PULUMI_STATE_KEY],
		});
		const made = first.reveal(PULUMI_STATE_KEY);
		expect(made).toBe("owner-provisioned-passphrase");
		const stored = await port.access(PULUMI_STATE_KEY);
		expect(stored.status === "ok" && stored.material).toBe(made);
		// A new machine: a new vault, the same store, the same key.
		const second = createTrustedVault();
		await loadOwnerKeys({ ...input, vault: second });
		expect(second.reveal(PULUMI_STATE_KEY)).toBe(made);
	});

	it("refuses concurrent initialization when the store has no atomic create", async () => {
		const workdir = await mkdtemp(path.join(tmpdir(), "hobo-owner-keys-"));
		directories.push(workdir);
		const { port, open } = memoryStore();
		const vaults = [createTrustedVault(), createTrustedVault()];
		const outcomes = await Promise.all(
			vaults.map((vault) =>
				loadOwnerKeys({
					env: live(workdir),
					cwd: workdir,
					verb: "up",
					subcommand: "",
					open,
					vault,
				}),
			),
		);
		expect(outcomes).toEqual([
			expect.objectContaining({
				kind: "refused",
				code: "HOBO_OWNER_KEY_MISSING",
			}),
			expect.objectContaining({
				kind: "refused",
				code: "HOBO_OWNER_KEY_MISSING",
			}),
		]);
		expect(vaults.map((vault) => vault.reveal(PULUMI_STATE_KEY))).toEqual([
			undefined,
			undefined,
		]);
		expect((await port.access(PULUMI_STATE_KEY)).status).not.toBe("ok");
	});

	it("refuses instead of falling back when the configured store cannot open or read", async () => {
		const workdir = await mkdtemp(path.join(tmpdir(), "hobo-owner-keys-"));
		directories.push(workdir);
		await mkdir(path.join(workdir, ".hobo"));
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path.join(workdir, ".hobo", "secret-store.json"), "{}");
		const input = {
			env: {},
			cwd: workdir,
			verb: "claim",
			subcommand: "open",
			vault: createTrustedVault(),
		};
		for (const open of [
			async () => undefined,
			async () => {
				throw new Error("sensitive detail");
			},
		]) {
			const outcome = await loadOwnerKeys({ ...input, open });
			expect(outcome).toMatchObject({
				kind: "refused",
				code: "HOBO_OWNER_STORE_UNAVAILABLE",
			});
			expect(JSON.stringify(outcome)).not.toContain("sensitive detail");
		}
		const { store } = memoryStore();
		store.port.access = async () => {
			throw new Error("sensitive detail");
		};
		expect(
			await loadOwnerKeys({ ...input, open: async () => store }),
		).toMatchObject({ kind: "refused", code: "HOBO_OWNER_STORE_UNAVAILABLE" });
	});

	it("refuses a retained workspace with state whose key the store does not hold", async () => {
		const workdir = await mkdtemp(path.join(tmpdir(), "hobo-owner-keys-"));
		directories.push(workdir);
		await mkdir(path.join(workdir, "state"));
		const { port, open } = memoryStore();
		const outcome = await loadOwnerKeys({
			env: live(workdir),
			cwd: workdir,
			verb: "up",
			subcommand: "",
			open,
			vault: createTrustedVault(),
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			code: "HOBO_PULUMI_STATE_KEY_MISSING",
		});
		// Nothing was made up in its place.
		expect((await port.access(PULUMI_STATE_KEY)).status).not.toBe("ok");
	});

	it("reports no store when none opens, and opens none for a verb that needs no key", async () => {
		let opened = 0;
		const open = async () => {
			opened += 1;
			return undefined;
		};
		const base = { env: {}, cwd: tmpdir(), open, vault: createTrustedVault() };
		expect(
			await loadOwnerKeys({ ...base, verb: "claim", subcommand: "status" }),
		).toEqual({ kind: "no-store" });
		await loadOwnerKeys({ ...base, verb: "up", subcommand: "" });
		expect(opened).toBe(1);
	});
});

describe("the claim action store's key", () => {
	it("seals with the store's key and writes no key file", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "hobo-owner-claims-"));
		directories.push(home);
		const vault = createTrustedVault();
		const { open, port } = memoryStore();
		await port.put(CLAIM_ACTION_KEY, Buffer.alloc(32, 7).toString("base64"));
		await loadOwnerKeys({
			env: {},
			cwd: home,
			verb: "claim",
			subcommand: "open",
			open,
			vault,
		});
		const key = vault.reveal(CLAIM_ACTION_KEY);
		expect(key).toBeDefined();
		createFileOneTimeActionStore({ home, key });
		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(home, "claims", "action-key"))).toBe(false);
	});
});
