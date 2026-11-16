import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { secretStoreLocatorPath } from "@hobo/hobo-ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { startFakeInfisical } from "./support/fake-infisical-api.js";
import { fakeNeon, fakeVercel } from "./support/fake-providers.js";
import { startTlsWorld } from "./support/tls-world.js";

// SMOKE: the real `hobo-mcp` binary, as the owner's host runs it on a remote
// box, driven exactly as that host does: its declared capabilities (taken
// from the live host's initialize), `cd up --hand-off`, `capture_secret`,
// the owner's answers to each prompt, and `cd up` again. Nothing in this
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
	const child = spawn(
		process.execPath,
		["--import", "tsx", "packages/hobo/src/bin/hobo-mcp.ts"],
		{ cwd: REPO, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	const inbox: Message[] = [];
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
			if (line.trim() !== "") inbox.push(message.parse(JSON.parse(line)));
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
	const send = (m: Message) => child.stdin.write(`${JSON.stringify(m)}\n`);
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
		tool: (name: string, args: Message) =>
			call("tools/call", { name, arguments: args }),
		stop: () => {
			child.stdin.end();
			child.kill();
		},
	};
}

describe("SMOKE remote ceremony through the real hobo-mcp binary", () => {
	it("cd up: sign-in link prompt, then the paste form, then provisioning", async () => {
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
			// 1. cd up: refuses with the sign-in line.
			const first = JSON.stringify(
				await server.answer(
					server.tool("cd", { args: ["up", "--hand-off"], cwd: REPO }),
				),
			);
			const signIn = /HOBO_OWNER_SIGN_IN url=(\S+?) capture=(\w+)/u.exec(first);
			trail.push(
				`cd: ${signIn === null ? first.slice(0, 300) : "sign-in link"}`,
			);
			expect(signIn).not.toBeNull();
			// 2. capture: the host is asked to show the link FIRST.
			const capture = server.tool("capture_secret", {
				name: signIn?.[2] ?? "",
			});
			const linkPrompt = await server.next(
				(m) => m.method === "elicitation/create",
			);
			const link = z
				.object({
					mode: z.literal("url"),
					url: z.string(),
					message: z.string(),
				})
				.parse(linkPrompt.params);
			trail.push(`prompt 1: link ${link.url}`);
			expect(link.url).toBe(signIn?.[1]);
			server.send({
				jsonrpc: "2.0",
				id: linkPrompt.id ?? null,
				result: { action: "accept" },
			});
			// The owner signs in; Infisical gives them the session to copy.
			const jwt = api.signIn();
			const copied = Buffer.from(
				JSON.stringify({
					JTWToken: jwt,
					email: "owner@example.com",
					privateKey: "",
				}),
			).toString("base64");
			// 3. then the one-field paste form.
			const form = await server.next((m) => m.method === "elicitation/create");
			const formParams = z
				.object({
					message: z.string(),
					requestedSchema: z.object({
						properties: z.record(z.string(), z.json()),
					}),
				})
				.parse(form.params);
			trail.push(`prompt 2: form "${formParams.message}"`);
			expect(Object.keys(formParams.requestedSchema.properties)).toEqual([
				"value",
			]);
			server.send({
				jsonrpc: "2.0",
				id: form.id ?? null,
				result: { action: "accept", content: { value: copied } },
			});
			const stored = JSON.stringify(await server.answer(capture));
			trail.push(
				`capture: ${stored.includes('"status":"stored"') ? "stored" : stored.slice(0, 300)}`,
			);
			expect(stored).toContain('"linkShownBy":"host"');
			expect(stored).not.toContain(copied);
			// 4. cd up again: provisions through Infisical's API, opens the store,
			// and starts Vercel's device grant off the request path: it returns
			// at once, and the host shows Vercel's own link.
			const second = JSON.stringify(
				await server.answer(
					server.tool("cd", { args: ["up", "--hand-off"], cwd: REPO }),
				),
			);
			trail.push(
				`cd again: ${/"code\\":\\"(\w+)/u.exec(second)?.[1] ?? second.slice(0, 400)}`,
			);
			expect(api.calls).toContain("POST /api/v1/identities");
			expect(second).toContain("HOBO_CD_VERCEL_AWAITING_APPROVAL");
			expect(second).not.toMatch(/HANDOFF_SILENT|--json/u);
			const vercelPrompt = await server.next(
				(m) => m.method === "elicitation/create",
			);
			const vercelLink = z
				.object({
					mode: z.literal("url"),
					url: z.string(),
					message: z.string(),
					elicitationId: z.string().min(1),
				})
				.parse(vercelPrompt.params);
			// The owner opens it (the host's link prompt).
			server.send({
				jsonrpc: "2.0",
				id: vercelPrompt.id ?? null,
				result: { action: "accept" },
			});
			trail.push(`prompt 3: link ${vercelLink.url}`);
			expect(new URL(vercelLink.url).hostname).toMatch(/(^|\.)vercel\.com$/u);
			expect(second).toContain(vercelLink.url);
			// 5. cd up while the owner has not approved yet: the same link, no new grant.
			const third = JSON.stringify(
				await server.answer(
					server.tool("cd", { args: ["up", "--hand-off"], cwd: REPO }),
				),
			);
			trail.push(
				`cd pending: ${/"code\\":\\"(\w+)/u.exec(third)?.[1] ?? third.slice(0, 400)}`,
			);
			expect(third).toContain(vercelLink.url);
			// 6. The owner approves on Vercel. The server completes the link prompt
			// when the grant behind it ends: the event, no polling.
			vercel.approve(vercelLink.url);
			await server.next(
				(m) =>
					m.method === "notifications/elicitation/complete" &&
					JSON.stringify(m.params).includes(vercelLink.elicitationId),
			);
			trail.push("vercel: approved, prompt completed");
			// 7. cd up: the connection is in the store; the run converges.
			const fourth = JSON.stringify(
				await server.answer(
					server.tool("cd", { args: ["up", "--hand-off"], cwd: REPO }),
				),
			);
			trail.push(`cd after approval: ${fourth.slice(0, 900)}`);
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
		} finally {
			process.stdout.write(
				`\nSMOKE TRAIL\n${trail.join("\n")}\nREQUESTS ${world.requests.join(" | ")}\nBLOCKED ${world.blocked.join(", ")}\nSTDERR ${server.stderr().slice(-1500)}\n`,
			);
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
