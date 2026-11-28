import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	ceremonyProperties,
	check,
	eventsFromWire,
	REACHES_FRONTIER,
	secretStoreLocatorPath,
	type WireMessage,
} from "@hobo/hobo-ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
	copiedSession,
	startFakeInfisical,
} from "./support/fake-infisical-api.js";
import {
	fakeNeon,
	fakeVercel,
	fakeVercelCli,
	readStagedBuilds,
} from "./support/fake-providers.js";
import { startTlsWorld } from "./support/tls-world.js";

// SMOKE: the real `hobo-mcp` binary, as the owner's host runs it on a remote
// box, driven exactly as that host does: its declared capabilities (taken
// from the live host's initialize), one `cd up --hand-off`, and the owner's
// answers to the forms it asks for. Nothing in this
// test reaches past the process's stdio but a fake Infisical on 127.0.0.1.
// Every step the owner sees is checked in the order they would see it.

/** What the live host declared at initialize (Claude Code 2.1.325). */
const LIVE_HOST = {
	roots: { listChanged: true },
	elicitation: { form: {}, url: {} },
};
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const message = z.record(z.string(), z.json());
type Message = z.infer<typeof message>;

function startServer(env: NodeJS.ProcessEnv) {
	const config = env.XDG_CONFIG_HOME;
	if (!config) throw new Error("A synthetic config directory is required.");
	const launcher = z
		.object({
			mcpServers: z.object({
				hobo: z.object({ command: z.string(), args: z.array(z.string()) }),
			}),
		})
		.parse(JSON.parse(readFileSync(path.join(REPO, ".mcp.json"), "utf8")))
		.mcpServers.hobo;
	const child = spawn(launcher.command, launcher.args, {
		cwd: REPO,
		env: {
			...env,
			XDG_STATE_HOME: path.join(config, "state"),
			CLAUDE_CODE_REMOTE: "",
			CODESPACES: "",
			GITPOD_WORKSPACE_ID: "",
			CODER: "",
			REMOTE_CONTAINERS: "",
			DEVCONTAINER: "",
			CLOUD_SHELL: "",
			SSH_CONNECTION: "",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const inbox: Message[] = [];
	// The whole exchange, both ways, for the spec model's properties.
	const wire: WireMessage[] = [];
	const waiters: (() => void)[] = [];
	let buffer = "";
	let exited = false;
	child.on("exit", () => {
		exited = true;
		for (const wake of waiters.splice(0)) wake();
	});
	child.stderr.resume();
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl);
			if (line.trim() !== "") {
				wire.push({ to: "host", message: line });
				inbox.push(message.parse(JSON.parse(line)));
			}
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
		}
		for (const wake of waiters.splice(0)) wake();
	});
	const next = async (match: (m: Message) => boolean): Promise<Message> => {
		for (;;) {
			const at = inbox.findIndex(match);
			const [found] = at === -1 ? [] : inbox.splice(at, 1);
			if (found !== undefined) return found;
			if (exited) throw new Error("The synthetic MCP server exited early.");
			await new Promise<void>((resolve) => waiters.push(resolve));
		}
	};
	const expectEvent = async (mine: number, match: (m: Message) => boolean) => {
		const event = await next(
			(m) => match(m) || (m.id === mine && m.method === undefined),
		);
		if (event.id !== mine || event.method !== undefined) return event;
		const response = z
			.object({
				result: z.object({ content: z.array(z.object({ text: z.string() })) }),
			})
			.safeParse(event);
		let code = "unrecognized";
		if (response.success) {
			try {
				const envelope = z
					.object({ code: z.string().regex(/^(?:HOBO|MCP)_[A-Z0-9_]+$/u) })
					.safeParse(
						JSON.parse(response.data.result.content[0]?.text ?? "null"),
					);
				if (envelope.success) code = envelope.data.code;
			} catch {}
		}
		throw new Error(`The synthetic owner step returned early: ${code}.`);
	};
	let id = 0;
	const send = (m: Message) => {
		const line = JSON.stringify(m);
		wire.push({ to: "server", message: line });
		return child.stdin.write(`${line}\n`);
	};
	const call = (method: string, params: Message) => {
		id += 1;
		send({ jsonrpc: "2.0", id, method, params });
		return id;
	};
	const answer = (mine: number) =>
		next((m) => m.id === mine && m.method === undefined);
	return {
		next,
		expectEvent,
		send,
		call,
		answer,
		wire,
		tool: (name: string, args: Message) =>
			call("tools/call", { name, arguments: args }),
		stop: () => {
			child.stdin.end();
			child.kill();
		},
	};
}

describe("SMOKE remote ceremony through the real hobo-mcp binary", () => {
	it("cd up with an existing journal: every owner step is a private form", async () => {
		const config = mkdtempSync(path.join(tmpdir(), "hobo-smoke-config-"));
		// The providers at their real hostnames, behind an inspecting proxy
		// that trusts only its own CA: real-internet egress, or egress that
		// bypasses the proxy, fails instead of passing silently.
		const api = await startFakeInfisical("org-1");
		api.seedJournalFleet();
		const vercelCli = fakeVercelCli(
			mkdtempSync(path.join(tmpdir(), "hobo-smoke-vercel-cli-")),
			path.join(
				REPO,
				"packages",
				"cd-vercel",
				"deploy",
				"secret-store.binding.json",
			),
		);
		const vercel = fakeVercel(vercelCli.staged);
		const neon = fakeNeon();
		const world = await startTlsWorld({
			"app.infisical.com": api.handle,
			"api.vercel.com": vercel.handle,
			"neon.new": neon.handle,
		});
		const locator = secretStoreLocatorPath(REPO, { XDG_CONFIG_HOME: config });
		mkdirSync(path.dirname(locator), { recursive: true });
		writeFileSync(
			locator,
			JSON.stringify({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "proj-1",
			}),
		);
		const server = startServer({
			...process.env,
			XDG_CONFIG_HOME: config,
			CLAUDE_CODE_REMOTE: "true",
			HOBO_VERCEL_CLI: vercelCli.cli,
			GITHUB_HEAD_REF: process.env.GITHUB_HEAD_REF || "hobo-smoke",
			HTTPS_PROXY: world.proxyUrl,
			https_proxy: world.proxyUrl,
			HTTP_PROXY: world.proxyUrl,
			http_proxy: world.proxyUrl,
			NO_PROXY: "",
			no_proxy: "",
			NODE_EXTRA_CA_CERTS: world.caBundle,
		});
		const trail: string[] = [];
		try {
			await server.answer(
				server.call("initialize", {
					protocolVersion: "2025-11-25",
					capabilities: LIVE_HOST,
				}),
			);
			// One cd up, start to end: every step the owner takes is a form in
			// their host, its link inside it, asked in this call. Nothing is
			// relayed through the agent.
			const run = server.tool("cd", { args: ["up", "--hand-off"], cwd: REPO });
			const formParams = z.object({
				message: z.string(),
				requestedSchema: z.object({
					properties: z.record(z.string(), z.json()),
				}),
			});
			// 1. The sign-in form: Infisical's link, then the paste field.
			const signInForm = await server.expectEvent(
				run,
				(m) => m.method === "elicitation/create",
			);
			const signIn = formParams.parse(signInForm.params);
			trail.push(`form 1: ${JSON.stringify(signIn.message)}`);
			// The link is the form's own field: never only in its text.
			const signInUrl = z
				.object({ format: z.literal("uri"), default: z.string() })
				.parse(signIn.requestedSchema.properties.link).default;
			expect(signIn.message).not.toMatch(/https?:\/\//u);
			expect(signInUrl).toBeDefined();
			expect(Object.keys(signIn.requestedSchema.properties)).toEqual([
				"link",
				"value",
			]);
			// The owner signs in; Infisical gives them the session to copy.
			const jwt = api.signIn();
			const copied = Buffer.from(
				JSON.stringify({
					JTWToken: jwt,
					email: "owner@example.com",
					privateKey: "",
				}),
			).toString("base64");
			server.send({
				jsonrpc: "2.0",
				id: signInForm.id ?? null,
				result: { action: "accept", content: { value: copied } },
			});
			// 2. The run provisions through Infisical's API, opens the store and
			// starts Vercel's device grant: its link and code in the next form.
			const vercelForm = await server.expectEvent(
				run,
				(m) => m.method === "elicitation/create",
			);
			const approve = formParams.parse(vercelForm.params);
			trail.push(`form 2: ${JSON.stringify(approve.message)}`);
			expect(api.calls).toContain("POST /api/v1/identities");
			const vercelUrl = z
				.object({ format: z.literal("uri"), default: z.string() })
				.parse(approve.requestedSchema.properties.link).default;
			expect(new URL(vercelUrl).hostname).toBe("vercel.com");
			expect(vercelUrl).toBeDefined();
			// The owner submits before Vercel has registered the approval: the
			// run waits for the grant's own outcome, not the click.
			server.send({
				jsonrpc: "2.0",
				id: vercelForm.id ?? null,
				result: { action: "accept", content: { done: true } },
			});
			vercel.approve(vercelUrl ?? "");
			trail.push("vercel: approved");
			// 3. The same call converges as far as the ceremony goes.
			const fourth = JSON.stringify(await server.answer(run));
			trail.push(`cd: ${fourth.slice(0, 900)}`);
			expect(fourth).not.toContain(copied);
			expect(world.blocked).toEqual([]);
			expect(world.requests).not.toContainEqual(
				expect.stringMatching(/^neon\.new POST \/api\/v1\/database$/u),
			);
			expect(fourth).toContain("HOBO_OK");
			expect(fourth).toContain('"status\\":\\"deployed\\"');
			expect(
				world.requests.filter((request) =>
					/^api\.vercel\.com POST \/v13\/deployments\b/u.test(request),
				),
			).toHaveLength(0);
			expect(readStagedBuilds(vercelCli.staged)).toEqual([
				expect.objectContaining({ bundled: true }),
			]);
			expect(vercel.promoted).toEqual(["dpl_staged0"]);
			expect(world.requests).toContainEqual(
				expect.stringMatching(
					/^app\.infisical\.com POST \/api\/v1\/projects\/proj-1\/identities$/u,
				),
			);
			expect(
				world.requests.filter((request) =>
					/^api\.vercel\.com \w+ \/v\d+\/projects\/[^/]+\/env\b/u.test(request),
				),
			).toHaveLength(0);
			expect(fourth).not.toMatch(
				/HOBO_CD_(INFISICAL|ONEPASSWORD|BITWARDEN)_|AWAITING_APPROVAL|STORE_|HANDOFF_SILENT|_NEEDS_OWNER|JOURNAL_NOT_PROVISIONED/u,
			);
			const events = eventsFromWire(server.wire);
			const verdicts = [
				...ceremonyProperties({ secrets: [copied, jwt] }),
				REACHES_FRONTIER,
			].map((property) => check(property, events));
			for (const verdict of verdicts)
				trail.push(
					`spec ${verdict.holds ? "holds" : "FAILS"}: ${verdict.property}`,
				);
			expect(verdicts.filter((verdict) => !verdict.holds)).toEqual([]);
			// Not vacuous: the run's own sign-in form is the capture the link
			// property holds to.
			expect(
				events.some(
					(event) =>
						event.kind === "form" && event.capture === "INFISICAL_CLI_SESSION",
				),
			).toBe(true);
		} finally {
			process.stdout.write(
				`SMOKE steps=${trail.length} requests=${world.requests.length} blocked=${world.blocked.length}\n`,
			);
			server.stop();
			await world.close();
			await api.close();
			rmSync(config, { recursive: true, force: true });
		}
	}, 120_000);

	it("refuses a fresh journal without an atomic claim before contacting Neon", async () => {
		const config = mkdtempSync(path.join(tmpdir(), "hobo-smoke-config-"));
		const api = await startFakeInfisical("org-1");
		const vercel = fakeVercel();
		const neon = fakeNeon();
		const world = await startTlsWorld({
			"app.infisical.com": api.handle,
			"api.vercel.com": vercel.handle,
			"neon.new": neon.handle,
		});
		const locator = secretStoreLocatorPath(REPO, { XDG_CONFIG_HOME: config });
		mkdirSync(path.dirname(locator), { recursive: true });
		writeFileSync(
			locator,
			JSON.stringify({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "proj-1",
			}),
		);
		const server = startServer({
			...process.env,
			XDG_CONFIG_HOME: config,
			CLAUDE_CODE_REMOTE: "true",
			HTTPS_PROXY: world.proxyUrl,
			https_proxy: world.proxyUrl,
			HTTP_PROXY: world.proxyUrl,
			http_proxy: world.proxyUrl,
			NO_PROXY: "",
			no_proxy: "",
			NODE_EXTRA_CA_CERTS: world.caBundle,
		});
		try {
			await server.answer(
				server.call("initialize", {
					protocolVersion: "2025-11-25",
					capabilities: LIVE_HOST,
				}),
			);
			const run = server.tool("cd", { args: ["up", "--hand-off"], cwd: REPO });
			const signIn = await server.expectEvent(
				run,
				(m) => m.method === "elicitation/create",
			);
			const jwt = api.signIn();
			const copied = copiedSession(jwt);
			server.send({
				jsonrpc: "2.0",
				id: signIn.id ?? null,
				result: { action: "accept", content: { value: copied } },
			});
			const approval = await server.expectEvent(
				run,
				(m) => m.method === "elicitation/create",
			);
			const form = z
				.object({
					requestedSchema: z.object({
						properties: z.object({ link: z.object({ default: z.string() }) }),
					}),
				})
				.parse(approval.params);
			server.send({
				jsonrpc: "2.0",
				id: approval.id ?? null,
				result: { action: "accept", content: { done: true } },
			});
			vercel.approve(form.requestedSchema.properties.link.default);
			const response = JSON.stringify(await server.answer(run));
			expect(response).toContain("HOBO_CD_JOURNAL_CLAIM_UNAVAILABLE");
			expect(response).toContain("atomic-claim-store-required");
			const retryId = server.tool("cd", {
				args: ["up", "--hand-off"],
				cwd: REPO,
			});
			const retryEvent = await server.next(
				(m) =>
					m.method === "elicitation/create" ||
					(m.id === retryId && m.method === undefined),
			);
			expect(retryEvent.method).toBeUndefined();
			const retry = JSON.stringify(retryEvent);
			expect(retry).toContain("HOBO_CD_JOURNAL_CLAIM_UNAVAILABLE");
			for (const privateValue of [copied, jwt, "proj-1"])
				for (const result of [response, retry])
					expect(result).not.toContain(privateValue);
			expect(world.blocked).toEqual([]);
			expect(world.requests).not.toContainEqual(
				expect.stringMatching(/^neon\.new POST \/api\/v1\/database$/u),
			);
		} finally {
			server.stop();
			await world.close();
			await api.close();
			rmSync(config, { recursive: true, force: true });
		}
	}, 120_000);

	it("withdraws an unanswered form without returning its private link", async () => {
		const config = mkdtempSync(path.join(tmpdir(), "hobo-smoke-config-"));
		const api = await startFakeInfisical("org-1");
		const world = await startTlsWorld({ "app.infisical.com": api.handle });
		const locator = secretStoreLocatorPath(REPO, { XDG_CONFIG_HOME: config });
		mkdirSync(path.dirname(locator), { recursive: true });
		writeFileSync(
			locator,
			JSON.stringify({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "proj-1",
			}),
		);
		const server = startServer({
			...process.env,
			XDG_CONFIG_HOME: config,
			CLAUDE_CODE_REMOTE: "true",
			HOBO_OWNER_FORM_WAIT_MS: "1",
			HTTPS_PROXY: world.proxyUrl,
			https_proxy: world.proxyUrl,
			HTTP_PROXY: world.proxyUrl,
			http_proxy: world.proxyUrl,
			NO_PROXY: "",
			no_proxy: "",
			NODE_EXTRA_CA_CERTS: world.caBundle,
		});
		try {
			await server.answer(
				server.call("initialize", {
					protocolVersion: "2025-11-25",
					capabilities: LIVE_HOST,
				}),
			);
			const run = server.tool("cd", { args: ["up", "--hand-off"], cwd: REPO });
			const form = await server.expectEvent(
				run,
				(m) => m.method === "elicitation/create",
			);
			// Never answered: withdrawn, and the call ends.
			await server.expectEvent(
				run,
				(m) =>
					m.method === "notifications/cancelled" &&
					JSON.stringify(m.params).includes(String(form.id)),
			);
			const ended = JSON.stringify(await server.answer(run));
			expect(ended).toContain("HOBO_CD_INFISICAL_SIGN_IN");
			expect(ended).toContain("retry-setup-when-ready");
			expect(ended).not.toMatch(/https?:|HOBO_OWNER_SIGN_IN|proj-1/u);
			const events = eventsFromWire(server.wire);
			const verdicts = ceremonyProperties({}).map((property) =>
				check(property, events),
			);
			expect(verdicts.filter((verdict) => !verdict.holds)).toEqual([]);
		} finally {
			server.stop();
			await world.close();
			await api.close();
			rmSync(config, { recursive: true, force: true });
		}
	}, 120_000);

	it("reuses the selected owner session for the same project subdirectory", async () => {
		const config = mkdtempSync(path.join(tmpdir(), "hobo-smoke-config-"));
		const api = await startFakeInfisical("org-1");
		const world = await startTlsWorld({ "app.infisical.com": api.handle });
		const project = path.join(REPO, "packages/ci-vercel");
		const server = startServer({
			...process.env,
			XDG_CONFIG_HOME: config,
			HTTPS_PROXY: world.proxyUrl,
			https_proxy: world.proxyUrl,
			HTTP_PROXY: world.proxyUrl,
			http_proxy: world.proxyUrl,
			NO_PROXY: "",
			no_proxy: "",
			NODE_EXTRA_CA_CERTS: world.caBundle,
		});
		try {
			await server.answer(
				server.call("initialize", {
					protocolVersion: "2025-11-25",
					capabilities: LIVE_HOST,
				}),
			);
			const first = await server.answer(
				server.tool("cd", { args: ["up", "--hand-off"], cwd: project }),
			);
			expect(JSON.stringify(first)).toContain("HOBO_CD_STORE_CHOICE");
			const choice = server.tool("choose_secret_store", {
				family: "cd",
				cwd: project,
			});
			const picker = await server.expectEvent(
				choice,
				(m) => m.method === "elicitation/create",
			);
			server.send({
				jsonrpc: "2.0",
				id: picker.id ?? null,
				result: { action: "accept", content: { store: "infisical" } },
			});
			const settings = await server.expectEvent(
				choice,
				(m) => m.method === "elicitation/create",
			);
			server.send({
				jsonrpc: "2.0",
				id: settings.id ?? null,
				result: {
					action: "accept",
					content: { INFISICAL_PROJECT_ID: "synthetic-private-project" },
				},
			});
			const choiceSignIn = await server.expectEvent(
				choice,
				(m) => m.method === "elicitation/create",
			);
			server.send({
				jsonrpc: "2.0",
				id: choiceSignIn.id ?? null,
				result: { action: "decline" },
			});
			const selected = JSON.stringify(await server.answer(choice));
			expect(selected).toContain("sign-in-needed");
			expect(selected).not.toContain("synthetic-private-project");
			const retry = server.tool("cd", {
				args: ["up", "--hand-off"],
				cwd: project,
			});
			const signIn = await server.expectEvent(
				retry,
				(m) => m.method === "elicitation/create",
			);
			server.send({
				jsonrpc: "2.0",
				id: signIn.id ?? null,
				result: { action: "decline" },
			});
			const result = JSON.stringify(await server.answer(retry));
			expect(result).toContain("HOBO_CD_INFISICAL_SIGN_IN");
			expect(result).not.toContain("synthetic-private-project");
			expect(result).not.toMatch(/https?:/u);
		} finally {
			server.stop();
			await world.close();
			await api.close();
			rmSync(config, { recursive: true, force: true });
		}
	}, 120_000);

	it("does not expose a sign-in link when the host offers no owner form", async () => {
		const config = mkdtempSync(path.join(tmpdir(), "hobo-smoke-config-"));
		const api = await startFakeInfisical("org-1");
		const world = await startTlsWorld({ "app.infisical.com": api.handle });
		const locator = secretStoreLocatorPath(REPO, { XDG_CONFIG_HOME: config });
		mkdirSync(path.dirname(locator), { recursive: true });
		writeFileSync(
			locator,
			JSON.stringify({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "synthetic-private-project",
			}),
		);
		const server = startServer({
			...process.env,
			XDG_CONFIG_HOME: config,
			HTTPS_PROXY: world.proxyUrl,
			https_proxy: world.proxyUrl,
			HTTP_PROXY: world.proxyUrl,
			http_proxy: world.proxyUrl,
			NO_PROXY: "",
			no_proxy: "",
			NODE_EXTRA_CA_CERTS: world.caBundle,
		});
		try {
			await server.answer(
				server.call("initialize", {
					protocolVersion: "2025-11-25",
					capabilities: {},
				}),
			);
			const result = JSON.stringify(
				await server.answer(
					server.tool("cd", { args: ["up", "--hand-off"], cwd: REPO }),
				),
			);
			expect(result).toContain("HOBO_MCP_OWNER_FORM_UNAVAILABLE");
			expect(result).not.toContain("synthetic-private-project");
			expect(result).not.toMatch(/https?:/u);
			expect(
				server.wire
					.filter((line) => line.to === "host")
					.map((line) => line.message)
					.join("\n"),
			).not.toMatch(/elicitation\/create|synthetic-private-project|https?:/u);
		} finally {
			server.stop();
			await world.close();
			await api.close();
			rmSync(config, { recursive: true, force: true });
		}
	}, 120_000);
});
