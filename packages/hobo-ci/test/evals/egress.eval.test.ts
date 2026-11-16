import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
	childEgressEnv,
	egressFrom,
	RECEIVER_THROUGH_PROXY,
	REDIRECT_RECEIVERS,
	redirectReceiverFrom,
} from "../../src/index.js";

// EVAL: a run reads the environment's egress once, before anything connects,
// and every outbound piece honours it: a proxy the environment requires, the
// hosts that bypass it, and the CA bundle that trusts it. Nothing discovers
// the proxy by failing.

const SANDBOX = {
	HTTPS_PROXY: "http://127.0.0.1:46397",
	NO_PROXY: "localhost,127.0.0.1,::1",
	NODE_EXTRA_CA_CERTS: "/root/.ccr/ca-bundle.crt",
};

function fakeCli(output: string) {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: () => true,
	});
	setTimeout(() => child.stdout.write(output), 5);
	return child;
}

describe("EVAL egress: proxies are detected and honoured up front", () => {
	it("reads the proxy, bypass list and CA bundle from either spelling", () => {
		expect(egressFrom(SANDBOX)).toEqual({
			proxy: SANDBOX.HTTPS_PROXY,
			noProxy: SANDBOX.NO_PROXY,
			caFile: SANDBOX.NODE_EXTRA_CA_CERTS,
		});
		expect(
			egressFrom({ https_proxy: "http://p:1", no_proxy: "x" }),
		).toMatchObject({ proxy: "http://p:1", noProxy: "x" });
		expect(egressFrom({}).proxy).toBeUndefined();
	});

	it("starts a tunnel CLI with the proxy and CA settings and without a secret", () => {
		const env = childEgressEnv(
			{ ...SANDBOX, PATH: "/usr/bin", BWS_ACCESS_TOKEN: "secret-value" },
			egressFrom(SANDBOX),
		);
		expect(env).toMatchObject({
			PATH: "/usr/bin",
			HTTPS_PROXY: SANDBOX.HTTPS_PROXY,
			https_proxy: SANDBOX.HTTPS_PROXY,
			NO_PROXY: SANDBOX.NO_PROXY,
			SSL_CERT_FILE: SANDBOX.NODE_EXTRA_CA_CERTS,
		});
		expect(Object.values(env)).not.toContain("secret-value");
	});

	it("never starts a receiver whose client cannot use the required proxy", async () => {
		for (const id of REDIRECT_RECEIVERS.filter(
			(r) => RECEIVER_THROUGH_PROXY.get(r) !== true,
		)) {
			let started = false;
			const receiver = redirectReceiverFrom(
				{
					...SANDBOX,
					HOBO_REDIRECT_RECEIVER: id,
					HOBO_REDIRECT_PUBLIC_ORIGIN: "https://hobo.owner.example",
				},
				{
					spawn: () => {
						started = true;
						return fakeCli("");
					},
				},
			);
			await expect(receiver?.open(9)).rejects.toMatchObject({
				code: "HOBO_REDIRECT_RECEIVER_EGRESS",
			});
			expect(started).toBe(false);
		}
	});

	it("starts a proxy-capable receiver with the proxy in its environment", async () => {
		const cases = [
			[
				"ngrok",
				"msg=started url=https://ab12.ngrok-free.app\n",
				"https://ab12.ngrok-free.app",
			],
			[
				"devtunnel",
				"Connect via browser: https://k3x9-9.usw2.devtunnels.ms\n",
				"https://k3x9-9.usw2.devtunnels.ms",
			],
		] as const;
		for (const [id, output, origin] of cases) {
			let seen: NodeJS.ProcessEnv = {};
			const receiver = redirectReceiverFrom(
				{ ...SANDBOX, HOBO_REDIRECT_RECEIVER: id },
				{
					env: { ...SANDBOX, GH_TOKEN: "secret-value" },
					spawn: (_command, _args, env) => {
						seen = env;
						// SAFETY: the fake implements the stdout/stderr/kill/once the reader uses.
						return fakeCli(output) as never;
					},
				},
			);
			const open = await receiver?.open(9);
			expect(open?.publicOrigin).toBe(origin);
			expect(seen.HTTPS_PROXY).toBe(SANDBOX.HTTPS_PROXY);
			expect(seen.SSL_CERT_FILE).toBe(SANDBOX.NODE_EXTRA_CA_CERTS);
			expect(Object.values(seen)).not.toContain("secret-value");
			await open?.close();
		}
	});
});
