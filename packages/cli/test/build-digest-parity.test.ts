import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { componentizeHelloBindle } from "@hobo/componentize";
import { describe, expect, it } from "vitest";
import { runCodegen } from "../src/codegen/run-codegen.js";
import {
	createBuildCommand,
	createHoboCli,
	runBuild,
	writeBuildFixtureProject,
} from "../src/index.js";

// SAFETY: `const GOLDEN_DIGEST = JSON.parse(` is required at this I/O or test boundary.
const GOLDEN_DIGEST = JSON.parse(
	readFileSync(
		new URL("./fixtures/hello-bindle.digest.json", import.meta.url),
		"utf8",
	),
) as {
	digest: string;
	sourceDateEpoch: string;
};

const HELLO_BINDLE_FIXTURE = fileURLToPath(
	new URL("../../componentize/test/fixtures/hello-bindle", import.meta.url),
);

describe("build digest parity", () => {
	it("matches @hobo/componentize direct path and golden S0-07 fixture", async () => {
		const direct = await componentizeHelloBindle({
			sourceRoot: HELLO_BINDLE_FIXTURE,
			sourceDateEpoch: GOLDEN_DIGEST.sourceDateEpoch,
		});

		expect(direct.component.digest).toBe(GOLDEN_DIGEST.digest);

		await withHelloBindleProject(async (projectRoot) => {
			const buildResult = await runBuild({
				requireRealComponentize: false,
				json: true,
				projectRoot,
				targetRuntime: "auto",
				sourceDateEpoch: GOLDEN_DIGEST.sourceDateEpoch,
			});

			const helloArtifact = buildResult.artifacts.find(
				(artifact) => artifact.service === "hello-bindle",
			);
			expect(helloArtifact?.digest).toBe(direct.component.digest);
			expect(helloArtifact?.digest).toBe(GOLDEN_DIGEST.digest);
		});
	});

	it("matches golden fixture through CLI envelope", async () => {
		const previous = process.env.SOURCE_DATE_EPOCH;
		process.env.SOURCE_DATE_EPOCH = GOLDEN_DIGEST.sourceDateEpoch;
		try {
			await withHelloBindleProject(async (projectRoot) => {
				const cli = await createHoboCli({
					commands: {
						build: createBuildCommand({ requireRealComponentize: false }),
					},
				}).run(["build", "--json"], {
					cwd: projectRoot,
				});
				const envelope = JSON.parse(cli.stdout);
				const helloArtifact = envelope.data.artifacts.find(
					(artifact: { service: string }) =>
						artifact.service === "hello-bindle",
				);
				expect(helloArtifact?.digest).toBe(GOLDEN_DIGEST.digest);
			});
		} finally {
			if (previous === undefined) {
				delete process.env.SOURCE_DATE_EPOCH;
			} else {
				process.env.SOURCE_DATE_EPOCH = previous;
			}
		}
	});
});

async function withHelloBindleProject(
	callback: (projectRoot: string) => Promise<void>,
) {
	const projectRoot = await mkdtemp(join(tmpdir(), "hobo-build-parity-"));
	try {
		await writeBuildFixtureProject(projectRoot, {
			services: [
				{
					name: "hello-bindle",
					language: "ts",
					runtime: "wasm",
					sourceRoot: "services/hello-bindle",
					entrypoint: "services/hello-bindle/src/service.ts",
				},
			],
		});
		await seedGeneratedTree(projectRoot);
		await copyHelloBindleSources(projectRoot);
		await callback(projectRoot);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
}

async function copyHelloBindleSources(projectRoot: string) {
	const target = join(projectRoot, "services/hello-bindle/src/service.ts");
	const source = join(HELLO_BINDLE_FIXTURE, "src/service.ts");
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, await readFile(source, "utf8"));
}

async function seedGeneratedTree(projectRoot: string) {
	await runCodegen({ projectRoot, check: false });
}
