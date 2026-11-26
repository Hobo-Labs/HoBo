import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	generateLocalRunnerPact,
	verifyLocalRunnerPact,
} from "./local-runner-pact.js";

it("generates every local-runner interaction with Pact and verifies the shipped relay", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-local-pact-"));
	const http = process.env.HTTP_PROXY;
	const https = process.env.HTTPS_PROXY;
	// Pact JS's Node provider proxy ignores NO_PROXY. Only loopback is used here.
	delete process.env.HTTP_PROXY;
	delete process.env.HTTPS_PROXY;
	try {
		const file = await generateLocalRunnerPact(directory);
		await expect(
			verifyLocalRunnerPact({ pactUrls: [file] }),
		).resolves.toBeUndefined();
	} finally {
		if (http !== undefined) process.env.HTTP_PROXY = http;
		if (https !== undefined) process.env.HTTPS_PROXY = https;
		await rm(directory, { recursive: true, force: true });
	}
}, 120000);
