import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { runCiProjectCli } from "../src/project-cli.js";
import {
	ciEnvironmentPolicySha256,
	ciEnvironmentSecretsSha256,
	parseCiProjectConfig,
} from "../src/project-config.js";
import { commonBudget } from "./fixtures/common-budget.js";

function policy(accountId: string, limitMicros: number) {
	return {
		accountId,
		tenantId: accountId,
		pool: { label: "hobo", os: "linux", architecture: "x64" },
		providers: [
			{
				id: "sandbox",
				kind: "vercel",
				connectionRef: "team",
				runsOn: "sandbox",
				location: "vercel",
				enabled: true,
			},
		],
		budget: {
			scope: "ci-account",
			currency: "USD",
			limitMicros,
			period: "manual",
			timeZone: "UTC",
		},
		routing: {
			strategy: "lowest-total-incremental-cost",
			noEligibleProvider: "queue",
			unknownAllocation: "zero",
		},
		thresholds: [],
	};
}

async function policyPin(
	accountId: string,
	limitMicros: number,
): Promise<string> {
	const config = parseCiProjectConfig(
		JSON.stringify({
			defaultEnvironment: "test",
			environments: {
				test: {
					relayOrigin: "https://trusted.example.test",
					policy: policy(accountId, limitMicros),
				},
			},
		}),
	);
	return ciEnvironmentPolicySha256(config, "test");
}

const servers: Server[] = [];
const directories: string[] = [];
const execute = promisify(execFile);

it("inspects the tighter common and legacy budget without contacting a relay", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-common-inspect-"));
	directories.push(directory);
	const path = join(directory, "ci.json");
	await writeFile(
		path,
		JSON.stringify({
			defaultEnvironment: "test",
			environments: {
				test: {
					relayOrigin: "https://trusted.example.test",
					policy: {
						...policy("account", 10000),
						budgetPolicy: {
							...commonBudget(),
							tenantId: "account",
							limitMicros: 1000,
						},
					},
				},
			},
		}),
	);
	let output = "";
	const fetch = vi.fn(async () => {
		throw new Error("inspection must not contact a relay");
	});
	await runCiProjectCli(
		["inspect", "--config", path, "--environment", "test"],
		{
			write: (value) => {
				output += value;
			},
			fetch,
		},
	);
	expect(JSON.parse(output)).toMatchObject({
		accountId: "account",
		budgetMicros: 1000,
	});
	expect(fetch).not.toHaveBeenCalled();
});

it("checks reviewed environment requirements against explicitly approved mounted secrets without printing values", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-secrets-cli-"));
	directories.push(directory);
	const configInput = {
		defaultEnvironment: "test",
		environments: {
			test: {
				relayOrigin: "https://trusted.example.test",
				policy: policy("account", 100),
				secrets: { CONTROL_TOKEN: { requiredFor: ["deployment"] } },
			},
		},
	};
	const configFile = join(directory, "ci.json");
	await writeFile(configFile, JSON.stringify(configInput));
	await writeFile(join(directory, "CONTROL_TOKEN"), "actual-secret-value\n");
	const digest = await ciEnvironmentSecretsSha256(
		parseCiProjectConfig(JSON.stringify(configInput)),
		"test",
	);
	const args = [
		"check-secrets",
		"--config",
		configFile,
		"--environment",
		"test",
		"--phase",
		"deployment",
		"--secret-dir",
		directory,
		"--trusted-origin",
		"https://trusted.example.test",
		"--trusted-account",
		"account",
		"--trusted-secrets-sha256",
		digest,
		"--allow-secret",
		"CONTROL_TOKEN",
	];
	let output = "";
	await runCiProjectCli(args, {
		write: (chunk) => {
			output += chunk;
		},
	});
	expect(JSON.parse(output)).toEqual({
		environment: "test",
		phase: "deployment",
		checked: ["CONTROL_TOKEN"],
	});
	expect(output).not.toContain("actual-secret-value");
	await expect(
		runCiProjectCli(
			args.filter(
				(_part, i) =>
					i !== args.indexOf("--allow-secret") &&
					i !== args.indexOf("--allow-secret") + 1,
			),
		),
	).rejects.toThrow("operator-approved");
	const swapped = [...args];
	swapped[swapped.indexOf("--trusted-secrets-sha256") + 1] = "0".repeat(64);
	await rm(join(directory, "CONTROL_TOKEN"));
	await expect(runCiProjectCli(swapped)).rejects.toThrow(
		"untrusted secret requirements",
	);
	const wrongTarget = [...args];
	wrongTarget[wrongTarget.indexOf("--trusted-origin") + 1] =
		"https://wrong.example.test";
	await expect(runCiProjectCli(wrongTarget)).rejects.toThrow(
		"binding is not trusted",
	);
});
afterEach(async () => {
	for (const server of servers.splice(0))
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

it("reads a repository file and applies the selected local or hosted account with separate credentials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-project-cli-"));
	directories.push(directory);
	const requests: Array<{
		path: string;
		authorization: string | undefined;
		match?: string;
		accountId?: string;
		budget?: number;
	}> = [];
	const server = createServer(async (req, res) => {
		const parts: Buffer[] = [];
		for await (const chunk of req) parts.push(Buffer.from(chunk));
		const raw = Buffer.concat(parts).toString("utf8");
		const input = raw ? JSON.parse(raw) : undefined;
		requests.push({
			path: req.url ?? "",
			authorization: req.headers.authorization,
			match: req.headers["if-match"],
			accountId: input?.accountId,
			budget: input?.budget?.limitMicros,
		});
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				revision: input ? 8 : 7,
				account: { id: "local-account" },
			}),
		);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = z
		.object({ port: z.number().int().positive() })
		.parse(server.address());
	const localOrigin = `http://127.0.0.1:${address.port}`;
	const hostedOrigin = "https://integration.example.test";
	const config = {
		defaultEnvironment: "local",
		environments: {
			local: {
				relayOrigin: localOrigin,
				githubWebhookOrigin: "https://tunnel.example.test",
				allowInsecureLoopback: true,
				policy: policy("local-account", 100000),
			},
			integration: {
				relayOrigin: hostedOrigin,
				policy: policy("hosted-account", 300000),
			},
		},
	};
	await writeFile(join(directory, "ci.json"), JSON.stringify(config));
	await writeFile(join(directory, "local-token"), "local-test-token\n");
	await writeFile(join(directory, "hosted-token"), "hosted-test-token\n");
	const output: string[] = [];
	await runCiProjectCli(["inspect", "--config", "ci.json"], {
		cwd: directory,
		env: { INIT_CWD: "ignored-relative-directory" },
		write: (text) => output.push(text),
	});
	expect(JSON.parse(output[0] ?? "")).toMatchObject({
		environment: "local",
		relayOrigin: localOrigin,
		githubWebhookOrigin: "https://tunnel.example.test",
		accountId: "local-account",
		budgetMicros: 100000,
		policySha256: await policyPin("local-account", 100000),
	});
	expect(requests).toHaveLength(0);
	await runCiProjectCli(
		[
			"apply",
			"--config",
			"ci.json",
			"--environment",
			"local",
			"--trusted-origin",
			localOrigin,
			"--trusted-account",
			"local-account",
			"--trusted-policy-sha256",
			await policyPin("local-account", 100000),
			"--token-file",
			"local-token",
		],
		{ env: { INIT_CWD: directory }, write: (text) => output.push(text) },
	);
	expect(requests).toEqual([
		{
			path: "/v1/accounts/self/policy",
			authorization: "Bearer local-test-token",
			match: undefined,
			accountId: undefined,
			budget: undefined,
		},
		{
			path: "/v2/accounts/self/policy",
			authorization: "Bearer local-test-token",
			match: '"7"',
			accountId: "local-account",
			budget: 100000,
		},
	]);
	const hostedFetch: typeof fetch = vi.fn(async (url, init) => {
		expect(new URL(String(url)).origin).toBe(hostedOrigin);
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer hosted-test-token",
		);
		const input = init?.body ? JSON.parse(String(init.body)) : undefined;
		if (input) {
			expect(input.accountId).toBe("hosted-account");
			expect(input.budget.limitMicros).toBe(300000);
			expect(new Headers(init?.headers).get("if-match")).toBe('"7"');
		}
		return Response.json({
			revision: input ? 8 : 7,
			account: { id: "hosted-account" },
		});
	});
	await runCiProjectCli(
		[
			"apply",
			"--config",
			"ci.json",
			"--environment",
			"integration",
			"--trusted-origin",
			hostedOrigin,
			"--trusted-account",
			"hosted-account",
			"--trusted-policy-sha256",
			await policyPin("hosted-account", 300000),
			"--token-file",
			"hosted-token",
		],
		{
			cwd: directory,
			env: {},
			fetch: hostedFetch,
			write: (text) => output.push(text),
		},
	);
	expect(hostedFetch).toHaveBeenCalledTimes(2);
	expect(output.join("")).not.toContain("test-token");
});

it("rejects untrusted or implicit write targets before accessing credentials or network", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-project-trust-"));
	directories.push(directory);
	await writeFile(
		join(directory, "ci.json"),
		JSON.stringify({
			defaultEnvironment: "integration",
			environments: {
				integration: {
					relayOrigin: "https://changed.example.test",
					policy: policy("hosted-account", 300000),
				},
			},
		}),
	);
	const send = vi.fn();
	await expect(
		runCiProjectCli(["inspect"], { env: { INIT_CWD: "not-absolute" } }),
	).rejects.toThrow(/invalid initial working directory/);
	await expect(
		runCiProjectCli(
			[
				"apply",
				"--config",
				"ci.json",
				"--environment",
				"integration",
				"--trusted-origin",
				"https://expected.example.test",
				"--trusted-account",
				"hosted-account",
				"--trusted-policy-sha256",
				await policyPin("hosted-account", 300000),
				"--token-file",
				"missing",
			],
			{ cwd: directory, env: {}, fetch: send },
		),
	).rejects.toThrow(/not trusted/);
	await expect(
		runCiProjectCli(
			[
				"apply",
				"--config",
				"ci.json",
				"--trusted-origin",
				"https://changed.example.test",
				"--trusted-account",
				"hosted-account",
				"--trusted-policy-sha256",
				await policyPin("hosted-account", 300000),
				"--token-file",
				"missing",
			],
			{ cwd: directory, env: {}, fetch: send },
		),
	).rejects.toThrow(/explicit environment/);
	await expect(
		runCiProjectCli(
			[
				"apply",
				"--config",
				"ci.json",
				"--environment",
				"integration",
				"--trusted-origin",
				"https://changed.example.test",
				"--trusted-account",
				"hosted-account",
				"--trusted-policy-sha256",
				await policyPin("hosted-account", 100000),
				"--token-file",
				"missing",
			],
			{ cwd: directory, env: {}, fetch: send },
		),
	).rejects.toThrow(/trusted digest/);
	expect(send).not.toHaveBeenCalled();
});

it("refuses to apply when the authenticated relay resolves to a different account", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-project-account-"));
	directories.push(directory);
	await writeFile(
		join(directory, "ci.json"),
		JSON.stringify({
			defaultEnvironment: "integration",
			environments: {
				integration: {
					relayOrigin: "https://integration.example.test",
					policy: policy("expected-account", 300000),
				},
			},
		}),
	);
	const send: typeof fetch = vi.fn(async (_url, init) => {
		expect(init?.method).toBe("GET");
		return Response.json({ revision: 7, account: { id: "other-account" } });
	});
	await expect(
		runCiProjectCli(
			[
				"apply",
				"--config",
				"ci.json",
				"--environment",
				"integration",
				"--trusted-origin",
				"https://integration.example.test",
				"--trusted-account",
				"expected-account",
				"--trusted-policy-sha256",
				await policyPin("expected-account", 300000),
			],
			{
				cwd: directory,
				env: { HOBO_CI_ACCOUNT_TOKEN: "fixture-token" },
				fetch: send,
			},
		),
	).rejects.toThrow(/account does not match/);
	expect(send).toHaveBeenCalledTimes(1);
});

it("loads organization profiles and uses an entire repository override without trusting its target", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-project-org-"));
	directories.push(directory);
	await writeFile(
		join(directory, "organization.json"),
		JSON.stringify({
			defaultEnvironment: "integration",
			environments: {
				integration: {
					relayOrigin: "https://organization.example.test",
					policy: policy("organization-account", 100000),
				},
				local: {
					relayOrigin: "http://127.0.0.1:8787",
					allowInsecureLoopback: true,
					policy: policy("local-account", 200000),
				},
			},
		}),
	);
	await writeFile(
		join(directory, "ci.json"),
		JSON.stringify({
			environments: {
				integration: {
					relayOrigin: "https://repo.example.test",
					policy: policy("repo-account", 300000),
				},
			},
		}),
	);
	const output: string[] = [];
	await runCiProjectCli(
		[
			"inspect",
			"--organization-config",
			"organization.json",
			"--config",
			"ci.json",
		],
		{ cwd: directory, env: {}, write: (text) => output.push(text) },
	);
	expect(JSON.parse(output[0] ?? "")).toMatchObject({
		environment: "integration",
		relayOrigin: "https://repo.example.test",
		accountId: "repo-account",
		budgetMicros: 300000,
	});
	await runCiProjectCli(
		[
			"inspect",
			"--organization-config",
			"organization.json",
			"--config",
			"ci.json",
			"--environment",
			"local",
		],
		{ cwd: directory, env: {}, write: (text) => output.push(text) },
	);
	expect(JSON.parse(output[1] ?? "")).toMatchObject({
		environment: "local",
		accountId: "local-account",
		budgetMicros: 200000,
	});
	const send = vi.fn();
	await expect(
		runCiProjectCli(
			[
				"apply",
				"--organization-config",
				"organization.json",
				"--config",
				"ci.json",
				"--environment",
				"integration",
				"--trusted-origin",
				"https://organization.example.test",
				"--trusted-account",
				"organization-account",
				"--trusted-policy-sha256",
				await policyPin("repo-account", 300000),
				"--token-file",
				"missing",
			],
			{ cwd: directory, env: {}, fetch: send },
		),
	).rejects.toThrow(/not trusted/);
	expect(send).not.toHaveBeenCalled();
});

it("uses the invoking repository directory when launched by the documented pnpm script", async () => {
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
	const directory = await mkdtemp(join(repoRoot, ".hobo-ci-project-smoke-"));
	directories.push(directory);
	await mkdir(join(directory, ".hobo"));
	await writeFile(
		join(directory, ".hobo", "ci.json"),
		JSON.stringify({
			defaultEnvironment: "local",
			environments: {
				local: {
					relayOrigin: "http://127.0.0.1:8787",
					allowInsecureLoopback: true,
					policy: policy("local-account", 100000),
				},
			},
		}),
	);
	const result = await execute(
		"pnpm",
		[
			"--filter",
			"@hobo/ci-gh-actions",
			"project",
			"inspect",
			"--environment",
			"local",
		],
		{
			cwd: directory,
			env: process.env,
			timeout: 30000,
		},
	);
	const line = result.stdout.trim().split("\n").at(-1);
	expect(JSON.parse(line ?? "")).toMatchObject({
		environment: "local",
		relayOrigin: "http://127.0.0.1:8787",
		accountId: "local-account",
		budgetMicros: 100000,
	});
});
