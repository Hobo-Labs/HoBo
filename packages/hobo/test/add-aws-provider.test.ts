import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";

// HOBO-711: the AWS provider is `hobo add`-able through the M0 catalog, and
// once installed+approved the Planner matches ports the base (cloudflare)
// provider does not advertise — database resolves to @hobo/provider-aws.

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

const LEDGER_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		// This catalog test asks only for a database. Comparing compute offers
		// from both providers requires a separate normalized hosting quote.
		// `hobo:database` lowers to the bare `database` port — advertised by the
		// AWS equivalence table (RDS PostgreSQL), not by the cloudflare base set.
		ledger: { type: "data.v1", port: "hobo:database" },
	},
};

describe("hobo add aws (composed catalog entry)", () => {
	it("installs+approves aws, then plan matches database to @hobo/provider-aws", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const dir = await mkdtemp(path.join(tmpdir(), "hobo-aws-"));
		await writeFile(
			path.join(dir, "hobo.bindle.json"),
			`${JSON.stringify(LEDGER_BINDLE, null, 2)}\n`,
		);

		try {
			// Unsatisfiable before install: the base provider set has no database.
			const before = envelope(
				(await cli.run(["plan", "--json"], { cwd: dir })).stdout,
			);
			expect(before.ok).toBe(false);

			const add = envelope(
				(await cli.run(["add", "aws", "--json"], { cwd: dir })).stdout,
			);
			expect(add.ok).toBe(true);
			expect(add.status).toBe("installed");
			expect(add.data.approved).toBe(true);
			expect(add.data.ports).toContain("database");

			const plan = envelope(
				(await cli.run(["plan", "--json"], { cwd: dir })).stdout,
			);
			expect(plan.ok, JSON.stringify(plan)).toBe(true);
			const ledger = plan.data.resources.find(
				(r: { name: string }) => r.name === "ledger",
			);
			expect(ledger.provider).toBe("@hobo/provider-aws");

			// The registry read view agrees: installed + approved, six ports.
			const registry = envelope(
				(await cli.run(["registry", "--json"], { cwd: dir })).stdout,
			);
			const row = registry.data.providers.find(
				(p: { providerId: string }) => p.providerId === "@hobo/provider-aws",
			);
			expect(row.source).toBe("installed");
			expect(row.approved).toBe(true);
			expect(row.ports.length).toBe(6);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
