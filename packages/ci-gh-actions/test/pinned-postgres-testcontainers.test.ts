import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	parsePinnedImage,
	pinnedContainerImages,
} from "../contracts/pinned-container-images.js";

function dockerAvailable(): boolean {
	if (process.env.HOBO_FUZZ_DOCKER === "0") return false;
	if (!existsSync("/var/run/docker.sock")) return false;
	return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

const docker = dockerAvailable();

describe.runIf(docker)("pinned Postgres via Testcontainers", () => {
	let container: StartedTestContainer;
	let connectionString = "";

	beforeAll(async () => {
		const { repository, digest } = parsePinnedImage(
			pinnedContainerImages.postgres17Alpine,
		);
		container = await new GenericContainer(repository)
			.withDigest(digest)
			.withEnvironment({
				POSTGRES_DB: "pact",
				POSTGRES_USER: "pact",
				POSTGRES_PASSWORD: "local-contract-tests-only",
			})
			.withWaitStrategy(
				Wait.forLogMessage(/database system is ready to accept connections/),
			)
			.withExposedPorts(5432)
			.start();
		const host = container.getHost();
		const port = container.getMappedPort(5432);
		connectionString = `postgresql://pact:local-contract-tests-only@${host}:${port}/pact`;
	}, 120_000);

	afterAll(async () => {
		await container?.stop();
	});

	it("accepts connections with the same credentials as compose.pact.yml", async () => {
		const client = new Client({ connectionString });
		await client.connect();
		try {
			const result = await client.query("SELECT 1 AS ok");
			expect(result.rows[0]?.ok).toBe(1);
		} finally {
			await client.end();
		}
	});
});

it("compose.pact.yml uses the pinned-container-images catalog", async () => {
	const composePath = fileURLToPath(
		new URL("../contracts/compose.pact.yml", import.meta.url),
	);
	const text = await readFile(composePath, "utf8");
	for (const ref of Object.values(pinnedContainerImages)) {
		expect(text).toContain(ref);
	}
});
