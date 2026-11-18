import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

import { startFakeInfisical } from "./support/fake-infisical-api.js";
import { fakeNeon, fakeVercel } from "./support/fake-providers.js";
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
	const launcher = z
		.object({
			mcpServers: z.object({
				hobo: z.object({ command: z.string(), args: z.array(z.string()) }),
			}),
		})
		.parse(JSON.parse(readFileSync(path.join(REPO, ".mcp.json"), "utf8")))
		.mcpServers.hobo;
	const child = spawn(launcher.command, launcher.args, {
		cwd: path.join(REPO, "packages/hobo"),
		env: {
			...env,
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
	let stderr = "";
	child.stderr.on("data", (c: Buffer) => {
		stderr += c.toString();
	});
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
			await new Promise<void>((resolve) => waiters.push(resolve));
		}
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
		send,
		call,
		answer,
		stderr: () => stderr,
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
	it("cd up in one call: every owner step a form carrying its link, nothing relayed", async () => {
		const config = mkdtempSync(path.join(tmpdir(), "hobo-smoke-config-"));
		// The providers at their real hostnames, behind an inspecting proxy
		// that trusts only its own CA: real-internet egress, or egress that
		// bypasses the proxy, fails instead of passing silently.
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
		const trail: string[] = [];
		// Each step as it happens: a stalled step is visible, not lost.
		const push = trail.push.bind(trail);
		trail.push = (...items: string[]) => {
			for (const item of items)
				process.stderr.write(`SMOKE ${item.slice(0, 600)}\n`);
			return push(...items);
		};
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
			const signInForm = await server.next(
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
			const vercelForm = await server.next(
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
			// Every provider call went through the box's proxy: a call that
			// bypassed it (Node's global fetch ignores HTTPS_PROXY) would reach
			// the internet directly, or fail on an enterprise network.
			expect(world.requests).toContainEqual(
				expect.stringMatching(/^neon\.new POST \/api\/v1\/database$/u),
			);
			// Nothing more is asked of the owner: no sign-in, approval, store or
			// hand-off refusal remains. What follows is the CD project's own
			// convergence (see the todo below).
			expect(fourth).not.toMatch(
				/HOBO_CD_(INFISICAL|ONEPASSWORD|BITWARDEN)_|AWAITING_APPROVAL|STORE_|HANDOFF_SILENT|_NEEDS_OWNER|JOURNAL_NOT_PROVISIONED/u,
			);
			const events = eventsFromWire(server.wire);
			const verdicts = ceremonyProperties({ secrets: [copied, jwt] }).map(
				(property) => check(property, events),
			);
			for (const verdict of verdicts)
				trail.push(
					`spec ${verdict.holds ? "holds" : "FAILS"}: ${verdict.property}`,
				);
			expect(verdicts.filter((verdict) => !verdict.holds)).toEqual([]);
			expect(fourth).toContain("HOBO_UP_INCOMPLETE");
			expect(check(REACHES_FRONTIER, events).holds).toBe(false);
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
				`\nSMOKE TRAIL\n${trail.join("\n")}\nREQUESTS ${world.requests.join(" | ")}\nBLOCKED ${world.blocked.join(", ")}\nSTDERR ${server.stderr().slice(-1500)}\n`,
			);
			server.stop();
			await world.close();
			await api.close();
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
			const form = await server.next((m) => m.method === "elicitation/create");
			// Never answered: withdrawn, and the call ends.
			await server.next(
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
			const picker = await server.next(
				(m) => m.method === "elicitation/create",
			);
			server.send({
				jsonrpc: "2.0",
				id: picker.id ?? null,
				result: { action: "accept", content: { store: "infisical" } },
			});
			const settings = await server.next(
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
			const selected = await server.answer(choice);
			expect(JSON.stringify(selected)).not.toContain(
				"synthetic-private-project",
			);
			const retry = server.tool("cd", {
				args: ["up", "--hand-off"],
				cwd: project,
			});
			const signIn = await server.next(
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
		}
	}, 120_000);

	// The CD project's own declaration (packages/hobo-cd/src/bindle.ts) says
	// its resources must be wired before it can deploy: the API has no handler
	// binding, the schedule no cadence, and cd-config / cd-journal no
	// providers in the composed runtime. The plan is rejected there today.
	it.todo(
		"cd up converges the CD project after the ceremony (the hobo-cd Bindle is not deployable yet)",
	);
});
