/**
 * The external-signer key store (design §6.4, O36): the identity key sits
 * behind a command that speaks line-delimited JSON on standard input and
 * output; the operational keys and the state follow the file store's rules.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runKeyStoreConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { createExternalSignerKeyStore } from "../../src/keystore/index.js";

const helper = fileURLToPath(
	new URL("./fixtures/external-signer.mjs", import.meta.url),
);

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "hobo-fleet-signer-"));
}

function storeFor(mode = "honest") {
	const root = scratch();
	const home = join(root, "fleet");
	const keyDir = join(root, "token");
	return {
		home,
		keyDir,
		store: createExternalSignerKeyStore(home, [
			process.execPath,
			helper,
			keyDir,
			mode,
		]),
	};
}

runKeyStoreConformance(() => storeFor().store);

describe("createExternalSignerKeyStore", () => {
	it("reports the identity key as held and signs through the command", async () => {
		const { store, keyDir } = storeFor();
		const keys = await store.open();
		expect(keys.heldKey).toBe(true);
		expect(keys.identity.keyId).toBe(`${keys.memberId}#identity`);
		const signature = await keys.identity.sign(new TextEncoder().encode("x"));
		expect(signature).toHaveLength(64);
		// The helper keeps the identity key; the store never sees it.
		expect(await readdir(keyDir)).toEqual(["identity.pem"]);
	});

	it("keeps the identity key out of the key directory", async () => {
		const { store, home } = storeFor();
		await store.open();
		for (const file of await readdir(home)) {
			expect(file.startsWith("identity")).toBe(false);
			if (process.platform !== "win32")
				expect((await stat(join(home, file))).mode & 0o777).toBe(0o600);
		}
	});

	it("sends the payload on standard input, never as an argument", async () => {
		const { store, keyDir } = storeFor("argv-log");
		const keys = await store.open();
		await keys.identity.sign(new TextEncoder().encode("secret-payload"));
		const argv: readonly string[] = JSON.parse(
			await readFile(join(keyDir, "argv.json"), "utf8"),
		);
		const encoded = Buffer.from("secret-payload").toString("base64");
		expect(argv.some((arg) => arg.includes(encoded))).toBe(false);
		expect(argv.some((arg) => arg.includes("secret-payload"))).toBe(false);
	});

	it("refuses a command that answers with an error", async () => {
		await expect(storeFor("fail").store.open()).rejects.toThrow(
			/external signer/u,
		);
	});

	it("refuses a command that answers with something other than JSON", async () => {
		await expect(storeFor("garbage").store.open()).rejects.toThrow(
			/external signer/u,
		);
	});

	it("refuses a public key that carries private members", async () => {
		await expect(storeFor("private-jwk").store.open()).rejects.toThrow(
			/external signer/u,
		);
	});

	it("refuses a signature that does not verify against the identity key", async () => {
		const keys = await storeFor("wrong-signature").store.open();
		await expect(
			keys.identity.sign(new TextEncoder().encode("bytes")),
		).rejects.toThrow(/does not verify/u);
	});

	it("refuses a command that cannot be started", async () => {
		const store = createExternalSignerKeyStore(join(scratch(), "fleet"), [
			join(scratch(), "no-such-binary"),
		]);
		await expect(store.open()).rejects.toThrow(/external signer/u);
	});

	it("refuses an empty command", () => {
		expect(() => createExternalSignerKeyStore(scratch(), [])).toThrow(
			/command/u,
		);
	});

	it("applies the file store's directory rules to its home", async () => {
		const root = scratch();
		mkdirSync(join(root, ".git"));
		const store = createExternalSignerKeyStore(join(root, "fleet"), [
			process.execPath,
			helper,
			join(root, "token"),
		]);
		await expect(store.open()).rejects.toThrow(/git checkout/u);
	});
});
