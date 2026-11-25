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
		expect(result).toMatchObject({ status: 200, body: { ready: true } });
	});

	it("keeps waiting while endpoints have no addresses", async () => {
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
		expect(first.body).not.toEqual(second.body);
	});
});

describe("tearing a forward down", () => {
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
		expect(proxied.status).toBe(503);
	});

	it("deletes resources that never had a forward", async () => {
		const api = transport("process.exit(0);");
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
