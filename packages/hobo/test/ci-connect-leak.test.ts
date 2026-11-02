import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCiRunnerIntegrations } from "@hobo/ci-gh-actions/project-config";
import { afterEach, describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import { runCiConnect } from "../src/ci-connect.js";

// Synthetic, real-looking credentials generated per run. They live only in
// memory: no fixture, snapshot or file ever contains them.
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function base62(length: number): string {
	const bytes = randomBytes(length);
	let out = "";
	for (const byte of bytes) out += BASE62[byte % 62];
	// Guarantee the mixed-class shape real tokens have.
	return `aZ9${out}`.slice(0, length);
}
function b64url(length: number) {
	return randomBytes(length).toString("base64url");
}
function syntheticSecrets() {
	return {
		githubPat: `ghp_${base62(36)}`,
		fineGrained: `github_pat_${base62(22)}_${base62(59)}`,
		depotOrg: `depot_org_${base62(48)}`,
		depotProject: `depot_project_${base62(48)}`,
		boatKey: `boat_${base62(40)}`,
		blacksmith: `bsm_${base62(40)}`,
		jwt: `eyJ${b64url(18)}.eyJ${b64url(48)}.${b64url(32)}`,
		opaque: base62(48),
	};
}

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
async function repo(initial?: object) {
	const dir = await mkdtemp(join(tmpdir(), "hobo-ci-connect-"));
	dirs.push(dir);
	if (initial) {
		await import("node:fs/promises").then((fs) =>
			fs.mkdir(join(dir, ".hobo"), { recursive: true }),
		);
		await writeFile(join(dir, ".hobo/ci.json"), JSON.stringify(initial));
	}
	return dir;
}
async function config(dir: string) {
	return readFile(join(dir, ".hobo/ci.json"), "utf8").catch(() => "");
}

function assertNoLeak(
	haystacks: readonly string[],
	secrets: Record<string, string>,
) {
	const all = haystacks.join("\n");
	for (const [name, secret] of Object.entries(secrets)) {
		expect(all.includes(secret), `${name} leaked`).toBe(false);
		// Also no sizeable fragment of it.
		expect(all.includes(secret.slice(-20)), `${name} fragment leaked`).toBe(
			false,
		);
	}
}

describe("hobo ci connect never leaks credentials", () => {
	it("rejects secret values in every flag without echoing them or writing config", async () => {
		const secrets = syntheticSecrets();
		const dir = await repo({ defaultEnvironment: "ci" });
		const before = await config(dir);
		const out: string[] = [];
		for (const secret of Object.values(secrets))
			for (const [provider, values] of [
				["depot", { auth: "secret-ref", "secret-ref": secret }],
				["depot", { auth: "oidc", "project-id": secret }],
				["boat", { org: secret }],
				["blacksmith", { "runs-on": [secret] }],
				["jog", { id: secret }],
			] as const) {
				const result = await runCiConnect({
					cwd: dir,
					provider,
					values: values as never,
					env: {},
					emitProgress: (m) => out.push(m),
				});
				expect(result.ok).toBe(false);
				out.push(JSON.stringify(result));
			}
		assertNoLeak([...out, await config(dir)], secrets);
		expect(await config(dir)).toBe(before);
	});

	it("routes CLI argv through the command without leaking", async () => {
		const secrets = syntheticSecrets();
		const dir = await repo();
		const command = createCiCommand({
			env: {},
			git: async () => dir,
		});
		const out: string[] = [];
		for (const secret of Object.values(secrets)) {
			const result = await command.run({
				args: [
					"connect",
					"depot",
					"--auth",
					"secret-ref",
					"--secret-ref",
					secret,
				],
				flags: { cwd: dir } as never,
				emitProgress: (m: string) => out.push(m),
			} as never);
			out.push(JSON.stringify(result));
		}
		assertNoLeak([...out, await config(dir)], secrets);
	});

	it("strips credential env from provider ceremonies and redacts their output", async () => {
		const secrets = syntheticSecrets();
		const dir = await repo();
		const seen: NodeJS.ProcessEnv[] = [];
		const result = await runCiConnect({
			cwd: dir,
			provider: "boat",
			values: { launch: true, org: "hobo-labs" },
			env: {
				PATH: "/usr/bin",
				BOAT_API_KEY: secrets.boatKey,
				DEPOT_TOKEN: secrets.depotOrg,
				GH_TOKEN: secrets.githubPat,
				HOBO_CI_ACCOUNT_TOKEN: secrets.opaque,
			},
			run: async (_command, _args, env) => {
				seen.push(env);
				// A misbehaving provider CLI that prints credentials.
				return {
					stdout: `authorized ${secrets.jwt} ${secrets.fineGrained}`,
					stderr: `debug key=${secrets.depotProject} ${secrets.blacksmith}`,
				};
			},
		});
		expect(result.ok).not.toBe(false);
		expect(seen).toHaveLength(1);
		expect(Object.keys(seen[0] ?? {})).toEqual(["PATH"]);
		assertNoLeak([JSON.stringify(result), await config(dir)], secrets);
		expect(result.message).toContain("[REDACTED]");
	});

	it("rejects configs that embed raw credentials without echoing them (in memory only)", () => {
		const secrets = syntheticSecrets();
		for (const secret of Object.values(secrets)) {
			const json = JSON.stringify({
				integrations: [
					{
						id: "depot",
						provider: "depot",
						runsOn: ["depot-ubuntu-24.04"],
						auth: { method: "secret-ref", secretRef: secret },
					},
				],
			});
			let message = "";
			try {
				parseCiRunnerIntegrations(json);
			} catch (error) {
				message = String(error instanceof Error ? error.message : error);
			}
			expect(message).toMatch(/invalid CI runner integrations/);
			assertNoLeak([message], secrets);
		}
	});

	it("writes references only for every provider", async () => {
		const secrets = syntheticSecrets();
		const dir = await repo({ defaultEnvironment: "ci" });
		const env = {
			DEPOT_TOKEN: secrets.depotOrg,
			BOAT_API_KEY: secrets.boatKey,
		};
		const cases = [
			[
				"blacksmith",
				{ org: "hobo-labs", "runs-on": ["blacksmith-2vcpu-ubuntu-2404"] },
			],
			["depot", {}],
			[
				"depot",
				{ id: "depot-builds", auth: "oidc", "project-id": "abc123def4" },
			],
			["depot", { id: "depot-token", auth: "secret-ref" }],
			["usejog", {}],
			["boat", {}],
			[
				"boat",
				{
					id: "boat-key",
					auth: "secret-ref",
					"secret-ref": "env:BOAT_API_KEY",
				},
			],
		] as const;
		const out: string[] = [];
		for (const [provider, values] of cases) {
			const result = await runCiConnect({
				cwd: dir,
				provider,
				values: values as never,
				env,
			});
			expect(result.ok, JSON.stringify(result)).not.toBe(false);
			out.push(JSON.stringify(result));
		}
		const written = await config(dir);
		const integrations = parseCiRunnerIntegrations(written);
		expect(integrations.map((i) => `${i.id}:${i.auth.method}`)).toEqual([
			"blacksmith:github-app",
			"depot:github-app",
			"depot-builds:oidc",
			"depot-token:secret-ref",
			"jog:github-app",
			"boat:device",
			"boat-key:secret-ref",
		]);
		expect(JSON.parse(written).defaultEnvironment).toBe("ci");
		assertNoLeak([...out, written], secrets);
	});

	it("refuses auth methods a provider does not support", async () => {
		const dir = await repo();
		for (const [provider, auth] of [
			["blacksmith", "secret-ref"],
			["blacksmith", "oidc"],
			["jog", "secret-ref"],
			["boat", "oidc"],
		] as const) {
			const result = await runCiConnect({
				cwd: dir,
				provider,
				values: { auth },
				env: {},
			});
			expect(result.ok).toBe(false);
		}
		expect(await config(dir)).toBe("");
	});
});
