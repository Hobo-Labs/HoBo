import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin/hobo.js", import.meta.url));

// Each template has its own root and HOBO_HOME, and the deployment listens on a
// port the OS picks, so the four run side by side.
describe.concurrent("canonical starter through real self-hosted deployment", () => {
	it.for(["todo", "api", "agent", "fullstack"])(
		"new → codegen → build → packaged up → HTTP → down for %s",
		{ timeout: 300_000 },
		async (template, { expect }) => {
			const root = await mkdtemp(join(tmpdir(), "hobo-starter-deployment-"));
			const project = join(root, "app");
			const hoboHome = join(root, "home");
			initBareMetalYard({ hoboHome, componentHost: "local" });
			const env: NodeJS.ProcessEnv = { ...process.env, HOBO_HOME: hoboHome };
			for (const name of [
				"HOBO_BROKER",
				"HOBO_BROKER_URI",
				"CLOUDFLARE_API_TOKEN",
				"CLOUDFLARE_ACCOUNT_ID",
				"VERCEL_TOKEN",
				"HOBO_PULUMI_LIVE",
			])
				delete env[name];
			const command = async (args: string[], cwd = project) => {
				const result = await exec(
					process.execPath,
					[
						bin,
						...args,
						...(args[0] === "up" ? ["--home", hoboHome] : []),
						"--json",
					],
					{ cwd, env, timeout: 300_000, maxBuffer: 1024 * 1024 },
				);
				return JSON.parse(result.stdout);
			};
			try {
				expect(
					await command(["new", "app", "-t", template], root),
				).toMatchObject({ ok: true });
				expect(await command(["codegen"])).toMatchObject({ ok: true });
				expect(await command(["build"])).toMatchObject({ ok: true });
				// Keep app.ts as a real unavailable-source case: its seed import was removed.
				await rm(join(project, "src"), { recursive: true, force: true });
				const up = await command(["up"]);
				expect(up).toMatchObject({
					ok: true,
					status: "deployed",
					data: { persistent: true },
				});
				const response = await fetch(`${up.data.primaryUrl}/proof`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ real: true }),
				});
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					template,
					path: "/proof",
					record: {
						key: expect.any(String),
						value: { message: expect.any(String) },
					},
				});
				expect(await command(["down"])).toMatchObject({
					ok: true,
					status: "destroyed",
				});
				await expect(
					fetch(up.data.primaryUrl, { signal: AbortSignal.timeout(1000) }),
				).rejects.toThrow();
			} finally {
				await command(["down"]).catch(() => undefined);
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
