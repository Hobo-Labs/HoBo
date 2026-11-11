import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createHoboCli } from "@hobo/cli";
import { parsePactDocument } from "@hobo/contract-harness";
import { at } from "@hobo/core/total-access";
import { type PactLifecycle, pactBackedTransport } from "@hobo/testing";
import { describe, expect, it } from "vitest";

import { createCiCommand } from "../src/ci-command.js";
import { type JsonObject, parseJsonObject } from "../src/json.js";
import type { VercelFetch } from "../src/vercel-client.js";

// `hobo ci deploy` against the REAL relay declaration
// (packages/ci-vercel/src/bindle.ts), through the CLI shell. The dry run is
// compared with the committed plan fixtures the CUE gate vets, so the record
// the schema constrains is the record the command prints. A real run goes to
// the pact-backed transport (contracts/vercel-git-deploy.pact.json). NO
// network, and no live Vercel call: nothing here reaches api.vercel.com.

const RELAY_DIR = fileURLToPath(new URL("../../ci-vercel/", import.meta.url));
const TOKEN = "synthetic-token-0123";
const TEAM = "team_hobo";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const fixture = (name: string) =>
	parseJsonObject(
		readFileSync(
			new URL(
				`../data-models/fixtures/vercel_git_deployment/valid/${name}.json`,
				import.meta.url,
			),
			"utf8",
		),
	);

const pact = parsePactDocument(
	JSON.parse(
		readFileSync(
			new URL("../contracts/vercel-git-deploy.pact.json", import.meta.url),
			"utf8",
		),
	),
);
const ENV = `/v10/projects/hobo-ci/env?teamId=${TEAM}`;
const LIST = `GET ${ENV}`;
const CREATE_ENV = `POST ${ENV}`;
const DEPLOY = `POST /v13/deployments?teamId=${TEAM}`;
const LIFECYCLE: PactLifecycle = {
	initial: "absent",
	created: "present",
	creates: [CREATE_ENV],
	answers: {
		absent: {
			[LIST]: "list project environment variables when the setting is absent",
		},
		present: {
			[LIST]: "list project environment variables holding the setting as asked",
		},
	},
	transitions: { [CREATE_ENV]: "present" },
};

// A transport no dry run and no refused run may reach.
function unreachable() {
	const sent: string[] = [];
	const fetch: VercelFetch = async (url, init) => {
		sent.push(`${init.method} ${url}`);
		throw new Error("no request may be sent");
	};
	return { fetch, sent };
}

interface Ran {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly envelope: JsonObject;
	readonly data: JsonObject;
}

async function deploy(
	args: readonly string[],
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly fetch: VercelFetch;
		readonly json?: boolean;
		readonly cwd?: string;
	},
): Promise<Ran> {
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: options.env ?? {},
				vercelFetch: options.fetch,
			}),
		},
	});
	const result = await cli.run([
		"ci",
		"deploy",
		...args,
		"--cwd",
		options.cwd ?? RELAY_DIR,
		...(options.json === false ? [] : ["--json"]),
	]);
	const envelope = options.json === false ? {} : parseJsonObject(result.stdout);
	const data = envelope.data;
	return {
		...result,
		envelope,
		data:
			data !== undefined && !Array.isArray(data) && data !== null
				? parseJsonObject(JSON.stringify(data))
				: {},
	};
}

const RELAY = [
	"--repo",
	"example/hobo",
	"--ref",
	"main",
	"--project",
	"hobo-ci",
];
const SETTING = ["--set", "HOBO_CI_PUBLIC_URL=https://ci.example.test"];

describe("hobo ci deploy --dry-run (the real relay declaration, no network)", () => {
	it("plans a preview deployment by default, with no token and no request", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[...RELAY, "--team", TEAM, ...SETTING, "--dry-run"],
			{ fetch },
		);

		expect(ran.exitCode).toBe(0);
		expect(ran.envelope).toMatchObject({
			ok: true,
			status: "dry-run",
			code: "HOBO_CI_DEPLOY_PLANNED",
		});
		expect(ran.data.plan).toEqual(fixture("relay-preview"));
		expect(ran.data.plan).toMatchObject({
			bindle: "hobo-ci-relay",
			target: "preview",
			scope: TEAM,
		});
		expect(sent).toEqual([]);
	});

	it("plans production only when asked, pinned to the commit", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[
				...RELAY,
				"--sha",
				SHA,
				"--target",
				"production",
				"--root-directory",
				"packages/ci-vercel",
				"--create-project",
				"--dry-run",
			],
			{ fetch },
		);

		expect(ran.exitCode).toBe(0);
		expect(ran.data.plan).toEqual(fixture("relay-production-own-scope"));
		expect(ran.data.plan).toMatchObject({
			target: "production",
			scope: "token-default",
			createMissingProject: true,
		});
		expect(sent).toEqual([]);
	});

	it("names the relay's resources and its secrets, and no secret's value", async () => {
		const { fetch } = unreachable();
		const ran = await deploy([...RELAY, ...SETTING, "--dry-run"], {
			fetch,
			json: false,
			// A token in the environment is not read by a dry run, and not printed.
			env: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM },
		});

		expect(ran.exitCode).toBe(0);
		expect(ran.stdout).toContain(
			"Dry run: nothing was sent to Vercel, and VERCEL_TOKEN was not read.",
		);
		expect(ran.stdout).toContain(
			"Deploy hobo-ci-relay (kv cache, secret config, queue hobo-ci, queue hobo-ci-intake, queue hobo-ci-lease-steps, schedule hobo-ci-repair, api relay)",
		);
		expect(ran.stdout).toContain(
			`to Vercel project hobo-ci, scope ${TEAM}, target preview`,
		);
		expect(ran.stdout).toContain("CRON_SECRET, HOBO_CI_BOOTSTRAP_TOKEN_SHA256,");
		expect(ran.stdout).toContain(`3. POST /v13/deployments?teamId=${TEAM}`);
		expect(`${ran.stdout}${ran.stderr}`).not.toContain(TOKEN);
	});

	it.each([
		["a declared secret", "CRON_SECRET=synthetic-cron-value-0123456789abcdef"],
		["the database connection", "DATABASE_URL=synthetic-value-0123"],
		["a secret with a plain-looking name", "HOBO_CI_CONFIG_JSON={}"],
		[
			"a secret-looking name the app never declared",
			"MY_API_TOKEN=synthetic-value-0123",
		],
		["a setting the app does not declare", "LOG_LEVEL=debug"],
		[
			"a credential under a non-secret name",
			"HOBO_CI_PUBLIC_URL=https://user:synthetic-pw@ci.example.test",
		],
	])("refuses to set %s, and never echoes its value", async (_name, setting) => {
		const { fetch, sent } = unreachable();
		const value = setting.slice(setting.indexOf("=") + 1);
		for (const mode of [["--dry-run"], []]) {
			const ran = await deploy([...RELAY, "--set", setting, ...mode], {
				fetch,
				env: { VERCEL_TOKEN: TOKEN },
			});

			expect(ran.exitCode).toBe(1);
			expect(ran.envelope).toMatchObject({
				ok: false,
				code: "HOBO_CI_DEPLOY_SETTING_REFUSED",
			});
			if (value.length > 2) expect(ran.stdout).not.toContain(value);
			// A name the app never declared is not echoed either.
			if (/^(?:MY_API_TOKEN|LOG_LEVEL)=/u.test(setting))
				expect(ran.stdout).not.toContain(setting.split("=")[0]);
			expect(ran.stdout).not.toContain(TOKEN);
		}
		expect(sent).toEqual([]);
	});

	it.each([
		[["--ref", "main", "--project", "hobo-ci"], /--repo <owner\/name>/u],
		[["--repo", "example/hobo", "--project", "hobo-ci"], /--ref/u],
		[["--repo", "example/hobo", "--ref", "main"], /--project/u],
		[
			[...RELAY, "--target", "staging"],
			/preview \(the default\) or production/u,
		],
		[[...RELAY, "--team", "my-team"], /canonical team id/u],
		[[...RELAY, "--set", "NOVALUE"], /NAME=value/u],
		[[...RELAY, ...SETTING, ...SETTING], /twice/u],
		[[...RELAY, "--sha", "0123abc"], /40-character lowercase commit sha/u],
		[[...RELAY, "--root-directory", "../elsewhere"], /--root-directory/u],
		[[...RELAY, "--project", "not a project"], /project name or id/u],
		[
			[...RELAY, "--relay", "https://ci.example.test"],
			/--relay does not apply/u,
		],
		[[...RELAY, "extra"], /no positional arguments/u],
	])("answers a usage error for %j", async (args, message) => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...args, "--dry-run"], { fetch });

		expect(ran.exitCode).toBe(2);
		expect(ran.envelope).toMatchObject({
			ok: false,
			code: "HOBO_CLI_USAGE",
			message: expect.stringMatching(message),
		});
		expect(sent).toEqual([]);
	});

	it("needs a project directory that declares a Bindle", async () => {
		const { fetch } = unreachable();
		const ran = await deploy([...RELAY, "--dry-run"], {
			fetch,
			cwd: fileURLToPath(new URL("../contracts/", import.meta.url)),
		});
		expect(ran.exitCode).toBe(2);
		expect(ran.envelope).toMatchObject({
			message: expect.stringContaining("--cwd packages/ci-vercel"),
		});
	});

	it("keeps its options off the other CI commands", async () => {
		const cli = createHoboCli({
			commands: { ci: createCiCommand({ env: {} }) },
		});
		const result = await cli.run(["ci", "status", "--ref", "main", "--json"]);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain("--ref only applies to hobo ci deploy.");
	});
});

describe("hobo ci deploy (pact-backed transport, no network)", () => {
	const env = { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM };

	it("needs VERCEL_TOKEN for a real run, and sends nothing without it", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...RELAY, ...SETTING], { fetch });

		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_AUTH_REQUIRED",
			status: "authentication-required",
		});
		expect(sent).toEqual([]);
	});

	it("sets the setting, deploys once for the whole Bindle, and prints the outputs", async () => {
		const vercel = pactBackedTransport(pact, { lifecycle: LIFECYCLE });
		const ran = await deploy([...RELAY, ...SETTING], {
			fetch: vercel.fetchImpl,
			env,
		});

		expect(ran.exitCode).toBe(0);
		// Five resources applied through the provider; one deployment.
		expect(vercel.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			LIST,
			CREATE_ENV,
			DEPLOY,
		]);
		expect(at(vercel.calls, 2).body).toEqual({
			name: "hobo-ci",
			project: "hobo-ci",
			gitSource: { type: "github", org: "example", repo: "hobo", ref: "main" },
		});
		expect(vercel.fidelityViolations()).toEqual([]);
		expect(ran.envelope).toMatchObject({ ok: true, code: "HOBO_CI_DEPLOYED" });
		expect(ran.data.outputs).toEqual({
			url: "https://hobo-ci-git-main.example.vercel.app",
			deploymentId: "dpl_preview",
			provider: "vercel",
			target: "preview",
			projectCreated: "false",
			scope: TEAM,
			artifact: "git",
			gitRepository: "example/hobo",
			gitRef: "main",
			gitSha: "",
			configCreated: "HOBO_CI_PUBLIC_URL",
			configUpdated: "",
			configUnchanged: "",
		});
		expect(ran.data.plan).toEqual(fixture("relay-preview"));
		expect(ran.stdout).not.toContain(TOKEN);

		// The same command again: the setting is as asked, so it is not written.
		const again = await deploy([...RELAY, ...SETTING], {
			fetch: vercel.fetchImpl,
			env,
			json: false,
		});
		expect(again.exitCode).toBe(0);
		expect(
			vercel.calls.slice(3).map((call) => `${call.method} ${call.path}`),
		).toEqual([LIST, DEPLOY]);
		expect(again.stdout).toContain(
			"Deployed hobo-ci-relay to Vercel project hobo-ci (preview): https://hobo-ci-git-main.example.vercel.app",
		);
		expect(again.stdout).toContain("configUnchanged: HOBO_CI_PUBLIC_URL");
		expect(again.stdout).not.toContain(TOKEN);
	});

	it("does not create a project unless asked: a missing one is a refusal", async () => {
		const vercel = pactBackedTransport(pact, { lifecycle: LIFECYCLE });
		const ran = await deploy(
			[
				"--repo",
				"example/hobo",
				"--ref",
				"main",
				"--project",
				"hobo-ci-absent",
			],
			{ fetch: vercel.fetchImpl, env },
		);

		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_VERCEL_REFUSED",
			data: { status: 404 },
			message: expect.stringContaining("Project not found"),
		});
		expect(vercel.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			DEPLOY,
		]);
	});

	it("keeps the token out of a refusal that echoes it, and out of a transport failure", async () => {
		const echoing: VercelFetch = async () => ({
			ok: false,
			status: 403,
			async text() {
				return JSON.stringify({
					error: { code: "forbidden", message: `no: Bearer ${TOKEN}` },
				});
			},
			async json() {
				return {};
			},
		});
		const throwing: VercelFetch = async (_url, init) => {
			throw new Error(`refused ${init.headers.Authorization}`);
		};
		for (const [fetch, code] of [
			[echoing, "HOBO_CI_DEPLOY_VERCEL_REFUSED"],
			[throwing, "HOBO_CI_DEPLOY_NO_ANSWER"],
		] as const) {
			for (const json of [true, false]) {
				const ran = await deploy([...RELAY, ...SETTING], { fetch, env, json });
				expect(ran.exitCode).toBe(1);
				if (json) expect(ran.envelope).toMatchObject({ ok: false, code });
				expect(`${ran.stdout}${ran.stderr}`).not.toContain(TOKEN);
			}
		}
	});
});
