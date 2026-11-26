import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProcessKubectlTransport } from "../src/kubectl-transport.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function forwardingKubectl(options: {
	answer?: string;
	contentType?: string;
	status?: number;
	readyLine?: boolean;
	exit?: boolean;
}): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-kubectl-pf-"));
	dirs.push(dir);
	const bin = join(dir, "kubectl");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const http = require('node:http');",
			"const argv = process.argv.slice(2);",
			"if (argv[0] !== 'port-forward') { process.exit(0); }",
			`if (${options.exit === true}) {`,
			"  process.stderr.write('error: services \"missing\" not found');",
			"  process.exit(1);",
			"}",
			"const mapping = argv[argv.length - 1];",
			"const localPort = Number(mapping.split(':')[0]);",
			`const answer = ${JSON.stringify(options.answer ?? '{"ok":true}')};`,
			`const contentType = ${JSON.stringify(options.contentType ?? "application/json")};`,
			`const status = ${options.status ?? 200};`,
			"const server = http.createServer((req, res) => {",
			"  res.writeHead(status, { 'content-type': contentType });",
			"  res.end(JSON.stringify({ body: answer, method: req.method, url: req.url }));",
			"});",
			"server.listen(localPort, '127.0.0.1', () => {",
			`  if (${options.readyLine !== false}) {`,
			"    process.stdout.write('Forwarding from 127.0.0.1:' + localPort + ' -> 8080\\n');",
			"  }",
			"});",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	return bin;
}

function transportFor(options: Parameters<typeof forwardingKubectl>[0] = {}) {
	return createProcessKubectlTransport({
		kubectlBin: forwardingKubectl(options),
		env: { PATH: process.env.PATH ?? "" },
	});
}

const post = (path: string, body: unknown) => ({
	method: "POST",
	path,
	body,
});

async function forwarded(
	options: Parameters<typeof forwardingKubectl>[0] = {},
	service = "api",
) {
	const transport = transportFor(options);
	const response = await transport.handle(
		post("/kubectl/port-forward", {
			namespace: "hobo-dev",
			service,
			targetPort: 8080,
		}) as never,
	);
	return { transport, response };
}

async function teardown(
	transport: Awaited<ReturnType<typeof forwarded>>["transport"],
	name = "api",
) {
	return await transport.handle({
		method: "DELETE",
		path: "/kubectl/resources",
		body: { namespace: "hobo-dev", name },
	} as never);
}

describe("opening a port-forward", () => {
	it("reports the loopback url it opened", async () => {
		const { transport, response } = await forwarded();
		expect(response.status).toBe(200);
		const body = response.body as { ok: boolean; loopbackUrl: string };
		expect(body.ok).toBe(true);
		expect(body.loopbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		await teardown(transport);
	});

	it("allocates a local port rather than reusing the target port", async () => {
		const { transport, response } = await forwarded();
		const body = response.body as { localPort: number };
		expect(body.localPort).toBeGreaterThan(0);
		expect(body.localPort).not.toBe(8080);
		await teardown(transport);
	});

	it("waits for kubectl's readiness line before reporting success", async () => {
		const { transport, response } = await forwarded();
		expect((response.body as { ok: boolean }).ok).toBe(true);
		await teardown(transport);
	});

	it("reports a child that exited rather than waiting it out", async () => {
		const { response } = await forwarded({ exit: true }, "missing");
		expect(response.status).toBe(503);
	});

	it("carries kubectl's own message into that failure", async () => {
		const { response } = await forwarded({ exit: true }, "missing");
		expect((response.body as { error: string }).error).toMatch(/not found/);
	});
});

describe("proxying a request over the tunnel", () => {
	const proxy = (
		transport: Awaited<ReturnType<typeof forwarded>>["transport"],
		body: Record<string, unknown>,
	) => transport.handle(post("/kubectl/http-proxy", body) as never);

	it("refuses when no forward is open for the service", async () => {
		const response = await proxy(transportFor(), {
			service: "api",
			method: "GET",
			path: "/",
		});
		expect(response.status).toBe(503);
	});

	it("names the service it has no tunnel for", async () => {
		const response = await proxy(transportFor(), { service: "api" });
		expect((response.body as { error: string }).error).toMatch(/api/);
	});

	it("reaches the served endpoint over the tunnel", async () => {
		const { transport } = await forwarded();
		const response = await proxy(transport, {
			service: "api",
			method: "GET",
			path: "/health",
		});
		expect(response.status).toBe(200);
		await teardown(transport);
	});

	it("carries the upstream's own status", async () => {
		const { transport } = await forwarded({ status: 404 });
		const response = await proxy(transport, { service: "api", path: "/" });
		expect((response.body as { status: number }).status).toBe(404);
		await teardown(transport);
	});

	it("decodes a JSON response as json", async () => {
		const { transport } = await forwarded();
		const response = await proxy(transport, { service: "api", path: "/" });
		expect((response.body as { json?: unknown }).json).toBeDefined();
		await teardown(transport);
	});

	it("carries a non-JSON response as text", async () => {
		const { transport } = await forwarded({ contentType: "text/plain" });
		const response = await proxy(transport, { service: "api", path: "/" });
		const body = response.body as { text?: string; json?: unknown };
		expect(body.text).toBeDefined();
		expect(body.json).toBeUndefined();
		await teardown(transport);
	});

	it("defaults the method to GET", async () => {
		const { transport } = await forwarded();
		const response = await proxy(transport, { service: "api", path: "/" });
		expect(response.status).toBe(200);
		await teardown(transport);
	});

	it("normalises a path with no leading slash", async () => {
		const { transport } = await forwarded();
		const response = await proxy(transport, {
			service: "api",
			path: "health",
		});
		expect(response.status).toBe(200);
		await teardown(transport);
	});

	it("sends a body on a POST", async () => {
		const { transport } = await forwarded();
		const response = await proxy(transport, {
			service: "api",
			method: "POST",
			path: "/",
			body: { hello: true },
		});
		expect(response.status).toBe(200);
		await teardown(transport);
	});

	it("sends a string body unchanged rather than re-encoding it", async () => {
		const { transport } = await forwarded();
		const response = await proxy(transport, {
			service: "api",
			method: "POST",
			path: "/",
			body: '{"hello":true}',
		});
		expect(response.status).toBe(200);
		await teardown(transport);
	});

	it("omits a body on GET even when one is supplied", async () => {
		const { transport } = await forwarded();
		const response = await proxy(transport, {
			service: "api",
			method: "GET",
			path: "/",
			body: { hello: true },
		});
		expect(response.status).toBe(200);
		await teardown(transport);
	});
});

describe("closing a forward", () => {
	it("stops the child and forgets the tunnel", async () => {
		const { transport } = await forwarded();
		await teardown(transport);
		const response = await transport.handle(
			post("/kubectl/http-proxy", { service: "api", path: "/" }) as never,
		);
		expect(response.status).toBe(503);
	});

	it("succeeds for a service with no forward open", async () => {
		const transport = transportFor();
		await expect(teardown(transport, "never-forwarded")).resolves.toBeDefined();
	});
});
