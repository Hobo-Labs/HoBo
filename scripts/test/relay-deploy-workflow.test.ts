import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	adoptDeadline,
	decide,
	RELAY_DEPLOY_JOB_MARGIN_MINUTES,
	RELAY_DEPLOY_JOB_TIMEOUT_MINUTES,
	RELAY_EXTRA_INPUTS,
	RELAY_SECRET_STORE_BINDING,
	relayInputDirs,
	storeBindingState,
	touchesRelay,
} from "../ci/relay-deploy-gate.mts";
import { lintActionsRepository } from "../lint-actions.ts";

// The relay deploy workflow (.github/workflows/relay-deploy.yml) and its gate
// (scripts/ci/relay-deploy-gate.mts), ADR-0179 phase 6. Nothing here reaches
// GitHub, Infisical or Vercel.

const root = join(import.meta.dirname, "..", "..");
const workflowPath = join(root, ".github", "workflows", "relay-deploy.yml");
const workflow = readFileSync(workflowPath, "utf8");
const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
const inputDirs = relayInputDirs(lockfile);
const configured = "bound" as const;

/** The block of one step, from its `- name:` line to the next step. */
function step(name: string): string {
	const lines = workflow.split("\n");
	const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
	assert.notEqual(start, -1, `no step named ${name}`);
	const end = lines.findIndex(
		(line, index) => index > start && /^ {6}- /u.test(line),
	);
	return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function stepLine(name: string): number {
	return workflow
		.split("\n")
		.findIndex((line) => line.trim() === `- name: ${name}`);
}

describe("the relay deploy gate", () => {
	it("takes the relay and every workspace package it is built from as its inputs", () => {
		for (const dir of [
			"packages/ci-vercel",
			"packages/ci",
			"packages/ci-gh-actions",
			"packages/core",
			"packages/adapters/adapter-infisical",
			"packages/yards",
			"packages/camps",
		])
			assert.ok(inputDirs.includes(dir), `${dir} is not a relay input`);
		assert.ok(!inputDirs.includes("site"));
		for (const file of RELAY_EXTRA_INPUTS)
			assert.ok(existsSync(join(root, file)), `${file} does not exist`);
	});

	it("deploys a push that changes the relay or a package it uses, and only that", () => {
		assert.equal(
			touchesRelay(["packages/ci-vercel/deploy/yard.ts"], inputDirs),
			true,
		);
		assert.equal(touchesRelay(["packages/core/src/index.ts"], inputDirs), true);
		assert.equal(
			touchesRelay([".github/workflows/relay-deploy.yml"], inputDirs),
			true,
		);
		assert.equal(
			touchesRelay(["docs/design/index.md", "site/src/x.ts"], inputDirs),
			false,
		);
		// A sibling directory sharing a prefix is not an input.
		assert.equal(
			touchesRelay(["packages/ci-vercel-other/x.ts"], inputDirs),
			false,
		);
	});

	it("fails a required deploy when the secret store binding is absent or unreadable", () => {
		const decision = decide({
			event: "push",
			store: "absent",
			changed: ["packages/ci-vercel/src/entry.ts"],
			inputDirs,
		});
		assert.equal(decision.run, false);
		assert.equal(decision.failure, true);
		assert.ok(decision.reason.includes(RELAY_SECRET_STORE_BINDING));
		assert.match(decision.reason, /hobo ci secret-store provision/u);
		const broken = decide({
			event: "workflow_dispatch",
			store: "unreadable",
			inputDirs,
		});
		assert.equal(broken.run, false);
		assert.equal(broken.failure, true);
		assert.equal(
			decide({
				event: "push",
				store: "absent",
				changed: ["README.md"],
				inputDirs,
			}).failure,
			undefined,
		);
	});

	it("fails a required deploy when the pushed range cannot be read and no store is bound", () => {
		const decision = decide({ event: "push", store: "absent", inputDirs });
		assert.equal(decision.run, false);
		assert.equal(decision.failure, true);
	});

	it("ships the fallback-period binding: coordinates, no deploy project", () => {
		assert.ok(existsSync(join(root, RELAY_SECRET_STORE_BINDING)));
		assert.equal(
			storeBindingState(
				readFileSync(join(root, RELAY_SECRET_STORE_BINDING), "utf8"),
			),
			"coordinates",
		);
	});

	it("keeps the Git fallback until the new channels carry a production value", () => {
		assert.doesNotMatch(
			readFileSync(join(root, "packages/ci-vercel/vercel.json"), "utf8"),
			/"git"\s*:/u,
		);
		assert.doesNotMatch(
			readFileSync(join(root, RELAY_SECRET_STORE_BINDING), "utf8"),
			/deployProjectId/u,
		);
	});

	it("reads the binding's shape only, and only an HTTPS endpoint counts", () => {
		assert.equal(storeBindingState(undefined), "absent");
		assert.equal(storeBindingState("not json"), "unreadable");
		assert.equal(
			storeBindingState(
				JSON.stringify({ kind: "infisical-self-hosted", endpoint: "http://x" }),
			),
			"unreadable",
		);
		const coordinates = JSON.stringify({
			kind: "infisical-self-hosted",
			endpoint: "https://secrets.example",
		});
		assert.equal(storeBindingState(coordinates), "coordinates");
		assert.equal(
			storeBindingState(
				JSON.stringify({
					kind: "infisical-self-hosted",
					endpoint: "https://secrets.example",
					deployProjectId: "",
				}),
			),
			"coordinates",
		);
		assert.equal(
			storeBindingState(
				JSON.stringify({
					kind: "infisical-self-hosted",
					endpoint: "https://secrets.example",
					deployProjectId: "b89dd05a-be1e-46bd-ad04-8f1510df4a31",
				}),
			),
			"bound",
		);
	});

	it("keeps the required check green on the fallback, and fails a manual run there", () => {
		const skipped = decide({
			event: "push",
			store: "coordinates",
			changed: ["packages/ci-vercel/src/entry.ts"],
			inputDirs,
		});
		assert.equal(skipped.run, false);
		assert.equal(skipped.failure, undefined);
		assert.match(skipped.reason, /Vercel's Git integration still deploys/u);
		assert.match(skipped.reason, /Merge cutover/u);
		assert.equal(
			decide({
				event: "push",
				store: "coordinates",
				changed: ["README.md"],
				inputDirs,
			}).failure,
			undefined,
		);
		const manual = decide({
			event: "workflow_dispatch",
			store: "coordinates",
			inputDirs,
		});
		assert.equal(manual.run, false);
		assert.equal(manual.failure, true);
		assert.match(manual.reason, /names no deploy project/u);
	});

	it("deploys a manual run and fails a push whose range it cannot read", () => {
		assert.equal(
			decide({ event: "workflow_dispatch", store: configured, inputDirs }).run,
			true,
		);
		const unreadable = decide({ event: "push", store: configured, inputDirs });
		assert.equal(unreadable.run, false);
		assert.equal(unreadable.failure, true);
		assert.equal(
			decide({
				event: "push",
				store: configured,
				changed: ["README.md"],
				inputDirs,
			}).run,
			false,
		);
		assert.equal(
			decide({ event: "pull_request", store: configured, inputDirs }).run,
			false,
		);
	});

	it("never quietly skips a manual run, so the app-credentials artifact download always has its artifact", () => {
		for (const store of [
			"absent",
			"unreadable",
			"coordinates",
			"bound",
		] as const) {
			const decision = decide({ event: "workflow_dispatch", store, inputDirs });
			assert.ok(
				decision.run === true || decision.failure === true,
				`workflow_dispatch with a ${store} store must deploy or fail the job, never skip it: app-credentials needs deploy-build and downloads its artifact unconditionally`,
			);
		}
	});

	it("writes the exact run/reason/deadline contract and a notice or error", () => {
		const work = mkdtempSync(join(tmpdir(), "relay-gate-output-"));
		const scriptDir = join(work, "scripts", "ci");
		mkdirSync(scriptDir, { recursive: true });
		symlinkSync(
			join(root, "scripts/ci/release-oci-affected.mts"),
			join(scriptDir, "release-oci-affected.mts"),
		);
		const gate = join(scriptDir, "relay-deploy-gate.mts");
		writeFileSync(
			gate,
			readFileSync(join(root, "scripts/ci/relay-deploy-gate.mts"), "utf8"),
		);
		symlinkSync(join(root, "pnpm-lock.yaml"), join(work, "pnpm-lock.yaml"));
		mkdirSync(join(work, "packages", "ci-vercel", "deploy"), {
			recursive: true,
		});
		writeFileSync(
			join(work, RELAY_SECRET_STORE_BINDING),
			JSON.stringify({
				...JSON.parse(
					readFileSync(join(root, RELAY_SECRET_STORE_BINDING), "utf8"),
				),
				deployProjectId: "prj_gate_contract_test",
			}),
		);
		const runGate = (args: readonly string[], output?: string) => {
			const before = Date.now();
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					gate,
					...args,
					...(output === undefined ? [] : ["--github-output", output]),
				],
				{ cwd: work, encoding: "utf8" },
			);
			return {
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				before,
				after: Date.now(),
			};
		};
		const assertDeadline = (line: string, before: number, after: number) => {
			const match =
				/^deadline=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/u.exec(line);
			assert.ok(match, `not an ISO deadline: ${line}`);
			const at = Date.parse(match[1] ?? "");
			assert.ok(
				at >= Date.parse(adoptDeadline(before)) &&
					at <= Date.parse(adoptDeadline(after)),
				`deadline outside the gate's run: ${line}`,
			);
		};
		const message = (decision: ReturnType<typeof decide>) =>
			decision.failure === true
				? `::error title=Relay deploy failed::${decision.reason}.`
				: decision.run
					? `Deploying the relay: ${decision.reason}.`
					: `::notice title=Relay deploy skipped::${decision.reason}.`;
		const assertContract = (
			lines: readonly string[],
			decision: ReturnType<typeof decide>,
			before: number,
			after: number,
		) => {
			assert.deepEqual(lines.slice(0, 2), [
				`run=${decision.run}`,
				`reason=${decision.reason}`,
			]);
			assertDeadline(lines[2] ?? "", before, after);
			assert.deepEqual(lines.slice(3), [message(decision), ""]);
		};
		try {
			const manualExpected = decide({
				event: "workflow_dispatch",
				store: "bound",
				inputDirs: [],
			});
			assert.equal(manualExpected.run, true);
			const manual = runGate(["--event", "workflow_dispatch"]);
			assert.equal(manual.status, 0, `${manual.stdout}${manual.stderr}`);
			assert.equal(manual.stderr, "");
			assertContract(
				manual.stdout.split("\n"),
				manualExpected,
				manual.before,
				manual.after,
			);

			const skippedExpected = decide({
				event: "pull_request",
				store: "bound",
				inputDirs: [],
			});
			assert.equal(skippedExpected.failure, undefined);
			const skipped = runGate(["--event", "pull_request"]);
			assert.equal(skipped.status, 0, `${skipped.stdout}${skipped.stderr}`);
			assert.equal(skipped.stderr, "");
			assertContract(
				skipped.stdout.split("\n"),
				skippedExpected,
				skipped.before,
				skipped.after,
			);

			const unreadableExpected = decide({
				event: "push",
				store: "bound",
				inputDirs,
			});
			assert.equal(
				unreadableExpected.failure,
				true,
				"an unreadable push range must fail",
			);
			const unreadable = runGate([
				"--event",
				"push",
				"--from",
				"0000000000000000000000000000000000000000",
			]);
			assert.equal(
				unreadable.status,
				1,
				`${unreadable.stdout}${unreadable.stderr}`,
			);
			assert.equal(unreadable.stderr, "");
			assertContract(
				unreadable.stdout.split("\n"),
				unreadableExpected,
				unreadable.before,
				unreadable.after,
			);

			const output = join(work, "gate.output");
			const written = runGate(["--event", "workflow_dispatch"], output);
			assert.equal(written.status, 0, `${written.stdout}${written.stderr}`);
			assert.equal(written.stdout, `${message(manualExpected)}\n`);
			const contract = readFileSync(output, "utf8").split("\n");
			assert.deepEqual(contract.slice(0, 2), [
				`run=${manualExpected.run}`,
				`reason=${manualExpected.reason}`,
			]);
			assertDeadline(contract[2] ?? "", written.before, written.after);
			assert.deepEqual(contract.slice(3), [""]);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("the relay deploy workflow", () => {
	it("checks out pinned workspace dependencies on fresh runners", () => {
		const build = workflow
			.split("\n  deploy-build:\n")[1]
			?.split("\n  deploy:\n")[0];
		const deploy = workflow
			.split("\n  deploy:\n")[1]
			?.split("\n  app-credentials:\n")[0];
		const deposit = workflow.split("\n  app-credentials:\n")[1];
		assert.ok(build && deploy && deposit);
		for (const job of [build, deploy, deposit]) {
			assert.match(job, /submodules: recursive/u);
			assert.match(job, /persist-credentials: false/u);
		}
	});

	it("runs on a push to main and by hand, and nowhere else", () => {
		assert.match(
			workflow,
			/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n {4}inputs:\n/mu,
		);
		// The only dispatch inputs: the App's one-time code and two ids.
		assert.deepEqual(
			[...workflow.matchAll(/^ {6}([a-z_]+):\n {8}description:/gmu)].map(
				(match) => match[1],
			),
			["manifest_code", "relay", "owner_id"],
		);
		assert.match(
			workflow,
			/if: github\.repository == 'Hobo-Labs\/HoBo' && github\.ref == 'refs\/heads\/main'/u,
		);
		assert.match(workflow, /cancel-in-progress: false/u);
	});

	it("may read the repository and mint an OIDC token, and nothing more", () => {
		assert.match(workflow, /^permissions:\n {2}contents: read\n/mu);
		assert.match(
			workflow,
			/ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/u,
		);
		assert.doesNotMatch(workflow, /write-all|secrets\.|\$\{\{\s*secrets/u);
	});

	it("builds the CLI it deploys unprivileged, and the deploy job runs only its digest-pinned artifact", () => {
		const build = workflow
			.split("\n  deploy-build:\n")[1]
			?.split("\n  deploy:\n")[0];
		assert.ok(build, "no deploy-build job");
		assert.match(build, /^ {4}permissions:\n {6}contents: read$/mu);
		assert.doesNotMatch(build, /id-token/u);
		assert.match(build, /turbo run build/u);
		assert.match(build, /release-freight-cli\.mts pack/u);
		assert.match(
			build,
			/actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/u,
		);
		const deploy = workflow
			.split("\n  deploy:\n")[1]
			?.split("\n  app-credentials:\n")[0];
		assert.ok(deploy, "no deploy job");
		assert.match(deploy, /id-token: write/u);
		assert.match(deploy, /^ {4}needs: deploy-build$/mu);
		assert.doesNotMatch(deploy, /turbo run build/u);
		assert.match(
			deploy,
			/actions\/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333/u,
		);
		assert.match(deploy, /--digest "\$HOBO_RELAY_CLI_DIGEST"/u);
		const restoreAt = deploy.indexOf("release-freight-cli.mts restore");
		assert.ok(restoreAt > 0, "no digest-pinned restore");
		assert.ok(
			restoreAt < deploy.indexOf("ci secret-store verify"),
			"the restore must precede every command that runs the CLI",
		);
		assert.ok(restoreAt < deploy.indexOf("ci deploy"));
		const deposit = workflow.split("\n  app-credentials:\n")[1];
		assert.ok(deposit, "no app-credentials job");
		assert.match(deposit, /^ {4}needs: deploy-build$/mu);
		assert.doesNotMatch(deposit, /turbo run build/u);
		assert.match(deposit, /release-freight-cli\.mts restore/u);
		assert.match(deposit, /--digest "\$HOBO_RELAY_CLI_DIGEST"/u);
		assert.ok(
			deposit.indexOf("release-freight-cli.mts restore") <
				deposit.indexOf("ci app deposit"),
		);
	});

	it("reads no repository variable or secret for the relay's configuration", () => {
		assert.doesNotMatch(workflow, /INFISICAL_|VERCEL_TEAM_ID|\$\{\{\s*vars\./u);
	});

	it("restores the CLI only against the build job's own digest output", () => {
		const deploy = workflow
			.split("\n  deploy:\n")[1]
			?.split("\n  app-credentials:\n")[0];
		const deposit = workflow.split("\n  app-credentials:\n")[1];
		assert.ok(deploy && deposit);
		for (const job of [deploy, deposit]) {
			assert.match(
				job,
				/HOBO_RELAY_CLI_DIGEST: \$\{\{ needs\.deploy-build\.outputs\.digest \}\}/u,
			);
			assert.doesNotMatch(
				job,
				/HOBO_RELAY_CLI_DIGEST: \$\{\{ (github\.event|env|vars)\./u,
			);
		}
		assert.match(workflow, /digest: \$\{\{ steps\.pack\.outputs\.digest \}\}/u);
	});

	it("fails the gate when a required base commit cannot be fetched", () => {
		const gates = workflow.split("- name: Decide whether to deploy");
		assert.equal(gates.length - 1, 2);
		for (const gate of gates.slice(1)) {
			assert.match(gate, /git fetch --no-tags --depth=1 origin/u);
			assert.doesNotMatch(gate, /git fetch[^\n]*\|\| true/u);
			assert.match(gate, /::error title=Relay deploy gate::/u);
			assert.match(gate, /exit 1/u);
		}
	});

	it("keeps deployment and App credentials on ephemeral clean runners", () => {
		const deploy = workflow
			.split("\n  deploy:\n")[1]
			?.split("\n  app-credentials:\n")[0];
		const deposit = workflow.split("\n  app-credentials:\n")[1];
		assert.ok(deploy && deposit);
		for (const job of [deploy, deposit]) {
			assert.match(job, /^ {4}runs-on: ubuntu-24\.04$/mu);
			assert.match(job, /clean: true/u);
			assert.doesNotMatch(job, /needs: route|needs\.route|clean: false/u);
		}
	});

	it("does not embed the Vercel credential in the workflow", () => {
		assert.doesNotMatch(
			workflow,
			/VERCEL_TOKEN|relay-deploy-credential|vercel@\d|vercel deploy|--token\b/u,
		);
		assert.doesNotMatch(workflow, /ci deploy --adopt\b/u);
		assert.ok(
			!existsSync(join(root, "scripts/ci/relay-deploy-credential.mts")),
		);
	});

	it("delivers preview and production through HoBo for the pinned commit", () => {
		const deploy = step("Deliver the relay through HoBo CD");
		assert.match(deploy, /node packages\/hobo\/dist\/bin\/hobo\.js ci deploy/u);
		assert.match(deploy, /--cwd packages\/ci-vercel/u);
		assert.match(deploy, /--sha "\$GITHUB_SHA"/u);
		assert.match(deploy, /for target in preview production/u);
		assert.match(deploy, /--target "\$target" --wait/u);
		assert.match(deploy, /HOBO_CI_RELAY_PREVIEW_PROBE_OIDC/u);
		assert.match(deploy, /HOBO_CI_RELAY_STAGED_PRODUCTION/u);
		assert.match(deploy, /HOBO_CI_RELAY_PUBLIC_URL/u);
		assert.match(deploy, /set -euo pipefail/u);
		assert.doesNotMatch(workflow, /gh api/u);
		assert.doesNotMatch(deploy, /curl /u);
		assert.doesNotMatch(workflow, /curl [^\n]*\/(healthz|readyz)/u);
	});

	it("fails a result report whose command status is omitted or invalid", () => {
		const work = mkdtempSync(join(tmpdir(), "relay-result-report-"));
		try {
			const json = join(work, "result.json");
			writeFileSync(json, JSON.stringify({ code: "HOBO_TEST_REFUSED" }));
			const report = join(root, "scripts/ci/relay-deploy-result-report.mts");
			for (const args of [
				[json, "preview"],
				[json, "preview", "", "0junk"],
			]) {
				const ran = spawnSync(
					process.execPath,
					["--experimental-strip-types", "--no-warnings", report, ...args],
					{ encoding: "utf8" },
				);
				assert.equal(ran.status, 1);
				assert.doesNotMatch(ran.stdout, /HOBO_OK/u);
			}
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	it("classifies success only from a validated success envelope", () => {
		const work = mkdtempSync(join(tmpdir(), "relay-result-report-"));
		try {
			const json = join(work, "result.json");
			const report = join(root, "scripts/ci/relay-deploy-result-report.mts");
			const cases: readonly {
				body: string;
				exitArg: string;
				want: number;
			}[] = [
				{
					body: JSON.stringify({ ok: true, code: "HOBO_OK" }),
					exitArg: "0",
					want: 0,
				},
				{
					body: JSON.stringify({
						ok: false,
						code: "HOBO_TEST_REFUSED",
						message: "deployment unavailable",
					}),
					exitArg: "0",
					want: 1,
				},
				{ body: JSON.stringify({ ok: true }), exitArg: "0", want: 0 },
				{ body: "{}", exitArg: "0", want: 1 },
				{ body: "", exitArg: "0", want: 1 },
				{ body: "not json", exitArg: "0", want: 1 },
				{
					body: JSON.stringify({ code: "HOBO_TEST_REFUSED" }),
					exitArg: "0",
					want: 1,
				},
				{
					body: JSON.stringify({ ok: true, code: "HOBO_OK" }),
					exitArg: "27",
					want: 27,
				},
				{
					body: JSON.stringify({ ok: true, code: "HOBO_OK" }),
					exitArg: "",
					want: 1,
				},
				{
					body: JSON.stringify({ ok: true, code: "HOBO_OK" }),
					exitArg: "0junk",
					want: 1,
				},
			];
			for (const scenario of cases) {
				writeFileSync(json, scenario.body);
				const ran = spawnSync(
					process.execPath,
					[
						"--experimental-strip-types",
						"--no-warnings",
						report,
						json,
						"preview",
						"",
						scenario.exitArg,
					],
					{ encoding: "utf8" },
				);
				assert.equal(
					ran.status,
					scenario.want,
					`${scenario.body} with status ${JSON.stringify(scenario.exitArg)}: ${ran.stdout}${ran.stderr}`,
				);
			}
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	it("redacts an untrusted refusal code before printing it", () => {
		const work = mkdtempSync(join(tmpdir(), "relay-result-redaction-"));
		try {
			const json = join(work, "result.json");
			writeFileSync(
				json,
				JSON.stringify({
					ok: false,
					code: "HOBO_TEST_REFUSED Bearer SECRetKpR9wZ",
					message: "deployment unavailable",
				}),
			);
			const ran = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					join(root, "scripts/ci/relay-deploy-result-report.mts"),
					json,
					"preview",
					"",
					"1",
				],
				{ encoding: "utf8" },
			);
			assert.equal(ran.status, 1);
			assert.match(ran.stdout, /^preview:/mu);
			assert.match(ran.stdout, /\[redacted\]/iu);
			assert.doesNotMatch(ran.stdout, /SECRetKpR9wZ/u);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	it("reports a delivery refusal and stops before any later target", () => {
		const work = mkdtempSync(join(tmpdir(), "relay-adopt-report-"));
		try {
			const bin = join(work, "packages/hobo/dist/bin");
			mkdirSync(bin, { recursive: true });
			symlinkSync(join(root, "scripts"), join(work, "scripts"), "dir");
			symlinkSync(
				join(root, "node_modules"),
				join(work, "node_modules"),
				"dir",
			);
			writeFileSync(
				join(bin, "hobo.js"),
				`const fs = require("node:fs");
const target = process.argv[process.argv.indexOf("--target") + 1];
fs.appendFileSync(process.env.CALLS, target + "\\n");
const failed = target === process.env.FAIL_TARGET;
const malformed = failed && process.env.MALFORMED === "true";
if (failed) process.stderr.write("provider diagnostic VERCEL_TOKEN=supersecretvalue1 and bearer abc.def-ghi_123\\n");
			process.stdout.write(malformed ? "{not json VERCEL_TOKEN=supersecretvalue1" : JSON.stringify({ok: !failed, code: failed ? "HOBO_TEST_REFUSED" : "HOBO_OK", message: failed ? "deployment unavailable VERCEL_TOKEN=supersecretvalue1 and bearer abc.def-ghi_123" : "delivered"}));
process.exitCode = failed ? 27 : 0;`,
			);
			const lines = step("Deliver the relay through HoBo CD").split("\n");
			const start = lines.findIndex((line) => line.trim() === "run: |");
			assert.notEqual(start, -1);
			const script = lines
				.slice(start + 1)
				.map((line) => line.replace(/^ {10}/u, ""))
				.join("\n");
			for (const failedTarget of ["preview", "production"]) {
				for (const malformed of [false, true]) {
					const scenario = `${failedTarget}-${malformed}`;
					const summary = join(work, `summary-${scenario}.md`);
					const calls = join(work, `calls-${scenario}.txt`);
					const result = spawnSync(
						"bash",
						["-e", "-o", "pipefail", "-c", script],
						{
							cwd: work,
							encoding: "utf8",
							env: {
								...process.env,
								RUNNER_TEMP: work,
								GITHUB_STEP_SUMMARY: summary,
								GITHUB_SHA: "test",
								GITHUB_REF_NAME: "main",
								ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/oidc",
								ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-oidc-token",
								DEPLOY_DEADLINE: "2099-01-01T00:00:00.000Z",
								FAIL_TARGET: failedTarget,
								MALFORMED: String(malformed),
								CALLS: calls,
							},
						},
					);
					assert.equal(result.status, 27, result.stderr);
					assert.match(
						result.stdout,
						malformed
							? /command did not emit a valid JSON envelope/u
							: /HOBO_TEST_REFUSED/u,
					);
					assert.match(result.stdout, /provider diagnostic/u);
					assert.match(result.stdout, /\[redacted\]/u);
					assert.doesNotMatch(
						result.stdout,
						/supersecretvalue1|abc\.def-ghi_123/u,
					);
					assert.doesNotMatch(
						result.stderr,
						/supersecretvalue1|abc\.def-ghi_123/u,
					);
					const summaryText = readFileSync(summary, "utf8");
					assert.match(summaryText, /provider diagnostic/u);
					assert.match(summaryText, /\[redacted\]/u);
					assert.doesNotMatch(
						summaryText,
						/supersecretvalue1|abc\.def-ghi_123/u,
					);
					assert.equal(
						readFileSync(calls, "utf8"),
						failedTarget === "preview" ? "preview\n" : "preview\nproduction\n",
					);
				}
			}
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	it("bounds the delivery step within the 20 minute job", () => {
		const deploy = /^ {2}deploy:\n([\s\S]*?)\n {4}steps:/mu.exec(workflow)?.[1];
		assert.ok(deploy, "no deploy job");
		const jobTimeout = Number(
			/^ {4}timeout-minutes: (\d+)$/mu.exec(deploy)?.[1],
		);
		assert.equal(jobTimeout, RELAY_DEPLOY_JOB_TIMEOUT_MINUTES);
		assert.ok(jobTimeout <= 20, "every job is capped at 20 minutes");
		assert.ok(RELAY_DEPLOY_JOB_MARGIN_MINUTES >= 2);
		// The deadline is counted from the gate's own run, the job's timeout
		// less the margin.
		assert.equal(
			adoptDeadline(Date.UTC(2026, 10, 13, 12)),
			"2026-11-13T12:17:00.000Z",
		);
		const gate = step("Decide whether to deploy");
		assert.match(gate, /id: gate/u);
		assert.match(gate, /relay-deploy-gate\.mts/u);
		const gateLine = stepLine("Decide whether to deploy");
		const deliveryLine = stepLine("Deliver the relay through HoBo CD");
		assert.ok(gateLine >= 0 && deliveryLine >= 0 && gateLine < deliveryLine);
		const delivery = step("Deliver the relay through HoBo CD");
		assert.match(
			delivery,
			/DEPLOY_DEADLINE: \$\{\{ steps\.gate\.outputs\.deadline \}\}/u,
		);
		assert.match(delivery, /--deadline "\$DEPLOY_DEADLINE"/u);
		const stepTimeout = Number(/timeout-minutes: (\d+)/u.exec(delivery)?.[1]);
		assert.equal(
			stepTimeout,
			RELAY_DEPLOY_JOB_TIMEOUT_MINUTES - RELAY_DEPLOY_JOB_MARGIN_MINUTES,
		);
		const steps = workflow.slice(
			workflow.indexOf("    steps:", workflow.indexOf("\n  deploy:")),
			workflow.indexOf("\n  app-credentials:"),
		);
		for (const match of steps.matchAll(/timeout-minutes: (\d+)/gu))
			assert.ok(Number(match[1]) <= jobTimeout, match[0]);
	});

	it("verifies the protected preview with OIDC and production at the relay origin", () => {
		// The production origin comes from the committed Yard, not a variable,
		// and is an https origin with no path.
		const yardSource = readFileSync(
			join(root, "packages", "ci-vercel", "deploy", "yard.ts"),
			"utf8",
		);
		const origin = /productionOrigin: "(https:\/\/[^"/]+)"/u.exec(yardSource);
		assert.ok(origin, "deploy/yard.ts declares no productionOrigin");
		assert.match(
			yardSource,
			/productionOrigin: RELAY_PLACEMENT\.productionOrigin/u,
		);
		// Nothing in the workflow reaches past protection or names a probe URL.
		assert.doesNotMatch(
			workflow,
			/protection-bypass|VERCEL_AUTOMATION_BYPASS_SECRET|x-vercel-set-bypass-cookie/iu,
		);
		const delivery = step("Deliver the relay through HoBo CD");
		assert.match(delivery, /HOBO_CI_RELAY_PREVIEW_PROBE_OIDC: "true"/u);
		assert.match(delivery, /ACTIONS_ID_TOKEN_REQUEST_URL/u);
		assert.match(delivery, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/u);
		assert.match(delivery, /OIDC mint unavailable/u);
		assert.ok(origin[1]);
		assert.match(
			delivery,
			new RegExp(
				`^\\s+HOBO_CI_RELAY_PUBLIC_URL: ${origin[1].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`,
				"m",
			),
		);
		assert.match(delivery, /HOBO_CI_RELAY_STAGED_PRODUCTION: "true"/u);
	});

	it("verifies the secret store's CI identity before deployment", () => {
		const verify = step("Verify the secret store connection");
		assert.match(
			verify,
			/node packages\/hobo\/dist\/bin\/hobo\.js ci secret-store verify/u,
		);
		assert.match(verify, /relay-deploy-secret-store-verify-report\.mts/u);
		assert.doesNotMatch(verify, /\|\| true/u);
		const verifyCmdAt = verify.indexOf("ci secret-store verify");
		const verifyLine = stepLine("Verify the secret store connection");
		const deliverLine = stepLine("Deliver the relay through HoBo CD");
		assert.ok(verifyCmdAt >= 0);
		assert.ok(verifyLine >= 0);
		assert.ok(deliverLine >= 0);
		assert.ok(verifyLine < deliverLine);
	});

	it("deposits the GitHub App's credentials with OIDC only when handed a manifest code, masked first", () => {
		assert.match(
			workflow,
			/ {2}app-credentials:\n[\s\S]*?if: [^\n]*github\.event\.inputs\.manifest_code != ''/u,
		);
		assert.match(
			workflow,
			/ {2}deploy:\n[\s\S]*?if: [^\n]*github\.event\.inputs\.manifest_code == ''/u,
		);
		const mask = step("Mask the one-time manifest code");
		assert.match(mask, /::add-mask::\$HOBO_APP_MANIFEST_CODE/u);
		const deposit = step(
			"Convert the manifest code and store the credentials (GitHub OIDC)",
		);
		assert.match(deposit, /ci app deposit/u);
		// The code reaches the command through the environment, never argv.
		assert.doesNotMatch(
			deposit,
			/--code|\$\{\{ github\.event\.inputs\.manifest_code \}\}"/u,
		);
		assert.ok(
			workflow.indexOf("Mask the one-time manifest code") <
				workflow.indexOf("ci app deposit"),
		);
	});

	describe("probes the public origin", () => {
		const name = "Probe the fleet verdict at the public origin";

		/** The step's body check, run as the workflow runs it. */
		function judge(body: string, repository = "Hobo-Labs/HoBo") {
			const probe = step(name);
			const match = /node -e '([^']+)' "\$RUNNER_TEMP\/verdict\.json"/u.exec(
				probe,
			);
			assert.ok(match, "the step judges the answer with one node -e script");
			const dir = mkdtempSync(join(tmpdir(), "relay-verdict-probe-"));
			try {
				const file = join(dir, "verdict.json");
				writeFileSync(file, body);
				return spawnSync(process.execPath, ["-e", match[1] ?? "", file], {
					encoding: "utf8",
					env: { ...process.env, GITHUB_REPOSITORY: repository },
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}

		it("reads the relay's public origin from .hobo/ci.json, not the deployment URL", () => {
			const probe = step(name);
			assert.match(probe, /\.hobo\/ci\.json/u);
			assert.match(probe, /defaultEnvironment/u);
			assert.match(probe, /relayOrigin/u);
			assert.match(probe, /https:/u);
			assert.doesNotMatch(probe, /DEPLOYMENT_URL/u);
			assert.match(probe, /\/v1\/fleet\/verdicts\/\$\{?repository/u);
			assert.match(probe, /if: steps\.gate\.outputs\.run == 'true'/u);
		});

		it("runs after the existing checks, so it reports on what Vercel already deployed", () => {
			assert.ok(
				workflow.indexOf(`- name: ${name}`) >
					workflow.indexOf("- name: Deliver the relay through HoBo CD"),
			);
			assert.ok(
				workflow.indexOf(`- name: ${name}`) <
					workflow.indexOf("  app-credentials:"),
			);
		});

		it("is red, naming the rollback order, unless the read answers 200", () => {
			const probe = step(name);
			assert.match(probe, /\[ "\$code" != "200" \]/u);
			assert.match(probe, /::error title=Relay fleet verdict::/u);
			assert.match(probe, /exit 1/u);
			assert.match(probe, /6\.10|rollback/iu);
		});

		it("accepts a verdict for this repository with a blocked object", () => {
			const open = judge(
				JSON.stringify({ repository: "hobo-labs/hobo", blocked: {} }),
			);
			assert.equal(open.status, 0, open.stderr);
			const blocked = judge(
				JSON.stringify({
					repository: "hobo-labs/hobo",
					blocked: { hobo: { reason: "no-capacity" } },
					observedAt: "2026-11-12T11:14:00.000Z",
				}),
			);
			assert.equal(blocked.status, 0, blocked.stderr);
		});

		it("refuses an answer that is not a verdict for this repository", () => {
			for (const body of [
				"",
				"not json",
				"[]",
				JSON.stringify({ blocked: {} }),
				JSON.stringify({ repository: "other/repo", blocked: {} }),
				JSON.stringify({ repository: "hobo-labs/hobo" }),
				JSON.stringify({ repository: "hobo-labs/hobo", blocked: [] }),
				JSON.stringify({ repository: "hobo-labs/hobo", blocked: null }),
				JSON.stringify({ status: "config-unavailable" }),
			]) {
				const result = judge(body);
				assert.notEqual(result.status, 0, `accepted ${body}`);
			}
		});
	});

	it("passes the repository's workflow lint, as an approved CI fabric workflow", async () => {
		const previous = process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY;
		process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY = "1";
		try {
			const result = await lintActionsRepository(root);
			assert.equal(result.exitCode, 0, result.stderr);
		} finally {
			if (previous === undefined)
				delete process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY;
			else process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY = previous;
		}
	});

	it("rejects a hosted relay job that loses an attestation", async () => {
		const previous = process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY;
		process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY = "1";
		const temp = mkdtempSync(join(tmpdir(), "relay-runner-lint-"));
		try {
			const workflowDir = join(temp, ".github", "workflows");
			mkdirSync(workflowDir, { recursive: true });
			const mutated = [
				[
					"an unclean checkout",
					workflow.replaceAll("clean: true", "clean: false"),
				],
				[
					"a route-runner step",
					workflow.replace(
						"      - name: Decide whether to deploy",
						"      - uses: ./.github/actions/route-runner\n      - name: Decide whether to deploy",
					),
				],
				[
					"an overbroad permission",
					workflow.replaceAll("id-token: write", "deployments: write"),
				],
				[
					"an unbound digest source",
					workflow.replace(
						"${{ needs.deploy-build.outputs.digest }}",
						"${{ vars.HOBO_RELAY_CLI_DIGEST }}",
					),
				],
				[
					"an unpinned artifact download",
					workflow.replace(
						"actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
						"actions/download-artifact@1111111111111111111111111111111111111111",
					),
				],
			] as const;
			for (const [name, text] of mutated) {
				writeFileSync(join(workflowDir, "relay-deploy.yml"), text);
				const result = await lintActionsRepository(temp);
				assert.equal(result.exitCode, 1, `${name}: ${result.stdout}`);
				assert.match(
					result.stderr,
					/runs-on must be hobo|authoritative CI jobs must run on self-hosted hobo runners/u,
					`${name}: ${result.stderr}`,
				);
			}
		} finally {
			if (previous === undefined)
				delete process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY;
			else process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY = previous;
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
