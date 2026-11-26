import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Sandbox } from "@vercel/sandbox";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
	launchSandboxProxyVm,
	parseProxyVmConfig,
} from "../src/sandbox-proxy-vm.js";

it("uses the Vercel SDK to upload a protected config and never puts its credential in the detached command", async () => {
	const pact = z
		.object({
			interactions: z.array(
				z.object({
					request: z.object({ method: z.string(), path: z.string() }),
					response: z.object({ status: z.number() }),
				}),
			),
		})
		.parse(
			JSON.parse(
				readFileSync(
					new URL("./sandbox-proxy-vm.pact.json", import.meta.url),
					"utf8",
				),
			),
		);
	expect(pact.interactions).toHaveLength(4);
	const secret = Buffer.alloc(32, 7).toString("base64url");
	const config = parseProxyVmConfig({
		proxyOrigin: "https://proxy.example.test",
		relayOrigin: "https://relay.example.test",
		expectedIssuer: "https://oidc.vercel.com/team-example",
		leaseId: "00000000-0000-4000-8000-000000000001",
		proxySessionId: "sbx_proxy",
		quotaToken: secret,
		teamId: "team_example",
		projectId: "prj_example",
		hosts: ["github.com"],
		maxEgressBytes: 1000000,
		maxControlCalls: 20,
		port: 8787,
		maxRequestBytes: 10485760,
		maxResponseBytes: 10485760,
	});
	const session = {
		id: "sbx_proxy",
		memory: 2048,
		vcpus: 1,
		region: "iad1",
		timeout: 300000,
		status: "running",
		requestedAt: 1,
		startedAt: 1,
		createdAt: 1,
		updatedAt: 1,
		cwd: "/vercel/sandbox",
	};
	const sandbox = {
		name: "hobo-proxy-fixture",
		persistent: false,
		createdAt: 1,
		updatedAt: 1,
		currentSessionId: "sbx_proxy",
		status: "running",
	};
	const command = {
		id: "cmd-fixture",
		name: "node",
		args: [],
		cwd: "/vercel/sandbox",
		sessionId: "sbx_proxy",
		startedAt: 1,
		exitCode: null,
	};
	const matched: string[] = [];
	let uploadedNonce = "";
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const interaction = pact.interactions[matched.length];
		if (!interaction)
			throw new Error(
				`unexpected SDK interaction: ${init.method} ${new URL(url).pathname}`,
			);
		expect(new URL(url).pathname).toBe(interaction.request.path);
		expect(init.method).toBe(interaction.request.method);
		matched.push(interaction.request.path);
		if (matched.length === 1)
			return Response.json(
				{ sandbox, session, routes: [] },
				{ status: interaction.response.status },
			);
		if (matched.length === 2) {
			const body = JSON.parse(String(init.body));
			expect(body).toMatchObject({
				command: "mkdir",
				args: ["-p", "-m", "700", "/vercel/sandbox"],
				cwd: "/",
				wait: true,
			});
			return new Response(
				`${JSON.stringify({ command })}\n${JSON.stringify({ command: { ...command, exitCode: 0 } })}\n`,
				{
					status: interaction.response.status,
					headers: { "content-type": "application/x-ndjson" },
				},
			);
		}
		if (matched.length === 3) {
			const tar = gunzipSync(
				Buffer.from(z.instanceof(Uint8Array).parse(init.body)),
			);
			const path = Buffer.from("vercel/sandbox/.hobo-ci-proxy-config.json");
			const offset = tar.indexOf(path);
			expect(offset).toBeGreaterThanOrEqual(0);
			expect(tar.includes(Buffer.from(secret))).toBe(true);
			expect(
				Number.parseInt(
					tar
						.subarray(offset + 100, offset + 108)
						.toString("ascii")
						.replace(/\0/g, "")
						.trim(),
					8,
				),
			).toBe(0o600);
			const nonceOffset = tar.indexOf(
				Buffer.from("vercel/sandbox/.hobo-ci-proxy-nonce"),
			);
			expect(nonceOffset).toBeGreaterThanOrEqual(0);
			expect(
				Number.parseInt(
					tar
						.subarray(nonceOffset + 100, nonceOffset + 108)
						.toString("ascii")
						.replace(/\0/g, "")
						.trim(),
					8,
				),
			).toBe(0o600);
			uploadedNonce = tar
				.subarray(nonceOffset + 512, nonceOffset + 544)
				.toString("ascii");
			expect(uploadedNonce).toMatch(/^[a-f0-9]{32}$/);
			return Response.json({}, { status: interaction.response.status });
		}
		const body = JSON.parse(String(init.body));
		expect(JSON.stringify(body)).not.toContain(secret);
		expect(body).toMatchObject({
			command: "node",
			args: ["/vercel/sandbox/hobo-ci-proxy.mjs"],
			cwd: "/vercel/sandbox",
		});
		return Response.json({ command }, { status: interaction.response.status });
	});
	try {
		const box = await Sandbox.create({
			token: "fixture-token",
			teamId: "team-fixture",
			projectId: "project-fixture",
			persistent: false,
			resources: { vcpus: 1 },
		});
		const result = await launchSandboxProxyVm(
			box.currentSession(),
			Buffer.from("fixture-bundle"),
			config,
		);
		expect(result).toEqual({
			commandId: "cmd-fixture",
			readinessNonce: uploadedNonce,
		});
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(matched).toHaveLength(pact.interactions.length);
	} finally {
		vi.unstubAllGlobals();
	}
});
