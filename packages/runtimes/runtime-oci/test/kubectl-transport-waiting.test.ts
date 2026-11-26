/**
 * The kubectl transport's two *waiting* paths: rollout-status and
 * port-forward.
 *
 * `kubectl-transport-paths.test.ts` pins which invocation each request
 * produces. These two paths are different in kind — they loop, they watch a
 * long-running child, and they have deadlines — so what matters is not the
 * argv but **what they do while they wait and how they give up**.
 *
 * **A rollout that reports failure is not necessarily a failed rollout.**
 * `kubectl rollout status` times out on its own schedule and exits non-zero;
 * the deployment may still be coming up. So a non-zero exit falls through to
 * polling endpoints, and a service with addresses is ready regardless of what
 * the rollout command said. Treating the first non-zero as fatal would fail
 * deploys that were about to succeed.
 *
 * **Giving up is a 504 carrying the CLI's own text.** The stderr is the only
 * description of *why* the cluster never became ready; a bare "timeout" would
 * make every failure look identical.
 *
 * **A port-forward that dies is a 503, not a hang.** The child is long-running
 * by design, so the loop has to distinguish "not ready yet" from "already
 * exited" — and an exited child must be reported immediately rather than
 * waited out for the full deadline.
 *
 * **A port-forward that never signals readiness is killed.** Leaving the child
 * running after returning would leak a process holding a loopback port for the
 * life of the station.
 *
 * The stand-in `kubectl` is a real script on disk, so the child process, its
 * exit code and its streamed output are all genuine.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProcessKubectlTransport } from "../src/kubectl-transport.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a stand-in `kubectl` whose body is the given JavaScript. The script
 * receives `argv` and may exit, print, or stay alive — which is what the
 * waiting paths need and a scripted answer table cannot express.
 */
function kubectlScript(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-kubectl-wait-"));
	dirs.push(dir);
	const bin = join(dir, "kubectl");
	writeFileSync(
		bin,
		["#!/usr/bin/env node", "const argv = process.argv.slice(2);", body].join(
			"\n",
		),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	return bin;
}

function transport(body: string) {
	return createProcessKubectlTransport({
		kubectlBin: kubectlScript(body),
		// The stand-in is a node script, so its shebang still needs node's own
		// directory on PATH.
		env: { PATH: dirname(process.execPath) },
	});
}

describe("waiting for a rollout", () => {
	it("reports ready when rollout status succeeds first time", async () => {
		const api = transport("process.exit(0);");
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: {
				namespace: "default",
				name: "web",
			},
		});
		expect(result).toMatchObject({ status: 200, body: { ready: true } });
	});

	it("falls through to endpoints when rollout status fails", async () => {
		// `kubectl rollout status` times out on its own schedule. A deployment
		// that is nearly up exits non-zero and then becomes ready seconds later.
		const api = transport(`
			if (argv[0] === "rollout") { process.stderr.write("timed out"); process.exit(1); }
			if (argv[0] === "get") { process.stdout.write("10.0.0.1"); process.exit(0); }
			process.exit(0);
		`);
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: {
				namespace: "default",
				name: "web",
				timeoutMs: 5_000,
			},
		});
		// Treating the first non-zero as fatal would fail deploys that were
		// about to succeed.
		expect(result).toMatchObject({ status: 200, body: { ready: true } });
	});

	it("keeps waiting while endpoints have no addresses", async () => {
		// An endpoints object exists but is empty while pods are still starting.
		// Exit 0 with empty stdout must not read as ready.
		const api = transport(`
			if (argv[0] === "rollout") { process.exit(1); }
			if (argv[0] === "get") { process.stdout.write("   "); process.exit(0); }
			process.exit(0);
		`);
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: {
				namespace: "default",
				name: "web",
				timeoutMs: 700,
			},
		});
		expect(result).toMatchObject({ status: 504 });
	});

	it("keeps waiting while the endpoints query itself fails", async () => {
		const api = transport(`
			if (argv[0] === "rollout") { process.exit(1); }
			process.exit(1);
		`);
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: {
				namespace: "default",
				name: "web",
				timeoutMs: 700,
			},
		});
		// A transient API error is not a verdict; the loop rides it out until
		// the caller's own deadline.
		expect(result).toMatchObject({ status: 504, body: { ready: false } });
	});

	it("carries the rollout command's own stderr into the timeout", async () => {
		const api = transport(`
			if (argv[0] === "rollout") { process.stderr.write("ImagePullBackOff"); process.exit(1); }
			process.exit(1);
		`);
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: {
				namespace: "default",
				name: "web",
				timeoutMs: 700,
			},
		});
		// The stderr is the only description of *why*. A bare "timeout" would
		// make ImagePullBackOff and a crash-looping container look identical.
		expect(String((result.body as { error?: string }).error)).toContain(
			"ImagePullBackOff",
		);
	});

	it("falls back to a generic message when the CLI said nothing", async () => {
		const api = transport(`
			if (argv[0] === "rollout") { process.exit(1); }
			process.exit(1);
		`);
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: {
				namespace: "default",
				name: "web",
				timeoutMs: 700,
			},
		});
		expect(String((result.body as { error?: string }).error)).toContain(
			"timeout waiting for ready",
		);
	});

	it("defaults the namespace when none is given", async () => {
		const api = transport("process.exit(0);");
		// A rollout wait against the wrong namespace would watch a deployment
		// that is not the one being deployed.
		expect(
			await api.handle({
				method: "POST",
				path: "/kubectl/rollout-status",
				body: { name: "web" },
			}),
		).toMatchObject({ status: 200 });
	});
});

describe("port-forwarding", () => {
	it("reports the forwarded port once kubectl says it is forwarding", async () => {
		const api = transport(`
			if (argv[0] === "port-forward") {
				process.stdout.write("Forwarding from 127.0.0.1:1234 -> 8080\\n");
				setInterval(() => {}, 1000);
			} else { process.exit(0); }
		`);
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/port-forward",
			body: {
				namespace: "default",
				service: "web",
				targetPort: 8080,
			},
		});
		expect(result.status).toBe(200);
	});

	it("matches the readiness line case-insensitively", async () => {
		// The exact casing of kubectl's line is not part of any contract, so the
		// match must not be brittle against a client-version change.
		const api = transport(`
			if (argv[0] === "port-forward") {
				process.stdout.write("forwarding from 127.0.0.1:1234 -> 8080\\n");
				setInterval(() => {}, 1000);
			} else { process.exit(0); }
		`);
		expect(
			(
				await api.handle({
					method: "POST",
					path: "/kubectl/port-forward",
					body: {
						service: "web",
					},
				})
			).status,
		).toBe(200);
	});

	it("reads the readiness line from stderr too", async () => {
		// kubectl has printed this on either stream across versions; the
		// transport watches both.
		const api = transport(`
			if (argv[0] === "port-forward") {
				process.stderr.write("Forwarding from 127.0.0.1:1234 -> 8080\\n");
				setInterval(() => {}, 1000);
			} else { process.exit(0); }
		`);
		expect(
			(
				await api.handle({
					method: "POST",
					path: "/kubectl/port-forward",
					body: { service: "web" },
				})
			).status,
		).toBe(200);
	});

	it("reports a 503 when the child exits instead of forwarding", async () => {
		const api = transport(`
			if (argv[0] === "port-forward") {
				process.stderr.write("error: service not found");
				process.exit(1);
			}
			process.exit(0);
		`);
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/port-forward",
			body: {
				service: "missing",
			},
		});
		// An exited child must be reported immediately rather than waited out
		// for the full 30-second deadline.
		expect(result.status).toBe(503);
	});

	it("carries the dead child's output into the 503", async () => {
		const api = transport(`
			if (argv[0] === "port-forward") {
				process.stderr.write("error: service \\"missing\\" not found");
				process.exit(1);
			}
			process.exit(0);
		`);
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/port-forward",
			body: {
				service: "missing",
			},
		});
		expect(String((result.body as { error?: string }).error)).toContain(
			"not found",
		);
	});

	it("reports a 503 even when the child exits zero without forwarding", async () => {
		// A clean exit that never printed the readiness line is still a failure:
		// nothing is listening, and returning 200 would hand back a dead port.
		const api = transport(`
			if (argv[0] === "port-forward") { process.exit(0); }
			process.exit(0);
		`);
		expect(
			(
				await api.handle({
					method: "POST",
					path: "/kubectl/port-forward",
					body: { service: "web" },
				})
			).status,
		).toBe(503);
	});

	it("defaults the target port when none is given", async () => {
		const api = transport(`
			if (argv[0] === "port-forward") {
				if (!argv.join(" ").includes(":8080")) { process.exit(1); }
				process.stdout.write("Forwarding from 127.0.0.1:1234 -> 8080\\n");
				setInterval(() => {}, 1000);
			} else { process.exit(0); }
		`);
		// 8080 is the default a Bindle's web role listens on; forwarding to the
		// wrong port would connect to nothing.
		expect(
			(
				await api.handle({
					method: "POST",
					path: "/kubectl/port-forward",
					body: { service: "web" },
				})
			).status,
		).toBe(200);
	});

	it("addresses the service, not a pod", async () => {
		const api = transport(`
			if (argv[0] === "port-forward") {
				if (!argv.includes("svc/web")) { process.exit(1); }
				process.stdout.write("Forwarding from 127.0.0.1:1234 -> 8080\\n");
				setInterval(() => {}, 1000);
			} else { process.exit(0); }
		`);
		// Forwarding to a pod pins traffic to one replica and breaks the moment
		// it is rescheduled.
		expect(
			(
				await api.handle({
					method: "POST",
					path: "/kubectl/port-forward",
					body: { service: "web" },
				})
			).status,
		).toBe(200);
	});

	it("passes the namespace through", async () => {
		const api = transport(`
			if (argv[0] === "port-forward") {
				if (!(argv.includes("-n") && argv.includes("prod"))) { process.exit(1); }
				process.stdout.write("Forwarding from 127.0.0.1:1234 -> 8080\\n");
				setInterval(() => {}, 1000);
			} else { process.exit(0); }
		`);
		expect(
			(
				await api.handle({
					method: "POST",
					path: "/kubectl/port-forward",
					body: {
						namespace: "prod",
						service: "web",
					},
				})
			).status,
		).toBe(200);
	});

	it("picks a free local port rather than a fixed one", async () => {
		const api = transport(`
			if (argv[0] === "port-forward") {
				process.stdout.write("Forwarding from 127.0.0.1:1234 -> 8080\\n");
				setInterval(() => {}, 1000);
			} else { process.exit(0); }
		`);
		const first = await api.handle({
			method: "POST",
			path: "/kubectl/port-forward",
			body: {
				service: "web",
			},
		});
		const second = await api.handle({
			method: "POST",
			path: "/kubectl/port-forward",
			body: {
				service: "web",
			},
		});
		// Two forwards on one station must not collide on a hard-coded port.
		expect(first.body).not.toEqual(second.body);
	});
});

describe("tearing a forward down", () => {
	/** A kubectl that forwards successfully and stays alive until signalled. */
	const forwarding = `
		if (argv[0] === "port-forward") {
			process.stdout.write("Forwarding from 127.0.0.1:1234 -> 8080\\n");
			setInterval(() => {}, 1000);
		} else { process.exit(0); }
	`;

	it("kills the forwarding child when its resources are deleted", async () => {
		const api = transport(forwarding);
		await api.handle({
			method: "POST",
			path: "/kubectl/port-forward",
			body: { service: "web" },
		});
		const result = await api.handle({
			method: "DELETE",
			path: "/kubectl/resources",
			body: { namespace: "default", name: "web" },
		});
		// A forward outliving the deployment it forwarded to would hold a
		// loopback port for the life of the station and proxy to nothing.
		expect(result.status).toBe(200);
	});

	it("stops proxying to a service whose forward was torn down", async () => {
		const api = transport(forwarding);
		await api.handle({
			method: "POST",
			path: "/kubectl/port-forward",
			body: { service: "web" },
		});
		await api.handle({
			method: "DELETE",
			path: "/kubectl/resources",
			body: { name: "web" },
		});
		const proxied = await api.handle({
			method: "POST",
			path: "/kubectl/http-proxy",
			body: { service: "web", path: "/" },
		});
		// The forward is gone, so a proxy attempt must be an honest 503 rather
		// than a connection to whatever now holds that port.
		expect(proxied.status).toBe(503);
	});

	it("deletes resources that never had a forward", async () => {
		const api = transport("process.exit(0);");
		// Tearing down a deployment that was never port-forwarded is the normal
		// case; it must not depend on a forward existing.
		expect(
			(
				await api.handle({
					method: "DELETE",
					path: "/kubectl/resources",
					body: { name: "web" },
				})
			).status,
		).toBe(200);
	});

	it("refuses to proxy to a service that was never forwarded", async () => {
		const api = transport("process.exit(0);");
		const result = await api.handle({
			method: "POST",
			path: "/kubectl/http-proxy",
			body: { service: "ghost", path: "/" },
		});
		expect(result.status).toBe(503);
		expect(String((result.body as { error?: string }).error)).toContain(
			"no active port-forward",
		);
	});
});
