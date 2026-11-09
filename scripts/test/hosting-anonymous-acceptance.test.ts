import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAnonymousAcceptanceRun } from "../manual/hosting-anonymous-acceptance.mts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanup.length) await cleanup.pop()?.();
});
async function stateDir() {
	const folder = await mkdtemp(
		path.join(tmpdir(), "hobo-anonymous-acceptance-"),
	);
	cleanup.push(() => rm(folder, { recursive: true, force: true }));
	return folder;
}

describe("manual anonymous acceptance durable no-replay boundary", () => {
	it("permits a single actual HTTP allocation across independent SQLite connections and reopen", async () => {
		let effects = 0;
		const server = createServer((_request, response) => {
			effects++;
			response.writeHead(201, { "content-type": "application/json" });
			response.end('{"providerId":"local-allocation"}');
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		cleanup.push(
			() =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
		);
		const address = server.address();
		if (!address || !(address instanceof Object))
			throw new Error("local HTTP fixture did not bind");
		const dir = await stateDir();
		const a = await openAnonymousAcceptanceRun({
			stateDir: dir,
			provider: "neon",
		});
		const b = await openAnonymousAcceptanceRun({
			stateDir: dir,
			provider: "neon",
		});
		const work = async () => {
			const response = await fetch(`http://127.0.0.1:${address.port}`);
			const body = await response.text();
			await a.writePrivate("native-test-response.json", {
				status: response.status,
				body,
			});
			return { status: response.status };
		};
		try {
			const results = await Promise.all([a.once(work), b.once(work)]);
			expect(results.map((row) => row.status).sort()).toEqual([
				"completed",
				"not-replayed",
			]);
			expect(effects).toBe(1);
		} finally {
			a.close();
			b.close();
		}
		const reopened = await openAnonymousAcceptanceRun({
			stateDir: dir,
			provider: "neon",
		});
		try {
			expect((await reopened.once(work)).status).toBe("not-replayed");
			expect(effects).toBe(1);
		} finally {
			reopened.close();
		}
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect(
			(await stat(path.join(dir, "neon", "native-test-response.json"))).mode &
				0o777,
		).toBe(0o600);
	});
	it("keeps a lost provider acknowledgement uncertain without logging its secret or replaying create", async () => {
		const dir = await stateDir();
		const first = await openAnonymousAcceptanceRun({
			stateDir: dir,
			provider: "upstash",
		});
		let effects = 0;
		let publicResult;
		try {
			publicResult = await first.once(async () => {
				effects++;
				await first.writePrivate("native-test-response.json", {
					token: "FAKE-private-provider-credential",
				});
				throw new Error("FAKE-private-provider-credential response lost");
			});
		} finally {
			first.close();
		}
		expect(publicResult).toEqual({ status: "uncertain" });
		expect(JSON.stringify(publicResult)).not.toContain("FAKE-private");
		expect(
			await readFile(path.join(dir, "upstash", "failure.json"), "utf8"),
		).toContain("FAKE-private-provider-credential");
		const reopened = await openAnonymousAcceptanceRun({
			stateDir: dir,
			provider: "upstash",
		});
		try {
			expect(
				(
					await reopened.once(async () => {
						effects++;
					})
				).status,
			).toBe("not-replayed");
			expect(effects).toBe(1);
		} finally {
			reopened.close();
		}
	});
	it("rejects provider-directory symlinks before any provider work or secret write", async () => {
		const dir = await stateDir();
		const destination = await stateDir();
		const initial = await openAnonymousAcceptanceRun({
			stateDir: dir,
			provider: "upstash",
		});
		initial.close();
		await symlink(destination, path.join(dir, "neon"));
		await expect(
			openAnonymousAcceptanceRun({ stateDir: dir, provider: "neon" }),
		).rejects.toThrow("symlink");
	});
	it("refuses to repurpose an unrelated nonempty directory as private state", async () => {
		const dir = await stateDir();
		await symlink(await stateDir(), path.join(dir, "unrelated"));
		await expect(
			openAnonymousAcceptanceRun({ stateDir: dir, provider: "neon" }),
		).rejects.toThrow("dedicated directory");
	});
});
