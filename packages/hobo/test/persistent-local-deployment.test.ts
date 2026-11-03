import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { collectStream } from "@hobo/cloud";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import {
	readLocalDeployment,
	startLocalDeployment,
} from "../src/local-deployment.js";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin/hobo.js", import.meta.url));
const bindles = fileURLToPath(
	new URL("../../bindles/dist/index.js", import.meta.url),
);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function assertLoopbackOrigin(origin: string): void {
	const host = new URL(origin).hostname.toLowerCase();
	expect(LOOPBACK_HOSTS.has(host)).toBe(true);
}

async function setup(
	run: (
		project: string,
		env: NodeJS.ProcessEnv,
		command: (args: string[]) => Promise<ReturnType<typeof JSON.parse>>,
	) => Promise<void>,
) {
	const project = await mkdtemp(join(tmpdir(), "hobo-real-local-"));
	const hoboHome = join(project, "home");
	await mkdir(join(project, "src"));
	await writeFile(
		join(project, "package.json"),
		JSON.stringify({ type: "module" }),
	);
	await writeFile(
		join(project, "src/bindle.mjs"),
		`import { bindle } from ${JSON.stringify(bindles)};
export default bindle("real-app", b => {
const handler = request => new Response(JSON.stringify({served: true, path: new URL(request.url).pathname}));
return {web: b.web(() => handler)};
});
`,
	);
	initBareMetalYard({ hoboHome, componentHost: "local" });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOBO_HOME: hoboHome,
		HOBO_PORTLESS: "0",
	};
	for (const key of [
		"HOBO_BROKER",
		"HOBO_BROKER_URI",
		"CLOUDFLARE_API_TOKEN",
		"CLOUDFLARE_ACCOUNT_ID",
		"VERCEL_TOKEN",
		"HOBO_PULUMI_LIVE",
	])
		delete env[key];
	const command = async (args: string[]) => {
		const result = await exec(
			process.execPath,
			[
				bin,
				...args,
				...(args[0] === "up" ? ["--home", hoboHome] : []),
				"--json",
			],
			{ cwd: project, env, timeout: 300_000, maxBuffer: 1024 * 1024 },
		);
		return JSON.parse(result.stdout);
	};
	try {
		await run(project, env, command);
	} finally {
		await command(["down"]).catch(() => undefined);
		await rm(project, { recursive: true, force: true });
	}
}

describe("product self-hosted deployment process lifecycle", () => {
	it("refuses an application returning 503 and tears down its worker", async () => {
		await setup(async (project, _env, command) => {
			const probedUrlFile = join(project, "probe-url.txt");
			await writeFile(
				join(project, "src/bindle.mjs"),
				`import { bindle } from ${JSON.stringify(bindles)};
import { writeFileSync } from "node:fs";
export default bindle("real-app", b => ({web: b.web(() => request => {
writeFileSync(${JSON.stringify(probedUrlFile)}, "http://127.0.0.1:" + new URL(request.url).port);
return new Response("application unavailable", {status: 503});
})}));`,
			);
			await expect(command(["up"])).rejects.toMatchObject({
				stdout: expect.stringContaining(
					"failed its readiness probe (HTTP 503)",
				),
			});
			const url = await readFile(probedUrlFile, "utf8");
			assertLoopbackOrigin(url.trim());
			await expect(
				fetch(url.trim(), { signal: AbortSignal.timeout(1000) }),
			).rejects.toThrow();
			expect(await readLocalDeployment(project)).toBeUndefined();
			await expect(
				readFile(join(project, ".hobo/local-deployment.token")),
			).rejects.toMatchObject({ code: "ENOENT" });
		});
	}, 300_000);

	it("deploys edited application code in a new worker and reuses only unchanged inputs", async () => {
		await setup(async (project, _env, command) => {
			const first = await command(["up"]);
			const source = join(project, "src/bindle.mjs");
			expect(await (await fetch(first.data.primaryUrl)).json()).toMatchObject({
				served: true,
			});
			await writeFile(
				source,
				(await readFile(source, "utf8")).replace(
					"served: true",
					'served: "v2"',
				),
			);
			const updated = await command(["up"]);
			expect(updated.data.reused).toBe(false);
			expect(updated.data.deploymentId).not.toBe(first.data.deploymentId);
			expect(await (await fetch(updated.data.primaryUrl)).json()).toMatchObject(
				{
					served: "v2",
				},
			);
			await expect(
				fetch(first.data.primaryUrl, { signal: AbortSignal.timeout(1000) }),
			).rejects.toThrow();
			await writeFile(
				join(project, "editor.tmp"),
				"unrelated temporary output",
			);
			const unchanged = await command(["up"]);
			expect(unchanged.data).toMatchObject({
				deploymentId: updated.data.deploymentId,
				pid: updated.data.pid,
				reused: true,
			});
			expect(await command(["down"])).toMatchObject({
				ok: true,
				status: "destroyed",
			});
			await expect(
				fetch(updated.data.primaryUrl, { signal: AbortSignal.timeout(1000) }),
			).rejects.toThrow();
		});
	}, 300_000);

	it("serves after up exits, reuses the same worker, rejects unauthenticated control, and down stops the server", async () => {
		await setup(async (project, _env, command) => {
			const up = await command(["up"]);
			expect(up).toMatchObject({
				ok: true,
				status: "deployed",
				data: { persistent: true, reused: false },
			});
			const url = up.data.primaryUrl;
			expect(await (await fetch(url)).json()).toMatchObject({ served: true });
			const again = await command(["up"]);
			expect(again.data).toMatchObject({
				primaryUrl: url,
				deploymentId: up.data.deploymentId,
				pid: up.data.pid,
				reused: true,
			});
			const privateToken = await readFile(
				join(project, ".hobo/local-deployment.token"),
				"utf8",
			);
			if (process.platform !== "win32")
				expect(
					(await stat(join(project, ".hobo/local-deployment.token"))).mode &
						0o777,
				).toBe(0o600);
			const receipt = JSON.parse(
				await readFile(join(project, ".hobo/local-deployment.json"), "utf8"),
			);
			const active = await readLocalDeployment(project);
			if (!active) throw new Error("Expected the running deployment receipt");
			for (const binding of [
				"componentHost",
				"campId",
				"providerId",
				"brokerId",
				"bindleName",
			] as const) {
				await expect(
					startLocalDeployment({
						projectDir: project,
						hoboHome: active.hoboHome,
						componentHost: active.componentHost,
						campId: active.campId,
						providerId: active.providerId,
						brokerId: active.brokerId,
						bindleName: active.bindleName,
						port: active.port,
						ttlSeconds: 0,
						[binding]: `different-${active[binding]}`,
					}),
				).rejects.toThrow(`different placement bindings (${binding})`);
			}
			expect(
				(await fetch(`${receipt.controlUrl}/shutdown`, { method: "POST" }))
					.status,
			).toBe(401);
			expect((await fetch(url)).status).toBe(200);
			expect(await command(["down"])).toMatchObject({
				ok: true,
				status: "destroyed",
			});
			await expect(
				fetch(url, { signal: AbortSignal.timeout(1000) }),
			).rejects.toThrow();
			const store = createRuntimeLocalEventStore({
				dataDir: join(project, ".hobo/local-deployment-events"),
			});
			try {
				const events = await collectStream(
					store,
					`local:${createHash("sha256").update(project).digest("hex")}`,
				);
				expect(events.map((event) => event.type)).toEqual([
					"deployment.LocalStarted",
					"deployment.LocalStopped",
				]);
				expect(events[0]?.data).toMatchObject({
					reason: "up",
					receipt: { leaseId: up.data.deploymentId, primaryUrl: url },
				});
				expect(events[1]?.data).toMatchObject({
					reason: "down",
					receipt: { leaseId: up.data.deploymentId },
				});
				expect(JSON.stringify(events)).not.toContain(privateToken);
			} finally {
				store.close();
			}
		});
	}, 300_000);

	it.each([
		"--anonymous",
		"--temporary",
	])("expires a real self-hosted %s deployment without a hosted service", async (flag) => {
		await setup(async (project, env, command) => {
			env.HOBO_LOCAL_DEPLOYMENT_TTL_SECONDS = "3";
			const up = await command(["up", flag]);
			expect(up).toMatchObject({
				ok: true,
				data: { persistent: true, expiresAt: expect.any(String) },
			});
			expect((await fetch(up.data.primaryUrl)).status).toBe(200);
			const deadline = Date.now() + 15_000;
			let running = true;
			while (running && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				try {
					await fetch(up.data.primaryUrl, { signal: AbortSignal.timeout(500) });
				} catch {
					running = false;
				}
			}
			expect(running).toBe(false);
			while (Date.now() < deadline) {
				try {
					await readFile(join(project, ".hobo/local-deployment.json"));
				} catch {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			await expect(
				readFile(join(project, ".hobo/local-deployment.json")),
			).rejects.toMatchObject({ code: "ENOENT" });
		});
	}, 300_000);
});
