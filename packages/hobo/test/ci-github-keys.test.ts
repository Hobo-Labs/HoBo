import { generateKeyPairSync } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoboCli } from "@hobo/cli";
import { afterEach, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import {
	githubKeyEnvironment,
	storedGithubKey,
} from "../src/ci-github-keys.js";
import { ciWorkerEnvironment } from "../src/ci-serve.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "hobo-ci-key-"));
	directories.push(root);
	const repo = join(root, "repo");
	const home = join(root, "home");
	await mkdir(repo);
	await mkdir(join(repo, ".git"));
	await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
	const pair = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	const keyFile = join(root, "source.pem");
	const webhookSecretFile = join(root, "source-secret");
	const secret = "fixture-webhook-secret-0123456789";
	await writeFile(keyFile, pair.privateKey, { mode: 0o600 });
	await writeFile(webhookSecretFile, `${secret}\n`, { mode: 0o600 });
	let appId = 123;
	let oversized = false;
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: { HOBO_HOME: home },
				git: async () => repo,
				fetch: async (url, init) => {
					expect(String(url)).toBe("https://api.github.com/app");
					expect(init?.redirect).toBe("error");
					expect(new Headers(init?.headers).get("authorization")).toMatch(
						/^Bearer [^.]+\.[^.]+\.[^.]+$/,
					);
					return oversized
						? new Response("x".repeat(65_537))
						: Response.json({ id: appId });
				},
			}),
		},
	});
	const args = [
		"ci",
		"github",
		"import-key",
		"--app-id",
		"123",
		"--key-file",
		keyFile,
		"--webhook-secret-file",
		webhookSecretFile,
	];
	return {
		root,
		repo,
		home,
		cli,
		args,
		pair,
		secret,
		setAppId: (id: number) => {
			appId = id;
		},
		setOversized: () => {
			oversized = true;
		},
	};
}

it("verifies and stores private credentials for the relay and worker, and rotates without overwriting the active version", async () => {
	const f = await fixture();
	const first = await f.cli.run(f.args, { cwd: f.repo });
	expect(first.exitCode).toBe(0);
	expect(first.stdout + first.stderr).not.toContain(f.pair.privateKey);
	expect(first.stdout + first.stderr).not.toContain(f.secret);
	const saved = await storedGithubKey(f.home);
	expect(saved?.appId).toBe("123");
	expect(await readFile(saved?.keyFile ?? "", "utf8")).toBe(f.pair.privateKey);
	expect(await readFile(saved?.webhookSecretFile ?? "", "utf8")).toBe(f.secret);
	expect((await stat(saved?.keyFile ?? "")).mode & 0o077).toBe(0);
	expect((await stat(saved?.webhookSecretFile ?? "")).mode & 0o077).toBe(0);
	const env = await githubKeyEnvironment({}, f.home);
	expect(env.HOBO_CI_GITHUB_APP_ID).toBe("123");
	expect(env.HOBO_CI_GITHUB_APP_KEY_FILE).toBe(saved?.keyFile);
	expect(env.HOBO_CI_WEBHOOK_SECRET_FILE).toBe(saved?.webhookSecretFile);
	const worker = ciWorkerEnvironment({
		relayEnv: env,
		stateDir: f.root,
		store: { kind: "sqlite" },
	});
	expect(worker.HOBO_CI_GITHUB_APP_KEY_FILE).toBe(saved?.keyFile);
	expect(worker.HOBO_CI_WEBHOOK_SECRET_FILE).toBe(saved?.webhookSecretFile);
	const second = await f.cli.run(f.args, { cwd: f.repo });
	expect(second.exitCode).toBe(0);
	const rotated = await storedGithubKey(f.home);
	expect(rotated?.keyFile).not.toBe(saved?.keyFile);
	expect(await readFile(saved?.keyFile ?? "", "utf8")).toBe(f.pair.privateKey);
	const status = await f.cli.run(["ci", "github", "key-status"], {
		cwd: f.repo,
	});
	expect(status.stdout).toContain("123");
	expect(status.stdout).not.toContain(f.secret);
	const removedAlias = await f.cli.run(["ci", "github-key", "status"], {
		cwd: f.repo,
	});
	expect(removedAlias.exitCode).toBe(2);
	const explicit = { HOBO_CI_GITHUB_APP_ID: "999" };
	expect(await githubKeyEnvironment(explicit, f.home)).toBe(explicit);
});

it("does not replace credentials when the private key belongs to a different App", async () => {
	const f = await fixture();
	expect((await f.cli.run(f.args, { cwd: f.repo })).exitCode).toBe(0);
	const saved = await storedGithubKey(f.home);
	f.setAppId(999);
	const result = await f.cli.run(f.args, { cwd: f.repo });
	expect(result.exitCode).toBe(1);
	expect((await storedGithubKey(f.home))?.keyFile).toBe(saved?.keyFile);
	expect(result.stdout + result.stderr).not.toContain(f.secret);
});

it("rejects an oversized GitHub response without changing the stored key", async () => {
	const f = await fixture();
	expect((await f.cli.run(f.args, { cwd: f.repo })).exitCode).toBe(0);
	const saved = await storedGithubKey(f.home);
	f.setOversized();
	const result = await f.cli.run(f.args, { cwd: f.repo });
	expect(result.exitCode).toBe(1);
	expect((await storedGithubKey(f.home))?.keyFile).toBe(saved?.keyFile);
	expect(result.stdout + result.stderr).not.toContain(f.secret);
});

it("refuses to put private credentials inside the checkout", async () => {
	const f = await fixture();
	const result = await f.cli.run(
		[...f.args, "--home", join(f.repo, "..hidden")],
		{
			cwd: f.root,
		},
	);
	expect(result.exitCode).toBe(1);
	expect(await storedGithubKey(join(f.repo, "..hidden"))).toBeUndefined();
});

it("refuses symbolic-link credential sources", async () => {
	const f = await fixture();
	const link = join(f.root, "key-link.pem");
	await symlink(join(f.root, "source.pem"), link);
	const args = [...f.args];
	args[args.indexOf("--key-file") + 1] = link;
	expect((await f.cli.run(args, { cwd: f.repo })).exitCode).toBe(1);
	expect(await storedGithubKey(f.home)).toBeUndefined();
});
