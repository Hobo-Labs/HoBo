import { readFileSync } from "node:fs";
import { defineCiPolicy } from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import {
	applyCiEnvironmentPolicy,
	ciEnvironmentPolicySha256,
	ciEnvironmentSecretsSha256,
	createConfiguredCiRelayClient,
	defineCiProjectConfig,
	parseCiProjectConfig,
	requiredCiSecrets,
	selectCiEnvironment,
} from "../src/project-config.js";

const policy = JSON.parse(
	readFileSync(
		new URL(
			"../../ci/data-models/fixtures/valid/desired-policy.json",
			import.meta.url,
		),
		"utf8",
	),
);
function profile(relayOrigin: string, accountId: string, limitMicros: number) {
	return {
		relayOrigin,
		policy: {
			...structuredClone(policy),
			accountId,
			tenantId: accountId,
			budget: { ...policy.budget, limitMicros },
		},
	};
}
function input() {
	return {
		defaultEnvironment: "local",
		environments: {
			local: {
				...profile("http://127.0.0.1:8080", "dev", 1000),
				allowInsecureLoopback: true,
			},
			integration: profile("https://ci.example.test/", "integration", 9000),
		},
	};
}
const targets = [
	{ environment: "local", origin: "http://127.0.0.1:8080", accountId: "dev" },
	{
		environment: "integration",
		origin: "https://ci.example.test",
		accountId: "integration",
	},
];

describe("repository CI environment configuration", () => {
	it("declares immutable environment-specific secret requirements without values", () => {
		const source = input();
		const secrets = {
			HOBO_CONTROL_TOKEN: { requiredFor: ["deployment", "execution"] as const },
			GITHUB_APP_KEY: { requiredFor: ["execution"] as const },
		};
		const config = defineCiProjectConfig({
			...source,
			environments: {
				...source.environments,
				local: { ...source.environments.local, secrets },
			},
		});
		expect(requiredCiSecrets(config, "local", "deployment")).toEqual([
			"HOBO_CONTROL_TOKEN",
		]);
		expect(requiredCiSecrets(config, "local", "execution")).toEqual([
			"GITHUB_APP_KEY",
			"HOBO_CONTROL_TOKEN",
		]);
		expect(requiredCiSecrets(config, "integration", "execution")).toEqual([]);
		const selected = selectCiEnvironment(config, "local");
		expect(Object.isFrozen(selected.secrets)).toBe(true);
		expect(
			Object.isFrozen(selected.secrets.HOBO_CONTROL_TOKEN?.requiredFor),
		).toBe(true);
		expect(() => requiredCiSecrets(config, "", "deployment")).toThrow();
		// SAFETY: This deliberately bypasses the type to test runtime input validation.
		expect(() =>
			requiredCiSecrets(config, "local", "other" as never),
		).toThrow();
	});

	it("rejects inline values, unsupported secret sources and invalid declarations", () => {
		const base = input();
		for (const secrets of [
			{ TOKEN: { requiredFor: ["execution"], value: "hidden-value" } },
			{
				TOKEN: {
					requiredFor: ["deployment"],
					source: "https://secret.example",
				},
			},
			{ TOKEN: { requiredFor: [] } },
			{ TOKEN: { requiredFor: ["execution", "execution"] } },
			{ TOKEN: { requiredFor: ["unknown"] } },
			{ "bad-name": { requiredFor: ["execution"] } },
		]) {
			const text = JSON.stringify({
				...base,
				environments: { local: { ...base.environments.local, secrets } },
			});
			expect(() => parseCiProjectConfig(text)).toThrow(
				"invalid CI project configuration",
			);
			try {
				parseCiProjectConfig(text);
			} catch (error) {
				expect(String(error)).not.toContain("hidden-value");
			}
		}
	});

	it("pins secret declarations and their target independently from the policy digest", async () => {
		const base = input();
		const config = (
			secrets:
				| Readonly<Record<string, { readonly requiredFor: readonly string[] }>>
				| undefined,
			relayOrigin = base.environments.local.relayOrigin,
		) =>
			parseCiProjectConfig(
				JSON.stringify({
					...base,
					environments: {
						...base.environments,
						local: { ...base.environments.local, relayOrigin, secrets },
					},
				}),
			);
		const first = config({
			A: { requiredFor: ["execution", "deployment"] },
			B: { requiredFor: ["execution"] },
		});
		const equivalent = config({
			B: { requiredFor: ["execution"] },
			A: { requiredFor: ["deployment", "execution"] },
		});
		const changed = config({
			A: { requiredFor: ["deployment"] },
			B: { requiredFor: ["execution"] },
		});
		expect(await ciEnvironmentSecretsSha256(first, "local")).toBe(
			await ciEnvironmentSecretsSha256(equivalent, "local"),
		);
		expect(await ciEnvironmentSecretsSha256(first, "local")).not.toBe(
			await ciEnvironmentSecretsSha256(changed, "local"),
		);
		expect(await ciEnvironmentPolicySha256(first, "local")).toBe(
			await ciEnvironmentPolicySha256(changed, "local"),
		);
		expect(await ciEnvironmentSecretsSha256(first, "local")).not.toBe(
			await ciEnvironmentSecretsSha256(
				config(first.environments.local?.secrets, "http://127.0.0.1:9090"),
				"local",
			),
		);
	});
	it("loads the shipped local and hosted example profiles", () => {
		const config = parseCiProjectConfig(
			readFileSync(
				new URL("../examples/project/ci.json", import.meta.url),
				"utf8",
			),
		);
		expect(selectCiEnvironment(config, "local")).toMatchObject({
			relayOrigin: "http://127.0.0.1:8787",
			policy: { accountId: "local-ci", budget: { limitMicros: 1000000 } },
		});
		expect(selectCiEnvironment(config, "integration")).toMatchObject({
			relayOrigin: "https://ci.example.com",
			policy: { accountId: "integration-ci", budget: { limitMicros: 5000000 } },
		});
	});

	it("selects immutable endpoints and distinct authored budgets", () => {
		const source = input();
		const config = defineCiProjectConfig(source);
		source.environments.local.policy.budget.limitMicros = 2;
		expect(selectCiEnvironment(config)).toMatchObject({
			name: "local",
			relayOrigin: "http://127.0.0.1:8080",
			policy: { accountId: "dev", budget: { limitMicros: 1000 } },
		});
		expect(selectCiEnvironment(config, "integration")).toMatchObject({
			relayOrigin: "https://ci.example.test",
			policy: { accountId: "integration", budget: { limitMicros: 9000 } },
		});
		expect(Object.isFrozen(config.environments)).toBe(true);
		expect(Object.isFrozen(config.environments.local?.policy.budget)).toBe(
			true,
		);
		expect(() => selectCiEnvironment(config, "missing")).toThrow();
	});

	it("records a public GitHub ingress separately from the local control endpoint", () => {
		const source = input();
		const config = defineCiProjectConfig({
			...source,
			environments: {
				...source.environments,
				local: {
					...source.environments.local,
					githubWebhookOrigin: "https://tunnel.example.test/",
				},
			},
		});
		expect(selectCiEnvironment(config, "local")).toMatchObject({
			relayOrigin: "http://127.0.0.1:8080",
			githubWebhookOrigin: "https://tunnel.example.test",
		});
		expect(
			selectCiEnvironment(config, "integration").githubWebhookOrigin,
		).toBeUndefined();
	});

	it.each([
		"http://tunnel.example.test",
		"https://localhost",
		"https://nested.localhost.",
		"https://127.1",
		"https://10.0.0.1",
		"https://100.64.1.1",
		"https://172.16.1.1",
		"https://192.168.1.1",
		"https://[::1]",
		"https://[::ffff:127.0.0.1]",
		"https://[fd00::1]",
		"https://[fe80::1]",
		"https://user:secret@tunnel.example.test",
		"https://tunnel.example.test/webhook",
	])("rejects an unsafe declared GitHub ingress %s", (githubWebhookOrigin) => {
		const source = input();
		expect(() =>
			defineCiProjectConfig({
				...source,
				environments: {
					...source.environments,
					local: { ...source.environments.local, githubWebhookOrigin },
				},
			}),
		).toThrow("invalid CI project configuration");
	});

	it("composes an SDK-authored policy without accepting extra runtime fields", () => {
		const source = input();
		const authored = defineCiPolicy(source.environments.integration.policy);
		const config = defineCiProjectConfig({
			defaultEnvironment: "integration",
			environments: {
				integration: {
					relayOrigin: "https://ci.example.test",
					policy: authored,
				},
			},
		});
		expect(selectCiEnvironment(config).policy.accountId).toBe("integration");
		const unsafe = input();
		unsafe.environments.integration.policy.spentMicros = 1;
		expect(() => defineCiProjectConfig(unsafe)).toThrow();
	});

	it("merges organization defaults with whole repository profile overrides", () => {
		const organization = defineCiProjectConfig(input());
		const repo = parseCiProjectConfig(
			JSON.stringify({
				environments: {
					integration: profile("https://repo.example.test", "repo", 7000),
				},
			}),
			organization,
		);
		expect(selectCiEnvironment(repo).name).toBe("local");
		expect(selectCiEnvironment(repo, "integration")).toMatchObject({
			relayOrigin: "https://repo.example.test",
			policy: { accountId: "repo", budget: { limitMicros: 7000 } },
		});
		expect(selectCiEnvironment(organization, "integration").relayOrigin).toBe(
			"https://ci.example.test",
		);
	});

	it("hashes normalized policy rather than JSON key order or formatting", async () => {
		const source = input();
		const reordered = input();
		reordered.environments.integration.policy = Object.fromEntries(
			Object.entries(reordered.environments.integration.policy).reverse(),
		);
		const original = defineCiProjectConfig(source);
		const reformatted = parseCiProjectConfig(
			JSON.stringify(reordered, null, 2),
		);
		expect(await ciEnvironmentPolicySha256(reformatted, "integration")).toBe(
			await ciEnvironmentPolicySha256(original, "integration"),
		);
	});

	it("does not use declarative GitHub ingress as a credential destination or policy input", async () => {
		const source = input();
		const base = defineCiProjectConfig(source);
		const declared = defineCiProjectConfig({
			...source,
			environments: {
				...source.environments,
				integration: {
					...source.environments.integration,
					githubWebhookOrigin: "https://hook.example.test",
				},
			},
		});
		expect(await ciEnvironmentPolicySha256(declared, "integration")).toBe(
			await ciEnvironmentPolicySha256(base, "integration"),
		);
		const requests: string[] = [];
		const client = createConfiguredCiRelayClient(declared, "integration", {
			trustedTargets: targets,
			accountToken: () => "TEST_ONLY",
			fetch: async (url) => {
				requests.push(String(url));
				return Response.json({ revision: 1, account: { id: "integration" } });
			},
		});
		await client.getPolicy();
		expect(requests).toEqual([
			"https://ci.example.test/v1/accounts/self/policy",
		]);
	});

	it("accepts the relayJobs and checks blocks relay mode reads (ADR-0183), strictly", () => {
		const relayMode = {
			...input(),
			relayJobs: { answer: true, label: "hobo-relay" },
			checks: { prTitle: { types: ["feat", "fix"] }, lint: false },
		};
		expect(
			parseCiProjectConfig(JSON.stringify(relayMode)).defaultEnvironment,
		).toBe("local");
		for (const broken of [
			{ ...relayMode, relayJobs: { answer: "yes" } },
			{ ...relayMode, relayJobs: { answer: true, extra: 1 } },
			{ ...relayMode, checks: { lint: true, prTitle: { types: ["no-dash"] } } },
		])
			expect(() => parseCiProjectConfig(JSON.stringify(broken))).toThrow(
				"invalid CI project configuration",
			);
	});

	it("rejects unsafe URLs, embedded secrets and duplicate billing targets", () => {
		for (const relayOrigin of [
			"http://relay.example.test",
			"https://user:secret@relay.example.test",
			"https://relay.example.test/path",
			"https://relay.example.test/?token=secret",
		]) {
			const config = input();
			config.environments.integration.relayOrigin = relayOrigin;
			expect(() => defineCiProjectConfig(config)).toThrow(
				"invalid CI project configuration",
			);
		}
		const local = input();
		local.environments.local.allowInsecureLoopback = false;
		expect(() => defineCiProjectConfig(local)).toThrow();
		const duplicate = input();
		duplicate.environments.local = {
			...profile("https://shared.example.test", "dev", 1000),
			allowInsecureLoopback: false,
		};
		duplicate.environments.integration = profile(
			"https://shared.example.test",
			"dev",
			9,
		);
		expect(() => defineCiProjectConfig(duplicate)).toThrow();
		expect(() =>
			parseCiProjectConfig(JSON.stringify({ ...input(), token: "secret" })),
		).toThrow("invalid CI project configuration");
	});

	it("does not obtain credentials for an untrusted or swapped environment binding", () => {
		const credentials = vi.fn(() => "sensitive-test-token");
		const original = input();
		const config = defineCiProjectConfig(original);
		expect(() =>
			createConfiguredCiRelayClient(config, "local", {
				trustedTargets: targets.slice(1),
				accountToken: credentials,
			}),
		).toThrow("not trusted");
		// Both origins are independently trusted, but not for the opposite name.
		const swapped = input();
		swapped.environments.local = {
			...profile("https://ci.example.test", "dev", 1000),
			allowInsecureLoopback: true,
		};
		const swappedTargets = [
			{
				environment: "local",
				origin: "http://127.0.0.1:8080",
				accountId: "dev",
			},
			{
				environment: "integration",
				origin: "https://ci.example.test",
				accountId: "dev",
			},
		];
		expect(() =>
			createConfiguredCiRelayClient(defineCiProjectConfig(swapped), "local", {
				trustedTargets: swappedTargets,
				accountToken: credentials,
			}),
		).toThrow("not trusted");
		expect(() =>
			// @ts-expect-error Verify missing environment is rejected at the JS boundary.
			createConfiguredCiRelayClient(config, undefined, {
				trustedTargets: targets,
				accountToken: credentials,
			}),
		).toThrow("explicit CI environment required");
		expect(credentials).not.toHaveBeenCalled();
	});

	it("applies only the selected endpoint's policy with its observed revision", async () => {
		const config = defineCiProjectConfig(input());
		const requests: Array<{
			url: string;
			method: string;
			revision: string | null;
			body: string;
		}> = [];
		const credentials = vi.fn(() => "test-account-token");
		const send: typeof fetch = async (url, init) => {
			const request = new Request(url, init);
			requests.push({
				url: request.url,
				method: request.method,
				revision: request.headers.get("if-match"),
				body: await request.text(),
			});
			return Response.json({
				revision: request.method === "GET" ? 7 : 8,
				account: { id: "integration" },
			});
		};
		const result = await applyCiEnvironmentPolicy(config, "integration", {
			trustedTargets: targets,
			accountToken: credentials,
			fetch: send,
			expectedPolicySha256: await ciEnvironmentPolicySha256(
				config,
				"integration",
			),
		});
		expect(result.revision).toBe(8);
		expect(
			requests.map(({ url, method, revision }) => ({ url, method, revision })),
		).toEqual([
			{
				url: "https://ci.example.test/v1/accounts/self/policy",
				method: "GET",
				revision: null,
			},
			{
				url: "https://ci.example.test/v2/accounts/self/policy",
				method: "PUT",
				revision: '"7"',
			},
		]);
		expect(JSON.parse(requests[1]?.body ?? "")).toMatchObject({
			accountId: "integration",
			budget: { limitMicros: 9000 },
		});
		expect(credentials).toHaveBeenCalledWith({
			environment: "integration",
			origin: "https://ci.example.test",
			accountId: "integration",
		});
	});

	it("refuses to write if the scoped relay account differs", async () => {
		const config = defineCiProjectConfig(input());
		const send = vi.fn(async () =>
			Response.json({ revision: 7, account: { id: "other" } }),
		);
		await expect(
			applyCiEnvironmentPolicy(config, "integration", {
				trustedTargets: targets,
				accountToken: () => "test-account-token",
				fetch: send,
				expectedPolicySha256: await ciEnvironmentPolicySha256(
					config,
					"integration",
				),
			}),
		).rejects.toThrow("account does not match");
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does not retry a stale policy revision", async () => {
		const config = defineCiProjectConfig(input());
		const send = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) =>
				init?.method === "GET"
					? Response.json({ revision: 7, account: { id: "integration" } })
					: new Response(null, { status: 409 }),
		);
		await expect(
			applyCiEnvironmentPolicy(config, "integration", {
				trustedTargets: targets,
				accountToken: () => "TEST_ONLY",
				fetch: send,
				expectedPolicySha256: await ciEnvironmentPolicySha256(
					config,
					"integration",
				),
			}),
		).rejects.toMatchObject({ status: 409 });
		expect(send).toHaveBeenCalledTimes(2);
	});

	it.each([
		"budget",
		"provider",
	])("refuses a repository-tampered %s before requesting a token", async (field) => {
		const reviewed = defineCiProjectConfig(input());
		const expectedPolicySha256 = await ciEnvironmentPolicySha256(
			reviewed,
			"integration",
		);
		const tampered = input();
		if (field === "budget")
			tampered.environments.integration.policy.budget.limitMicros = 999999;
		else
			tampered.environments.integration.policy.providers[0].runsOn = "attacker";
		const token = vi.fn(() => "TEST_ONLY");
		const send = vi.fn(async () => Response.json({}));
		await expect(
			applyCiEnvironmentPolicy(defineCiProjectConfig(tampered), "integration", {
				trustedTargets: targets,
				accountToken: token,
				fetch: send,
				expectedPolicySha256,
			}),
		).rejects.toThrow("does not match trusted digest");
		expect(token).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});
