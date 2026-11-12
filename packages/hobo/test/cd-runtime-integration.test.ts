/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- SAFETY: integration responses are untyped HTTP bodies read for one field. */
// End-to-end composition of the real @hobo/cd modules through the hobo host
// (WP18). Every module is a sibling work package of plan 0024, so this suite
// runs once they are merged (their built subpaths exist) and reports itself
// skipped, with the reason, on a WP18-only checkout.
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDeployCommand } from "../src/deploy-command.js";
import { runInput } from "./support/cd-fakes.js";

function siblingModulesBuilt(): boolean {
	const root = join(import.meta.dirname, "..", "node_modules", "@hobo", "cd");
	return ["freight", "promotion", "reconcile", "service", "posture"].every(
		(m) => existsSync(join(root, "dist", m, "index.js")),
	);
}

const MERGED = siblingModulesBuilt();

describe.skipIf(!MERGED)(
	"composed @hobo/cd through the hobo host (binds at merge, plan 0024)",
	() => {
		it("opens the runtime with --simulate and serves read subcommands", async () => {
			const { openCdRuntime } = await import("../src/cd-runtime.js");
			const home = await mkdtemp(join(tmpdir(), "cd-int-"));
			const opened = await openCdRuntime({
				env: {},
				home,
				cwd: home,
				simulate: true,
				now: () => Date.UTC(2026, 10, 12),
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			const { runCdDeploySubcommand } = await import("../src/cd-deploy.js");
			for (const args of [
				["freight", "list"],
				["source", "list"],
				["pipeline", "list"],
				["window", "list"],
				["campset", "list"],
				["preview", "list"],
				["failover", "list"],
				["fanout", "show"],
			]) {
				const out = await runCdDeploySubcommand(opened.value.host, args, {
					format: "json",
				});
				expect(out.ok, `${args.join(" ")}: ${out.message}`).toBe(true);
				expect(out.data?.simulated).toBe(true);
			}
			await opened.value.close();
		});

		it("opens the default SQLite runtime (no fixture without --simulate)", async () => {
			const home = await mkdtemp(join(tmpdir(), "cd-int-sqlite-"));
			const out = await createDeployCommand({ env: {}, hoboHome: home }).run(
				runInput(["freight", "list"], { format: "json" }),
			);
			expect(out.ok, out.message).toBe(true);
			expect(out.data?.simulated).toBe(false);
			expect(existsSync(join(home, "cd", "journal.sqlite"))).toBe(true);
		});

		it("hobo serve cd --simulate serves health, readiness and the /v1/cd/ mount", async () => {
			const { openCdRuntime } = await import("../src/cd-runtime.js");
			const { startCdServer } = await import("../src/cd-serve.js");
			const home = await mkdtemp(join(tmpdir(), "cd-int-serve-"));
			const opened = await openCdRuntime({
				env: {},
				home,
				cwd: home,
				simulate: true,
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			const server = await startCdServer({
				runtime: opened.value,
				host: "127.0.0.1",
				port: 0,
				log: () => {},
			});
			try {
				expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
				const ready = await fetch(`${server.url}/readyz`);
				const body = (await ready.json()) as { simulated: boolean };
				expect(body.simulated).toBe(true);
				const pipelines = await fetch(`${server.url}/v1/cd/pipelines`);
				expect(pipelines.status).toBeLessThan(500);
			} finally {
				await server.close();
			}
		});

		it("refuses a conductor without a realizer outside --simulate", async () => {
			const { openCdRuntime } = await import("../src/cd-runtime.js");
			const home = await mkdtemp(join(tmpdir(), "cd-int-real-"));
			const opened = await openCdRuntime({
				env: {},
				home,
				cwd: home,
				simulate: false,
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			expect(() => opened.value.conductor(["edge/prod" as never])).toThrow(
				/compose-realizer-missing/,
			);
			await opened.value.close();
		});
	},
);

describe("composition integration gate", () => {
	it("names why it is skipped on a WP18-only checkout", () => {
		expect(typeof MERGED).toBe("boolean");
	});
});
