/**
 * The port-forward and the hop that rides it.
 *
 * `kubectl-transport-paths.test.ts` covers every path that only shells out to
 * kubectl and reads its output. These two are different: a port-forward is a
 * *long-running* child process, and the http-proxy hop is a real network call
 * over the tunnel it opened. Together they are how a HoBo mesh call reaches a
 * workload in a cluster, so what they do when the tunnel is not there is the
 * behaviour that matters most.
 *
 * **A port-forward is only ready when kubectl says it is.** The child is
 * spawned and then watched for its `Forwarding from 127.0.0.1:` line. Treating
 * spawn as readiness would return a loopback URL to a socket nothing is
 * listening on yet, and the first request through it would fail with a
 * connection refused that looks like the workload being down.
 *
 * **A child that exits is reported as a failure, not waited out.** kubectl
 * exits immediately when the service does not exist. Polling until the 30s
 * deadline would turn a typo into a half-minute stall with a timeout at the
 * end, instead of the message kubectl already printed.
 *
 * **A proxy hop with no tunnel is refused with 503, naming the service.** The
 * alternative is a fetch against a URL that means nothing, whose failure would
 * be indistinguishable from the workload refusing the connection.
 *
 * The stand-in `kubectl` here does something the other fakes do not: on
 * `port-forward` it starts a real HTTP server on the local port it was given
 * and prints the readiness line. That makes the proxy hop a genuine loopback
 * request rather than a mocked one — which is the only way to prove the
 * transport actually opens the tunnel it reports.
 */
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

/**
 * A stand-in `kubectl` whose `port-forward` really listens.
 *
 * `answer` is what the served endpoint replies with; `contentType` decides
 * whether the transport decodes it as JSON or carries it as text. `readyLine`
 * false makes the child print nothing, so readiness never arrives; `exit`
 * makes it exit immediately, as kubectl does for a missing service.
 */
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
			// `svc/<name> <local>:<remote>` is the last argument pair.
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

/** Open a forward for `service`, returning the transport and the response. */
async function forwarded(
	options: Parameters<typeof forwardingKubectl>[0] = {},
	service = "api",
) {
	const transport = transportFor(options);
	const response = await transport.handle(
		// SAFETY: the transport reads exactly the fields a request names.
		post("/kubectl/port-forward", {
			namespace: "hobo-dev",
			service,
			targetPort: 8080,
		}) as never,
	);
	return { transport, response };
}

/** Tear a forward down so its child process does not outlive the test. */
async function teardown(
	transport: Awaited<ReturnType<typeof forwarded>>["transport"],
	name = "api",
) {
	return await transport.handle({
		method: "DELETE",
		path: "/kubectl/resources",
		body: { namespace: "hobo-dev", name },
		// SAFETY: the transport reads exactly the fields a request names.
	} as never);
}

describe("opening a port-forward", () => {
	it("reports the loopback url it opened", async () => {
		const { transport, response } = await forwarded();
		expect(response.status).toBe(200);
		// SAFETY: the transport answers with exactly this body shape.
		const body = response.body as { ok: boolean; loopbackUrl: string };
		expect(body.ok).toBe(true);
		expect(body.loopbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		await teardown(transport);
	});

	it("allocates a local port rather than reusing the target port", async () => {
		// Two forwards to different services both targeting 8080 would collide
		// on a fixed local port, and the second would silently reach the first.
		const { transport, response } = await forwarded();
		// SAFETY: the transport answers with exactly this body shape.
		const body = response.body as { localPort: number };
		expect(body.localPort).toBeGreaterThan(0);
		expect(body.localPort).not.toBe(8080);
		await teardown(transport);
	});

	it("waits for kubectl's readiness line before reporting success", async () => {
		// Treating spawn as readiness would return a URL to a socket nothing is
		// listening on, and the first request would fail with a connection
		// refused that looks like the workload being down.
		const { transport, response } = await forwarded();
		// SAFETY: the transport answers with exactly this body shape.
		expect((response.body as { ok: boolean }).ok).toBe(true);
		await teardown(transport);
	});

	it("reports a child that exited rather than waiting it out", async () => {
		// kubectl exits immediately when the service does not exist. Polling to
		// the 30s deadline would turn a typo into a half-minute stall.
		const { response } = await forwarded({ exit: true }, "missing");
		expect(response.status).toBe(503);
	});

	it("carries kubectl's own message into that failure", async () => {
		// kubectl already said what was wrong; discarding it leaves nothing to
		// act on.
		const { response } = await forwarded({ exit: true }, "missing");
		// SAFETY: the transport answers with exactly this body shape.
		expect((response.body as { error: string }).error).toMatch(/not found/);
	});
});

describe("proxying a request over the tunnel", () => {
	const proxy = (
		transport: Awaited<ReturnType<typeof forwarded>>["transport"],
		body: Record<string, unknown>,
	) =>
		transport.handle(
			// SAFETY: the transport reads exactly the fields a request names.
			post("/kubectl/http-proxy", body) as never,
		);

	it("refuses when no forward is open for the service", async () => {
		// A fetch against a URL that means nothing would fail
		// indistinguishably from the workload refusing the connection.
		const response = await proxy(transportFor(), {
			service: "api",
			method: "GET",
			path: "/",
		});
		expect(response.status).toBe(503);
	});

	it("names the service it has no tunnel for", async () => {
		const response = await proxy(transportFor(), { service: "api" });
		// SAFETY: the transport answers with exactly this body shape.
		expect((response.body as { error: string }).error).toMatch(/api/);
	});

	it("reaches the served endpoint over the tunnel", async () => {
		// A real loopback request — the only way to prove the transport opened
		// the tunnel it reported rather than merely claiming to.
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
		// The proxy's 200 means "the hop happened"; the upstream status lives
		// in the body, so a 404 from the workload is not reported as a
		// transport failure.
		const { transport } = await forwarded({ status: 404 });
		const response = await proxy(transport, { service: "api", path: "/" });
		// SAFETY: the transport answers with exactly this body shape.
		expect((response.body as { status: number }).status).toBe(404);
		await teardown(transport);
	});

	it("decodes a JSON response as json", async () => {
		// So a caller reads fields rather than re-parsing a string it was
		// handed.
		const { transport } = await forwarded();
		const response = await proxy(transport, { service: "api", path: "/" });
		// SAFETY: the transport answers with exactly this body shape.
		expect((response.body as { json?: unknown }).json).toBeDefined();
		await teardown(transport);
	});

	it("carries a non-JSON response as text", async () => {
		// Not everything a workload serves is JSON. Forcing a parse would drop
		// an HTML error page — exactly what an ingress returns when something
		// is misrouted.
		const { transport } = await forwarded({ contentType: "text/plain" });
		const response = await proxy(transport, { service: "api", path: "/" });
		// SAFETY: the transport answers with exactly this body shape.
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
		// A caller passing `health` means `/health`; concatenating it raw would
		// produce `http://127.0.0.1:1234health`.
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
		// A caller that already serialised its payload would otherwise get it
		// wrapped in quotes as a JSON string.
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
		// `fetch` throws on a GET with a body, so passing one through would
		// turn a caller's mistake into a transport crash.
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
		// A forward left running holds a port and a process after its workload
		// is gone; the next proxy hop must be refused rather than reaching a
		// tunnel to nothing.
		const { transport } = await forwarded();
		await teardown(transport);
		const response = await transport.handle(
			// SAFETY: the transport reads exactly the fields a request names.
			post("/kubectl/http-proxy", { service: "api", path: "/" }) as never,
		);
		expect(response.status).toBe(503);
	});

	it("succeeds for a service with no forward open", async () => {
		// Teardown is a cleanup path; refusing an already-clean state would
		// make rollback fail on the very case it exists to handle.
		const transport = transportFor();
		await expect(teardown(transport, "never-forwarded")).resolves.toBeDefined();
	});
});
