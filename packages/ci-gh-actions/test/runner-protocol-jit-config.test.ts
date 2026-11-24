import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { FakeGithubRunnerService } from "../src/runner-protocol/fake-service.js";
import {
	isGithubServiceUrl,
	JitConfigRejection,
	parseJitConfig,
} from "../src/runner-protocol/jit-config.js";

const fake = new FakeGithubRunnerService();
const encoded = fake.jitConfig("hobo-relay-1");

type Files = Map<string, string>;

function decode(config: string): Files {
	const outer = JSON.parse(Buffer.from(config, "base64").toString("utf8"));
	return new Map(
		Object.entries(outer).map(([name, value]) => [
			name,
			Buffer.from(String(value), "base64").toString("utf8"),
		]),
	);
}

function encode(files: Files): string {
	return Buffer.from(
		JSON.stringify(
			Object.fromEntries(
				[...files].map(([name, text]) => [
					name,
					Buffer.from(text).toString("base64"),
				]),
			),
		),
	).toString("base64");
}

function edit(
	file: string,
	change: (text: string) => string,
	config = encoded,
): string {
	const files = decode(config);
	files.set(file, change(files.get(file) ?? ""));
	return encode(files);
}

function refusal(config: string, runnerName = "hobo-relay-1"): string {
	try {
		parseJitConfig(config, { runnerName });
	} catch (error) {
		expect(error).toBeInstanceOf(JitConfigRejection);
		return error instanceof Error ? error.message : "";
	}
	throw new Error("the configuration was accepted");
}

describe("parseJitConfig", () => {
	it("reads a one-job runner configuration as generate-jitconfig returns it", () => {
		const config = parseJitConfig(encoded, { runnerName: "hobo-relay-1" });
		expect(config.runner).toMatchObject({
			agentName: "hobo-relay-1",
			poolId: 1,
			useV2Flow: true,
			serverUrlV2: "https://broker.actions.githubusercontent.com/",
			workFolder: "_work",
		});
		expect(config.runner.agentId).toBeGreaterThan(0);
		expect(config.credentials.scheme).toBe("OAuth");
		expect(config.credentials.authorizationUrl).toMatch(
			/^https:\/\/vstoken\.actions\.githubusercontent\.com\//u,
		);
		expect(Object.isFrozen(config)).toBe(true);
	});

	it.each([
		"AgentId",
		"PoolId",
	] as const)("accepts only safely representable %s values", (field) => {
		const withId = (id: string | number) =>
			edit(".runner", (text) => {
				const runner: { AgentId: string | number; PoolId: string | number } =
					JSON.parse(text);
				runner[field] = id;
				return JSON.stringify(runner);
			});
		const name = field === "AgentId" ? "agentId" : "poolId";
		expect(
			parseJitConfig(withId("9007199254740991"), {
				runnerName: "hobo-relay-1",
			}).runner[name],
		).toBe(Number.MAX_SAFE_INTEGER);
		for (const id of [
			"9007199254740992",
			"9007199254740993",
			9007199254740992,
		]) {
			expect(refusal(withId(id))).toContain(".runner has the wrong shape");
		}
	});

	it("refuses a runner other than the one expected", () => {
		expect(refusal(encoded, "hobo-relay-2")).toContain(
			'is for runner "hobo-relay-1", not "hobo-relay-2"',
		);
	});

	it("refuses text that is not a configuration", () => {
		expect(refusal("not base64!")).toContain("not base64");
		expect(refusal(Buffer.from("[1,2]").toString("base64"))).toContain(
			"wrong shape",
		);
		expect(refusal(Buffer.from("{").toString("base64"))).toContain("not JSON");
	});

	it("refuses a configuration missing a file", () => {
		const files = decode(encoded);
		files.delete(".credentials_rsaparams");
		expect(refusal(encode(files))).toContain("no .credentials_rsaparams file");
	});

	it("refuses keys that differ only by case, at any depth", () => {
		const outer = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
		outer[".Runner"] = outer[".runner"];
		expect(
			refusal(Buffer.from(JSON.stringify(outer)).toString("base64")),
		).toContain("differ only by case");
		expect(
			refusal(
				edit(".runner", (text) =>
					text.replace('"AgentName"', '"agentname":"other","AgentName"'),
				),
			),
		).toContain("differ only by case");
		expect(
			refusal(
				edit(".credentials", (text) =>
					text.replace(
						'"ClientId"',
						'"clientID":"00000000-0000-0000-0000-000000000009","ClientId"',
					),
				),
			),
		).toContain("differ only by case");
	});

	it("refuses a URL that is not https on a GitHub host", () => {
		expect(
			refusal(
				edit(".runner", (text) =>
					text.replace(
						"https://broker.actions.githubusercontent.com/",
						"http://broker.actions.githubusercontent.com/",
					),
				),
			),
		).toContain("ServerUrlV2 is not an https URL on a GitHub host");
		expect(
			refusal(
				edit(".credentials", (text) =>
					text.replace(
						"https://vstoken.actions.githubusercontent.com",
						"https://vstoken.actions.githubusercontent.com.evil.example",
					),
				),
			),
		).toContain("authorizationUrl is not an https URL on a GitHub host");
		expect(
			refusal(
				edit(".runner", (text) =>
					text.replace(
						'"GitHubUrl":""',
						'"GitHubUrl":"https://example.com/octo/app"',
					),
				),
			),
		).toContain("GitHubUrl");
		expect(
			refusal(
				edit(".runner", (text) =>
					text
						.replace(/"ServerUrl":"[^"]*"/u, '"ServerUrl":""')
						.replace(/"ServerUrlV2":"[^"]*"/u, '"ServerUrlV2":""'),
				),
			),
		).toContain("names no runner service URL");
	});

	it("refuses credentials that are not a usable OAuth key", () => {
		expect(
			refusal(
				edit(".credentials", (text) => text.replace('"OAuth"', '"Basic"')),
			),
		).toContain(".credentials has the wrong shape");
		expect(
			refusal(
				edit(".credentials_rsaparams", (text) =>
					text.replace(
						/"modulus":"[^"]*"/u,
						`"modulus":"${
							decode(new FakeGithubRunnerService().jitConfig("x"))
								.get(".credentials_rsaparams")
								?.match(/"modulus":"([^"]*)"/u)?.[1]
						}"`,
					),
				),
			),
		).toContain("not a usable RSA private key");
	});

	it("never puts a key in a refusal", () => {
		const files = decode(encoded);
		const key = files.get(".credentials_rsaparams") ?? "";
		const message = refusal(encoded, "someone-else");
		expect(message).not.toContain(key.slice(10, 40));
	});

	it("does not disclose untrusted property names in a refusal", () => {
		const marker = "fixturesecretmarker";
		const collision = edit(".credentials", (text) => {
			const credentials = JSON.parse(text);
			credentials.Data[marker] = "unused";
			credentials.Data[marker.toUpperCase()] = "unused";
			return JSON.stringify(credentials);
		});
		expect(refusal(collision)).not.toContain(marker);

		const outer = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
		outer[marker] = 123;
		expect(
			refusal(Buffer.from(JSON.stringify(outer)).toString("base64")),
		).not.toContain(marker);
	});
});

describe("isGithubServiceUrl", () => {
	it.each([
		["https://github.com/octo/app", true],
		["https://api.github.com/repos", true],
		["https://broker.actions.githubusercontent.com/", true],
		[
			"https://run-actions-3-azure-eastus.actions.githubusercontent.com/42/",
			true,
		],
		["https://tenant.ghe.com/", true],
		["http://github.com/", false],
		["https://github.com.example/", false],
		["https://actions.githubusercontent.com/", false],
		["https://evilgithub.com/", false],
		["https://user:pass@github.com/", false],
		["https://github.com:8443/", false],
		["not a url", false],
	])("%s is %s", (url, expected) => {
		expect(isGithubServiceUrl(url)).toBe(expected);
	});
});
