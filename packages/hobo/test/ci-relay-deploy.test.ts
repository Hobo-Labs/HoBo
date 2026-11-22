import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHoboCli } from "@hobo/cli";
import { parsePactDocument } from "@hobo/contract-harness";
import type { HttpTransport } from "@hobo/core";
import { createTrustedVault } from "@hobo/core";
import { at } from "@hobo/core/total-access";
import { type PactLifecycle, pactBackedTransport } from "@hobo/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadDeliveryFile } from "../src/cd-delivery-module.js";
import { createCiCommand } from "../src/ci-command.js";
import { RELAY_DELIVERY_FILE } from "../src/ci-relay-delivery.js";
import {
	RELAY_DEPLOY_READER_OIDC_AUDIENCE,
	readRelayDeployToken,
} from "../src/ci-relay-deploy-credential.js";
import type { VercelCliRunner } from "../src/ci-relay-provision.js";
import {
	RELAY_VERIFY_REFUSAL,
	recordVerifiedPreviewRecords,
} from "../src/ci-relay-verify.js";
import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";
import type { VercelFetch } from "../src/vercel-client.js";

// `hobo ci deploy` against the REAL relay declaration
// (packages/ci-vercel/src/bindle.ts), through the CLI shell. The dry run is
// compared with the committed plan fixtures the CUE gate vets, so the record
// the schema constrains is the record the command prints. A real run goes to
// the pact-backed transport (contracts/vercel-git-deploy.pact.json), through
// @hobo/cd (Freight, the relay pipeline, the gate and the conductor) on a
// temporary journal. NO network, and no live Vercel call: nothing here
// reaches api.vercel.com, and the verification probes answer from a fake.

const RELAY_DIR = fileURLToPath(new URL("../../ci-vercel/", import.meta.url));
const TOKEN = "synthetic-token-0123";
/** Pact corpus uses `team_hobo`; override the committed binding team in tests. */
const TEAM = "team_hobo";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const relayFixtureDir = mkdtempSync(
	join(RELAY_DIR, "..", ".ci-relay-fixture-"),
);
cpSync(RELAY_DIR, relayFixtureDir, {
	recursive: true,
	filter: (source) => !source.includes("node_modules"),
});
rmSync(join(relayFixtureDir, "package.json"), { force: true });
symlinkSync(
	join(RELAY_DIR, "node_modules"),
	join(relayFixtureDir, "node_modules"),
);
{
	const file = join(relayFixtureDir, "deploy", "secret-store.binding.json");
	const binding: Record<string, JsonValue> = Object.fromEntries(
		Object.entries(
			parseJsonObject(
				readFileSync(
					join(RELAY_DIR, "deploy", "secret-store.binding.json"),
					"utf8",
				),
			),
		),
	);
	binding.deployProjectId = "ci-deploy-project";
	binding.deployCredentialIdentityId = "ci-deploy-reader-identity";
	binding.deployOidcSubject =
		"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials";
	writeFileSync(file, `${JSON.stringify(binding, null, "\t")}\n`);
}

const legacyFixtureDir = mkdtempSync(
	join(RELAY_DIR, "..", ".ci-relay-legacy-fixture-"),
);
cpSync(RELAY_DIR, legacyFixtureDir, {
	recursive: true,
	filter: (source) => !source.includes("node_modules"),
});
rmSync(join(legacyFixtureDir, "package.json"), { force: true });
symlinkSync(
	join(RELAY_DIR, "node_modules"),
	join(legacyFixtureDir, "node_modules"),
);

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
	readonly credentialReads: number;
}

async function deploy(
	args: readonly string[],
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly fetch: VercelFetch;
		readonly json?: boolean;
		readonly cwd?: string;
		readonly vercelCli?: VercelCliRunner;
		readonly sleep?: (ms: number) => Promise<void>;
		readonly now?: () => number;
		readonly hoboHome?: string;
		readonly probe?: HttpTransport;
		readonly oidc?: boolean;
		readonly credentialFetch?: typeof fetch;
	},
): Promise<Ran> {
	const { VERCEL_TOKEN: storeToken, ...plainEnv } = options.env ?? {};
	const oidc = storeToken !== undefined && options.oidc !== false;
	const deployCredentials = createTrustedVault();
	let credentialReads = 0;
	const readDeployCredential: typeof readRelayDeployToken = async (request) => {
		credentialReads += 1;
		if (storeToken === undefined) return readRelayDeployToken(request);
		return {
			token: storeToken,
			secretRef: "infisical://ci-deploy-project/prod/VERCEL_TOKEN",
			identityId: "ci-deploy-reader-identity",
			audience: RELAY_DEPLOY_READER_OIDC_AUDIENCE,
		};
	};
	if (storeToken !== undefined)
		deployCredentials.put("VERCEL_TOKEN", storeToken);
	const env = { ...plainEnv };
	if (oidc) {
		env.ACTIONS_ID_TOKEN_REQUEST_URL =
			"https://token.actions.example.test/token?api-version=2.0";
		env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "synthetic-request-token";
	}
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env,
				deployCredentials,
				readDeployCredential,
				vercelFetch: options.fetch,
				...(options.vercelCli !== undefined
					? { vercelCli: options.vercelCli }
					: undefined),
				...(options.sleep !== undefined ? { sleep: options.sleep } : undefined),
				...(options.now !== undefined ? { now: options.now } : undefined),
				...(options.credentialFetch !== undefined
					? { credentialFetch: options.credentialFetch }
					: undefined),
				hoboHome: options.hoboHome ?? freshHome(),
				probeHttp: options.probe ?? healthyRelay().http,
			}),
		},
	});
	const teamOverride = args.includes("--team")
		? []
		: (["--team", TEAM] as const);
	const result = await cli.run([
		"ci",
		"deploy",
		...args,
		...teamOverride,
		"--cwd",
		options.cwd ?? relayFixtureDir,
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
		credentialReads,
	};
}

// A HOBO_HOME of its own for each run: the CD journal lives there. Removed
// once the file's tests are done.
const homes: string[] = [];
function freshHome(): string {
	const home = mkdtempSync(join(tmpdir(), "hobo-ci-deploy-"));
	homes.push(home);
	return home;
}
afterAll(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
	rmSync(relayFixtureDir, { recursive: true, force: true });
	rmSync(legacyFixtureDir, { recursive: true, force: true });
});

// The relay answering its probes, and the URLs it was asked for. Its
// `/healthz` names the commit its build is of, as the relay's entry does.
function healthyRelay(status = 200, commit: string = SHA) {
	const probed: string[] = [];
	const http: HttpTransport = async (request) => {
		probed.push(request.url);
		return {
			status,
			headers: { "content-type": "application/json" },
			body: request.url.endsWith("/healthz")
				? JSON.stringify({ ok: true, commit })
				: JSON.stringify({ ready: status === 200 }),
		};
	};
	return { http, probed };
}

// A clock that moves only when the command sleeps.
function steppingClock() {
	let clock = Date.UTC(2026, 10, 12, 12);
	return {
		sleep: async (ms: number) => {
			clock += ms;
		},
		now: () => clock,
	};
}

const ORIGINS = {
	HOBO_CI_RELAY_PREVIEW_URL: "https://relay-preview.example.test",
	HOBO_CI_RELAY_URL: "https://relay.example.test",
};
// deploy/delivery.ts reads its probe origins from the process environment
// when it loads, as it does when the workflow runs the command. Stubbed for
// this file only, and restored after it.
beforeAll(() => {
	for (const [name, value] of Object.entries(ORIGINS)) vi.stubEnv(name, value);
});
afterAll(() => {
	vi.unstubAllEnvs();
});

const RELAY = [
	"--repo",
	"example/hobo",
	"--ref",
	"main",
	"--project",
	"hobo-ci",
];
const SETTING = ["--set", "HOBO_CI_PUBLIC_URL=https://ci.example.test"];
// The owner's Infisical ids the production config-service binding asks for:
// identifiers, not credentials (synthetic here).
const INPUTS = [
	"--set",
	"INFISICAL_IDENTITY_ID=3f2b1c9e-8a7d-4e6f-9b0c-1d2e3f4a5b6c",
	"--set",
	"INFISICAL_PROJECT_ID=6512a1b0-c3d4-4e5f-8071-8293a4b5c6d7",
	"--set",
	"INFISICAL_SITE_URL=https://app.infisical.com",
];

describe("hobo ci deploy --dry-run (the real relay declaration, no network)", () => {
	it("plans a preview deployment with OIDC available but no credential read or request", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[...RELAY, "--team", TEAM, ...SETTING, "--dry-run"],
			{ fetch, env: { VERCEL_TOKEN: TOKEN } },
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
		expect(ran.credentialReads).toBe(0);
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
				...INPUTS,
				"--dry-run",
			],
			{ fetch },
		);

		expect(ran.exitCode).toBe(0);
		expect(ran.data.plan).toEqual(fixture("relay-production-own-scope"));
		expect(ran.data.plan).toMatchObject({
			target: "production",
			scope: TEAM,
			createMissingProject: true,
			placement: {
				yard: "hobo-ci-relay",
				camp: "hobo-ci-relay/production",
				provider: "vercel",
			},
		});
		expect(sent).toEqual([]);
	});

	it("takes the repository and the project from the Yard, and the settings from the bindings production chooses", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[
				"--ref",
				"main",
				"--sha",
				SHA,
				"--target",
				"production",
				"--team",
				TEAM,
				...INPUTS,
				"--dry-run",
			],
			{ fetch, json: false },
		);

		expect(ran.exitCode).toBe(0);
		expect(ran.stdout).toContain(
			"placed by Yard hobo-ci-relay (provider vercel, iad1), Camp hobo-ci-relay/production",
		);
		expect(ran.stdout).toContain(
			`to Vercel project hobo-ci, scope ${TEAM}, target production`,
		);
		expect(ran.stdout).toContain("from github Hobo-Labs/HoBo@main");
		expect(ran.stdout).toContain(
			"Settings set for production first (non-secret): HOBO_CI_CONFIG_SERVICE=infisical INFISICAL_ENVIRONMENT=prod INFISICAL_IDENTITY_ID=3f2b1c9e-8a7d-4e6f-9b0c-1d2e3f4a5b6c INFISICAL_PROJECT_ID=6512a1b0-c3d4-4e5f-8071-8293a4b5c6d7 INFISICAL_SECRET_PATH=/hobo-ci-relay INFISICAL_SITE_URL=https://app.infisical.com",
		);
		expect(ran.stdout).toContain(
			"secret-ref.runtime-projection/v1 -> infisical.secrets/v1 via infisical.oidc-auth/v1",
		);
		expect(ran.stdout).toContain(
			"kv.redis-compatible/v1 -> upstash.redis/v1 via vercel.marketplace/v1 (marketplace:upstash/upstash-kv)",
		);
		// The catalog's other cache backends are listed in the record, not chosen.
		expect(ran.stdout).not.toContain("-> aiven.valkey/v1");
		expect(sent).toEqual([]);
	});

	it("keeps the config service out of preview, where the relay identity cannot sign in", async () => {
		const { fetch } = unreachable();
		const ran = await deploy([...RELAY, "--dry-run"], { fetch });
		expect(ran.exitCode).toBe(0);
		expect(ran.data.plan).toMatchObject({
			target: "preview",
			placement: { camp: "hobo-ci-relay/preview" },
		});
		const plan = parseJsonObject(JSON.stringify(ran.data.plan));
		expect(JSON.stringify(plan.settings ?? [])).not.toContain("INFISICAL");
		const bindings = Array.isArray(plan.bindings) ? plan.bindings : [];
		expect(bindings).toContainEqual(
			expect.objectContaining({
				profile: "secret-ref.runtime-projection/v1",
				inputs: [
					"INFISICAL_IDENTITY_ID",
					"INFISICAL_PROJECT_ID",
					"INFISICAL_SITE_URL",
				],
			}),
		);
		expect(bindings).not.toContainEqual(
			expect.objectContaining({
				profile: "secret-ref.runtime-projection/v1",
				selected: true,
			}),
		);
	});

	it("fills production Infisical coordinates from deploy/secret-store.binding.json when present", async () => {
		const binding = parseJsonObject(
			readFileSync(
				new URL(
					"../../ci-vercel/deploy/secret-store.binding.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[...RELAY, "--target", "production", "--sha", SHA, "--dry-run"],
			{ fetch },
		);
		expect(ran.exitCode).toBe(0);
		const plan = isJsonObject(ran.data.plan) ? ran.data.plan : {};
		const rawSettings = plan.settings;
		const settings = Array.isArray(rawSettings) ? rawSettings : [];
		expect(settings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: "INFISICAL_PROJECT_ID",
					value: binding.projectId,
				}),
				expect.objectContaining({
					key: "INFISICAL_IDENTITY_ID",
					value: binding.relayIdentityId,
				}),
				expect.objectContaining({
					key: "INFISICAL_SITE_URL",
					value: binding.endpoint,
				}),
			]),
		);
		expect(sent).toEqual([]);
	});

	it("plans the committed declaration without requiring owner-provisioned ids for a dry run", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...RELAY, ...SETTING, "--dry-run"], {
			fetch,
			cwd: RELAY_DIR,
		});
		expect(ran.exitCode).toBe(0);
		expect(ran.envelope).toMatchObject({
			ok: true,
			code: "HOBO_CI_DEPLOY_PLANNED",
		});
		expect(sent).toEqual([]);
	});

	it("rejects a credential-free legacy binding before any OIDC or deploy request", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...RELAY, ...SETTING], {
			fetch,
			cwd: legacyFixtureDir,
			env: {
				ACTIONS_ID_TOKEN_REQUEST_URL:
					"https://token.actions.example.test/token?api-version=2.0",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-token",
			},
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			ok: false,
			code: "HOBO_CI_DEPLOY_AUTH_REQUIRED",
			message: expect.stringContaining("no deploy credential identity"),
		});
		expect(sent).toEqual([]);
	});

	it("refuses to override a setting the Yard's bindings set", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[
				...RELAY,
				"--target",
				"production",
				...INPUTS,
				"--set",
				"INFISICAL_ENVIRONMENT=dev",
				"--dry-run",
			],
			{ fetch },
		);
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_SETTING_REFUSED",
			message: expect.stringContaining(
				"Camp hobo-ci-relay/production's bindings set INFISICAL_ENVIRONMENT",
			),
		});
		expect(sent).toEqual([]);
	});

	it("plans what the workflow on main runs: production from the Yard, provisioning first", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[
				"--ref",
				"main",
				"--sha",
				SHA,
				"--target",
				"production",
				"--team",
				TEAM,
				"--provision",
				...INPUTS,
				"--dry-run",
			],
			{ fetch },
		);
		expect(ran.exitCode).toBe(0);
		expect(ran.data.plan).toEqual(fixture("relay-production-provision"));
		expect(sent).toEqual([]);
	});

	it("lists the Vercel CLI commands --provision would run, with no token among them", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[...RELAY, "--team", TEAM, "--provision", "--dry-run"],
			{ fetch, json: false, env: { VERCEL_TOKEN: TOKEN } },
		);
		expect(ran.exitCode).toBe(0);
		expect(ran.stdout).toContain(
			"1. vercel integration list hobo-ci --integration upstash --json",
		);
		expect(ran.stdout).toContain(
			"4. vercel integration add upstash/upstash-kv --name hobo-ci-cache --environment preview --no-env-pull --non-interactive --json",
		);
		expect(ran.stdout).not.toContain(TOKEN);
		expect(ran.stdout).not.toContain("--token");
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
			"Dry run: nothing was sent to Vercel, and no deploy token was read.",
		);
		expect(ran.stdout).toContain(
			"Deploy hobo-ci-relay (kv cache, secret config, queue hobo-ci, queue hobo-ci-intake, queue hobo-ci-lease-steps, schedule hobo-ci-repair, api relay)",
		);
		expect(ran.stdout).toContain(
			`to Vercel project hobo-ci, scope ${TEAM}, target preview`,
		);
		expect(ran.stdout).toContain(
			"CRON_SECRET, HOBO_CI_BOOTSTRAP_TOKEN_SHA256,",
		);
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
		["an Infisical access token", "INFISICAL_TOKEN=synthetic-value-0123"],
		[
			"an Infisical Universal Auth client id",
			"INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=synthetic-value-0123",
		],
		[
			"an Infisical name that is not a coordinate",
			"INFISICAL_API_URL=https://synthetic.example.test",
		],
		["the Upstash token", "UPSTASH_REDIS_REST_TOKEN=synthetic-value-0123"],
		["a Vercel KV URL", "KV_REST_API_URL=https://synthetic.example.test"],
		["the Turso URL", "TURSO_DATABASE_URL=libsql://synthetic.example.test"],
		["a libSQL URL", "LIBSQL_URL=libsql://synthetic.example.test"],
		["the Blob token", "BLOB_READ_WRITE_TOKEN=synthetic-value-0123"],
		["a Valkey URL", "VALKEY_URL=rediss://synthetic.example.test:6379"],
		["a Redis URL", "REDIS_URL=rediss://synthetic.example.test:6379"],
	])("refuses to set %s, and never echoes its value", async (_name, setting) => {
		const { fetch, sent } = unreachable();
		const value = setting.slice(setting.indexOf("=") + 1);
		for (const mode of [["--dry-run"], []]) {
			// Production too: its config-service binding's inputs are allowed,
			// and nothing else under the config service's prefix is.
			const ran = await deploy(
				[
					...RELAY,
					"--target",
					"production",
					...INPUTS,
					"--set",
					setting,
					...mode,
				],
				{ fetch, env: { VERCEL_TOKEN: TOKEN } },
			);

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
		[["--repo", "not-a-repo", "--ref", "main"], /--repo <owner\/name>/u],
		[["--repo", "example/hobo", "--project", "hobo-ci"], /--ref/u],
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

	it("needs the Bindle's Yard: without one there is no placement and no provider", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...RELAY, "--dry-run"], {
			fetch,
			cwd: fileURLToPath(
				new URL("./fixtures/relay-yards/no-yard/", import.meta.url),
			),
		});
		expect(ran.exitCode).toBe(2);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CLI_USAGE",
			message: expect.stringContaining("No Yard found here for relay-fixture"),
		});
		expect(sent).toEqual([]);
	});

	it("realizes Vercel Yards only, and says which provider the Yard named", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...RELAY, "--dry-run"], {
			fetch,
			cwd: fileURLToPath(
				new URL("./fixtures/relay-yards/other-provider/", import.meta.url),
			),
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_YARD_PROVIDER",
			message: expect.stringContaining("places relay-fixture on netlify"),
		});
		expect(sent).toEqual([]);
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

	it("needs the deploy token from the store for a real run, and sends nothing without it", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...RELAY, ...SETTING], { fetch });

		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_AUTH_REQUIRED",
			status: "authentication-required",
		});
		expect(sent).toEqual([]);
	});

	it("refuses a preloaded deploy token when the dedicated reader is unavailable", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...RELAY, ...SETTING], {
			fetch,
			env,
			oidc: false,
		});

		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_AUTH_REQUIRED",
			status: "authentication-required",
		});
		expect(ran.credentialReads).toBe(0);
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
		expect(ran.credentialReads).toBe(1);
		expect(ran.data).toMatchObject({
			deployTokenRef: "infisical://ci-deploy-project/prod/VERCEL_TOKEN",
			deployCredentialIdentityId: "ci-deploy-reader-identity",
			deployCredentialAudience: RELAY_DEPLOY_READER_OIDC_AUDIENCE,
		});
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
			yard: "hobo-ci-relay",
			camp: "hobo-ci-relay/preview",
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

// A Vercel that holds no settings, answers one deployment, and reports its
// state from `states`, one per read. Records each request as "METHOD path".
function scriptedVercel(
	states: readonly string[],
	deployment: {
		commit?: string;
		project?: string;
		projectId?: string;
		target?: string;
		readRefusal?: number;
	} = {},
) {
	const sent: string[] = [];
	let reads = 0;
	const answer = (status: number, body: JsonObject) => ({
		ok: status >= 200 && status < 300,
		status,
		async text() {
			return JSON.stringify(body);
		},
		async json() {
			return body;
		},
	});
	const fetch: VercelFetch = async (url, init) => {
		const path = url.replace("https://api.vercel.com", "");
		sent.push(`${init.method} ${path}`);
		if (init.method === "POST" && path.startsWith("/v13/deployments"))
			return answer(200, {
				id: "dpl_wait",
				url: "hobo-ci-git-main.example.vercel.app",
				readyState: "QUEUED",
			});
		if (init.method === "GET" && path.startsWith("/v13/deployments/dpl_wait")) {
			if (deployment.readRefusal !== undefined)
				return answer(deployment.readRefusal, {
					error: { code: "forbidden", message: "no read" },
				});
			const readyState = states[Math.min(reads, states.length - 1)] ?? "READY";
			reads += 1;
			return answer(200, {
				id: "dpl_wait",
				name: deployment.project ?? "hobo-ci",
				...(deployment.projectId !== undefined
					? { projectId: deployment.projectId }
					: undefined),
				url: "hobo-ci-git-main.example.vercel.app",
				readyState,
				target: deployment.target ?? "preview",
				meta: { githubCommitSha: deployment.commit ?? SHA },
			});
		}
		// The project's settings: none held, and each one asked for is created.
		if (path.startsWith("/v10/projects/hobo-ci/env"))
			return init.method === "GET"
				? answer(200, { envs: [] })
				: answer(200, { created: {} });
		return answer(404, { error: { code: "not_found", message: "no" } });
	};
	return { fetch, sent };
}

// A Vercel CLI whose `integration list` answers come from `listed` (project,
// then team) and which records every command it is given.
function fakeVercelCli(listed: { project: string; team: string }) {
	const commands: string[] = [];
	const run: VercelCliRunner = async (args) => {
		commands.push(args.join(" "));
		if (args[0] === "integration" && args[1] === "list")
			return {
				code: 0,
				stdout: args.includes("--all") ? listed.team : listed.project,
			};
		return { code: 0, stdout: "{}" };
	};
	return { run, commands };
}

describe("hobo ci deploy --provision and --wait (fakes, no network)", () => {
	const env = { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM, ...ORIGINS };

	it("provisions the Marketplace cache the Camp chooses when the team has none, then deploys and waits for READY", async () => {
		const vercel = scriptedVercel(["BUILDING", "READY"]);
		const cli = fakeVercelCli({ project: "[]", team: "[]" });
		const relay = healthyRelay();
		const ran = await deploy([...RELAY, "--provision", "--wait"], {
			fetch: vercel.fetch,
			env,
			vercelCli: cli.run,
			probe: relay.http,
			...steppingClock(),
		});

		expect(ran.exitCode).toBe(0);
		expect(cli.commands).toEqual([
			"integration list hobo-ci --integration upstash --json",
			"integration list --all --integration upstash --json",
			"integration add upstash/upstash-kv --name hobo-ci-cache --environment preview --no-env-pull --non-interactive --json",
		]);
		// One deployment, then readiness reads until READY.
		expect(vercel.sent[0]).toBe(`POST /v13/deployments?teamId=${TEAM}`);
		expect(vercel.sent.length).toBeGreaterThan(2);
		expect(
			vercel.sent
				.slice(1)
				.every(
					(sent) => sent === `GET /v13/deployments/dpl_wait?teamId=${TEAM}`,
				),
		).toBe(true);
		expect(ran.data.outputs).toMatchObject({
			provisioned: "upstash/upstash-kv:hobo-ci-cache=created",
			readyState: "READY",
			camp: "hobo-ci-relay/preview",
		});
		// Verified by the relay's probes, then qualified: the promotion ended.
		expect(relay.probed).toContain(
			"https://relay-preview.example.test/healthz",
		);
		expect(ran.data.delivery).toMatchObject({
			pipeline: "hobo-ci-relay",
			node: "preview",
			campId: "hobo-ci-relay/hobo-ci-relay/preview",
			state: "PROMOTED",
		});
		expect(`${ran.stdout}${ran.stderr}`).not.toContain(TOKEN);
	});

	it("connects a resource the team already has, and leaves a connected one alone", async () => {
		const resource = JSON.stringify([{ name: "hobo-ci-cache" }]);
		const connect = fakeVercelCli({ project: "[]", team: resource });
		const first = await deploy([...RELAY, "--provision"], {
			fetch: scriptedVercel(["READY"]).fetch,
			env,
			vercelCli: connect.run,
		});
		expect(first.data.outputs).toMatchObject({
			provisioned: "upstash/upstash-kv:hobo-ci-cache=connected",
		});
		expect(connect.commands.at(-1)).toBe(
			"integration resource connect hobo-ci-cache hobo-ci --environment preview --yes --json",
		);

		const present = fakeVercelCli({ project: resource, team: resource });
		const again = await deploy([...RELAY, "--provision"], {
			fetch: scriptedVercel(["READY"]).fetch,
			env,
			vercelCli: present.run,
		});
		expect(again.data.outputs).toMatchObject({
			provisioned: "upstash/upstash-kv:hobo-ci-cache=present",
		});
		expect(present.commands).toHaveLength(1);
	});

	it("reports a provisioning it could not do and deploys anyway", async () => {
		const refusing: VercelCliRunner = async (args) =>
			args[1] === "add" ? { code: 1, stdout: "" } : { code: 0, stdout: "[]" };
		const ran = await deploy([...RELAY, "--provision"], {
			fetch: scriptedVercel(["READY"]).fetch,
			env,
			vercelCli: refusing,
		});
		expect(ran.exitCode).toBe(0);
		expect(ran.data.outputs).toMatchObject({
			provisioned: "upstash/upstash-kv:hobo-ci-cache=failed",
		});
	});

	it("fails when the deployment ends in ERROR", async () => {
		const ran = await deploy([...RELAY, "--wait"], {
			fetch: scriptedVercel(["BUILDING", "ERROR"]).fetch,
			env,
			...steppingClock(),
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			ok: false,
			code: "HOBO_CI_DEPLOY_NOT_READY",
			data: { outputs: { readyState: "ERROR" } },
		});
	});

	it("stops waiting after its limit, and says the state it last saw", async () => {
		const ran = await deploy([...RELAY, "--wait"], {
			fetch: scriptedVercel(["BUILDING"]).fetch,
			env,
			...steppingClock(),
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_NOT_READY",
			data: {
				outputs: {
					readyState: expect.stringMatching(/^BUILDING after \d+ minutes$/),
				},
				// The rollout's deadline failed the promotion: nothing qualified.
				delivery: { state: "FAILED" },
			},
		});
	});

	it("refuses a --deadline that is not an ISO-8601 time with a zone", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[...RELAY, "--wait", "--deadline", "in 5 minutes"],
			{
				fetch,
				env,
			},
		);
		expect(ran.exitCode).toBe(2);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CLI_USAGE",
			message: expect.stringContaining("--deadline takes an ISO-8601 time"),
		});
		expect(sent).toEqual([]);
	});

	it("stops waiting at --deadline, before its 20-minute limit", async () => {
		const vercel = scriptedVercel(["BUILDING"]);
		const ran = await deploy(
			[...RELAY, "--wait", "--deadline", "2026-11-12T12:00:30Z"],
			{
				fetch: vercel.fetch,
				env,
				...steppingClock(),
			},
		);
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_NOT_READY",
			data: {
				outputs: {
					readyState: expect.stringMatching(/^BUILDING after \d+ minutes$/u),
				},
			},
		});
		const reads = vercel.sent.filter((line) => line.startsWith("GET ")).length;
		expect(reads).toBeLessThan(10);
	});
});

async function relayDeliveryRecords() {
	const loaded = await loadDeliveryFile(RELAY_DELIVERY_FILE, {
		cwd: RELAY_DIR,
	});
	if (!loaded.ok) throw new Error(loaded.message);
	return loaded.value;
}

describe("deployment-record preview verification", () => {
	it("refuses a preview node without verification", async () => {
		const records = await relayDeliveryRecords();
		const withoutVerification = {
			...records,
			pipelines: records.pipelines.map((pipeline) => ({
				...pipeline,
				nodes: pipeline.nodes.map((node) =>
					node.name === "preview" ? { ...node, verification: undefined } : node,
				),
			})),
		};
		expect(() => recordVerifiedPreviewRecords(withoutVerification)).toThrow(
			/preview has no verification/u,
		);
	});

	it("refuses when no preview verification node exists", async () => {
		const records = await relayDeliveryRecords();
		const withoutPreview = {
			...records,
			pipelines: records.pipelines.map((pipeline) => ({
				...pipeline,
				nodes: pipeline.nodes.filter((node) => node.name !== "preview"),
			})),
		};
		expect(() => recordVerifiedPreviewRecords(withoutPreview)).toThrow(
			/no preview verification node was updated/u,
		);
	});
});

describe("hobo ci deploy through @hobo/cd: preview, then production (fakes, no network)", () => {
	const env = { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM, ...ORIGINS };
	const PINNED = ["--repo", "example/hobo", "--ref", "main", "--sha", SHA];

	it("needs --sha for production: a ref alone names no commit to qualify", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...RELAY, "--target", "production", ...INPUTS], {
			fetch,
			env,
		});
		expect(ran.exitCode).toBe(2);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CLI_USAGE",
			message: expect.stringContaining("--target production needs --sha"),
		});
		expect(sent).toEqual([]);
	});

	it("refuses --wait before anything is sent when the target's probe origin is not set to an https origin", async () => {
		const { fetch, sent } = unreachable();
		const production = await deploy(
			[
				...PINNED,
				"--project",
				"hobo-ci",
				"--target",
				"production",
				...INPUTS,
				"--wait",
			],
			{
				fetch,
				env: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM },
				...steppingClock(),
			},
		);
		expect(production.exitCode).toBe(1);
		expect(production.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_VERIFY_ORIGIN_UNSET",
			message: expect.stringContaining("HOBO_CI_RELAY_URL"),
		});
		const preview = await deploy([...RELAY, "--wait"], {
			fetch,
			env: {
				VERCEL_TOKEN: TOKEN,
				VERCEL_TEAM_ID: TEAM,
				HOBO_CI_RELAY_PREVIEW_URL: "http://relay-preview.example.test",
			},
		});
		expect(preview.exitCode).toBe(1);
		expect(preview.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_VERIFY_ORIGIN_UNSET",
		});
		expect(sent).toEqual([]);
	});

	it("verifies preview by the deployment record when no preview origin is set, probing nothing", async () => {
		const probed: string[] = [];
		const http: HttpTransport = async (request) => {
			probed.push(request.url);
			return { status: 200, headers: {}, body: '{"ok":true}' };
		};
		const ran = await deploy([...PINNED, "--project", "hobo-ci", "--wait"], {
			fetch: scriptedVercel(["READY"]).fetch,
			env: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM },
			hoboHome: freshHome(),
			probe: http,
			...steppingClock(),
		});
		expect(ran.exitCode).toBe(0);
		expect(ran.data.delivery).toMatchObject({
			node: "preview",
			state: "PROMOTED",
		});
		expect(probed).toEqual([]);
	});

	it("requires a commit before using deployment-record preview verification", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy([...RELAY, "--wait"], {
			fetch,
			env: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM },
		});
		expect(ran.exitCode).toBe(2);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CLI_USAGE",
			message: expect.stringContaining("needs --sha <commit>"),
		});
		expect(sent).toEqual([]);
	});

	it.each([
		["commit", { commit: "f".repeat(40) }],
		["project", { project: "another-project" }],
		[
			"canonical project id, though the display name matches",
			{ projectId: "prj_another" },
		],
		["environment", { target: "production" }],
	])("does not qualify a READY preview with the wrong %s", async (_field, record) => {
		const ran = await deploy([...PINNED, "--project", "hobo-ci", "--wait"], {
			fetch: scriptedVercel(["READY"], record).fetch,
			env: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM },
			hoboHome: freshHome(),
			...steppingClock(),
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_VERIFICATION_FAILED",
		});
		expect(ran.data.delivery).toMatchObject({ state: "FAILED" });
	});

	it("qualifies a READY preview bound to the intended canonical project id", async () => {
		const ran = await deploy([...PINNED, "--project", "prj_relay", "--wait"], {
			fetch: scriptedVercel(["READY"], { projectId: "prj_relay" }).fetch,
			env: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM },
			hoboHome: freshHome(),
			...steppingClock(),
		});
		expect(ran.exitCode).toBe(0);
		expect(ran.data.delivery).toMatchObject({
			node: "preview",
			state: "PROMOTED",
		});
	});

	it.each([
		["unauthorized (401)", 401],
		["refused (403)", 403],
		["absent (404)", 404],
	])("fails preview verification when the deployment read is %s, instead of looping on UNKNOWN", async (_what, status) => {
		const ran = await deploy([...PINNED, "--project", "hobo-ci", "--wait"], {
			fetch: scriptedVercel(["READY"], { readRefusal: status }).fetch,
			env: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM },
			hoboHome: freshHome(),
			...steppingClock(),
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			ok: false,
			code: "HOBO_CI_DEPLOY_VERIFICATION_FAILED",
			message: expect.stringContaining(`HTTP ${status}`),
		});
		expect(ran.data.delivery).not.toMatchObject({ state: "PROMOTED" });
	});

	it("retries a deployment read that got no answer or a retryable status, and still qualifies", async () => {
		const vercel = scriptedVercel(["READY"]);
		let reads = 0;
		const fetch: VercelFetch = async (url, init) => {
			if (init.method === "GET" && url.includes("/v13/deployments/dpl_wait")) {
				reads += 1;
				if (reads === 1)
					return {
						ok: false,
						status: 503,
						async text() {
							return JSON.stringify({
								error: { code: "internal", message: "try later" },
							});
						},
						async json() {
							return {};
						},
					};
				if (reads === 2) throw new Error("socket hang up");
			}
			return vercel.fetch(url, init);
		};
		const ran = await deploy([...PINNED, "--project", "hobo-ci", "--wait"], {
			fetch,
			env: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM },
			hoboHome: freshHome(),
			...steppingClock(),
		});
		expect(ran.exitCode).toBe(0);
		expect(ran.data.delivery).toMatchObject({
			node: "preview",
			state: "PROMOTED",
		});
	});

	it("refuses production before any request when preview has not qualified the commit", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[
				...PINNED,
				"--project",
				"hobo-ci",
				"--target",
				"production",
				...INPUTS,
				"--wait",
			],
			{ fetch, env, ...steppingClock() },
		);
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_NOT_QUALIFIED",
			message: expect.stringContaining("Run hobo ci deploy --target preview"),
		});
		expect(sent).toEqual([]);
	});

	it("promotes to production the commit preview verified, in the same journal", async () => {
		const home = freshHome();
		const relay = healthyRelay();
		// One clock across both runs: production comes after preview.
		const clock = steppingClock();
		const first = await deploy([...PINNED, "--project", "hobo-ci", "--wait"], {
			fetch: scriptedVercel(["READY"]).fetch,
			env,
			hoboHome: home,
			probe: relay.http,
			...clock,
		});
		expect(first.exitCode).toBe(0);
		expect(first.data.delivery).toMatchObject({
			node: "preview",
			state: "PROMOTED",
		});

		const second = await deploy(
			[
				...PINNED,
				"--project",
				"hobo-ci",
				"--target",
				"production",
				...INPUTS,
				"--wait",
			],
			{
				fetch: scriptedVercel(["READY"]).fetch,
				env,
				hoboHome: home,
				probe: relay.http,
				...clock,
			},
		);
		expect(second.exitCode, JSON.stringify(second.envelope)).toBe(0);
		expect(second.envelope).toMatchObject({
			ok: true,
			code: "HOBO_CI_DEPLOYED",
		});
		const previewDelivery = first.data.delivery;
		expect(second.data.delivery).toMatchObject({
			node: "production",
			campId: "hobo-ci-relay/hobo-ci-relay/production",
			state: "PROMOTED",
			freightId: isJsonObject(previewDelivery) ? previewDelivery.freightId : "",
		});
		expect(second.data.outputs).toMatchObject({
			camp: "hobo-ci-relay/production",
			readyState: "READY",
		});
		expect(relay.probed).toContain("https://relay.example.test/readyz");
	});

	it("does not qualify production while HOBO_CI_RELAY_URL serves another commit", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const first = await deploy([...PINNED, "--project", "hobo-ci", "--wait"], {
			fetch: scriptedVercel(["READY"]).fetch,
			env,
			hoboHome: home,
			probe: healthyRelay().http,
			...clock,
		});
		expect(first.exitCode).toBe(0);
		const stale = healthyRelay(200, "f".repeat(40));
		const second = await deploy(
			[
				...PINNED,
				"--project",
				"hobo-ci",
				"--target",
				"production",
				...INPUTS,
				"--wait",
			],
			{
				fetch: scriptedVercel(["READY"]).fetch,
				env,
				hoboHome: home,
				probe: stale.http,
				...clock,
			},
		);
		expect(second.exitCode).toBe(1);
		expect(second.envelope).toMatchObject({
			code: RELAY_VERIFY_REFUSAL.commitMismatch,
			message: expect.stringContaining("f".repeat(40)),
		});
		expect(stale.probed).toContain("https://relay.example.test/healthz");
	});

	it("without --wait returns once the deployment exists, unverified and unqualified", async () => {
		const ran = await deploy([...PINNED, "--project", "hobo-ci"], {
			fetch: scriptedVercel(["READY"]).fetch,
			env,
		});
		expect(ran.exitCode).toBe(0);
		expect(ran.data.outputs).not.toHaveProperty("readyState");
		expect(ran.data.delivery).toMatchObject({ node: "preview" });
		expect(ran.data.delivery).not.toMatchObject({ state: "PROMOTED" });
		expect(ran.envelope.message).toEqual(
			expect.stringContaining("not yet verified"),
		);
	});
});

describe("staged production finalizePromotion recovery", () => {
	const PINNED = ["--repo", "example/hobo", "--ref", "main", "--sha", SHA];
	const stagedEnv = {
		VERCEL_TOKEN: TOKEN,
		VERCEL_TEAM_ID: TEAM,
		...ORIGINS,
		HOBO_CI_RELAY_STAGED_PRODUCTION: "true",
		HOBO_CI_RELAY_PUBLIC_URL: "https://relay.example.test",
		HOBO_CI_RELAY_PREVIEW_PROBE_OIDC: "false",
	};
	const fakeCredentialFetch: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				value: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.c2ln",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);

	function stagedVercel(
		states: readonly string[],
		options: {
			currentProduction?: string | "missing";
			promoteTo?: string | "missing";
		} = {},
	) {
		const base = scriptedVercel(states, {
			projectId: "prj_relay",
			target: "production",
		});
		const sent = base.sent;
		const fetch: VercelFetch = async (url, init) => {
			const path = url.replace("https://api.vercel.com", "");
			if (init.method === "GET" && path.startsWith("/v9/projects/")) {
				sent.push(`${init.method} ${path}`);
				const currentProduction = options.currentProduction;
				if (currentProduction === "missing")
					return {
						ok: true,
						status: 200,
						async text() {
							return JSON.stringify({ id: "prj_relay", targets: {} });
						},
						async json() {
							return { id: "prj_relay", targets: {} };
						},
					};
				return {
					ok: true,
					status: 200,
					async text() {
						return JSON.stringify({
							id: "prj_relay",
							targets: {
								production: {
									id: currentProduction ?? "dpl_old",
								},
							},
						});
					},
					async json() {
						return {
							id: "prj_relay",
							targets: { production: { id: currentProduction ?? "dpl_old" } },
						};
					},
				};
			}
			if (
				init.method === "POST" &&
				/^\/v10\/projects\/[^/]+\/promote\//.test(path)
			) {
				sent.push(`${init.method} ${path}`);
				if (options.promoteTo === "missing") return base.fetch(url, init);
				return {
					ok: true,
					status: 200,
					async text() {
						return "{}";
					},
					async json() {
						return {};
					},
				};
			}
			return base.fetch(url, init);
		};
		return { fetch, sent };
	}

	it("recovers when promote succeeded but promotedFrom is missing and public is healthy", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const relay = healthyRelay();
		const baseEnv = {
			VERCEL_TOKEN: TOKEN,
			VERCEL_TEAM_ID: TEAM,
			...ORIGINS,
		};
		const preview = await deploy(
			[...PINNED, "--project", "hobo-ci", "--wait"],
			{
				fetch: scriptedVercel(["READY"]).fetch,
				env: baseEnv,
				hoboHome: home,
				probe: relay.http,
				...clock,
			},
		);
		expect(preview.exitCode).toBe(0);

		const vercel = stagedVercel(["READY"], {
			currentProduction: "dpl_wait",
		});
		const ran = await deploy(
			[
				...PINNED,
				"--project",
				"hobo-ci",
				"--target",
				"production",
				...INPUTS,
				"--wait",
			],
			{
				fetch: vercel.fetch,
				env: stagedEnv,
				hoboHome: home,
				probe: relay.http,
				credentialFetch: fakeCredentialFetch,
				...clock,
			},
		);
		expect(ran.exitCode, JSON.stringify(ran.envelope)).toBe(0);
		expect(ran.envelope).toMatchObject({
			ok: true,
			code: "HOBO_CI_DEPLOYED",
		});
		expect(ran.data.delivery).toMatchObject({
			node: "production",
			state: "PROMOTED",
		});
	});

	it("fails with explicit manual recovery when already promoted, promotedFrom missing, and public unhealthy", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const baseEnv = {
			VERCEL_TOKEN: TOKEN,
			VERCEL_TEAM_ID: TEAM,
			...ORIGINS,
		};
		const preview = await deploy(
			[...PINNED, "--project", "hobo-ci", "--wait"],
			{
				fetch: scriptedVercel(["READY"]).fetch,
				env: baseEnv,
				hoboHome: home,
				probe: healthyRelay().http,
				...clock,
			},
		);
		expect(preview.exitCode).toBe(0);

		const vercel = stagedVercel(["READY"], {
			currentProduction: "dpl_wait",
		});
		const deploymentHealthy: HttpTransport = async (request) => {
			const live = request.url.startsWith("https://relay.example.test");
			const status = live ? 503 : 200;
			return {
				status,
				headers: { "content-type": "application/json" },
				body: request.url.includes("/healthz")
					? JSON.stringify({ ok: status === 200, commit: SHA })
					: JSON.stringify({ ready: status === 200 }),
			};
		};
		const ran = await deploy(
			[
				...PINNED,
				"--project",
				"hobo-ci",
				"--target",
				"production",
				...INPUTS,
				"--wait",
			],
			{
				fetch: vercel.fetch,
				env: stagedEnv,
				hoboHome: home,
				probe: deploymentHealthy,
				credentialFetch: fakeCredentialFetch,
				...clock,
			},
		);
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			ok: false,
			code: "HOBO_CI_DEPLOY_ROLLBACK_TARGET_UNKNOWN",
		});
		expect(String(ran.envelope.message)).toContain("manual recovery is required");
		expect(String(ran.envelope.message)).toContain(
			"no previous production deployment was recorded",
		);
	});

	it("treats ambiguous promotion read-back as possibly promoted, verifies live, and rolls back on failure", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const baseEnv = {
			VERCEL_TOKEN: TOKEN,
			VERCEL_TEAM_ID: TEAM,
			...ORIGINS,
		};
		const preview = await deploy(
			[...PINNED, "--project", "hobo-ci", "--wait"],
			{
				fetch: scriptedVercel(["READY"]).fetch,
				env: baseEnv,
				hoboHome: home,
				probe: healthyRelay().http,
				...clock,
			},
		);
		expect(preview.exitCode).toBe(0);

		const base = scriptedVercel(["READY"], {
			projectId: "prj_relay",
			target: "production",
		});
		const sent: string[] = [];
		let projectReads = 0;
		let promoteCalls = 0;
		let ambiguousReturned = false;
		const unhealthyLive: HttpTransport = async (request) => {
			if (request.url.startsWith("https://relay.example.test"))
				return {
					status: 503,
					headers: { "content-type": "application/json" },
					body: request.url.includes("/healthz")
						? JSON.stringify({ ok: false, commit: SHA })
						: JSON.stringify({ ready: false }),
				};
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: request.url.includes("/healthz")
					? JSON.stringify({ ok: true, commit: SHA })
					: JSON.stringify({ ready: true }),
			};
		};
		const fetch: VercelFetch = async (url, init) => {
			const path = url.replace("https://api.vercel.com", "");
			if (init.method === "GET" && path.startsWith("/v9/projects/")) {
				sent.push(`${init.method} ${path}`);
				projectReads += 1;
				const rolledBack = sent.some((line) =>
					line.includes("/promote/dpl_old"),
				);
				const promoted = sent.some((line) =>
					line.includes("/promote/dpl_wait"),
				);
				if (promoted && !ambiguousReturned) {
					ambiguousReturned = true;
					return {
						ok: false,
						status: 500,
						async text() {
							return JSON.stringify({
								error: { code: "internal", message: "read failed" },
							});
						},
						async json() {
							return {};
						},
					};
				}
				const current = rolledBack ? "dpl_old" : promoted ? "dpl_wait" : "dpl_old";
				return {
					ok: true,
					status: 200,
					async text() {
						return JSON.stringify({
							id: "prj_relay",
							targets: { production: { id: current } },
						});
					},
					async json() {
						return {
							id: "prj_relay",
							targets: { production: { id: current } },
						};
					},
				};
			}
			if (
				init.method === "POST" &&
				/^\/v10\/projects\/[^/]+\/promote\//.test(path)
			) {
				sent.push(`${init.method} ${path}`);
				promoteCalls += 1;
				return {
					ok: true,
					status: 200,
					async text() {
						return "{}";
					},
					async json() {
						return {};
					},
				};
			}
			return base.fetch(url, init);
		};

		const ran = await deploy(
			[
				...PINNED,
				"--project",
				"hobo-ci",
				"--target",
				"production",
				...INPUTS,
				"--wait",
			],
			{
				fetch,
				env: stagedEnv,
				hoboHome: home,
				probe: unhealthyLive,
				credentialFetch: fakeCredentialFetch,
				...clock,
			},
		);

		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			ok: false,
			code: "HOBO_CI_DEPLOY_LIVE_VERIFICATION_FAILED",
			data: expect.objectContaining({ rollback: "completed" }),
		});
		expect(sent).toContain(
			`POST /v10/projects/prj_relay/promote/dpl_wait?teamId=${TEAM}`,
		);
		expect(sent).toContain(
			`POST /v10/projects/prj_relay/promote/dpl_old?teamId=${TEAM}`,
		);
		expect(promoteCalls).toBe(2);
		expect(projectReads).toBeGreaterThanOrEqual(4);
	});
});

describe("hobo ci deploy --dry-run names its delivery through @hobo/cd", () => {
	it("says which pipeline node and Camp the Freight is promoted to, and what verifies it", async () => {
		const { fetch, sent } = unreachable();
		const ran = await deploy(
			[
				...RELAY,
				"--target",
				"production",
				"--sha",
				SHA,
				...INPUTS,
				"--dry-run",
			],
			{ fetch },
		);
		expect(ran.exitCode).toBe(0);
		expect(ran.data.delivery).toEqual({
			pipeline: "hobo-ci-relay",
			node: "production",
			campId: "hobo-ci-relay/hobo-ci-relay/production",
			verifiedBy: "HOBO_CI_RELAY_URL",
		});
		expect(ran.envelope.message).toEqual(
			expect.stringContaining(
				"only if preview qualified the same Freight (the same commit)",
			),
		);
		expect(sent).toEqual([]);
	});
});
