/**
 * The file key store (design §6.4, O36): the shared conformance suite, the
 * key directory rules (outside any git checkout, `0700`, never writable by
 * group or others) and the file modes (`0600`).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	KeyAlgorithm,
	RECEIPT_CONTEXT,
	SignedEnvelopeSchema,
} from "@hobo/fleet";
import { runKeyStoreConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { createFileKeyStore } from "../../src/keystore/index.js";

const posix = process.platform !== "win32";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "hobo-fleet-keystore-"));
}

/** A key directory that does not exist yet, outside any git checkout. */
function freshHome(): string {
	return join(scratch(), "fleet");
}

async function modeOf(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

runKeyStoreConformance(() => createFileKeyStore(freshHome()));

describe("createFileKeyStore", () => {
	it("creates the directory 0700 and every file in it 0600", async () => {
		const home = freshHome();
		const store = createFileKeyStore(home);
		await store.open();
		await store.writeState({
			...(await store.readState()),
			generation: 1,
		});
		if (!posix) return;
		expect(await modeOf(home)).toBe(0o700);
		const files = await readdir(home);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files)
			expect(await modeOf(join(home, file)), file).toBe(0o600);
	});

	it("keeps the keys and the state across instances on one directory", async () => {
		const home = freshHome();
		const first = createFileKeyStore(home);
		const keys = await first.open();
		const receipt = create(SignedEnvelopeSchema, {
			context: RECEIPT_CONTEXT,
			keyId: `${keys.memberId}#sign`,
			algorithm: KeyAlgorithm.EDDSA,
			payload: new Uint8Array([1, 2, 3]),
			signature: new Uint8Array(64),
		});
		await first.writeState({
			generation: 2,
			pendingRefreshNonce: new Uint8Array([9, 8, 7]),
			trust: undefined,
			lastSequence: { orders: 4 },
			seenOrderIds: ["order-1"],
			pendingReceipts: [receipt],
		});
		const second = createFileKeyStore(home);
		const reopened = await second.open();
		expect(reopened.memberId).toBe(keys.memberId);
		expect(reopened.identityJwk).toBe(keys.identityJwk);
		expect(reopened.signPublicKey).toBe(keys.signPublicKey);
		expect(reopened.sealPublicKey).toBe(keys.sealPublicKey);
		expect(reopened.heldKey).toBe(false);
		const state = await second.readState();
		expect(state.generation).toBe(2);
		expect([...(state.pendingRefreshNonce ?? [])]).toEqual([9, 8, 7]);
		expect(state.lastSequence).toEqual({ orders: 4 });
		expect(state.seenOrderIds).toEqual(["order-1"]);
		expect(state.pendingReceipts).toHaveLength(1);
		expect([...(state.pendingReceipts[0]?.payload ?? [])]).toEqual([1, 2, 3]);
	});

	it("keeps rotated operational keys across instances", async () => {
		const home = freshHome();
		const store = createFileKeyStore(home);
		await store.open();
		const rotated = await store.rotateOperational();
		const reopened = await createFileKeyStore(home).open();
		expect(reopened.sealPublicKey).toBe(rotated.sealPublicKey);
		expect(reopened.signPublicKey).toBe(rotated.signPublicKey);
	});

	it("writes no private key into the state file", async () => {
		const home = freshHome();
		const store = createFileKeyStore(home);
		await store.open();
		await store.writeState({ ...(await store.readState()), generation: 5 });
		const files = await readdir(home);
		const stateFile = files.find((file) => file.startsWith("state"));
		expect(stateFile).toBeDefined();
		const text = await readFile(join(home, stateFile ?? ""), "utf8");
		expect(text).not.toContain("PRIVATE KEY");
	});

	it("refuses a key directory inside a git checkout", async () => {
		const root = scratch();
		mkdirSync(join(root, ".git"));
		const store = createFileKeyStore(join(root, "nested", "fleet"));
		await expect(store.open()).rejects.toThrow(/git checkout/u);
	});

	it("refuses a key directory inside a git worktree, where .git is a file", async () => {
		const root = scratch();
		writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
		const store = createFileKeyStore(join(root, "fleet"));
		await expect(store.readState()).rejects.toThrow(/git checkout/u);
	});

	it.skipIf(!posix)(
		"refuses a key directory group can write, and one others can write",
		async () => {
			for (const mode of [0o770, 0o702]) {
				const home = freshHome();
				mkdirSync(home);
				await chmod(home, mode);
				const store = createFileKeyStore(home);
				await expect(store.open()).rejects.toThrow(/writable/u);
				await expect(store.writeState(await emptyState())).rejects.toThrow(
					/writable/u,
				);
			}
		},
	);

	it.skipIf(!posix)(
		"tightens an existing key directory nobody else can write to 0700",
		async () => {
			const home = freshHome();
			mkdirSync(home);
			await chmod(home, 0o755);
			await createFileKeyStore(home).open();
			expect(await modeOf(home)).toBe(0o700);
		},
	);

	it.skipIf(!posix)(
		"refuses to load a key file group or others can read",
		async () => {
			const home = freshHome();
			await createFileKeyStore(home).open();
			const files = await readdir(home);
			const identity = files.find((file) => file.startsWith("identity"));
			expect(identity).toBeDefined();
			await chmod(join(home, identity ?? ""), 0o640);
			await expect(createFileKeyStore(home).open()).rejects.toThrow(
				/permissions/u,
			);
		},
	);

	it("refuses a state file that does not parse", async () => {
		const home = freshHome();
		const store = createFileKeyStore(home);
		await store.open();
		await store.writeState(await emptyState());
		const files = await readdir(home);
		const stateFile = files.find((file) => file.startsWith("state"));
		await writeFile(join(home, stateFile ?? ""), '{"generation":"two"}', {
			mode: 0o600,
		});
		await expect(createFileKeyStore(home).readState()).rejects.toThrow(
			/state/u,
		);
	});

	it("destroy removes every file it wrote", async () => {
		const home = freshHome();
		const store = createFileKeyStore(home);
		await store.open();
		await store.writeState({ ...(await store.readState()), generation: 1 });
		await store.destroy();
		expect(await readdir(home)).toEqual([]);
		const state = await store.readState();
		expect(state.generation).toBe(0);
	});
});

async function emptyState() {
	return {
		generation: 0,
		pendingRefreshNonce: undefined,
		trust: undefined,
		lastSequence: {},
		seenOrderIds: [],
		pendingReceipts: [],
	};
}
