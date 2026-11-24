import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	type Change,
	isCredentialName,
	isFixturePath,
	isRealLookingCoordinate,
	isSecretFile,
	secretStorageViolations,
} from "../check-secret-storage.mts";

const script = resolve("scripts/check-secret-storage.mts");
const scratch: string[] = [];
const env = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

const words = (...parts: string[]) => parts.join(" ");
const envRead = (name: string) =>
	`const value = ${["process", "env", name].join(".")};`;
const locator = (name: string) => ["env", name].join("://");
const realUuid = ["3f2a9c4e", "7b1d", "4e8a", "9c3f", "2d7e8b1a5c6f"].join("-");
const realTeam = ["team", "Q7xK2mP9vR4tL8nW3yZ6bC1d"].join("_");
const realProject = ["prj", "H5jN8qT2wE6rY9uI3oP1aS4dF7gK"].join("_");
const syntheticUuid = "00000000-0000-0000-0000-000000000001";

afterEach(() => {
	for (const directory of scratch.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function change(file: string, text: string, created = false): Change {
	return {
		file,
		created,
		content: text,
		lines: text
			.split("\n")
			.map((line, index) => ({ line: index + 1, text: line })),
	};
}

function messages(changes: readonly Change[]): string[] {
	return secretStorageViolations(changes).map(
		(violation) => `${violation.file}:${violation.line}: ${violation.message}`,
	);
}

function git(cwd: string, args: string[]) {
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function write(repository: string, file: string, text: string) {
	mkdirSync(dirname(join(repository, file)), { recursive: true });
	writeFileSync(join(repository, file), text);
}

function fixture() {
	const repository = mkdtempSync(join(tmpdir(), "hobo-secret-storage-"));
	scratch.push(repository);
	git(repository, ["init", "--quiet", "--initial-branch=main"]);
	write(repository, ".gitignore", ".env\n");
	write(repository, "app.ts", "export const ok = 1;\n");
	git(repository, ["add", "."]);
	git(repository, ["commit", "--quiet", "-m", "base"]);
	return repository;
}

function guard(repository: string, ...args: string[]) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", script, ...args],
		{ cwd: repository, env, encoding: "utf8" },
	);
}

describe("secrets:guard patterns", () => {
	it("rejects stored GitHub Actions secrets and variables and permits only the per-job token", () => {
		const found = messages([
			change(
				".github/workflows/ci.yml",
				[
					"      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}",
					"      TEAM: ${{ vars.TURBO_TEAM }}",
					"      ALL: ${{ toJSON(secrets) }}",
					"      KEY: ${{ secrets['DEPLOY_KEY'] }}",
					"    secrets: inherit",
					"      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
					"      GH_TOKEN: ${{ github.token }}",
					"      vars.HOBO_NPM_PUBLISH == 'true' &&",
				].join("\n"),
			),
		]);
		assert.equal(found.length, 6);
		assert.match(
			found[0] ?? "",
			/:1: .*secret NPM_TOKEN.*choose_secret_store/u,
		);
		assert.match(found[1] ?? "", /:2: .*variable TURBO_TEAM/u);
		assert.match(found[2] ?? "", /:3: .*context secrets/u);
		assert.match(found[3] ?? "", /:4: .*secret DEPLOY_KEY/u);
		assert.match(found[4] ?? "", /:5: .*every stored GitHub Actions secret/u);
		assert.match(found[5] ?? "", /:8: .*variable HOBO_NPM_PUBLISH/u);
		for (const message of found)
			assert.match(message, /per-job GITHUB_TOKEN|owner:\/\/<NAME>/u);
	});

	it("leaves workflow-looking text outside .github alone", () => {
		assert.deepEqual(
			messages([change("docs/ci.md", "uses ${{ secrets.NPM_TOKEN }}")]),
			[],
		);
	});

	it("rejects added secret files, examples included", () => {
		for (const file of [
			".env",
			"apps/web/.env.local",
			".env.example",
			".envrc",
			"certs/server.pem",
			"tls.key",
			"keys/id_ed25519",
			"deploy/kubeconfig",
			"prod.kubeconfig.yaml",
			".kube/config",
			".netrc",
			".docker/config.json",
			"credentials.json",
			"secrets.yaml",
		]) {
			assert.ok(isSecretFile(file), file);
			assert.match(
				messages([change(file, "", true)]).join("\n"),
				/secret or credential file/u,
				file,
			);
		}
		for (const file of [
			"src/env.ts",
			"keyboard.ts",
			"docs/keys.md",
			"identity.ts",
		])
			assert.equal(isSecretFile(file), false, file);
		assert.deepEqual(messages([change(".env", "", false)]), []);
	});

	it("rejects registry tokens and private key material", () => {
		assert.match(
			messages([
				change(".npmrc", "//registry.npmjs.org/:_authToken=abc"),
			]).join(),
			/package registry credential/u,
		);
		assert.match(
			messages([
				change(
					"fixture.txt",
					`-----BEGIN ${words("OPENSSH", "PRIVATE")} KEY-----`,
				),
			]).join(),
			/private key material/u,
		);
	});

	it("rejects credential reads from the environment in code", () => {
		const reads = [
			envRead("NPM_TOKEN"),
			envRead("STRIPE_SECRET"),
			envRead("OPENAI_API_KEY"),
			envRead("DB_PASSWORD"),
			envRead("GOOGLE_APPLICATION_CREDENTIALS"),
			envRead("AZURE_CLIENT_SECRET"),
			envRead("INFISICAL_PROJECT_ID"),
			`const t = ${["process", "env"].join(".")}["CF_API_TOKEN"];`,
			`const { VERCEL_TOKEN, PORT } = ${["process", "env"].join(".")};`,
			`const t = options.${["env", "HOSTINGER_API_TOKEN"].join(".")};`,
		];
		for (const line of reads)
			assert.match(
				messages([change("src/tool.ts", line)]).join(),
				/reads the credential .* from the environment.*owner-store-session/u,
				line,
			);
		assert.match(
			messages([
				change("tool.py", `t = ${["os", "getenv"].join(".")}("HF_TOKEN")`),
			]).join(),
			/HF_TOKEN/u,
		);
		assert.match(
			messages([change("run.sh", `curl -H "x: $${"SLACK_TOKEN"}"`)]).join(),
			/SLACK_TOKEN/u,
		);
		assert.deepEqual(
			messages([change("run.sh", 'for key in a b; do echo "$key"; done')]),
			[],
		);
		for (const line of [
			envRead("PORT"),
			envRead("HOBO_CI_RELAY_URL"),
			envRead("GITHUB_TOKEN"),
		])
			assert.deepEqual(messages([change("src/tool.ts", line)]), [], line);
		assert.deepEqual(messages([change("notes.md", envRead("NPM_TOKEN"))]), []);
		assert.equal(isCredentialName("github_token"), false);
		assert.equal(isCredentialName("ACCESS_KEY"), true);
	});

	it("rejects env:// credential locators anywhere", () => {
		for (const file of ["src/deploy.ts", "README.md", "agent.json.example"])
			assert.match(
				messages([
					change(file, `credentialRef: "${locator("CLOUDFLARE_API_TOKEN")}"`),
				]).join(),
				/env:\/\/CLOUDFLARE_API_TOKEN.*owner:\/\/CLOUDFLARE_API_TOKEN/u,
				file,
			);
		assert.deepEqual(
			messages([change("README.md", "`env://<NAME>` is refused")]),
			[],
		);
	});

	it("rejects personal GitHub tokens and accepts only the App and the per-job token", () => {
		const fine = [
			"github",
			["p", "at"].join(""),
			"11ABCDEFG0123456789abcdef",
		].join("_");
		const classic = ["gh", "p_", "a".repeat(36)].join("");
		const rejected = [
			change(
				"src/release.ts",
				`credentialRef: "owner://${["GITHUB", "RELEASE", "TOKEN"].join("_")}"`,
			),
			change(
				"src/fleet.ts",
				`const ref = "${["HOBO", "CI", "GITHUB", ["P", "AT"].join("")].join("_")}";`,
			),
			change("src/fixture.test.ts", `const token = "${fine}";`),
			change("src/fixture.test.ts", `const token = "${classic}";`),
			change("scripts/status.mts", `run("${words("gh", "auth", "token")}")`),
			change(
				"docs/setup.md",
				words(
					"Create",
					"a",
					"GitHub",
					"personal",
					"access",
					"token",
					"with",
					"repo",
					"scope.",
				),
			),
			change(
				"docs/setup.md",
				words("Paste", "a", "fine-grained", "token", "for", "GitHub."),
			),
		];
		for (const added of rejected)
			assert.match(messages([added]).join(), /GitHub App/u, added.content);
		assert.deepEqual(
			messages([
				change("src/app.ts", 'const id = "HOBO_CI_GITHUB_APP_ID";'),
				change("src/job.ts", `const name = "${"GITHUB_TOKEN"}";`),
				change(
					".github/workflows/ci.yml",
					"      GH_TOKEN: ${{ github.token }}",
				),
				change(
					"docs/setup.md",
					"Install HoBo's GitHub App and HoBo mints installation tokens.",
				),
			]),
			[],
		);
	});

	it("rejects commands that store secrets or variables", () => {
		const commands = [
			words("gh", "secret", "set", "NPM_TOKEN"),
			words("gh", "secret", "delete", "NPM_TOKEN"),
			words("gh", "variable", "set", "TURBO_TEAM", "--body", "x"),
			words("gh", "api", "-X", "PUT", "repos/o/r/actions/secrets/NAME"),
			words("vercel", "env", "add", "TOKEN", "production"),
			words("vercel", "env", "pull"),
			words("infisical", "secrets", "set", "A=b"),
			words("export", "HOSTINGER_API_TOKEN=abc"),
			words("echo", "A=b", ">>", ".env"),
			words("printf", "x", "|", "tee", "apps/web/.env.local"),
			words("git", "config", "--global", "credential.helper", "store"),
			words("npm", "config", "set", "//r/:_authToken", "x"),
		];
		for (const command of commands)
			assert.match(
				messages([change("scripts/setup.sh", command)]).join(),
				/runs a command that/u,
				command,
			);
		assert.match(
			messages([
				change("docs/setup.md", ["```sh", commands[0], "```"].join("\n")),
			]).join(),
			/:2: runs a command/u,
		);
		assert.deepEqual(
			messages([change("docs/setup.md", `Never run \`${commands[0]}\`.`)]),
			[],
		);
		assert.deepEqual(
			messages([
				change(
					"packages/hobo-ci/src/store.ts",
					`run("${words("infisical", "secrets", "set")}")`,
				),
			]),
			[],
		);
		assert.deepEqual(
			messages([change("scripts/setup.sh", words("export", "PORT=3000"))]),
			[],
		);
	});
});

describe("secrets:guard store coordinates", () => {
	it("tells real-looking coordinates from obviously synthetic ones", () => {
		for (const value of [realUuid, realTeam, realProject])
			assert.equal(isRealLookingCoordinate(value), true);
		for (const value of [
			syntheticUuid,
			"00000000-0000-4000-8000-000000000002",
			"11111111-1111-1111-1111-111111111111",
			"team_synthetic",
			"team_000000000000000000000000",
			"prj_0000000000000000000000000000",
			"relay-identity",
			"secret-store:hobo-ci-relay:connect-1",
		])
			assert.equal(isRealLookingCoordinate(value), false, value);
		assert.equal(isFixturePath("packages/a/data-models/fixtures/x.json"), true);
		assert.equal(isFixturePath("packages/a/test/x.ts"), true);
		assert.equal(isFixturePath("packages/a/deploy/x.binding.json"), false);
	});

	it("rejects real-looking coordinates under store coordinate keys in JSON, YAML and TypeScript, fixtures included", () => {
		for (const key of [
			"projectId",
			"relayIdentityId",
			"deployIdentityId",
			"deployCredentialIdentityId",
			"deployProjectId",
		])
			for (const { file, text } of [
				{
					file: "packages/a/deploy/store.json",
					text: `{ "${key}": "${realUuid}" }`,
				},
				{ file: "packages/a/deploy/store.yaml", text: `${key}: ${realUuid}` },
				{
					file: "packages/a/src/store.ts",
					text: `const binding = { ${key}: "${realUuid}" };`,
				},
				{
					file: "packages/a/test/fixtures/store.json",
					text: `{ "${key}": "${realUuid}" }`,
				},
			]) {
				const found = messages([change(file, text)]);
				assert.equal(found.length, 1, `${file} ${key}`);
				assert.match(found[0] ?? "", /real-looking store coordinate/u);
				assert.match(found[0] ?? "", /owner's secret store/u);
				assert.equal(found[0]?.includes(realUuid), false);
			}
		assert.equal(
			messages([
				change("packages/a/src/team.ts", `vercelTeamId: "${realTeam}"`),
			]).length,
			1,
		);
		assert.equal(
			messages([
				change(
					"packages/a/src/project.ts",
					`deployProjectId: "${realProject}"`,
				),
			]).length,
			1,
		);
	});

	it("admits synthetic coordinates and unrelated identifiers", () => {
		assert.deepEqual(
			messages([
				change(
					"packages/a/test/fixtures/store.json",
					`{ "projectId": "${syntheticUuid}", "vercelTeamId": "team_synthetic", "claimBundleId": "secret-store:hobo-ci-relay:connect-1" }`,
				),
				change("packages/a/src/other.ts", `const traceId = "${realUuid}";`),
			]),
			[],
		);
	});

	it("rejects binding files with real-looking ids outside fixtures, and the bundled binding anywhere", () => {
		const binding = JSON.stringify({
			kind: "infisical-cloud-attach",
			relay: realUuid,
		});
		assert.match(
			messages([
				change("packages/a/deploy/store.binding.json", binding, true),
			]).join("\n"),
			/binding file with real-looking store coordinates/u,
		);
		assert.deepEqual(
			messages([
				change(
					"packages/a/data-models/fixtures/valid/store.binding.json",
					binding,
					true,
				),
			]).filter((line) => line.includes("binding file")),
			[],
		);
		assert.match(
			messages([
				change(
					"packages/ci-vercel/deploy/secret-store.binding.json",
					JSON.stringify({ projectId: syntheticUuid }),
					true,
				),
			]).join("\n"),
			/bundles into a deployment/u,
		);
	});
});

describe("secrets:guard modes", () => {
	it("checks staged additions only", () => {
		const repository = fixture();
		write(repository, "tool.ts", `${envRead("NPM_TOKEN")}\n`);
		assert.equal(guard(repository, "--staged").status, 0);
		git(repository, ["add", "tool.ts"]);
		const result = guard(repository, "--staged");
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/^tool\.ts:1: reads the credential NPM_TOKEN/mu,
		);
	});

	it("checks the branch diff against its base and ignores what the base already has", () => {
		const repository = fixture();
		write(repository, "old.ts", `${envRead("OLD_TOKEN")}\n`);
		git(repository, ["add", "."]);
		git(repository, ["commit", "--quiet", "-m", "existing"]);
		git(repository, ["switch", "--quiet", "-c", "feature"]);
		write(
			repository,
			"old.ts",
			`${envRead("OLD_TOKEN")}\nexport const more = 2;\n`,
		);
		git(repository, ["commit", "--quiet", "-am", "unrelated"]);
		assert.equal(guard(repository, "--base=main").status, 0);
		write(
			repository,
			".github/workflows/ci.yml",
			"env:\n  A: ${{ vars.TURBO_TEAM }}\n",
		);
		git(repository, ["add", "."]);
		git(repository, ["commit", "--quiet", "-m", "adds a variable"]);
		const result = guard(repository, "--base=main");
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/\.github\/workflows\/ci\.yml:2: .*TURBO_TEAM/u,
		);
	});

	it("checks untracked and ignored secret files in the worktree", () => {
		const repository = fixture();
		assert.equal(guard(repository, "--worktree").status, 0);
		write(repository, ".env", "A=1\n");
		const result = guard(repository, "--worktree");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /^\.env:1: adds a secret or credential file/mu);
	});

	it("does not count a merged parent's lines as staged additions", () => {
		const repository = fixture();
		git(repository, ["switch", "--quiet", "-c", "other"]);
		write(repository, "from-main.ts", `${envRead("MAIN_TOKEN")}\n`);
		git(repository, ["add", "."]);
		git(repository, ["commit", "--quiet", "-m", "main side"]);
		git(repository, ["switch", "--quiet", "main"]);
		write(repository, "mine.ts", "export const mine = 1;\n");
		git(repository, ["add", "."]);
		git(repository, ["commit", "--quiet", "-m", "branch side"]);
		git(repository, ["merge", "--quiet", "--no-commit", "--no-ff", "other"]);
		assert.equal(guard(repository, "--staged").status, 0);
	});
});
