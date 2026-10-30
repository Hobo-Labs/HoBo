import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { SURROGATE_PATTERN } from "@hobo/adapter-opensesame";
import { createHoboCli } from "@hobo/cli";
import {
	type EventStore,
	IAC_PROGRAM_API_VERSION,
	IAC_PROGRAM_KIND,
	type IacProgramDocument,
} from "@hobo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDefaultYardRuntime,
	selectIacProvider,
	selectPulumiEstateAdapter,
} from "../src/compose.js";
import {
	CREDENTIAL_BINDINGS_FILE,
	CREDENTIALS_BESIDE_SURROGATE,
	OPENSESAME_PASS_ENV,
	OpenSesameCredentialsError,
	type RelaunchInput,
	relaunchInputFor,
	relaunchMcpUnderOpenSesame,
	relaunchUnderOpenSesame,
	reportingCredentialRefusals,
	requireOpenSesameSurrogate,
	runsAVerb,
	wantsOpenSesameRelaunch,
	withoutCredentials,
	workingDirOf,
} from "../src/credentials-opensesame.js";
import { isJsonObject, isJsonString, parseJsonValue } from "../src/json.js";
import type { VercelFetch } from "../src/vercel-client.js";

// HOBO_CREDENTIALS=opensesame (ADR-0170): the composed hobo relaunches itself
// once under `opensesame dev --agent run` and exits as the run did, and
// selectIacProvider refuses anything but a surrogate. OpenSesame is played by
// @hobo/adapter-opensesame's stand-in, the one its real lane holds to the real
// binary (scenario per FAKE_OPENSESAME_SCENARIO); the command it runs is
// fixtures/opensesame-child.mts, which records the environment it was given.

const FAKE_OPENSESAME = fileURLToPath(
	new URL(
		"../../adapters/adapter-opensesame/test/fixtures/fake-opensesame.mts",
		import.meta.url,
	),
);
const CHILD = fileURLToPath(
	new URL("./fixtures/opensesame-child.mts", import.meta.url),
);
const SURROGATE = new RegExp(SURROGATE_PATTERN, "u");
// Each relaunch starts the stand-in, its `--version` probe and the command: a few
// processes, which the default 10 s does not always cover beside a full suite.
const RUN_TIMEOUT_MS = 60_000;

const BINDINGS = {
	bindings: [
		{
			locator: "hobo-token://vercel/deploy",
			connection: "conn://acme/vercel",
			provider: "vercel",
			env_name: "VERCEL_TOKEN",
			paths: ["/v9/projects", "/v13/deployments"],
			methods: ["GET", "POST"],
			projection: "legacy-token",
		},
	],
};

let work = "";
beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "hobo-opensesame-relaunch-"));
	writeFileSync(join(work, CREDENTIAL_BINDINGS_FILE), JSON.stringify(BINDINGS));
});
afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

interface Relaunched {
	readonly status: number;
	readonly stderr: string;
	/** What the stand-in recorded when it was started; absent when it was not. */
	readonly started: boolean;
	/** The environment the relaunched command was given. */
	readonly childEnv: Record<string, string>;
}

function readEnv(path: string) {
	if (!existsSync(path)) return {};
	const parsed = parseJsonValue(readFileSync(path, "utf8"));
	const env = isJsonObject(parsed) ? parsed.env : undefined;
	const out: Record<string, string> = {};
	if (isJsonObject(env)) {
		for (const [key, value] of Object.entries(env)) {
			if (isJsonString(value)) out[key] = value;
		}
	}
	return out;
}

async function relaunch(
	scenario: string,
	childStatus = "0",
	env: Record<string, string> = {},
): Promise<Relaunched> {
	const record = join(work, "opensesame-record.json");
	const childOut = join(work, "child-env.json");
	rmSync(record, { force: true });
	rmSync(childOut, { force: true });
	const sink = new PassThrough();
	const seen: string[] = [];
	sink.on("data", (chunk) => seen.push(String(chunk)));
	const input: RelaunchInput = {
		argv: [process.execPath, CHILD, childOut, childStatus],
		env: {
			PATH: process.env.PATH ?? "",
			NODE_NO_WARNINGS: "1",
			HOBO_CREDENTIALS: "opensesame",
			FAKE_OPENSESAME_RECORD: record,
			FAKE_OPENSESAME_SCENARIO: scenario,
			...env,
		},
		cwd: work,
		bin: FAKE_OPENSESAME,
		// What hobo's bin passes, and the stand-in's own knobs.
		passEnv: [
			...OPENSESAME_PASS_ENV,
			"FAKE_OPENSESAME_RECORD",
			"FAKE_OPENSESAME_SCENARIO",
		],
		stderr: sink,
		tmpRoot: work,
	};
	const status = await relaunchUnderOpenSesame(input);
	return {
		status,
		stderr: seen.join(""),
		started: existsSync(record),
		childEnv: readEnv(childOut),
	};
}

// Selection-only: constructing a provider touches neither the store nor the network.
const selectionDeps = {
	// SAFETY: assertion required at this I/O or test boundary.
	store: {} as EventStore,
	providers: [],
};

function countingFetch() {
	let calls = 0;
	const fetch: VercelFetch = async () => {
		calls += 1;
		throw new Error("no request may be made in this test");
	};
	return { fetch, calls: () => calls };
}

describe("HOBO_CREDENTIALS=opensesame relaunch", () => {
	it(
		"relaunches once and not twice",
		async () => {
			const first = await relaunch("surrogate-delivered");
			expect(first.status).toBe(0);
			expect(first.started).toBe(true);
			const record = parseJsonValue(
				readFileSync(join(work, "opensesame-record.json"), "utf8"),
			);
			const argv = isJsonObject(record) ? record.argv : undefined;
			expect(argv).toEqual([
				"dev",
				"--agent",
				"--schema",
				expect.stringMatching(/\/\.env\.schema$/u),
				"run",
				"--",
				process.execPath,
				CHILD,
				join(work, "child-env.json"),
				"0",
			]);
			const child = first.childEnv;
			expect(child.HOBO_OPENSESAME_CHILD).toBe("1");
			expect(child.HOBO_CREDENTIALS).toBe("opensesame");
			expect(child.NODE_USE_ENV_PROXY).toBe("1");
			expect(child.VERCEL_TOKEN).toMatch(SURROGATE);
			// The child composes instead of relaunching, and its surrogate passes the guard.
			expect(wantsOpenSesameRelaunch(child)).toBe(false);
			expect(() => requireOpenSesameSurrogate(child)).not.toThrow();

			// Asked to relaunch from inside the run, it refuses and starts nothing.
			const second = await relaunch("surrogate-delivered", "0", {
				HOBO_OPENSESAME_CHILD: "1",
			});
			expect(second.status).toBe(1);
			expect(second.started).toBe(false);
			expect(second.stderr).toMatch(/^hobo: recursion_guard: /mu);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"reads the bindings from the directory the verb works in: --cwd, else the working directory",
		async () => {
			expect(workingDirOf(["--cwd", work, "up"], "/elsewhere")).toBe(work);
			expect(workingDirOf(["up", "--cwd", work], "/elsewhere")).toBe(work);
			expect(workingDirOf(["up"], work)).toBe(work);
			// What the CLI cannot parse runs no verb; it is not given a directory either.
			expect(workingDirOf(["up", "--cwd"], work)).toBe(work);
			expect(workingDirOf(["--no-such-flag"], work)).toBe(work);

			// relaunchInputFor reads them from there, not from where the process started.
			const elsewhere = mkdtempSync(
				join(tmpdir(), "hobo-opensesame-elsewhere-"),
			);
			try {
				const input = relaunchInputFor(
					{
						execPath: process.execPath,
						execArgv: [],
						argv: [process.execPath, CHILD, join(work, "child-env.json")],
						env: {
							PATH: process.env.PATH ?? "",
							NODE_NO_WARNINGS: "1",
							HOBO_CREDENTIALS: "opensesame",
							FAKE_OPENSESAME_SCENARIO: "surrogate-delivered",
						},
						cwd: () => elsewhere,
					},
					workingDirOf(["--cwd", work, "up"], elsewhere),
				);
				expect(input.cwd).toBe(work);
				const status = await relaunchUnderOpenSesame({
					...input,
					bin: FAKE_OPENSESAME,
					passEnv: [...OPENSESAME_PASS_ENV, "FAKE_OPENSESAME_SCENARIO"],
					stderr: new PassThrough(),
					tmpRoot: work,
				});
				expect(status).toBe(0);
				expect(readEnv(join(work, "child-env.json")).VERCEL_TOKEN).toMatch(
					SURROGATE,
				);
			} finally {
				rmSync(elsewhere, { recursive: true, force: true });
			}
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"hobo-mcp's relaunch starts nothing without the store passphrase, and runs with it",
		async () => {
			const record = join(work, "opensesame-record.json");
			const base = {
				argv: [process.execPath, CHILD, join(work, "child-env.json")],
				cwd: work,
				bin: FAKE_OPENSESAME,
				passEnv: [
					...OPENSESAME_PASS_ENV,
					"FAKE_OPENSESAME_RECORD",
					"FAKE_OPENSESAME_SCENARIO",
				],
				tmpRoot: work,
			};
			const env = {
				PATH: process.env.PATH ?? "",
				NODE_NO_WARNINGS: "1",
				HOBO_CREDENTIALS: "opensesame",
				FAKE_OPENSESAME_RECORD: record,
				FAKE_OPENSESAME_SCENARIO: "surrogate-delivered",
			};
			for (const passphrase of [undefined, ""]) {
				const sink = new PassThrough();
				const seen: string[] = [];
				sink.on("data", (chunk) => seen.push(String(chunk)));
				const status = await relaunchMcpUnderOpenSesame({
					...base,
					env:
						passphrase === undefined
							? env
							: { ...env, OPENSESAME_STORE_PASSWORD: passphrase },
					stderr: sink,
				});
				expect(status).toBe(1);
				expect(seen.join("")).toMatch(
					/^hobo: OPENSESAME_STORE_PASSWORD_REQUIRED: [^\n]*\n$/u,
				);
				expect(existsSync(record)).toBe(false);
			}
			const status = await relaunchMcpUnderOpenSesame({
				...base,
				env: { ...env, OPENSESAME_STORE_PASSWORD: "dummy-not-a-secret" },
				stderr: new PassThrough(),
			});
			expect(status).toBe(0);
			expect(existsSync(record)).toBe(true);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"gives OpenSesame the store passphrase and the store's place, and nothing else of OpenSesame's",
		async () => {
			const run = await relaunch("surrogate-delivered", "0", {
				OPENSESAME_STORE_PASSWORD: "dummy-not-a-secret",
				OPENSESAME_STORE_DIR: "/dummy/store",
				OPENSESAME_NOT_LISTED: "kept-back",
			});
			expect(run.status).toBe(0);
			const record = parseJsonValue(
				readFileSync(join(work, "opensesame-record.json"), "utf8"),
			);
			// OpenSesame was given the passphrase (the allowlist alone keeps it back)…
			expect(isJsonObject(record) && record.sawStorePassword).toBe(true);
			// …and strips it from the command, which still sees where the store is.
			expect(run.childEnv.OPENSESAME_STORE_PASSWORD).toBeUndefined();
			expect(run.childEnv.OPENSESAME_STORE_DIR).toBe("/dummy/store");
			expect(run.childEnv.OPENSESAME_NOT_LISTED).toBeUndefined();
		},
		RUN_TIMEOUT_MS,
	);

	it("relaunches only when HOBO_CREDENTIALS is opensesame", () => {
		expect(wantsOpenSesameRelaunch({})).toBe(false);
		expect(wantsOpenSesameRelaunch({ HOBO_CREDENTIALS: "env" })).toBe(false);
		expect(wantsOpenSesameRelaunch({ HOBO_CREDENTIALS: "opensesame" })).toBe(
			true,
		);
	});

	describe("exit codes pass through (77, 143)", () => {
		it(
			"a tripwire's 77",
			async () => {
				const tripwire = await relaunch("misdirected");
				expect(tripwire.status).toBe(77);
				expect(tripwire.stderr).toMatch(/^hobo: tripwire_misdirected: /mu);
			},
			RUN_TIMEOUT_MS,
		);

		it(
			"a SIGTERM's 143",
			async () => {
				const signalled = await relaunch("sigterm");
				expect(signalled.status).toBe(143);
				expect(signalled.stderr).toMatch(/^hobo: signalled: /mu);
			},
			RUN_TIMEOUT_MS,
		);

		it(
			"the command's own failing status, not re-reported",
			async () => {
				const failed = await relaunch("surrogate-delivered", "3");
				expect(failed.status).toBe(3);
				expect(failed.stderr).not.toMatch(/^hobo: /mu);
			},
			RUN_TIMEOUT_MS,
		);
	});

	it(
		"a run that left a placeholder exits 1, and the placeholder never deploys",
		async () => {
			const absent = await relaunch("plugin-absent");
			expect(absent.status).toBe(1);
			expect(absent.stderr).toMatch(/^hobo: placeholders_only: /mu);
			expect(absent.childEnv.VERCEL_TOKEN).toMatch(/^ostest_/u);

			const { fetch, calls } = countingFetch();
			expect(() =>
				selectIacProvider({
					...selectionDeps,
					env: absent.childEnv,
					vercelFetch: fetch,
				}),
			).toThrow(OpenSesameCredentialsError);
			expect(calls()).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);

	it(
		"without hobo.credentials.json nothing is started",
		async () => {
			rmSync(join(work, CREDENTIAL_BINDINGS_FILE));
			const run = await relaunch("surrogate-delivered");
			expect(run.status).toBe(1);
			expect(run.started).toBe(false);
			expect(run.stderr).toMatch(/^hobo: OPENSESAME_BINDINGS_UNREADABLE: /mu);
		},
		RUN_TIMEOUT_MS,
	);
});

describe("selectIacProvider under HOBO_CREDENTIALS=opensesame", () => {
	const placeholder = "ostest_0123456789abcdef";
	const plainToken = "vtok_plain_token_exported_by_hand";

	it("refuses a placeholder token before any request", () => {
		for (const VERCEL_TOKEN of [placeholder, plainToken, "", undefined]) {
			for (const resolvers of [undefined, "1"]) {
				const { fetch, calls } = countingFetch();
				let refusal: unknown;
				try {
					selectIacProvider({
						...selectionDeps,
						env: {
							HOBO_CREDENTIALS: "opensesame",
							VERCEL_TOKEN,
							HOBO_DEPLOY_RESOLVERS: resolvers,
						},
						vercelFetch: fetch,
					});
				} catch (error) {
					refusal = error;
				}
				expect(refusal).toBeInstanceOf(OpenSesameCredentialsError);
				if (refusal instanceof OpenSesameCredentialsError) {
					expect(refusal.code).toBe("OPENSESAME_PLACEHOLDERS_ONLY");
					if (VERCEL_TOKEN) expect(refusal.message).not.toContain(VERCEL_TOKEN);
				}
				expect(calls()).toBe(0);
			}
		}
	});

	it("takes exactly osr_ and 32 lower-case hex digits: a near miss is refused", () => {
		const hex = "0123456789abcdef".repeat(2);
		const nearMisses = [
			`osr_${hex.slice(1)}`, // 31 digits
			`osr_${hex}0`, // 33 digits
			`osr_${hex.toUpperCase()}`, // upper case
			`osr_${hex.slice(1)}g`, // not hex
			`osr_${hex}\n`, // a trailing newline
			`\nosr_${hex}`, // a leading newline
			`osr_${hex.slice(0, 16)}\n${hex.slice(16)}`, // two lines
			`xosr_${hex}`,
			`OSR_${hex}`,
			`osr-${hex}`,
			"osr_",
		];
		for (const VERCEL_TOKEN of nearMisses) {
			const { fetch, calls } = countingFetch();
			expect(
				() =>
					selectIacProvider({
						...selectionDeps,
						env: { HOBO_OPENSESAME_CHILD: "1", VERCEL_TOKEN },
						vercelFetch: fetch,
					}),
				JSON.stringify(VERCEL_TOKEN),
			).toThrow(OpenSesameCredentialsError);
			expect(calls()).toBe(0);
		}
		expect(() =>
			requireOpenSesameSurrogate({
				HOBO_OPENSESAME_CHILD: "1",
				VERCEL_TOKEN: `osr_${hex}`,
			}),
		).not.toThrow();
	});

	it("a proxied run's command refuses a placeholder even without HOBO_CREDENTIALS", () => {
		const { fetch, calls } = countingFetch();
		expect(() =>
			selectIacProvider({
				...selectionDeps,
				env: { HOBO_OPENSESAME_CHILD: "1", VERCEL_TOKEN: placeholder },
				vercelFetch: fetch,
			}),
		).toThrow(/OpenSesame surrogate/u);
		expect(calls()).toBe(0);
	});

	it("refuses another provider's credential beside the surrogate, naming it and never its value", () => {
		const surrogate = `osr_${"0123456789abcdef".repeat(2)}`;
		// What a command that re-read an .env file held (C-1 of the #1593 review):
		// with these, the Cloudflare lane was picked, outside OpenSesame.
		const stray = {
			CLOUDFLARE_API_TOKEN: "cf_dummy_marker_not_a_secret",
			CLOUDFLARE_ACCOUNT_ID: "acct_dummy",
		};
		for (const marker of [
			{ HOBO_OPENSESAME_CHILD: "1" },
			{ HOBO_CREDENTIALS: "opensesame" },
		]) {
			let calls = 0;
			let refusal: unknown;
			try {
				selectIacProvider({
					...selectionDeps,
					env: { ...marker, VERCEL_TOKEN: surrogate, ...stray },
					cloudflareFetch: async () => {
						calls += 1;
						throw new Error("no request may be made in this test");
					},
				});
			} catch (error) {
				refusal = error;
			}
			expect(refusal).toBeInstanceOf(OpenSesameCredentialsError);
			if (!(refusal instanceof OpenSesameCredentialsError)) continue;
			expect(refusal.code).toBe("OPENSESAME_CREDENTIALS_BESIDE_SURROGATE");
			expect(refusal.message).toContain("CLOUDFLARE_API_TOKEN");
			expect(refusal.message).not.toContain(stray.CLOUDFLARE_API_TOKEN);
			expect(calls).toBe(0);
		}
		// Every listed name is refused on its own; an empty or surrogate-shaped value is not a credential.
		expect(CREDENTIALS_BESIDE_SURROGATE).toEqual(
			expect.arrayContaining([
				"CLOUDFLARE_API_TOKEN",
				"AWS_ACCESS_KEY_ID",
				"PULUMI_ACCESS_TOKEN",
				"VERCEL_API_TOKEN",
			]),
		);
		for (const name of CREDENTIALS_BESIDE_SURROGATE) {
			const base = { HOBO_OPENSESAME_CHILD: "1", VERCEL_TOKEN: surrogate };
			expect(() =>
				requireOpenSesameSurrogate({ ...base, [name]: "real-looking" }),
			).toThrow(name);
			expect(() =>
				requireOpenSesameSurrogate({ ...base, [name]: "" }),
			).not.toThrow();
			expect(() =>
				requireOpenSesameSurrogate({ ...base, [name]: surrogate }),
			).not.toThrow();
		}
	});

	it("refuses the live Pulumi lane, which OpenSesame does not broker, naming the variable", () => {
		const surrogate = `osr_${"0123456789abcdef".repeat(2)}`;
		const live = {
			HOBO_PULUMI_LIVE: "1",
			// Kept inside this test's directory, and a pulumi that is not there: nothing is run.
			HOBO_PULUMI_WORKDIR: join(work, "pulumi"),
			HOBO_PULUMI_BIN: join(work, "no-pulumi"),
		};
		for (const marker of [
			{ HOBO_OPENSESAME_CHILD: "1" },
			{ HOBO_CREDENTIALS: "opensesame" },
		]) {
			const env = { ...marker, VERCEL_TOKEN: surrogate, ...live };
			for (const select of [
				() => selectIacProvider({ ...selectionDeps, env }),
				// drift and import reach the lane through the estate seam alone.
				() => selectPulumiEstateAdapter({ store: selectionDeps.store, env }),
			]) {
				let refusal: unknown;
				try {
					select();
				} catch (error) {
					refusal = error;
				}
				expect(refusal).toBeInstanceOf(OpenSesameCredentialsError);
				if (!(refusal instanceof OpenSesameCredentialsError)) continue;
				expect(refusal.code).toBe("OPENSESAME_LANE_NOT_BROKERED");
				expect(refusal.message).toContain("HOBO_PULUMI_LIVE");
				expect(refusal.message).not.toContain(live.HOBO_PULUMI_WORKDIR);
			}
		}
		// Outside OpenSesame the live lane is chosen as before.
		expect(selectIacProvider({ ...selectionDeps, env: live }).id).toMatch(
			/^pulumi-backed:/u,
		);
	});

	it("deploys on a surrogate", () => {
		const provider = selectIacProvider({
			...selectionDeps,
			env: {
				HOBO_CREDENTIALS: "opensesame",
				VERCEL_TOKEN: `osr_${"0123456789abcdef".repeat(2)}`,
			},
			vercelFetch: countingFetch().fetch,
		});
		expect(provider.id).toMatch(/^resolver-backed:/u);
	});

	it("selectIacProvider is unchanged when HOBO_CREDENTIALS is unset", () => {
		const { fetch } = countingFetch();
		for (const env of [{}, { HOBO_CREDENTIALS: "env" }]) {
			expect(
				selectIacProvider({
					...selectionDeps,
					env: { ...env, VERCEL_TOKEN: placeholder },
					vercelFetch: fetch,
				}).id,
			).toMatch(/^resolver-backed:/u);
			expect(selectIacProvider({ ...selectionDeps, env }).id).toMatch(
				/^pulumi-backed:/u,
			);
		}
	});
});

describe("the composed hobo under a placeholder", () => {
	const env = {
		HOBO_CREDENTIALS: "opensesame",
		VERCEL_TOKEN: "ostest_0123456789abcdef",
	};

	it("is refused when the runtime is composed, before any verb runs", () => {
		expect(() =>
			createDefaultYardRuntime({ dataDir: join(work, "yard"), env }),
		).toThrow(OpenSesameCredentialsError);
	});

	it("a command holding a stray provider credential is refused as one hobo: line, before any verb", async () => {
		const sink = new PassThrough();
		const seen: string[] = [];
		sink.on("data", (chunk) => seen.push(String(chunk)));
		const childEnv = {
			HOBO_OPENSESAME_CHILD: "1",
			VERCEL_TOKEN: `osr_${"0123456789abcdef".repeat(2)}`,
			AWS_SECRET_ACCESS_KEY: "aws_dummy_marker_not_a_secret",
		};
		const status = await reportingCredentialRefusals(async () => {
			createDefaultYardRuntime({ dataDir: join(work, "yard"), env: childEnv });
			return 0;
		}, sink);
		expect(status).toBe(1);
		expect(seen.join("")).toMatch(
			/^hobo: OPENSESAME_CREDENTIALS_BESIDE_SURROGATE: .*AWS_SECRET_ACCESS_KEY.*\n$/u,
		);
		expect(seen.join("")).not.toContain(childEnv.AWS_SECRET_ACCESS_KEY);
	});

	it("reports the refusal as one hobo: line and status 1", async () => {
		const sink = new PassThrough();
		const seen: string[] = [];
		sink.on("data", (chunk) => seen.push(String(chunk)));
		const status = await reportingCredentialRefusals(async () => {
			createDefaultYardRuntime({ dataDir: join(work, "yard"), env });
			return 0;
		}, sink);
		expect(status).toBe(1);
		expect(seen.join("")).toMatch(
			/^hobo: OPENSESAME_PLACEHOLDERS_ONLY: .*\n$/u,
		);
		expect(seen.join("")).not.toContain(env.VERCEL_TOKEN);
	});

	it("passes the CLI's own status through and rethrows anything else", async () => {
		expect(await reportingCredentialRefusals(async () => 4)).toBe(4);
		await expect(
			reportingCredentialRefusals(async () => {
				throw new Error("not a credential refusal");
			}),
		).rejects.toThrow("not a credential refusal");
	});
});

describe("an invocation that runs no verb, under HOBO_CREDENTIALS=opensesame", () => {
	// [arguments, whether they run a verb]
	const cases: ReadonlyArray<readonly [readonly string[], boolean]> = [
		[[], false],
		[["--help"], false],
		[["-h"], false],
		[["up", "--help"], false],
		[["--json"], false],
		[["status"], false],
		[["--version"], false],
		[["up", "--no-such-flag"], false],
		[["up", "--cwd"], false],
		[["up"], true],
		[["recipes"], true],
		[["--json", "--cwd", ".", "down"], true],
	];

	it("is told apart by the CLI's own parser: the CLI dispatches exactly the ones that run a verb", async () => {
		for (const [args, verb] of cases) {
			expect(runsAVerb(args), args.join(" ")).toBe(verb);
			// The CLI builds a verb's context just before it dispatches it, and never otherwise.
			let dispatched = false;
			const cli = createHoboCli({
				contextFactory: async () => {
					dispatched = true;
					throw new Error("dispatch stops here in this test");
				},
			});
			await cli.run(args);
			expect(dispatched, args.join(" ")).toBe(verb);
		}
	});

	it("is composed with no credential and an IaC lane that refuses every call", async () => {
		const options = withoutCredentials();
		expect(options.env).toEqual({});
		// Composing it does not meet the surrogate guard, which HOBO_CREDENTIALS alone would.
		const runtime = createDefaultYardRuntime({
			dataDir: join(work, "yard"),
			...options,
		});
		expect(runtime.store).toBeDefined();
		const adapter = options.iacAdapter;
		expect(adapter).toBeDefined();
		if (adapter === undefined) return;
		const program: IacProgramDocument = {
			apiVersion: IAC_PROGRAM_API_VERSION,
			kind: IAC_PROGRAM_KIND,
			provider: "vercel",
			deploymentId: "deployment",
			stack: "stack",
			resources: [],
			stackOutputs: {},
		};
		for (const call of [
			() => adapter.preview(program),
			() => adapter.apply(program),
			() => adapter.destroy(program),
			() => adapter.refresh(program),
		]) {
			expect(call).toThrow(OpenSesameCredentialsError);
			expect(call).toThrow(/runs no verb/u);
		}
	});
});
