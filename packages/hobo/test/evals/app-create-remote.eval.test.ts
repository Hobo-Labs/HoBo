import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
	type InfisicalClient,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import { createGithubAppManifest } from "@hobo/ci-gh-actions";
import {
	openTunnel,
	type RedirectReceiver,
	redirectReceiverFrom,
	safePublicOrigin,
	tunnelCommand,
} from "@hobo/hobo-ci";
import { createMemorySecretsPort, type SecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	APP_CREDENTIAL_KEYS,
	APP_HANDOFF_PAGE,
	OWNER_APP_LINE_PREFIX,
	OWNER_APP_REGISTER_LINE_PREFIX,
	runCiAppCreate,
} from "../../src/ci-app-create.js";

// EVAL: an agent runs `hobo ci app create` on a remote box the owner's browser
// cannot reach. Every path must end with the App's credentials in the owner's
// own store and the App checked with GitHub, and none may expose more than
// one single-use, unguessable callback, or route the code through a service:
//
//   receiver  the owner's outbound-only tunnel carries GitHub's redirect;
//   paste     the owner carries GitHub's single-use `code~state` back;
//   store     the owner registers the App and stores it; the run checks it.

const RELAY = "https://hobo-ci.example.com";
const OWNER = 145080887;
const PUBLIC = "https://owner-tunnel.trycloudflare.com";
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ type: "pkcs8", format: "pem" })
	.toString();
const reviewed = createGithubAppManifest({
	name: "HoBo CI",
	relayUrl: RELAY,
	manifestCallbackUrl: `${RELAY}/v1/app-bootstrap/callback`,
	installationCallbackUrl: `${RELAY}/v1/app-registration/install-callback`,
});
const app = {
	id: 4242,
	slug: "hobo-ci-test",
	owner: { id: OWNER, type: "User" },
	external_url: `${RELAY}/`,
	permissions: { ...reviewed.defaultPermissions },
	events: [...reviewed.defaultEvents],
};

/** GitHub: the one-time conversion and what verification reads. */
function github() {
	const conversions: string[] = [];
	const http: typeof fetch = async (input) => {
		const url = String(input);
		const conversion =
			/^https:\/\/api\.github\.com\/app-manifests\/([^/]+)\/conversions$/u.exec(
				url,
			);
		if (conversion) {
			conversions.push(conversion[1] ?? "");
			return Response.json(
				{
					...app,
					pem,
					webhook_secret: "whsec-from-github",
					client_id: "Iv23liTestClient",
					client_secret: "client-secret-from-github",
				},
				{ status: 201 },
			);
		}
		if (url === "https://api.github.com/app") return Response.json(app);
		if (url === "https://api.github.com/app/hook/config")
			return Response.json({
				url: `${RELAY}/github/webhooks`,
				content_type: "json",
				insecure_ssl: "0",
			});
		return new Response(null, { status: 404 });
	};
	return { http, conversions };
}

/** The owner's own store, as the run reaches it. */
function ownerStore() {
	const memory = createMemorySecretsPort();
	const port: SecretsPort = { ...memory, kind: "infisical" };
	const client: InfisicalClient = {
		binding: parseInfisicalBinding({
			projectId: "proj-1",
			environment: "prod",
			secretPath: "/hobo-ci-relay",
		}),
		async listSecretNames() {
			return memory.names().map((secretKey) => ({ secretKey, version: 1 }));
		},
		listSecrets: () => Promise.reject(new Error("unused")),
		getSecret: () => Promise.reject(new Error("unused")),
		putSecret: () => Promise.reject(new Error("unused")),
		signOut() {},
		signIn: () => Promise.reject(new Error("unused")),
		revoke: () => Promise.reject(new Error("unused")),
		forBinding() {
			throw new Error("unused");
		},
	};
	return {
		service: { client, port },
		memory,
		async value(name: string) {
			const read = await memory.access(name);
			return read.status === "ok" ? read.material : undefined;
		},
	};
}

/**
 * The owner's outbound-only tunnel: its edge answers on PUBLIC and carries
 * each request over the run's outgoing connection to the local listener.
 */
function tunnel() {
	let localPort = 0;
	let closed = false;
	const receiver: RedirectReceiver = {
		id: "cloudflared",
		async open(port) {
			localPort = port;
			return {
				publicOrigin: PUBLIC,
				close: async () => {
					closed = true;
				},
			};
		},
	};
	/** A request at the edge, as the browser makes it. */
	const edge = async (publicUrl: string) => {
		if (closed) throw new Error("the tunnel is closed");
		const url = new URL(publicUrl);
		expect(url.origin).toBe(PUBLIC);
		return fetch(`http://127.0.0.1:${localPort}${url.pathname}${url.search}`);
	};
	return { receiver, edge, closed: () => closed };
}

const lineOf = (lines: readonly string[], prefix: string) =>
	lines.find((line) => line.startsWith(`${prefix} `)) ?? "";

describe("EVAL remote box: hobo ci app create through the owner's tunnel", () => {
	it("creates the App: GitHub's redirect comes through the tunnel to the same run", async () => {
		const store = ownerStore();
		const gh = github();
		const net = tunnel();
		const lines: string[] = [];
		let probes: number[] = [];
		const run = runCiAppCreate({
			relay: RELAY,
			ownerId: String(OWNER),
			replace: false,
			interactive: false,
			handOff: true,
			receiver: net.receiver,
			tunnelProbe: (url) => net.edge(String(url)),
			env: {},
			configService: store.service,
			fetch: gh.http,
			sleep: async () => {},
			openBrowser: () => {
				throw new Error("a handed-off run opens no browser in the box");
			},
			emitProgress: (line) => {
				lines.push(line);
				if (!line.startsWith(`${OWNER_APP_LINE_PREFIX} `)) return;
				// The owner, outside: opens the public link, posts to GitHub, and
				// GitHub sends their browser back through the tunnel.
				void (async () => {
					const page = line.split(" ")[1] ?? "";
					expect(new URL(page).protocol).toBe("https:");
					probes = [
						(await net.edge(`${PUBLIC}/`)).status,
						(await net.edge(`${PUBLIC}/callback?code=x&state=y`)).status,
					];
					const html = await (await net.edge(page)).text();
					const state = /[?&]state=([A-Za-z0-9_-]+)"/u.exec(html)?.[1] ?? "";
					const manifest = JSON.parse(
						(/name="manifest" value="([^"]*)"/u.exec(html)?.[1] ?? "")
							.replaceAll("&quot;", '"')
							.replaceAll("&amp;", "&"),
					);
					const back = new URL(manifest.redirect_url);
					expect(back.origin).toBe(PUBLIC);
					back.searchParams.set("code", "one-time-code");
					back.searchParams.set("state", state);
					await net.edge(back.href);
				})();
			},
		});
		const result = await run;
		expect(result.ok).not.toBe(false);
		expect(gh.conversions).toEqual(["one-time-code"]);
		for (const key of APP_CREDENTIAL_KEYS)
			expect(await store.value(key)).toBeTruthy();
		// Only the unguessable path answers; the tunnel ends with the run.
		expect(probes).toEqual([404, 404]);
		expect(net.closed()).toBe(true);
		expect(lines.join("\n")).not.toMatch(/127\.0\.0\.1|localhost|PRIVATE KEY/u);
	});

	it("takes one callback: a replay through the tunnel reaches nothing", async () => {
		const store = ownerStore();
		const net = tunnel();
		let replay = 0;
		let owner: Promise<void> = Promise.resolve();
		await runCiAppCreate({
			relay: RELAY,
			ownerId: String(OWNER),
			replace: false,
			interactive: false,
			handOff: true,
			receiver: net.receiver,
			tunnelProbe: (url) => net.edge(String(url)),
			env: {},
			configService: store.service,
			fetch: github().http,
			sleep: async () => {},
			emitProgress: (line) => {
				if (!line.startsWith(`${OWNER_APP_LINE_PREFIX} `)) return;
				owner = (async () => {
					const page = line.split(" ")[1] ?? "";
					const html = await (await net.edge(page)).text();
					const state = /[?&]state=([A-Za-z0-9_-]+)"/u.exec(html)?.[1] ?? "";
					const back = new URL(`${page}callback`);
					back.searchParams.set("code", "one-time-code");
					back.searchParams.set("state", state);
					await net.edge(back.href);
					replay = await net
						.edge(back.href)
						.then((r) => r.status)
						.catch(() => -1);
				})();
			},
		});
		await owner;
		// Refused (404) or already gone with the tunnel (-1): never accepted twice.
		expect([404, -1]).toContain(replay);
	});

	it("falls back to the owner's hand-off when the tunnel prints an address but its edge cannot reach the run", async () => {
		// What the live test found in a sandbox without direct egress: the URL
		// is issued, every request through it answers 530.
		const store = ownerStore();
		const gh = github();
		const lines: string[] = [];
		let pasted: (text: string) => void = () => {};
		let closed = false;
		const result = await runCiAppCreate({
			relay: RELAY,
			ownerId: String(OWNER),
			replace: false,
			interactive: false,
			handOff: true,
			receiver: {
				id: "cloudflared",
				open: async () => ({
					publicOrigin: PUBLIC,
					close: async () => {
						closed = true;
					},
				}),
			},
			tunnelProbe: async () => new Response(null, { status: 530 }),
			tunnelProbeTimeoutMs: 1,
			env: {},
			configService: store.service,
			fetch: gh.http,
			sleep: async () => {},
			readCode: () =>
				new Promise<string>((resolve) => {
					pasted = resolve;
				}),
			emitProgress: (line) => {
				lines.push(line);
				if (!line.startsWith(`${OWNER_APP_LINE_PREFIX} `)) return;
				const link = new URL(line.split(" ")[1] ?? "");
				const action = new URLSearchParams(link.hash.slice(1)).get("action");
				const state = new URL(action ?? "").searchParams.get("state") ?? "";
				queueMicrotask(() => pasted(`one-time-code~${state}`));
			},
		});
		expect(closed).toBe(true);
		expect(
			lines.some((l) => l.startsWith("HOBO_REDIRECT_RECEIVER_FAILED")),
		).toBe(true);
		// The owner never got the dead tunnel's link: only the hand-off page.
		expect(lines.join("\n")).not.toContain(PUBLIC);
		expect(result.ok).not.toBe(false);
		expect(gh.conversions).toEqual(["one-time-code"]);
	});

	it("behind a required proxy, never starts a receiver that cannot use it and goes straight to the hand-off", async () => {
		const store = ownerStore();
		const gh = github();
		const lines: string[] = [];
		let started = false;
		let pasted: (text: string) => void = () => {};
		const result = await runCiAppCreate({
			relay: RELAY,
			ownerId: String(OWNER),
			replace: false,
			interactive: false,
			handOff: true,
			// This sandbox's own settings: an HTTPS proxy is required.
			receiver: redirectReceiverFrom(
				{
					HTTPS_PROXY: "http://127.0.0.1:46397",
					NO_PROXY: "localhost,127.0.0.1",
					HOBO_REDIRECT_RECEIVER: "cloudflared",
				},
				{
					spawn: () => {
						started = true;
						throw new Error("cloudflared must not start behind a proxy");
					},
				},
			),
			env: {},
			configService: store.service,
			fetch: gh.http,
			sleep: async () => {},
			readCode: () =>
				new Promise<string>((resolve) => {
					pasted = resolve;
				}),
			emitProgress: (line) => {
				lines.push(line);
				if (!line.startsWith(`${OWNER_APP_LINE_PREFIX} `)) return;
				const link = new URL(line.split(" ")[1] ?? "");
				const action = new URLSearchParams(link.hash.slice(1)).get("action");
				const state = new URL(action ?? "").searchParams.get("state") ?? "";
				queueMicrotask(() => pasted(`one-time-code~${state}`));
			},
		});
		expect(started).toBe(false);
		expect(lines[0]).toMatch(/^HOBO_REDIRECT_RECEIVER_EGRESS: /u);
		expect(lines[1]).toMatch(
			new RegExp(`^${OWNER_APP_LINE_PREFIX} https://`, "u"),
		);
		expect(result.ok).not.toBe(false);
		expect(gh.conversions).toEqual(["one-time-code"]);
	});

	it("without --hand-off, a missing tunnel CLI fails and names the hand-off", async () => {
		const result = await runCiAppCreate({
			relay: RELAY,
			ownerId: String(OWNER),
			replace: false,
			interactive: false,
			handOff: false,
			receiver: {
				id: "ngrok",
				open: (port) =>
					openTunnel(tunnelCommand("ngrok", port, {}), {
						spawn: () => {
							throw new Error("ENOENT");
						},
					}),
			},
			env: {},
			configService: ownerStore().service,
			fetch: github().http,
			emitProgress: () => {},
		});
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_REDIRECT_RECEIVER_MISSING",
		});
		expect(result.message).toMatch(/HOBO_APP_HANDOFF=paste/u);
	});
});

describe("EVAL remote box: hobo ci app create with no receiver (owner hand-off)", () => {
	it("paste: the owner carries GitHub's single-use code back, and nothing connects to the box", async () => {
		const store = ownerStore();
		const gh = github();
		const lines: string[] = [];
		let pasted: (text: string) => void = () => {};
		const result = await runCiAppCreate({
			relay: RELAY,
			ownerId: String(OWNER),
			replace: false,
			interactive: false,
			handOff: true,
			env: {},
			configService: store.service,
			fetch: gh.http,
			sleep: async () => {},
			readCode: () =>
				new Promise<string>((resolve) => {
					pasted = resolve;
				}),
			emitProgress: (line) => {
				lines.push(line);
				if (!line.startsWith(`${OWNER_APP_LINE_PREFIX} `)) return;
				// The owner opens the static page; the manifest is in the
				// fragment, which no server receives.
				const link = new URL(line.split(" ")[1] ?? "");
				expect(`${link.origin}${link.pathname}`).toBe(APP_HANDOFF_PAGE);
				const fragment = new URLSearchParams(link.hash.slice(1));
				const manifest = JSON.parse(fragment.get("manifest") ?? "{}");
				expect(manifest.redirect_url).toBe(APP_HANDOFF_PAGE);
				const state =
					new URL(fragment.get("action") ?? "").searchParams.get("state") ?? "";
				// GitHub shows `code~state` on that page; the owner gives it back.
				queueMicrotask(() => pasted(`one-time-code~${state}\n`));
			},
		});
		expect(result.ok).not.toBe(false);
		expect(gh.conversions).toEqual(["one-time-code"]);
		expect(await store.value("HOBO_CI_GITHUB_APP_ID")).toBe("4242");
		expect(lines.join("\n")).not.toMatch(/127\.0\.0\.1|localhost/u);
	});

	it("paste: refuses a code GitHub did not issue for this run", async () => {
		const gh = github();
		const result = await runCiAppCreate({
			relay: RELAY,
			ownerId: String(OWNER),
			replace: false,
			interactive: false,
			handOff: true,
			env: {},
			configService: ownerStore().service,
			fetch: gh.http,
			readCode: async () => "someone-elses-code~not-this-runs-state",
			emitProgress: () => {},
		});
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_APP_CODE_INVALID",
		});
		expect(gh.conversions).toEqual([]);
	});

	it("store: the owner registers and stores the App themselves; the run finds and checks it", async () => {
		const store = ownerStore();
		const lines: string[] = [];
		let registered = false;
		const result = await runCiAppCreate({
			relay: RELAY,
			ownerId: String(OWNER),
			replace: false,
			interactive: false,
			handOff: true,
			env: { HOBO_APP_HANDOFF: "store" },
			configService: store.service,
			fetch: github().http,
			emitProgress: (line) => lines.push(line),
			// Between polls, the owner finishes on github.com and in Infisical.
			sleep: async () => {
				if (registered) return;
				registered = true;
				const form = new URL(
					lineOf(lines, OWNER_APP_REGISTER_LINE_PREFIX).split(" ")[1] ?? "",
				);
				expect(form.origin).toBe("https://github.com");
				expect(form.searchParams.get("webhook_url")).toBe(
					`${RELAY}/github/webhooks`,
				);
				expect(form.searchParams.getAll("events[]").sort()).toEqual(
					[...reviewed.defaultEvents].sort(),
				);
				for (const [name, value] of Object.entries({
					HOBO_CI_GITHUB_APP_ID: "4242",
					HOBO_CI_GITHUB_APP_PRIVATE_KEY: pem,
					HOBO_CI_WEBHOOK_SECRET: "whsec-owner",
					HOBO_CI_GITHUB_APP_CLIENT_ID: "Iv23liTestClient",
					HOBO_CI_GITHUB_APP_CLIENT_SECRET: "client-secret-owner",
				}))
					await store.memory.put(name, value);
			},
		});
		expect(result.ok).not.toBe(false);
		expect(result.data).toMatchObject({ appId: 4242, handoff: "store" });
		expect(lines.join("\n")).not.toMatch(/127\.0\.0\.1|localhost|PRIVATE KEY/u);
	});
});

/** A tunnel CLI that prints what the real one prints. */
function fakeCli(output: string) {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		killed: false,
		kill() {
			this.killed = true;
			return true;
		},
	});
	setTimeout(() => child.stderr.write(output), 5);
	return child;
}

describe("EVAL receivers: each provider's CLI output gives a safe public origin", () => {
	const cases = [
		[
			"cloudflared",
			"2026-11-16T04:00:00Z INF |  https://quiet-lake-1234.trycloudflare.com  |\n",
			"https://quiet-lake-1234.trycloudflare.com",
		],
		[
			"ngrok",
			't=2026-11-16T04:00:00 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://127.0.0.1:9 url=https://ab12-34-56.ngrok-free.app\n',
			"https://ab12-34-56.ngrok-free.app",
		],
		[
			"localtunnel",
			"your url is: https://tidy-owl-42.loca.lt\n",
			"https://tidy-owl-42.loca.lt",
		],
		[
			"devtunnel",
			"Connect via browser: https://k3x9-9.usw2.devtunnels.ms\n",
			"https://k3x9-9.usw2.devtunnels.ms",
		],
	] as const;
	for (const [id, output, origin] of cases)
		it(`${id}: reads the public origin it prints and stops the tunnel on close`, async () => {
			const child = fakeCli(output);
			const open = await openTunnel(tunnelCommand(id, 9, {}), {
				// SAFETY: the fake implements the stdout/stderr/kill/once the reader uses.
				spawn: () => child as never,
			});
			expect(open.publicOrigin).toBe(origin);
			await open.close();
			expect(child.killed).toBe(true);
		});

	it("pangolin: uses the configured origin its resource routes, and requires one", () => {
		expect(
			tunnelCommand("pangolin", 9, {
				HOBO_REDIRECT_PUBLIC_ORIGIN: "https://hobo.owner.example",
			}).fixedOrigin,
		).toBe("https://hobo.owner.example");
		expect(() => tunnelCommand("pangolin", 9, {})).toThrow(
			/HOBO_REDIRECT_PUBLIC_ORIGIN/u,
		);
	});

	it("refuses an address that is not a public https origin", () => {
		for (const unsafe of [
			"http://abc.trycloudflare.com",
			"https://127.0.0.1:8080",
			"https://192.168.1.4",
			"https://user:pw@abc.example.com",
			"https://abc.example.com/path",
		])
			expect(() => safePublicOrigin(unsafe)).toThrow();
	});
});
