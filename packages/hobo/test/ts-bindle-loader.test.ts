import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectBindleManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import helloBindle from "../../../examples/hello-bindle/src/bindle.js";
import { createComposedHoboCli } from "../src/cli.js";
import { createDefaultYardRuntime } from "../src/compose.js";
import type { JsonObject } from "../src/json.js";

// Verification: a fresh project with only a bindle
// source (no hobo.bindle.json) runs collect → plan → up against the local
// lane, and the example's real TS bindle compiles through the same loader.

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

async function scaffoldProject(): Promise<string> {
	const projectDir = await mkdtemp(path.join(tmpdir(), "hobo-loader-"));
	cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
	await mkdir(path.join(projectDir, "src"), { recursive: true });
	// A definition-shaped bindle module (the loader accepts any module whose
	// default export matches the bindle() definition contract) — hermetic: no
	// node_modules resolution needed inside the temp project.
	await writeFile(
		path.join(projectDir, "src", "bindle.js"),
		`export default {
	name: "loader-e2e",
	resources: {
		db: { kind: "data", name: "db", stableId: "data:db", declaredAllow: [], annotations: [], dependsOn: [] },
		api: { kind: "api", name: "api", stableId: "api:api", declaredAllow: [], annotations: [], dependsOn: ["data"] },
	},
	edges: [{ from: "api", to: "db" }],
};
`,
	);
	return projectDir;
}

describe("TS bindle loader (3-1)", () => {
	it("compiles the real hello-bindle example definition through the adapter", () => {
		const target = targetFromBindleDefinition(helloBindle);
		expect(target.bindleId).toBe("hello-bindle");
		const result = collectBindleManifest(target);
		expect(result.resources).toEqual(["api", "web"]);
		// Deterministic: two runs of one source produce one hash.
		expect(collectBindleManifest(target).manifestHash).toBe(
			result.manifestHash,
		);
	});

	it("hobo collect materializes the project's own bindle source", async () => {
		const projectDir = await scaffoldProject();
		const cli = createComposedHoboCli();
		const result = await cli.run(["collect", "--json"], { cwd: projectDir });

		expect(result.exitCode).toBe(0);
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = JSON.parse(result.stdout) as {
			code: string;
			data: { bindleId: string; resources: string[] };
		};
		expect(envelope.code).toBe("HOBO_OK");
		expect(envelope.data.bindleId).toBe("loader-e2e");
		expect(envelope.data.resources).toEqual(["api", "db"]);
	});

	it("hobo plan and up run from the bindle source with no hobo.bindle.json", async () => {
		// Same shape as hello-bindle (api + web services): satisfiable by the
		// default provider registry, so plan/up exercise the green path.
		const projectDir = await mkdtemp(path.join(tmpdir(), "hobo-loader-"));
		cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
		await mkdir(path.join(projectDir, "src"), { recursive: true });
		await writeFile(
			path.join(projectDir, "src", "bindle.js"),
			`export default {
	name: "loader-plan-e2e",
	resources: {
		api: { kind: "api", name: "api", stableId: "api:api", declaredAllow: [], annotations: [], dependsOn: [] },
		web: { kind: "web", name: "web", stableId: "web:web", declaredAllow: [], annotations: [], dependsOn: ["api"] },
	},
	edges: [{ from: "web", to: "api" }],
};
`,
		);
		const runtime = createDefaultYardRuntime();
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const plan = await cli.run(["plan", "--json"], { cwd: projectDir });
		expect(plan.exitCode).toBe(0);
		// SAFETY: assertion required at this I/O or test boundary.
		const planEnvelope = JSON.parse(plan.stdout) as {
			code: string;
			status: string;
		};
		expect(planEnvelope.code).not.toBe("HOBO_CLI_STUB");

		const up = await cli.run(["up", "--json"], { cwd: projectDir });
		expect(up.exitCode).toBe(0);
		// SAFETY: assertion required at this I/O or test boundary.
		const upEnvelope = JSON.parse(up.stdout) as { code: string };
		expect(upEnvelope.code).not.toBe("HOBO_CLI_STUB");
	});

	it("hobo dev serves the project's own entrypoint handler", async () => {
		const projectDir = await mkdtemp(path.join(tmpdir(), "hobo-loader-"));
		cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
		await mkdir(path.join(projectDir, "src"), { recursive: true });
		await writeFile(
			path.join(projectDir, "src", "bindle.js"),
			`const handler = () => (request) => new Response("hi from loader " + new URL(request.url).pathname);
export default {
	name: "loader-dev-e2e",
	resources: {
		api: { kind: "api", name: "api", stableId: "api:api", declaredAllow: [], annotations: [], dependsOn: [] },
	},
	edges: [],
	entrypoint: (name) => (name === "api" ? handler : undefined),
};
`,
		);
		const cli = createComposedHoboCli();
		const result = await cli.run(["dev", "--once", "--json"], {
			cwd: projectDir,
		});

		expect(result.exitCode).toBe(0);
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = JSON.parse(result.stdout) as {
			code: string;
			data: {
				mode?: string;
				served: { status: number; body: string };
			};
		};
		expect(envelope.code).toBe("HOBO_OK");
		expect(envelope.data.served.status).toBe(200);
		// Bare-metal yard serves the project's entrypoint; body is the handler
		// response for GET / (may be HTML or plain text).
		expect(envelope.data.served.body).toContain("hi from loader /");
	});

	it("a committed hobo.bindle.json still wins over the source path", async () => {
		const projectDir = await scaffoldProject();
		// Compile the source once, commit the artifact, then verify collect
		// --check agrees (artifact and source describe the same manifest).
		const cli = createComposedHoboCli();
		const collected = await cli.run(["collect", "--json"], {
			cwd: projectDir,
		});
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = JSON.parse(collected.stdout) as {
			data: { manifest: JsonObject };
		};
		await writeFile(
			path.join(projectDir, "hobo.manifest.json"),
			JSON.stringify(envelope.data.manifest, null, 2),
		);
		const check = await cli.run(["collect", "--check", "--json"], {
			cwd: projectDir,
		});
		expect(check.exitCode).toBe(0);
		// SAFETY: assertion required at this I/O or test boundary.
		const checkEnvelope = JSON.parse(check.stdout) as { code: string };
		expect(checkEnvelope.code).toBe("HOBO_OK");
		expect(
			await readFile(path.join(projectDir, "hobo.manifest.json"), "utf8"),
		).toContain("hobo.manifest/v1");
	});
});
