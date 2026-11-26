import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	proxyCommandExited,
	proxyReadinessScript,
} from "../src/sandbox-proxy-vm.js";

function run(
	args: string[],
	timeout = 5000,
): Promise<{ code: number | string; stdout: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, args, { timeout }, (error, stdout) => {
			resolve({ code: error ? (error.code ?? "error") : 0, stdout });
		});
	});
}

describe("proxy startup readiness", () => {
	it("does not interpret missing or null command exit status as termination", () => {
		expect(proxyCommandExited(undefined)).toBe(false);
		expect(proxyCommandExited(null)).toBe(false);
		expect(proxyCommandExited(0)).toBe(true);
		expect(proxyCommandExited(1)).toBe(true);
	});
	it("waits for this launch's marker before accepting a delayed listener", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-proxy-ready-"));
		const paths = {
			ready: join(directory, "ready"),
			failure: join(directory, "failure"),
		};
		const nonce = "a".repeat(32);
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.writeHead(204).end();
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = z.object({ port: z.number() }).parse(server.address());
		try {
			await writeFile(paths.ready, "b".repeat(32));
			const pending = run([
				"-e",
				proxyReadinessScript(port, nonce, 3000, paths),
			]);
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(requests).toBe(0);
			await writeFile(paths.ready, nonce);
			expect((await pending).code).toBe(0);
			expect(requests).toBeGreaterThan(0);
		} finally {
			server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("retries nonready responses until the proxy is healthy", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-proxy-ready-"));
		const paths = {
			ready: join(directory, "ready"),
			failure: join(directory, "failure"),
		};
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.writeHead(requests < 3 ? 503 : 204).end();
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = z.object({ port: z.number() }).parse(server.address());
		try {
			await writeFile(paths.ready, "a".repeat(32));
			expect(
				(
					await run([
						"-e",
						proxyReadinessScript(port, "a".repeat(32), 3000, paths),
					])
				).code,
			).toBe(0);
			expect(requests).toBeGreaterThanOrEqual(3);
		} finally {
			server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("waits when the marker is present before the port accepts connections", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-proxy-ready-"));
		const paths = {
			ready: join(directory, "ready"),
			failure: join(directory, "failure"),
		};
		const server = createServer((_request, response) =>
			response.writeHead(204).end(),
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = z.object({ port: z.number() }).parse(server.address());
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		try {
			await writeFile(paths.ready, "a".repeat(32));
			const pending = run([
				"-e",
				proxyReadinessScript(port, "a".repeat(32), 3000, paths),
			]);
			await new Promise((resolve) => setTimeout(resolve, 500));
			server.listen(port, "127.0.0.1");
			await once(server, "listening");
			expect((await pending).code).toBe(0);
		} finally {
			server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("times out when only an unrelated listener responds and reports fixed failure markers", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-proxy-ready-"));
		const paths = {
			ready: join(directory, "ready"),
			failure: join(directory, "failure"),
		};
		const server = createServer((_request, response) =>
			response.writeHead(204).end(),
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = z.object({ port: z.number() }).parse(server.address());
		try {
			await writeFile(paths.ready, "b".repeat(32));
			expect(
				await run([
					"-e",
					proxyReadinessScript(port, "a".repeat(32), 300, paths),
				]),
			).toEqual({ code: 1, stdout: "timeout\n" });
			await writeFile(paths.failure, "parse_config");
			expect(
				await run([
					"-e",
					proxyReadinessScript(port, "a".repeat(32), 300, paths),
				]),
			).toEqual({ code: 1, stdout: "parse_config\n" });
		} finally {
			server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("terminates an already listening process after a server error", async () => {
		const script = `import { createServer } from 'node:http'; import { installProxyFatalErrorHandler } from './src/sandbox-proxy-vm.ts'; const server = createServer(); installProxyFatalErrorHandler(server, async () => {}); server.listen(0, '127.0.0.1', () => server.emit('error', new Error('failed')));`;
		expect(
			(
				await run(
					["--import", "tsx", "--input-type=module", "-e", script],
					30000,
				)
			).code,
		).toBe(1);
	}, 35000);
});
