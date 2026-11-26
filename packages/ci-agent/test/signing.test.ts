import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseCommitSigningKey,
	signingPublicKeyLine,
	sshSignedData,
} from "../src/signing.js";
import {
	createRepositories,
	type Repositories,
} from "./fixtures/repository.js";

const pem = () =>
	generateKeyPairSync("ed25519")
		.privateKey.export({ format: "pem", type: "pkcs8" })
		.toString();

/** An unencrypted OpenSSH-format ed25519 key, as `ssh-keygen -N ""` writes it. */
function openSsh(seedPem: string): string {
	const key = parseCommitSigningKey(seedPem);
	const der = key.privateKey.export({ format: "der", type: "pkcs8" });
	const seed = der.subarray(-32);
	const string = (bytes: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		return Buffer.concat([length, bytes]);
	};
	const text = (value: string) => string(Buffer.from(value));
	const raw = key.publicKey.subarray(-32);
	const check = Buffer.from([1, 2, 3, 4, 1, 2, 3, 4]);
	const body = Buffer.concat([
		check,
		text("ssh-ed25519"),
		string(raw),
		string(Buffer.concat([seed, raw])),
		text("test"),
	]);
	const padding = Buffer.from(
		Array.from({ length: (8 - (body.length % 8)) % 8 }, (_, i) => i + 1),
	);
	const blob = Buffer.concat([
		Buffer.from("openssh-key-v1\0"),
		text("none"),
		text("none"),
		text(""),
		Buffer.from([0, 0, 0, 1]),
		string(key.publicKey),
		string(Buffer.concat([body, padding])),
	]);
	return `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** Split a signed commit object into the payload git verifies and its signature. */
function unsign(object: string) {
	const start = object.indexOf("\ngpgsig ");
	const end = object.indexOf("-----END SSH SIGNATURE-----", start);
	const block = object.slice(
		start + 1,
		end + "-----END SSH SIGNATURE-----".length,
	);
	return {
		payload:
			object.slice(0, start + 1) + object.slice(start + 1 + block.length + 1),
		armored: block.replace(/^gpgsig /, "").replace(/\n /g, "\n"),
	};
}

/** Verify an SSHSIG over a payload with the key it names, as `ssh-keygen -Y verify` does. */
function verifySshSignature(
	armored: string,
	payload: string,
	publicKey: Buffer,
) {
	const blob = Buffer.from(
		armored
			.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, "")
			.replace(/\s+/g, ""),
		"base64",
	);
	let at = 10;
	const read = () => {
		const length = blob.readUInt32BE(at);
		const value = blob.subarray(at + 4, at + 4 + length);
		at += 4 + length;
		return value;
	};
	expect(blob.subarray(0, 6).toString()).toBe("SSHSIG");
	expect(read().equals(publicKey)).toBe(true);
	expect(read().toString()).toBe("git");
	read();
	read();
	const wrapped = read();
	const signature = wrapped.subarray(4 + 11 + 4);
	const spki = Buffer.concat([
		Buffer.from("302a300506032b6570032100", "hex"),
		publicKey.subarray(-32),
	]);
	return verify(
		null,
		sshSignedData(payload),
		createPublicKey({ key: spki, format: "der", type: "spki" }),
		signature,
	);
}

describe("commit signing", () => {
	let repos: Repositories;
	beforeEach(() => {
		repos = createRepositories();
		repos.seed({ "a.txt": "one\ntwo\n" });
	});
	afterEach(() => repos.cleanup());

	it("reads PKCS#8 and OpenSSH ed25519 keys to the same key, and refuses others", () => {
		const key = pem();
		const fromPem = parseCommitSigningKey(key);
		const fromOpenSsh = parseCommitSigningKey(openSsh(key));
		expect(fromOpenSsh.publicKey.equals(fromPem.publicKey)).toBe(true);
		expect(signingPublicKeyLine(fromPem)).toMatch(
			/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI/,
		);
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
			.privateKey.export({ format: "pem", type: "pkcs8" })
			.toString();
		for (const bad of [rsa, "not a key", key.replace("PRIVATE", "PUBLIC")])
			expect(() => parseCommitSigningKey(bad)).toThrow(
				"invalid commit signing key (an unencrypted ed25519 key is required)",
			);
	});

	it("signs merge commits verifiably, by the configured identity, with a stable id", async () => {
		const ours = repos.commit("ours", { "a.txt": "one\nTWO ours\n" });
		const theirs = repos.commit("theirs", { "a.txt": "one\nTWO theirs\n" });
		repos.pull(1, "ours");
		repos.pull(2, "theirs");
		const key = parseCommitSigningKey(pem());
		const { createGitWorkspace } = await import("../src/git-workspace.js");
		const workspace = createGitWorkspace({
			directory: repos.agent,
			identity: { name: "HoBo CI agent", email: "ci-agent@hobo.example" },
			signer: key,
		});
		await workspace.fetch(["refs/pull/1/head", "refs/pull/2/head"]);
		const merge = await workspace.trial(ours, theirs);
		const input = {
			tree: merge.tree,
			parents: [ours, theirs] as const,
			files: new Map([["a.txt", "one\nTWO both\n"]]),
			message: "Merge theirs into ours\n",
		};
		const commit = await workspace.commit(input);
		expect(await workspace.commit(input)).toBe(commit);
		const object = repos.git(repos.agent, "cat-file", "commit", commit);
		expect(object).toMatch(
			/\nauthor HoBo CI agent <ci-agent@hobo\.example> \d+ \+0000\n/,
		);
		expect(object).toContain("\ngpgsig -----BEGIN SSH SIGNATURE-----\n ");
		const { payload, armored } = unsign(`${object}\n`);
		expect(verifySshSignature(armored, payload, key.publicKey)).toBe(true);
		// The object is intact: git reads its tree and parents, and fsck accepts it.
		expect(repos.git(repos.agent, "show", `${commit}:a.txt`)).toBe(
			"one\nTWO both",
		);
		expect(repos.git(repos.agent, "log", "-1", "--format=%P", commit)).toBe(
			`${ours} ${theirs}`,
		);
		repos.git(repos.agent, "fsck", "--no-dangling");
	});
});
