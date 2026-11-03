import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "@hobo/core/total-access";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import {
	BROWSER_RECORDING_SCHEMA,
	exportEvidenceRecordingAutomation,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";
import { createLocalSessionControl } from "../src/local-session-control.js";
import type { MuxRunner } from "../src/mux.js";
import {
	saveRecordingCapability,
	startSessionControlServer,
} from "../src/session-control-server.js";

const roots: string[] = [];
const capabilityInteractions =
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	(
		JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"..",
					"contracts",
					"pacts",
					"recording-capability-host.pact.json",
				),
				"utf8",
			),
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
		) as {
			interactions: readonly {
				request: {
					method: string;
					path: string;
					headers: Record<string, string>;
					body: JsonObject;
				};
				response: {
					status: number;
					headers: Record<string, string>;
					body: JsonObject;
				};
			}[];
		}
	).interactions;

const capabilityInteraction = capabilityInteractions[0];
const rejectedCapabilityInteraction = capabilityInteractions[1];
if (!capabilityInteraction || !rejectedCapabilityInteraction)
	throw new Error("recording capability PACT is empty");

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function git(cwd: string, args: readonly string[]): void {
	const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
}

function repository(): string {
	const root = temp("hobo-session-server-repo-");
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "Test"]);
	writeFileSync(join(root, "README.md"), "base\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-qm", "base"]);
	return root;
}

function fakeTmux(): MuxRunner {
	let pane = 0;
	let exists = false;
	return {
		async run(args) {
			if (args[0] === "capture-pane") {
				return { code: 0, stdout: "resident output\n" };
			}
			if (args[0] === "has-session") {
				return { code: exists ? 0 : 1, stdout: "" };
			}
			if (
				["new-session", "new-window", "split-window"].includes(args[0] ?? "")
			) {
				exists = true;
				pane += 1;
				return { code: 0, stdout: `%${pane}\n` };
			}
			if (args[0] === "kill-session") exists = false;
			return { code: 0, stdout: "" };
		},
	};
}

function envelope(
	sessionId: string,
	revision: string,
	command: string,
	value: JsonObject,
): JsonObject {
	return {
		schemaVersion: "hobo.code.session-command/v1",
		commandId: `${command}-${revision}`,
		actorId: "browser-test",
		sessionId,
		expectedRevision: revision,
		[command]: value,
	};
}

describe("resident session loopback server", () => {
	it("rejects a recording root symlink that escapes the project", () => {
		const projectRoot = temp("hobo-session-recording-project-");
		const outside = temp("hobo-session-recording-outside-");
		symlinkSync(outside, join(projectRoot, ".hobo"), "dir");
		const exported = exportEvidenceRecordingAutomation(
			{
				schemaVersion: BROWSER_RECORDING_SCHEMA,
				id: "recording-escape",
				title: "Escape",
				status: "completed",
				startUrl: "https://example.test/start",
				endUrl: "https://example.test/end",
				durationMs: 1,
				viewport: { width: 800, height: 600 },
				actions: [
					{
						sequence: 1,
						offsetMs: 0,
						type: "navigate",
						path: "/end",
					},
				],
				checkpoints: [],
			},
			{ name: "Escape" },
		);

		expect(() => saveRecordingCapability(projectRoot, exported)).toThrow(
			"recording capability path escaped the project root",
		);
		expect(existsSync(join(outside, "recordings"))).toBe(false);
		expect(() =>
			saveRecordingCapability(temp("hobo-session-recording-forged-"), {
				...exported,
				capabilityId: "../escape",
			}),
		).toThrow("skill name must be a lowercase slug");
	});

	it("serves authenticated browser controls and the shared command boundary", async () => {
		const hoboHome = temp("hobo-session-server-home-");
		const projectRoot = repository();
		const tmux = fakeTmux();
		const control = createLocalSessionControl({ hoboHome, tmux });
		const server = await startSessionControlServer({
			hoboHome,
			projectRoot,
			token: "test-token",
			control,
		});
		try {
			expect(
				existsSync(join(hoboHome, "runtime", "code", "evidence-controls-url")),
			).toBe(true);
			expect(server.controlsUrlTemplate).toMatch(
				/^http:\/\/127\.0\.0\.1:\d+\/__hobo\/evidence\/controls\/[A-Za-z0-9_-]+$/u,
			);
			const unauthorized = await fetch(
				`http://127.0.0.1:${server.port}/code/sessions`,
			);
			expect(unauthorized.status).toBe(401);

			const page = await fetch(server.url);
			expect(page.status).toBe(200);
			const html = await page.text();
			expect(html).toContain("HoBo Code resident sessions");
			expect(html).toContain("Evidence report");
			expect(html).toContain("forward this loopback port");
			expect(html).toContain("never binds publicly");
			expect(html).toContain("Full command boundary");
			for (const action of [
				"create-tab",
				"create-pane",
				"split-horizontal",
				"split-vertical",
				"close-pane",
				"start-agent",
				"stop-agent",
				"create-checkpoint",
				"restore-checkpoint",
				"commit",
				"push",
				"open-pr",
				"stack-pr",
				"merge-pr",
			]) {
				expect(html).toContain(`'${action}'`);
			}
			expect(html).toContain("className='pane-grid'");
			expect(html).toContain("function paneGeometry(p)");
			expect(html).toContain("grid.style.aspectRatio");
			expect(html).toContain("tile.style.left=g.left+'%'");
			expect(html).toContain("@media(max-width:48rem)");
			expect(html).toContain("width:100%!important;height:auto!important");
			expect(html).toContain("b.dataset.action=action");
			expect(html).toContain("sessionStorage.hoboCodeClientId");
			expect(html).toContain("p.id===s.focusedPaneId?' · focused':'");
			expect(html).toContain("Running panes and agents will terminate.");
			expect(html).toContain("Session is stopped.");
			expect(html).toContain("Session failed unexpectedly.");
			expect(html).toContain("failed?'failed':'stopped'");
			expect(html).toContain("'+s.session.id+')?");
			expect(html).toContain("Exact effect:");
			expect(html).toContain("Approval required for ");
			expect(html).toContain("challenge.approvalDigest");
			expect(html).toContain("Stop agent '+run.provider+' ('+run.id+')");
			expect(html).toContain("Restore checkpoint '+checkpoint.label");
			expect(html).toContain("s.session.name+' · '+s.session.id");
			expect(html).toContain("focused&&!forceIds.has(s.session.id)");
			expect(html).toContain("await refresh(id)");
			expect(html).toContain("pullRequestNumber:Number(pullRequestNumber)");
			expect(html).toContain("Git workbench");
			expect(html).toContain("1–5 panels · ↑↓/jk move · Space stage");
			expect(html).toContain("stagedOnly:true");
			expect(html).toContain("data-git-panel");
			expect(html).toContain("forcedRefreshIds.add(forceId)");
			expect(html).toContain("while(forcedRefreshIds.size)");
			expect(html).toContain("const scrollY=window.scrollY");
			expect(html).toContain("window.scrollTo(0,scrollY)");
			for (const action of [
				"select-git-tab",
				"git-stage",
				"git-discard",
				"git-ignore",
				"git-fetch",
				"git-pull",
				"git-checkout",
				"git-new-branch",
				"git-delete-branch",
				"git-stash-create",
				"git-stash-apply",
				"git-stash-pop",
				"git-stash-drop",
				"git-revert",
				"git-commit",
				"git-push",
				"git-open-pr",
				"git-stack",
				"git-merge",
			]) {
				expect(html).toContain(`'${action}'`);
			}
			expect(html).not.toContain("root.replaceChildren()");
			expect(html).toContain(
				"This browser is detached. Reattach to view pane output and controls.",
			);
			expect(html.indexOf("if(!attached)")).toBeLessThan(
				html.indexOf("/panes/'+encodeURIComponent(pane.id)+'/output"),
			);
			const script = /<script>([\s\S]+)<\/script>/u.exec(html)?.[1];
			expect(script).toBeDefined();
			expect(() => new Function(script ?? "")).not.toThrow();

			const report = await fetch(server.reportUrl);
			expect(report.status).toBe(200);
			const reportHtml = await report.text();
			expect(reportHtml).toContain("live work report");
			expect(reportHtml).toMatch(/class="stream/);
			expect(reportHtml).toContain("/__hobo/evidence/journal");
			expect(reportHtml).toContain("provenance");
			const controls = await fetch(server.controlsUrl("http://127.0.0.1:4173"));
			expect(controls.status).toBe(200);
			const controlsHtml = await controls.text();
			expect(controlsHtml).toContain("Evidence desk");
			const evidenceHref = /href="([^"]+\?report=[^"]+)"/u.exec(
				controlsHtml,
			)?.[1];
			expect(evidenceHref).toBeDefined();
			expect(evidenceHref).not.toContain("test-token");
			const linkedEvidence = await fetch(must(evidenceHref, "evidenceHref"));
			expect(linkedEvidence.status).toBe(200);
			expect(await linkedEvidence.text()).toContain("live work report");
			const screenshot = Uint8Array.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
			]);
			const foreignCapture = await fetch(
				`${server.controlsUrlTemplate.replace("/controls/", "/api/captures/")}?kind=screenshot`,
				{
					method: "POST",
					headers: { origin: "https://attacker.example" },
					body: screenshot,
				},
			);
			expect(foreignCapture.status).toBe(403);
			const foreignAction = await fetch(
				server.controlsUrlTemplate.replace("/controls/", "/api/actions/"),
				{
					method: "POST",
					headers: {
						origin: "https://attacker.example",
						"content-type": "text/plain",
					},
					body: JSON.stringify({ type: "report" }),
				},
			);
			expect(foreignAction.status).toBe(403);
			const reportAction = await fetch(
				server.controlsUrlTemplate.replace("/controls/", "/api/actions/"),
				{
					method: "POST",
					headers: {
						origin: "http://127.0.0.1:4173",
						"content-type": "text/plain",
					},
					body: JSON.stringify({ type: "report" }),
				},
			);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const reportResult = (await reportAction.json()) as { url: string };
			expect(reportAction.status).toBe(200);
			expect(reportResult.url).toContain("?report=");
			expect(reportResult.url).not.toContain("test-token");
			const readOnlyReport = await fetch(reportResult.url);
			expect(readOnlyReport.status).toBe(200);
			expect(await readOnlyReport.text()).not.toContain("test-token");
			const actionResponse = await fetch(
				`${server.controlsUrlTemplate.replace("/controls/", "/api/captures/")}?kind=screenshot&subject=browser%3Acurrent`,
				{
					method: "POST",
					headers: {
						origin: "http://127.0.0.1:4173",
					},
					body: screenshot,
				},
			);
			expect(actionResponse.status).toBe(201);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const captured = (await actionResponse.json()) as {
				artifactRef: string;
			};
			expect(captured.artifactRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
			const capturedAsset = await fetch(
				`http://127.0.0.1:${server.port}/__hobo/assets/sha256/${captured.artifactRef.slice(7)}?token=test-token`,
			);
			expect(new Uint8Array(await capturedAsset.arrayBuffer())).toEqual(
				screenshot,
			);
			const video = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
			const videoResponse = await fetch(
				`${server.controlsUrlTemplate.replace("/controls/", "/api/captures/")}?kind=recording-video`,
				{
					method: "POST",
					headers: { origin: "http://127.0.0.1:4173" },
					body: video,
				},
			);
			expect(videoResponse.status).toBe(201);
			const videoArtifactRef =
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				((await videoResponse.json()) as { artifactRef: string }).artifactRef;
			const manifestResponse = await fetch(
				`${server.controlsUrlTemplate.replace("/controls/", "/api/captures/")}?kind=recording-manifest`,
				{
					method: "POST",
					headers: {
						origin: "http://127.0.0.1:4173",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						videoArtifactRef,
						manifest: {
							schemaVersion: "hobo.code.browser-recording/v1",
							id: "recording-17",
							title: "Checkout",
							status: "completed",
							startUrl: "http://127.0.0.1:4173/cart",
							endUrl: "http://127.0.0.1:4173/complete",
							durationMs: 42,
							viewport: { width: 1280, height: 720 },
							actions: [
								{
									sequence: 1,
									offsetMs: 3,
									type: "click",
									target: { role: "button", name: "Checkout" },
								},
							],
							checkpoints: [
								{
									sequence: 1,
									afterAction: 1,
									path: "/complete",
									title: "Complete",
								},
							],
						},
					}),
				},
			);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const manifestResult = (await manifestResponse.json()) as {
				recordingId: string;
				artifactRefs: readonly string[];
			};
			expect(manifestResult).toMatchObject({
				recordingId: "recording-17",
				artifactRefs: [videoArtifactRef, expect.stringMatching(/^sha256:/u)],
			});
			const capabilityUrl = server.controlsUrlTemplate.replace(
				"/controls/",
				"/api/actions/",
			);
			const unprivilegedCapability = await fetch(capabilityUrl, {
				method: "POST",
				headers: {
					origin: "http://127.0.0.1:4173",
					"content-type": "text/plain",
				},
				body: JSON.stringify(capabilityInteraction.request.body),
			});
			expect(unprivilegedCapability.status).toBe(403);
			expect(await unprivilegedCapability.json()).toMatchObject({
				error: "recording capability export requires controls authorization",
			});
			expect(
				new URL(capabilityUrl).pathname.replace(
					/\/[^/]+$/u,
					"/:controlsCapability",
				),
			).toBe(capabilityInteraction.request.path);
			const rejectedResponse = await fetch(capabilityUrl, {
				method: rejectedCapabilityInteraction.request.method,
				headers: rejectedCapabilityInteraction.request.headers,
				body: JSON.stringify(rejectedCapabilityInteraction.request.body),
			});
			expect(rejectedResponse.status).toBe(
				rejectedCapabilityInteraction.response.status,
			);
			for (const [name, value] of Object.entries(
				rejectedCapabilityInteraction.response.headers,
			))
				expect(rejectedResponse.headers.get(name)).toBe(value);
			expect(await rejectedResponse.json()).toMatchObject(
				rejectedCapabilityInteraction.response.body,
			);
			const capabilityResponse = await fetch(capabilityUrl, {
				method: capabilityInteraction.request.method,
				headers: capabilityInteraction.request.headers,
				body: JSON.stringify(capabilityInteraction.request.body),
			});
			expect(manifestResult.recordingId).toBe(
				capabilityInteraction.request.body.recordingId,
			);
			expect(capabilityResponse.status).toBe(
				capabilityInteraction.response.status,
			);
			for (const [name, value] of Object.entries(
				capabilityInteraction.response.headers,
			))
				expect(capabilityResponse.headers.get(name)).toBe(value);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const capability = (await capabilityResponse.json()) as {
				capabilityId: string;
				command: string;
				path: string;
				replayability: string;
				artifactRefs: readonly string[];
			};
			expect(capability).toMatchObject(capabilityInteraction.response.body);
			expect(capability.artifactRefs).toHaveLength(3);
			expect(
				readFileSync(
					join(
						projectRoot,
						".hobo",
						"recordings",
						"checkout-replay",
						"SKILL.md",
					),
					"utf8",
				),
			).toContain(`Source recording: \`recording-17\``);
			expect(
				readFileSync(
					join(
						projectRoot,
						".hobo",
						"recordings",
						"checkout-replay",
						"scripts",
						"run.spec.ts",
					),
					"utf8",
				),
			).toContain('getByRole("button", { name: "Checkout"');

			const headers = {
				authorization: "Bearer test-token",
				"content-type": "application/json",
			};
			const evidenceResponse = await fetch(
				`http://127.0.0.1:${server.port}/code/evidence`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						kind: "test",
						title: "Focused server test",
						summary: "passed",
						subject: "project:test",
						artifactRefs: [],
					}),
				},
			);
			expect(evidenceResponse.status).toBe(200);
			expect(await evidenceResponse.json()).toMatchObject({
				kind: "test",
				verification: "claimed",
				origin: "hobo-code:control-server",
				actor: "principal:local-developer",
			});
			const liveReport = await fetch(
				`http://127.0.0.1:${server.port}/__hobo/evidence/api/report`,
				{ headers },
			);
			expect(await liveReport.json()).toMatchObject({
				sections: expect.arrayContaining([
					expect.objectContaining({
						id: "tests",
						facts: [
							expect.objectContaining({
								title: "Focused server test",
								state: "claimed",
							}),
						],
					}),
				]),
			});
			const portable = await fetch(
				`http://127.0.0.1:${server.port}/__hobo/evidence/api/export`,
				{ headers },
			);
			expect(await portable.json()).toMatchObject({
				html: expect.stringContaining("portable export"),
				manifest: expect.stringContaining('"controlsEnabled": false'),
			});
			const createdResponse = await fetch(
				`http://127.0.0.1:${server.port}/code/commands`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						command: envelope("session-1", "0", "createSession", {
							name: "review",
							projectRoot,
							branch: "code/review",
							clientId: "browser-test",
						}),
					}),
				},
			);
			expect(createdResponse.status).toBe(200);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const created = (await createdResponse.json()) as {
				revision: string;
				session: { worktreePath: string };
				panes: readonly { id: string }[];
				agentRuns: readonly unknown[];
			};
			expect(created.panes).toHaveLength(1);
			expect(created.agentRuns).toEqual([]);
			const recorded = await fetch(
				`http://127.0.0.1:${server.port}/code/sessions/session-1/replay`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						track: "annotation",
						metadata: { selector: "#primary" },
						observable: { note: "spacing is wrong", token: "must-redact" },
					}),
				},
			);
			expect(await recorded.json()).toMatchObject({
				accepted: true,
				level: "observable",
			});
			const replay = await fetch(
				`http://127.0.0.1:${server.port}/code/sessions/session-1/replay`,
				{ headers },
			);
			expect(await replay.json()).toMatchObject({
				openUi: { readOnly: true, mutationSurface: "cli-only" },
				debugTimeline: [
					expect.objectContaining({
						track: "annotation",
						metadata: { selector: "#primary" },
					}),
				],
			});
			writeFileSync(
				join(created.session.worktreePath, "approved.txt"),
				"approved\n",
			);
			const gitResponse = await fetch(
				`http://127.0.0.1:${server.port}/code/sessions/session-1/git`,
				{ headers },
			);
			expect(gitResponse.status).toBe(200);
			expect(await gitResponse.json()).toMatchObject({
				branch: "code/review",
				files: [{ path: "approved.txt", untracked: true }],
			});
			const invalidSelection = await fetch(
				`http://127.0.0.1:${server.port}/code/sessions/session-1/git?kind=tag&value=v1`,
				{ headers },
			);
			expect(invalidSelection.status).toBe(400);
			const invalidAction = await fetch(
				`http://127.0.0.1:${server.port}/code/sessions/session-1/git/actions`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ action: "shell", command: "rm -rf" }),
				},
			);
			expect(invalidAction.status).toBe(400);
			const commitCommand = envelope("session-1", created.revision, "commit", {
				message: "approved browser commit",
			});
			const challengeResponse = await fetch(
				`http://127.0.0.1:${server.port}/code/commands`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ command: commitCommand }),
				},
			);
			expect(challengeResponse.status).toBe(409);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const challenge = (await challengeResponse.json()) as {
				approvalDigest: string;
				approval: { details: { gitHead: string; message: string } };
			};
			expect(challenge.approval.details).toMatchObject({
				message: "approved browser commit",
			});
			const wrongApproval = await fetch(
				`http://127.0.0.1:${server.port}/code/commands`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						command: commitCommand,
						approvalDigest: "0".repeat(64),
					}),
				},
			);
			expect(wrongApproval.status).toBe(409);
			const approvedCommit = await fetch(
				`http://127.0.0.1:${server.port}/code/commands`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						command: commitCommand,
						approvalDigest: challenge.approvalDigest,
					}),
				},
			);
			expect(approvedCommit.status).toBe(200);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const committed = (await approvedCommit.json()) as { revision: string };

			const detached = await fetch(
				`http://127.0.0.1:${server.port}/code/commands`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						command: envelope(
							"session-1",
							committed.revision,
							"detachSession",
							{
								clientId: "browser-test",
							},
						),
					}),
				},
			);
			expect(detached.status).toBe(200);

			const listed = await fetch(
				`http://127.0.0.1:${server.port}/code/sessions`,
				{ headers },
			);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const sessions = (await listed.json()) as readonly unknown[];
			expect(sessions).toHaveLength(1);
			const output = await fetch(
				`http://127.0.0.1:${server.port}/code/sessions/session-1/panes/${created.panes[0]?.id}/output`,
				{ headers },
			);
			expect(await output.json()).toEqual({ output: "resident output\n" });
		} finally {
			await server.close();
		}
		const restarted = createLocalSessionControl({ hoboHome, tmux });
		await expect(restarted.list()).resolves.toHaveLength(1);
		restarted.close();
	});

	it("keeps keyboard selection and focus through forced Git refreshes", async () => {
		const hoboHome = temp("hobo-session-browser-home-");
		const projectRoot = repository();
		const control = createLocalSessionControl({ hoboHome, tmux: fakeTmux() });
		const server = await startSessionControlServer({
			hoboHome,
			projectRoot,
			token: "browser-token",
			control,
		});
		const headers = {
			authorization: "Bearer browser-token",
			"content-type": "application/json",
		};
		const createdResponse = await fetch(
			`http://127.0.0.1:${server.port}/code/commands`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					command: envelope("keyboard-session", "0", "createSession", {
						name: "keyboard review",
						projectRoot,
						branch: "code/keyboard-review",
						clientId: "browser-test",
					}),
				}),
			},
		);
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		const created = (await createdResponse.json()) as {
			session: { worktreePath: string };
		};
		writeFileSync(join(created.session.worktreePath, "stashed.txt"), "stash\n");
		git(created.session.worktreePath, ["add", "stashed.txt"]);
		git(created.session.worktreePath, ["stash", "push", "-m", "browser stash"]);
		writeFileSync(
			join(created.session.worktreePath, "approved.txt"),
			"approved\n",
		);

		const browser = await chromium.launch({
			headless: true,
			executablePath: resolveChromiumExecutable(),
		});
		try {
			const page = await browser.newPage();
			page.setDefaultTimeout(3_000);
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.addInitScript(() => {
				sessionStorage.hoboCodeClientId = "browser-test";
			});
			await page.goto(server.url);
			await page.waitForTimeout(250);
			if ((await page.getByRole("tab", { name: "Git" }).count()) === 0)
				throw new Error(
					JSON.stringify({
						pageErrors,
						result: await page.locator("#result").textContent(),
						body: await page.locator("body").innerText(),
					}),
				);
			await page.getByRole("tab", { name: "Git" }).click();
			await page.locator(".git-workbench").waitFor();

			for (const [key, kind, panel] of [
				["1", "branch", "1"],
				["2", "file", "2"],
				["3", "branch", "3"],
				["4", "commit", "4"],
				["5", "stash", "5"],
			] as const) {
				await page.keyboard.press(key);
				await page.waitForFunction(
					({ expected, expectedPanel }) =>
						document.activeElement instanceof HTMLElement &&
						document.activeElement.dataset.gitKind === expected &&
						document.activeElement.dataset.gitPanel === expectedPanel &&
						document.activeElement.getAttribute("aria-selected") === "true",
					{ expected: kind, expectedPanel: panel },
				);
			}

			await page.keyboard.press("2");
			await page.waitForFunction(
				() =>
					document.activeElement instanceof HTMLElement &&
					document.activeElement.dataset.gitKind === "file" &&
					document.activeElement.getAttribute("aria-selected") === "true",
			);
			await page.keyboard.press("Space");
			await expect
				.poll(
					() =>
						spawnSync("git", ["status", "--short"], {
							cwd: created.session.worktreePath,
							encoding: "utf8",
						}).stdout,
				)
				.toContain("A  approved.txt");
			await page.waitForFunction(
				() =>
					// @ts-expect-error browser test reaches the inline workbench state
					gitMutationFlights.size === 0 &&
					document.activeElement instanceof HTMLElement &&
					document.activeElement.dataset.gitKind === "file",
			);
			await page.keyboard.press("Space");
			await expect
				.poll(
					() =>
						spawnSync("git", ["status", "--short"], {
							cwd: created.session.worktreePath,
							encoding: "utf8",
						}).stdout,
				)
				.toContain("?? approved.txt");
			await page.waitForFunction(
				() =>
					// @ts-expect-error browser test reaches the inline workbench state
					gitMutationFlights.size === 0 &&
					document.activeElement instanceof HTMLElement &&
					document.activeElement.dataset.gitKind === "file",
			);

			await page.keyboard.press("j");
			await page.waitForFunction(
				() =>
					document.activeElement instanceof HTMLElement &&
					document.activeElement.dataset.gitKind === "branch" &&
					document.activeElement.dataset.gitPanel === "3" &&
					document.activeElement.getAttribute("aria-selected") === "true",
			);
			await page.keyboard.press("2");
			await page.waitForFunction(
				() =>
					document.activeElement instanceof HTMLElement &&
					document.activeElement.dataset.gitKind === "file" &&
					document.activeElement.dataset.gitPanel === "2" &&
					document.activeElement.getAttribute("aria-selected") === "true",
			);
			await page.keyboard.press("k");
			await page.waitForFunction(
				() =>
					document.activeElement instanceof HTMLElement &&
					document.activeElement.dataset.gitKind === "branch" &&
					document.activeElement.dataset.gitPanel === "1" &&
					document.activeElement.getAttribute("aria-selected") === "true",
			);
		} finally {
			await browser.close();
			await server.close();
		}
	}, 20_000);
});

/**
 * Finds a Chromium that is actually installed, rather than the revision this
 * Playwright build happens to pin.
 *
 * Playwright resolves its browser by exact revision — `chromium_headless_shell-1234`
 * — and hard-fails with "run npx playwright install" when the host has a
 * different one. Plenty of hosts deliberately ship a pinned browser they do not
 * want re-downloaded (the CI runner image bakes one under /opt/pw-browsers; dev
 * containers often carry an older revision), so the pin makes the test fail for
 * a reason that has nothing to do with the code under test.
 *
 * This looks for whatever is on disk instead, preferring the headless shell
 * because that is what `headless: true` wants, in both Playwright layouts
 * (linux-x64 Chrome for Testing, linux-arm64 Chromium builds). An explicit
 * PLAYWRIGHT_CHROMIUM_PATH wins. Finding nothing throws: a browser test that
 * passes without a browser is not one.
 */
function resolveChromiumExecutable(): string {
	const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
	if (override) {
		if (existsSync(override)) return override;
		throw new Error(`PLAYWRIGHT_CHROMIUM_PATH=${override} does not exist`);
	}

	const roots = [
		process.env.PLAYWRIGHT_BROWSERS_PATH,
		"/opt/pw-browsers",
		join(homedir(), ".cache", "ms-playwright"),
	].filter(
		(root): root is string =>
			root !== undefined && root !== "" && existsSync(root),
	);
	const layouts = [
		{
			prefix: "chromium_headless_shell-",
			paths: [
				["chrome-headless-shell-linux64", "chrome-headless-shell"],
				["chrome-linux", "headless_shell"],
			],
		},
		{
			prefix: "chromium-",
			paths: [
				["chrome-linux64", "chrome"],
				["chrome-linux", "chrome"],
			],
		},
	];
	const candidates: string[] = [];
	for (const { prefix, paths } of layouts) {
		for (const root of roots) {
			for (const entry of readdirSync(root).sort().reverse()) {
				if (!entry.startsWith(prefix)) continue;
				for (const path of paths) candidates.push(join(root, entry, ...path));
			}
		}
	}
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found) return found;
	throw new Error(
		[
			"no Chromium for the browser test.",
			`searched: ${roots.length > 0 ? roots.join(", ") : "(no browser directory exists)"}`,
			"CI: rebuild the runner image (packages/ci-gh-actions/deploy/ci-runner/build.sh bakes the headless shell into /opt/pw-browsers).",
			"Local: pnpm exec playwright install chromium-headless-shell, or set PLAYWRIGHT_CHROMIUM_PATH.",
		].join("\n"),
	);
}
