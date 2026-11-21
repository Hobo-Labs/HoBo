import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { GenericContainer, Wait } from "testcontainers";
import { createAgent37FakeServer } from "./server.mts";

const FAKE_CONTAINER_PORT = 4180;
const FAKE_IMAGE = "node:24-alpine";

export type FakeAgent37StartOptions = {
	readonly requireContainer?: boolean;
	readonly allowInProcessFallback?: boolean;
	readonly apiKey?: string;
};

export type StartedFakeAgent37 = {
	readonly mode: "container" | "in-process";
	readonly baseUrl: string;
	readonly apiKey: string;
	close(): Promise<void>;
};

export function dockerAvailable(): boolean {
	if (process.env.HOBO_FUZZ_DOCKER === "0") return false;
	if (!existsSync("/var/run/docker.sock")) return false;
	return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

async function startFakeInContainer(
	apiKey: string,
): Promise<StartedFakeAgent37> {
	const serverSource = readFileSync(
		new URL("./server.mts", import.meta.url),
		"utf8",
	);
	const entrySource = readFileSync(
		new URL("./container-entry.mts", import.meta.url),
		"utf8",
	);
	const container = await new GenericContainer(FAKE_IMAGE)
		.withEnvironment({
			AGENT37_FAKE_PORT: String(FAKE_CONTAINER_PORT),
			AGENT37_FAKE_API_KEY: apiKey,
		})
		.withCopyContentToContainer(serverSource, "/opt/agent37-fake/server.mts")
		.withCopyContentToContainer(
			entrySource,
			"/opt/agent37-fake/container-entry.mts",
		)
		.withCommand(["node", "/opt/agent37-fake/container-entry.mts"])
		.withExposedPorts(FAKE_CONTAINER_PORT)
		.withWaitStrategy(Wait.forLogMessage("agent37 fake listening", 1))
		.start();
	return {
		mode: "container",
		baseUrl: `http://${container.getHost()}:${container.getMappedPort(FAKE_CONTAINER_PORT)}`,
		apiKey,
		close: () => container.stop(),
	};
}

export async function startFakeAgent37Server(
	options: FakeAgent37StartOptions = {},
): Promise<StartedFakeAgent37> {
	const apiKey = options.apiKey ?? `sk_live_${randomUUID()}`;
	if (dockerAvailable()) return startFakeInContainer(apiKey);
	if (
		options.requireContainer === true ||
		options.allowInProcessFallback !== true
	)
		throw new Error(
			options.requireContainer === true
				? "startFakeAgent37Server: this docker-required test needs a Docker engine and none is available"
				: "startFakeAgent37Server: Docker is unavailable; set allowInProcessFallback: true to use the in-process fake explicitly",
		);
	const fake = await createAgent37FakeServer({ apiKey });
	return {
		mode: "in-process",
		baseUrl: fake.baseUrl,
		apiKey,
		close: () => fake.close(),
	};
}
