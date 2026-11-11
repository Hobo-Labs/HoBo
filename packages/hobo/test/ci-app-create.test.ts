import { generateKeyPairSync } from "node:crypto";
import {
	type InfisicalClient,
	InfisicalError,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import { createGithubAppManifest } from "@hobo/ci-gh-actions";
import { type CommandResult, createHoboCli } from "@hobo/cli";
import { createMemorySecretsPort, type SecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { APP_CREDENTIAL_KEYS, runCiAppCreate } from "../src/ci-app-create.js";
import { createCiCommand } from "../src/ci-command.js";

const RELAY = "https://hobo-ci.example.com";
const OWNER = 145080887;
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ type: "pkcs8", format: "pem" })
	.toString();
const SECRETS = {
	webhook: "webhook-secret-from-github-0123456789",
	client: "client-secret-from-github-0123456789",
};

const reviewed = createGithubAppManifest({
	name: "HoBo CI",
	relayUrl: RELAY,
	manifestCallbackUrl: `${RELAY}/v1/app-bootstrap/callback`,
	installationCallbackUrl: `${RELAY}/v1/app-registration/install-callback`,
});
const app = (ownerId = OWNER) => ({
	id: 4242,
	slug: "hobo-ci-test",
	owner: { id: ownerId, type: "User" },
	external_url: `${RELAY}/`,
	permissions: { ...reviewed.defaultPermissions },
	events: [...reviewed.defaultEvents],
});

/** GitHub's conversion and the App endpoints verification reads. */
function github(ownerId = OWNER) {
	const calls: string[] = [];
	const fetchStub: typeof fetch = async (input, init) => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (
			url === "https://api.github.com/app-manifests/one-time-code/conversions"
		)
			return Response.json(
				{
					...app(ownerId),
					pem,
					webhook_secret: SECRETS.webhook,
					client_id: "Iv23liTestClient",
					client_secret: SECRETS.client,
				},
				{ status: 201 },
			);
		if (url === "https://api.github.com/app")
			return Response.json(app(ownerId));
		if (url === "https://api.github.com/app/hook/config")
			return Response.json({
				url: `${RELAY}/github/webhooks`,
				content_type: "json",
				insecure_ssl: "0",
			});
		return new Response(null, { status: 404 });
	};
	return { fetch: fetchStub, calls };
}

/** Plays the person in the browser: reads the form, then follows GitHub's redirect. */
function browser(options: { state?: string; code?: string } = {}) {
	const pages: string[] = [];
	const done: Promise<void>[] = [];
	const open = (url: string) => {
		done.push(
			(async () => {
				const page = await (await fetch(url)).text();
				pages.push(page);
				const state =
					options.state ?? /[?&]state=([A-Za-z0-9_-]+)"/u.exec(page)?.[1];
				const manifest = JSON.parse(
					(/name="manifest" value="([^"]*)"/u.exec(page)?.[1] ?? "")
						.replaceAll("&quot;", '"')
						.replaceAll("&amp;", "&"),
				);
				const callback = new URL(manifest.redirect_url);
				callback.searchParams.set("code", options.code ?? "one-time-code");
				callback.searchParams.set("state", state ?? "");
				await fetch(callback);
			})(),
		);
	};
	return { open, pages, done };
}

function store(failures: { count: number } = { count: 0 }) {
	const memory = createMemorySecretsPort();
	const port: SecretsPort = {
		...memory,
		kind: "infisical",
		async put(name, value) {
			if (failures.count > 0) {
				failures.count--;
				throw new InfisicalError("write secret", "forbidden", { status: 403 });
			}
			return memory.put(name, value);
		},
	};
	let signOuts = 0;
	const client: InfisicalClient = {
		binding: parseInfisicalBinding({
			projectId: "proj-1",
			environment: "prod",
			secretPath: "/hobo-ci-relay",
		}),
		async listSecretNames() {
			return memory.names().map((secretKey) => ({ secretKey, version: 1 }));
		},
		listSecrets: () => Promise.reject(new Error("unused")),
		getSecret: () => Promise.reject(new Error("unused")),
		putSecret: () => Promise.reject(new Error("unused")),
		signOut() {
			signOuts++;
		},
	};
	return {
		client,
		port,
		memory,
		signOuts: () => signOuts,
		async value(name: string) {
			const result = await memory.access(name);
			return result.status === "ok" ? result.material : undefined;
		},
	};
}

function expectNoSecret(text: string) {
	expect(text).not.toContain("PRIVATE KEY");
	expect(text).not.toContain(SECRETS.webhook);
	expect(text).not.toContain(SECRETS.client);
}

async function run(
	overrides: Partial<Parameters<typeof runCiAppCreate>[0]> = {},
	githubFake = github(),
	people = browser(),
) {
	const progress: string[] = [];
	const result: CommandResult = await runCiAppCreate({
		relay: RELAY,
		ownerId: String(OWNER),
		replace: false,
		interactive: false,
		env: {},
		emitProgress: (message) => progress.push(message),
		fetch: githubFake.fetch,
		openBrowser: people.open,
		sleep: async () => {},
		...overrides,
	});
	await Promise.all(people.done);
	for (const line of [
		...progress,
		result.message ?? "",
		JSON.stringify(result),
	])
		expectNoSecret(line);
	return { result, progress, people, githubFake };
}

describe("hobo ci app create", () => {
	it("creates the App and deposits every credential in the config service", async () => {
		const service = store();
		const { result, people, githubFake } = await run({
			configService: service,
		});
		expect(result.ok).not.toBe(false);
		expect(await service.value("HOBO_CI_GITHUB_APP_PRIVATE_KEY")).toBe(pem);
		expect(await service.value("HOBO_CI_WEBHOOK_SECRET")).toBe(SECRETS.webhook);
		expect(await service.value("HOBO_CI_GITHUB_APP_CLIENT_SECRET")).toBe(
			SECRETS.client,
		);
		expect(await service.value("HOBO_CI_GITHUB_APP_CLIENT_ID")).toBe(
			"Iv23liTestClient",
		);
		expect(await service.value("HOBO_CI_GITHUB_APP_ID")).toBe("4242");
		expect(result.message).toContain(
			"https://github.com/apps/hobo-ci-test/installations/new",
		);
		expect(result.data).toMatchObject({
			appId: 4242,
			refs: {
				HOBO_CI_GITHUB_APP_PRIVATE_KEY:
					"infisical://proj-1/prod/hobo-ci-relay/HOBO_CI_GITHUB_APP_PRIVATE_KEY",
			},
		});
		// The form posts the reviewed manifest to GitHub, redirecting to this machine.
		expect(people.pages[0]).toContain(
			'action="https://github.com/settings/apps/new?state=',
		);
		expect(githubFake.calls[0]).toBe(
			"POST https://api.github.com/app-manifests/one-time-code/conversions",
		);
	});

	it("retries a failed deposit from memory, then succeeds", async () => {
		const service = store({ count: 2 });
		const { result, progress } = await run({
			configService: service,
			depositAttempts: 3,
		});
		expect(result.ok).not.toBe(false);
		expect(progress.filter((line) => line.includes("Retrying"))).toHaveLength(
			2,
		);
		expect(service.signOuts()).toBe(2);
		expect(service.memory.names().length).toBe(APP_CREDENTIAL_KEYS.length);
	});

	it("explains a deposit that cannot succeed, naming what was stored", async () => {
		const service = store({ count: 100 });
		const { result } = await run({
			configService: service,
			depositAttempts: 2,
		});
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_APP_DEPOSIT_FAILED",
		});
		expect(result.message).toContain("forbidden");
		expect(result.message).toContain(
			"https://github.com/settings/apps/hobo-ci-test/advanced",
		);
		expect(result.message).toContain("cannot be repeated");
		expect(service.memory.names()).toEqual([]);
	});

	it("lets the person fix Infisical and retry, or discard", async () => {
		const retried = store({ count: 1 });
		const questions: string[] = [];
		const ok = await run({
			configService: retried,
			interactive: true,
			prompt: async (question) => {
				questions.push(question);
				return "";
			},
		});
		expect(ok.result.ok).not.toBe(false);
		expect(questions).toHaveLength(1);
		expectNoSecret(questions[0] ?? "");

		const discarded = await run({
			configService: store({ count: 100 }),
			interactive: true,
			prompt: async () => "discard",
		});
		expect(discarded.result.code).toBe("HOBO_CI_APP_DEPOSIT_FAILED");
	});

	it("refuses to replace an App's credentials without --yes, before GitHub", async () => {
		const service = store();
		await service.memory.put("HOBO_CI_GITHUB_APP_ID", "1");
		const people = browser();
		const { result } = await run({ configService: service }, github(), people);
		expect(result.code).toBe("HOBO_CI_APP_EXISTS");
		expect(people.pages).toEqual([]);
	});

	it("deposits nothing when the converted App is not the reviewed one", async () => {
		const service = store();
		const { result } = await run({ configService: service }, github(999));
		expect(result.code).toBe("HOBO_CI_APP_UNVERIFIED");
		expect(result.message).toContain("advanced");
		expect(service.memory.names()).toEqual([]);
	});

	it("ignores a callback with the wrong state and times out", async () => {
		const service = store();
		const { result } = await run(
			{ configService: service, callbackTimeoutMs: 300 },
			github(),
			browser({ state: "x".repeat(43) }),
		);
		expect(result.code).toBe("HOBO_CI_APP_TIMEOUT");
		expect(service.memory.names()).toEqual([]);
	});

	it("explains how to sign in to Infisical when no credentials are set", async () => {
		const { result } = await run({
			env: { INFISICAL_PROJECT_ID: "p", INFISICAL_ENVIRONMENT: "prod" },
		});
		expect(result.code).toBe("HOBO_CI_CONFIG_SERVICE_UNCONFIGURED");
		expect(result.message).toContain("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID");
	});

	it("is reachable as hobo ci app create, with usage errors for missing input", async () => {
		const cli = createHoboCli({
			commands: { ci: createCiCommand({ env: {}, interactive: false }) },
		});
		const call = async (args: string[]) => {
			const result = await cli.run(["ci", ...args], { cwd: process.cwd() });
			expect(result.exitCode).not.toBe(0);
			return `${result.stdout}${result.stderr}`;
		};
		expect(await call(["app", "create"])).toContain("--relay");
		expect(await call(["app", "create", "--relay", RELAY])).toContain(
			"--owner-id",
		);
		expect(await call(["app", "list"])).toContain("hobo ci app create");
		expect(await call(["app", "create", "--key-file", "x"])).toContain(
			"does not apply",
		);
		expect(await call(["status", "--owner-id", "1"])).toContain(
			"only applies to hobo ci app create",
		);
		const help = await cli.run(["ci"], { cwd: process.cwd() });
		expect(help.stdout).toContain("hobo ci app create");
	});
});
