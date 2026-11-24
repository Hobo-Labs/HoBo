import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
	AgentVaultProxyStartError,
	agentVaultProxyAgentOptions,
	agentVaultProxyFetch,
	agentVaultProxyLauncher,
} from "../src/index.js";

const PROXY_TOKEN = "fixture-proxy-token";
const SESSION_TOKEN = "agv_fixture-session-token";
const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";

const FAKE_PROXY = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const seen = {
	args,
	dataDirEmpty: fs.readdirSync(flag("--data-dir")).length === 0,
	variables: Object.entries(process.env).filter(([name]) => name.startsWith("INFISICAL_")),
};
let tunnel = { target: null, proxyAuthorization: null };
const server = http.createServer((request, response) => {
	response.setHeader("content-type", "application/json");
	if (request.url === "/_agent-vault/ca") return response.end(JSON.stringify({ certificate: "pem" }));
	if (request.url === "/seen") return response.end(JSON.stringify(seen));
	response.setHeader("x-agent-vault-decision", "brokered");
	response.end(JSON.stringify({ ...tunnel, host: request.headers.host, path: request.url }));
});
server.on("connect", (request, socket) => {
	tunnel = { target: request.url, proxyAuthorization: request.headers["proxy-authorization"] ?? null };
	const upstream = net.connect(Number(flag("--port")), flag("--listen-host"), () => {
		socket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
		upstream.pipe(socket);
		socket.pipe(upstream);
	});
});
server.listen(Number(flag("--port")), flag("--listen-host"));
`;

const Seen = z.object({
	args: z.array(z.string()),
	dataDirEmpty: z.boolean(),
	variables: z.array(z.tuple([z.string(), z.string()])),
});
const Forwarded = z.object({
	target: z.string(),
	proxyAuthorization: z.string().nullable(),
	host: z.string(),
	path: z.string(),
});

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

async function fakeCli(script: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-fake-infisical-"));
	dirs.push(dir);
	const command = path.join(dir, "infisical");
	await writeFile(command, script);
	await chmod(command, 0o755);
	return command;
}

describe("the Agent Vault proxy HoBo runs", () => {
	it("starts the CLI on loopback with the token in its environment only, and removes everything on stop", async () => {
		const launch = agentVaultProxyLauncher({
			env: { PATH: process.env.PATH, HOBO_UNRELATED: "kept" },
			pollMs: 20,
		});
		const proxy = await launch({
			command: await fakeCli(FAKE_PROXY),
			siteUrl: "https://eu.infisical.com",
			proxyToken: PROXY_TOKEN,
		});
		const seen = Seen.parse(
			await (await fetch(`http://127.0.0.1:${proxy.port}/seen`)).json(),
		);
		expect(seen.args).toEqual([
			"agent-vault",
			"proxy",
			"--listen-host",
			"127.0.0.1",
			"--port",
			String(proxy.port),
			"--data-dir",
			expect.stringContaining("hobo-agent-vault-"),
			"--domain",
			"https://eu.infisical.com/api",
			"--silent",
			"--telemetry=false",
		]);
		expect(seen.args.join(" ")).not.toContain(PROXY_TOKEN);
		expect(seen.dataDirEmpty).toBe(true);
		expect(seen.variables).toEqual(
			expect.arrayContaining([
				["INFISICAL_AGENT_VAULT_PROXY_TOKEN", PROXY_TOKEN],
				["INFISICAL_DISABLE_TELEMETRY", "1"],
			]),
		);
		const dataDir = seen.args[seen.args.indexOf("--data-dir") + 1] ?? "";
		expect(existsSync(dataDir)).toBe(true);
		await proxy.stop();
		expect(existsSync(dataDir)).toBe(false);
		await expect(
			fetch(`http://127.0.0.1:${proxy.port}/seen`),
		).rejects.toThrow();
	});

	it("refuses a proxy that exits while starting, and leaves no data directory", async () => {
		const launch = agentVaultProxyLauncher({ env: {}, pollMs: 20 });
		const before = new Set(
			readdirSync(tmpdir()).filter((name) =>
				name.startsWith("hobo-agent-vault-"),
			),
		);
		const error = await launch({
			command: await fakeCli("#!/bin/sh\nexit 3\n"),
			siteUrl: "https://app.infisical.com",
			proxyToken: PROXY_TOKEN,
		}).catch((caught) => caught);
		expect(error).toBeInstanceOf(AgentVaultProxyStartError);
		expect(error.reason).toBe("exited");
		expect(String(error.message)).not.toContain(PROXY_TOKEN);
		const after = readdirSync(tmpdir()).filter((name) =>
			name.startsWith("hobo-agent-vault-"),
		);
		expect(after.filter((name) => !before.has(name))).toEqual([]);
	});

	it("routes requests through the proxy with the session token as proxy credentials and trusts only its CA", async () => {
		expect(
			agentVaultProxyAgentOptions({
				port: 17323,
				sessionToken: SESSION_TOKEN,
				certificateAuthority: CA,
			}),
		).toEqual({
			uri: "http://127.0.0.1:17323",
			token: `Basic ${Buffer.from(`x-agent-vault:${SESSION_TOKEN}`).toString("base64")}`,
			requestTls: { ca: [CA] },
		});
		const proxy = await agentVaultProxyLauncher({
			env: { PATH: process.env.PATH },
			pollMs: 20,
		})({
			command: await fakeCli(FAKE_PROXY),
			siteUrl: "https://app.infisical.com",
			proxyToken: PROXY_TOKEN,
		});
		const routed = agentVaultProxyFetch({
			port: proxy.port,
			sessionToken: SESSION_TOKEN,
			certificateAuthority: CA,
		});
		try {
			const response = await routed.fetch(
				"http://developers.hostinger.test/api/vps/v1/virtual-machines",
			);
			expect(response.headers.get("x-agent-vault-decision")).toBe("brokered");
			expect(Forwarded.parse(await response.json())).toEqual({
				target: "developers.hostinger.test:80",
				host: "developers.hostinger.test",
				path: "/api/vps/v1/virtual-machines",
				proxyAuthorization: `Basic ${Buffer.from(`x-agent-vault:${SESSION_TOKEN}`).toString("base64")}`,
			});
		} finally {
			await routed.close();
			await proxy.stop();
		}
	});
});
