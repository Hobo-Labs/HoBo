import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ensureGitHubRelease,
	type ReleaseApiRequest,
} from "../ci/create-github-release.mts";
import {
	RELEASE_TAGGER,
	releaseSigningKey,
	signedTagObject,
	tagPayload,
} from "../ci/push-release-git-tag.mts";
import {
	ed25519PublicLine,
	parseOpenSshEd25519PrivateKey,
	sshVerify,
} from "../lib/ssh-sig.mts";

// The tag object of v0.0.0-alpha.2, signed by `git tag -s` with ssh-keygen.
// Checking it here proves the verifier reads git's real sshsig output.
const ALPHA_2_PAYLOAD =
	"object df8f484817a7f5f8dcd7df1946e86e3144ff9f9d\ntype commit\ntag v0.0.0-alpha.2\ntagger Cursor Agent <cursoragent@cursor.com> 1793841028 +0000\n\nHoBo v0.0.0-alpha.2\n";
const ALPHA_2_SIGNATURE =
	"-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAg+qImwGMCy/grKZ50VxRHz3VfWW\nAL3QNbzIy2Nwcn+nQAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5\nAAAAQPCDL724xyhChG65BdhuV5EFoWiHF0fGVh4EAKFwWPiYwtiXBwZh8HwB+/J9i+VROk\nIzIIZEKZLEdqdFXTYGfwU=\n-----END SSH SIGNATURE-----\n";

function wire(value: Buffer | string): Buffer {
	const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length);
	return Buffer.concat([length, body]);
}

/** An unencrypted openssh-key-v1 file for a fresh ed25519 key, as ssh-keygen writes it. */
/** A key file and its public line. */
interface TestKey {
	readonly pem: string;
	readonly publicLine: string;
}

function openSshKey(options: { cipher?: string } = {}): TestKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const seed = Buffer.from(
		privateKey.export({ format: "jwk" }).d ?? "",
		"base64url",
	);
	const pub = Buffer.from(
		publicKey.export({ format: "jwk" }).x ?? "",
		"base64url",
	);
	const publicBlob = Buffer.concat([wire("ssh-ed25519"), wire(pub)]);
	const check = Buffer.from([1, 2, 3, 4]);
	let secret = Buffer.concat([
		check,
		check,
		wire("ssh-ed25519"),
		wire(pub),
		wire(Buffer.concat([seed, pub])),
		wire("release@test"),
	]);
	const pad: number[] = [];
	for (let i = 1; (secret.length + pad.length) % 8 !== 0; i++) pad.push(i);
	secret = Buffer.concat([secret, Buffer.from(pad)]);
	const cipher = options.cipher ?? "none";
	const body = Buffer.concat([
		Buffer.from("openssh-key-v1\0", "latin1"),
		wire(cipher),
		wire(cipher === "none" ? "none" : "bcrypt"),
		wire(""),
		Buffer.from([0, 0, 0, 1]),
		wire(publicBlob),
		wire(secret),
	]).toString("base64");
	const lines = body.match(/.{1,70}/gu) ?? [];
	return {
		pem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
		publicLine: ed25519PublicLine(pub),
	};
}

describe("ssh signatures", () => {
	it("verifies the real signature git wrote on v0.0.0-alpha.2", () => {
		const verified = sshVerify(Buffer.from(ALPHA_2_PAYLOAD), ALPHA_2_SIGNATURE);
		expect(verified.namespace).toBe("git");
		expect(verified.publicKey).toHaveLength(32);
	});

	it("refuses that signature over a changed tag", () => {
		const changed = ALPHA_2_PAYLOAD.replace("alpha.2\n", "alpha.3\n");
		expect(() => sshVerify(Buffer.from(changed), ALPHA_2_SIGNATURE)).toThrow(
			/does not verify/,
		);
	});

	it("signs a tag object that the same check accepts, in git's layout", () => {
		const { pem } = openSshKey();
		const key = parseOpenSshEd25519PrivateKey(pem);
		const payload = tagPayload({
			commit: "df8f484817a7f5f8dcd7df1946e86e3144ff9f9d",
			tag: "v0.0.0-alpha.122",
			tagger: RELEASE_TAGGER,
			epochSeconds: 1793900000,
			message: "HoBo release v0.0.0-alpha.122",
		});
		expect(payload).toBe(
			`object df8f484817a7f5f8dcd7df1946e86e3144ff9f9d\ntype commit\ntag v0.0.0-alpha.122\ntagger ${RELEASE_TAGGER} 1793900000 +0000\n\nHoBo release v0.0.0-alpha.122\n`,
		);
		const object = signedTagObject(payload, key);
		expect(object.startsWith(payload)).toBe(true);
		const signature = object.slice(payload.length);
		expect(signature).toMatch(
			/^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=]{1,70}\n)+-----END SSH SIGNATURE-----\n$/u,
		);
		expect(sshVerify(Buffer.from(payload), signature).publicKey).toEqual(
			key.publicKey,
		);
		expect(() =>
			sshVerify(Buffer.from(payload.replace("122", "123")), signature),
		).toThrow(/does not verify/);
	});
});

describe("release signing key", () => {
	it("reads the private key and accepts its own public half", () => {
		const { pem, publicLine } = openSshKey();
		const key = releaseSigningKey({
			HOBO_RELEASE_TAG_SSH_PRIVATE_KEY: pem,
			HOBO_RELEASE_TAG_SSH_SIGNING_KEY: `key::${publicLine} release@test`,
		});
		expect(ed25519PublicLine(key.publicKey)).toBe(publicLine);
	});

	it("refuses a published key that is not the private key's", () => {
		const { pem } = openSshKey();
		const other = openSshKey();
		expect(() =>
			releaseSigningKey({
				HOBO_RELEASE_TAG_SSH_PRIVATE_KEY: pem,
				HOBO_RELEASE_TAG_SSH_SIGNING_KEY: other.publicLine,
			}),
		).toThrow(/not the public half/);
	});

	it("names the missing secret, and refuses an encrypted key", () => {
		expect(() => releaseSigningKey({})).toThrow(
			/HOBO_RELEASE_TAG_SSH_PRIVATE_KEY is required/,
		);
		const { pem } = openSshKey({ cipher: "aes256-ctr" });
		expect(() =>
			releaseSigningKey({ HOBO_RELEASE_TAG_SSH_PRIVATE_KEY: pem }),
		).toThrow(/encrypted keys are not supported/);
	});
});

describe("GitHub Release", () => {
	type Call = { url: string; method: string; body?: string | undefined };
	function api(answers: Array<{ status: number; text?: string }>) {
		const calls: Call[] = [];
		const request: ReleaseApiRequest = async (url, init) => {
			calls.push({ url, method: init.method, body: init.body });
			const next = answers.shift() ?? { status: 500 };
			return { status: next.status, text: next.text ?? "" };
		};
		return { calls, request };
	}
	const base = {
		repository: "Hobo-Labs/HoBo",
		token: "t",
		tag: "v0.0.0-alpha.122",
		sleep: async () => {},
	};

	it("leaves an existing release alone", async () => {
		const { calls, request } = api([{ status: 200 }]);
		await expect(
			ensureGitHubRelease({ ...base, prerelease: true, request }),
		).resolves.toBe("exists");
		expect(calls.map((c) => c.method)).toEqual(["GET"]);
	});

	it("creates a prerelease with generated notes when there is none", async () => {
		const { calls, request } = api([{ status: 404 }, { status: 201 }]);
		await expect(
			ensureGitHubRelease({ ...base, prerelease: true, request }),
		).resolves.toBe("created");
		expect(calls[1]?.url).toBe(
			"https://api.github.com/repos/Hobo-Labs/HoBo/releases",
		);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			tag_name: "v0.0.0-alpha.122",
			name: "v0.0.0-alpha.122",
			prerelease: true,
			generate_release_notes: true,
		});
	});

	it("treats a release another run just made as there", async () => {
		const { request } = api([
			{ status: 404 },
			{ status: 422, text: '{"errors":[{"code":"already_exists"}]}' },
		]);
		await expect(
			ensureGitHubRelease({ ...base, prerelease: false, request }),
		).resolves.toBe("exists");
	});

	it("retries a server error, then names it", async () => {
		const { calls, request } = api([
			{ status: 502 },
			{ status: 502 },
			{ status: 502 },
		]);
		await expect(
			ensureGitHubRelease({ ...base, prerelease: true, request }),
		).rejects.toThrow(/GET release: HTTP 502/);
		expect(calls).toHaveLength(3);
	});
});

describe("as the release job runs them", () => {
	// release-tag runs these with plain `node` (type stripping only, no tsx). A
	// non-erasable construct passes vitest, which transpiles, and crashes there.
	const root = join(import.meta.dirname, "..", "..");
	const plainNode = (args: readonly string[]) =>
		spawnSync(process.execPath, ["--no-warnings", ...args], {
			cwd: root,
			encoding: "utf8",
		});

	it("loads push-release-git-tag with plain node", () => {
		const run = plainNode([
			"scripts/ci/push-release-git-tag.mts",
			"--tag",
			"v0.0.0-alpha.987654",
			"--dry-run",
		]);
		expect(run.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout).toMatch(
			/would create signed tag v0\.0\.0-alpha\.987654/,
		);
	});

	it("signs and verifies with plain node", () => {
		const { pem } = openSshKey();
		const run = spawnSync(
			process.execPath,
			[
				"--no-warnings",
				"--input-type=module",
				"-e",
				[
					`import { parseOpenSshEd25519PrivateKey, sshSign, sshVerify } from ${JSON.stringify(join(root, "scripts/lib/ssh-sig.mts"))};`,
					"const key = parseOpenSshEd25519PrivateKey(process.env.KEY);",
					'const message = Buffer.from("payload\\n");',
					"sshVerify(message, sshSign(message, key));",
					'console.log("ok");',
				].join("\n"),
			],
			{ cwd: root, encoding: "utf8", env: { ...process.env, KEY: pem } },
		);
		expect(run.stderr).toBe("");
		expect(run.stdout.trim()).toBe("ok");
	});

	it("loads create-github-release with plain node", () => {
		const run = plainNode(["scripts/ci/create-github-release.mts"]);
		expect(run.stderr).toMatch(/usage: create-github-release\.mts/);
		expect(run.status).toBe(2);
	});
});

describe("signature checks", () => {
	it("refuses a signature made for another namespace", () => {
		expect(() =>
			sshVerify(Buffer.from(ALPHA_2_PAYLOAD), ALPHA_2_SIGNATURE, "file"),
		).toThrow(/namespace git, expected file/);
	});

	it("refuses a published signing key it cannot read", () => {
		const { pem } = openSshKey();
		expect(() =>
			releaseSigningKey({
				HOBO_RELEASE_TAG_SSH_PRIVATE_KEY: pem,
				HOBO_RELEASE_TAG_SSH_SIGNING_KEY: "ssh-rsa AAAAB3Nza release@test",
			}),
		).toThrow(/expected "ssh-ed25519 <base64>"/);
	});
});
