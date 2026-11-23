import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { GenericContainer, Wait } from "testcontainers";
import {
	createAgent37FakeServer,
	generateAgent37TestApiKey,
} from "./server.js";

const exposedPort = 4180;
const entrypoint = `const { createAgent37FakeServer } = await import("./server.mts");
const apiKey = process.env.AGENT37_FAKE_API_KEY;
if (!apiKey) throw new Error("AGENT37_FAKE_API_KEY is required");
const port = Number(process.env.AGENT37_FAKE_PORT ?? "4180");
await createAgent37FakeServer({ apiKey, host: "0.0.0.0", port });
console.log("agent37 fake listening");
`;

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

async function startContainer(apiKey: string): Promise<StartedFakeAgent37> {
	const sourceExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const serverSource = readFileSync(
		new URL(`./server.${sourceExtension}`, import.meta.url),
		"utf8",
	);
	const container = await new GenericContainer("node:24-alpine")
		.withEnvironment({
			AGENT37_FAKE_API_KEY: apiKey,
			AGENT37_FAKE_PORT: String(exposedPort),
		})
		.withCopyContentToContainer([
			{ content: serverSource, target: "/opt/agent37-fake/server.mts" },
			{ content: entrypoint, target: "/opt/agent37-fake/entry.mjs" },
		])
		.withCommand(["node", "/opt/agent37-fake/entry.mjs"])
		.withExposedPorts(exposedPort)
		.withWaitStrategy(Wait.forLogMessage("agent37 fake listening", 1))
		.start();
	return {
		mode: "container",
		baseUrl: `http://${container.getHost()}:${container.getMappedPort(exposedPort)}`,
		apiKey,
		async close() {
			await container.stop();
		},
	};
}

export async function startFakeAgent37Server(
	options: FakeAgent37StartOptions = {},
): Promise<StartedFakeAgent37> {
	const apiKey = options.apiKey ?? generateAgent37TestApiKey();
	if (dockerAvailable()) return startContainer(apiKey);
	if (options.requireContainer === true) {
		throw new Error(
			"startFakeAgent37Server: this docker-required test needs a Docker engine",
		);
	}
	if (options.allowInProcessFallback !== true) {
		throw new Error(
			"startFakeAgent37Server: Docker is unavailable; set allowInProcessFallback: true explicitly",
		);
	}
	const fake = await createAgent37FakeServer({ apiKey });
	return {
		mode: "in-process",
		baseUrl: fake.baseUrl,
		apiKey,
		close: fake.close,
	};
}
