import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { secretStoreLocatorPath } from "@hobo/hobo-ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { startFakeInfisical } from "./support/fake-infisical-api.js";

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
		// Infisical over https with a certificate only this run trusts, plus
		// the box's own CA bundle so real hosts behind its proxy still verify.
		const keyPath = path.join(config, "infisical.key");
		const certPath = path.join(config, "infisical.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
				"-keyout",
				keyPath,
				"-out",
				certPath,
			],
			{ stdio: "ignore" },
		);
		const bundle = path.join(config, "ca-bundle.pem");
		writeFileSync(
			bundle,
			[
				process.env.NODE_EXTRA_CA_CERTS === undefined
					? ""
					: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8"),
				readFileSync(certPath, "utf8"),
			].join("\n"),
		);
		const api = await startFakeInfisical("org-1", {
			key: readFileSync(keyPath, "utf8"),
			cert: readFileSync(certPath, "utf8"),
		});
		const locator = secretStoreLocatorPath(REPO, { XDG_CONFIG_HOME: config });
		mkdirSync(path.dirname(locator), { recursive: true });
		writeFileSync(
			locator,
			JSON.stringify({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "proj-1",
				INFISICAL_SITE_URL: api.origin,
			}),
		);
		const server = startServer({
			...process.env,
			XDG_CONFIG_HOME: config,
			CLAUDE_CODE_REMOTE: "true",
			NODE_EXTRA_CA_CERTS: bundle,
			NO_PROXY: `${process.env.NO_PROXY ?? ""},127.0.0.1,localhost`,
		});
		const trail: string[] = [];
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
				})
				.parse(vercelPrompt.params);
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
		} finally {
			process.stdout.write(
				`\nSMOKE TRAIL\n${trail.join("\n")}\nINFISICAL CALLS ${api.calls.join(", ")}\n`,
			);
			server.stop();
			await api.close();
		}
	}, 120_000);
});
