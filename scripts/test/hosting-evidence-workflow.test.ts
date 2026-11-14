import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectHostingEvidence } from "../ci/hosting-evidence.mts";
import { decide, relayInputDirs } from "../ci/relay-deploy-gate.mts";

const bindingText = readFileSync(
	"packages/ci-vercel/deploy/secret-store.binding.json",
	"utf8",
);
const workflow = readFileSync(".github/workflows/hosting-evidence.yml", "utf8");
const baseEnv = {
	GITHUB_ACTIONS: "true",
	GITHUB_EVENT_NAME: "workflow_dispatch",
	GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
	GITHUB_REPOSITORY_ID: "1274791462",
	GITHUB_REPOSITORY_OWNER_ID: "344805935",
	GITHUB_REF: "refs/heads/main",
	GITHUB_WORKFLOW_REF:
		"Hobo-Labs/HoBo/.github/workflows/hosting-evidence.yml@refs/heads/main",
	GITHUB_SHA: "a".repeat(40),
	ACTIONS_ID_TOKEN_REQUEST_URL:
		"https://pipelines.actions.githubusercontent.com/run/oidc?request=1",
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
};

type FakeOptions = Readonly<{ listStatus?: number }>;
function fakeTransport(options: FakeOptions = {}) {
	const calls: { method: string; url: URL }[] = [];
	const send: typeof fetch = async (resource, init) => {
		const url = new URL(String(resource));
		const method = init?.method ?? "GET";
		calls.push({ method, url });
		assert.equal(init?.redirect, "error");
		const answer = (status: number, body: string) =>
			new Response(body, {
				status,
				headers: { "content-type": "application/json" },
			});
		if (url.hostname === "pipelines.actions.githubusercontent.com") {
			assert.equal(
				url.searchParams.get("audience"),
				"https://github.com/Hobo-Labs",
			);
			return answer(200, JSON.stringify({ value: "a.b.c" }));
		}
		if (url.pathname === "/api/v1/auth/oidc-auth/login")
			return answer(
				200,
				JSON.stringify({
					accessToken: "hidden-access-token",
					expiresIn: 600,
					tokenType: "Bearer",
				}),
			);
		assert.equal(url.pathname, "/api/v4/secrets");
		assert.equal(method, "GET");
		assert.equal(url.searchParams.get("viewSecretValue"), "false");
		assert.equal(url.searchParams.get("recursive"), "false");
		assert.equal(url.searchParams.get("includeImports"), "false");
		assert.equal(url.searchParams.get("expandSecretReferences"), "false");
		if (options.listStatus)
			return answer(
				options.listStatus,
				JSON.stringify({ error: "hidden-access-token" }),
			);
		return answer(
			200,
			JSON.stringify({
				secrets: [
					{ secretKey: "HOBO_CI_CONFIG_JSON", version: 2 },
					{ secretKey: "VERCEL_TOKEN", version: 1 },
					{
						secretKey: "CUSTOM_SECRET_NAME",
						version: 1,
						secretValue: "hidden-provider-secret",
					},
				],
			}),
		);
	};
	return { send, calls };
}

describe("trusted-main hosting evidence", () => {
	it("uses the SDK to sign in and list names without printing credentials, unknown names or readiness claims", async () => {
		const fake = fakeTransport();
		const result = await inspectHostingEvidence({
			env: baseEnv,
			bindingText,
			fetch: fake.send,
		});
		assert.deepEqual(result, {
			status: "observed",
			storeAccess: "names-only",
			knownNamesPresent: ["HOBO_CI_CONFIG_JSON", "VERCEL_TOKEN"],
			ciCanDeploy: "not-evaluated",
			cdCanDeploy: "not-evaluated",
		});
		assert.deepEqual(
			fake.calls.map(({ method, url }) => [method, url.hostname, url.pathname]),
			[
				["GET", "pipelines.actions.githubusercontent.com", "/run/oidc"],
				["POST", "app.infisical.com", "/api/v1/auth/oidc-auth/login"],
				["GET", "app.infisical.com", "/api/v4/secrets"],
			],
		);
		const output = JSON.stringify(result);
		for (const secret of [
			"oidc-request-token",
			"hidden-access-token",
			"hidden-provider-secret",
			"CUSTOM_SECRET_NAME",
		]) {
			assert.equal(output.includes(secret), false);
		}
	});

	it("refuses non-main, wrong repository, wrong workflow, and untrusted OIDC origins before any request", async () => {
		for (const changed of [
			{ GITHUB_REF: "refs/heads/branch" },
			{ GITHUB_EVENT_NAME: "push" },
			{ GITHUB_REPOSITORY_ID: "999" },
			{
				GITHUB_WORKFLOW_REF:
					"Hobo-Labs/HoBo/.github/workflows/other.yml@refs/heads/main",
			},
			{ ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example/oidc" },
		]) {
			const fake = fakeTransport();
			const result = await inspectHostingEvidence({
				env: { ...baseEnv, ...changed },
				bindingText,
				fetch: fake.send,
			});
			assert.equal(result.status, "unavailable");
			assert.equal(fake.calls.length, 0);
		}
	});

	it("rejects foreign or unclaimed stores without contacting them", async () => {
		for (const change of [
			{ endpoint: "https://foreign.example" },
			{ claimState: "pending" },
		]) {
			const fake = fakeTransport();
			const foreign = { ...JSON.parse(bindingText), ...change };
			const result = await inspectHostingEvidence({
				env: baseEnv,
				bindingText: JSON.stringify(foreign),
				fetch: fake.send,
			});
			assert.equal(result.status, "unavailable");
			assert.equal(fake.calls.length, 0);
		}
	});

	it("makes at most one names request and never falls through after provider refusal", async () => {
		const fake = fakeTransport({ listStatus: 401 });
		const result = await inspectHostingEvidence({
			env: baseEnv,
			bindingText,
			fetch: fake.send,
		});
		assert.equal(result.status, "unavailable");
		assert.equal(fake.calls.length, 3);
		assert.equal(JSON.stringify(result).includes("hidden-access-token"), false);
	});

	it("limits the workflow to manual main runs and does not trigger the relay deploy gate", () => {
		assert.match(workflow, /on:\n  workflow_dispatch:/u);
		assert.doesNotMatch(workflow, /\n  (push|pull_request|schedule):/u);
		assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
		assert.match(workflow, /github\.repository == 'Hobo-Labs\/HoBo'/u);
		assert.match(workflow, /contents: read\n  id-token: write/u);
		assert.match(workflow, /persist-credentials: false/u);
		assert.match(
			workflow,
			/node --experimental-strip-types --no-warnings scripts\/ci\/hosting-evidence\.mts/u,
		);
		assert.doesNotMatch(
			workflow,
			/\b(curl|wget|adopt|ci up|cd up|deployments: write|contents: write)\b/u,
		);
		const inputDirs = relayInputDirs(readFileSync("pnpm-lock.yaml", "utf8"));
		assert.equal(
			decide({
				event: "push",
				store: "bound",
				inputDirs,
				changed: [
					".github/workflows/hosting-evidence.yml",
					"scripts/ci/hosting-evidence.mts",
					"scripts/test/hosting-evidence-workflow.test.ts",
					"scripts/lint-actions.ts",
					"docs/ci/hosting-evidence.md",
				],
			}).run,
			false,
		);
	});

	it("the workflow linter rejects a changed hosting observation recipe", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-hosting-evidence-lint-"));
		try {
			const dir = join(root, ".github", "workflows");
			mkdirSync(dir, { recursive: true });
			const file = join(dir, "hosting-evidence.yml");
			const lint = fileURLToPath(
				new URL("../lint-actions.ts", import.meta.url),
			);
			const check = () =>
				spawnSync(process.execPath, ["--experimental-strip-types", lint], {
					cwd: root,
					encoding: "utf8",
					env: {
						...process.env,
						HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY: "1",
					},
				});
			writeFileSync(file, workflow);
			assert.equal(check().status, 0);
			writeFileSync(
				file,
				workflow.replace(
					"HoBo hosting evidence (read-only)",
					"Changed hosting evidence",
				),
			);
			const altered = check();
			assert.notEqual(altered.status, 0);
			assert.match(altered.stderr, /differs from its reviewed recipe/u);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
