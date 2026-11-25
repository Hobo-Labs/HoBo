import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { createGithubConnectFlow } from "../src/github.js";
import { prepareGithubConnection } from "../src/prepare.js";

describe("GitHub organization app setup", () => {
	it.each([
		".",
		"..",
		"other/org",
		"-invalid",
		"invalid-",
		"double--dash",
		"a".repeat(40),
	])("refuses the invalid organization login %s before opening the store", async (login) => {
		let opened = false;
		const flow = createGithubConnectFlow({
			relayUrl: "https://ci.example.test",
			owner: { kind: "Organization", login, id: 123 },
			callbackUrl: () => "http://127.0.0.1:1/callback",
			openStore: async () => {
				opened = true;
				return {
					ok: true,
					store: {
						id: "infisical",
						port: createMemorySecretsPort({ id: "test" }),
						reference: (name) => `test://${name}`,
					},
				};
			},
		});
		const result = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(result.step.kind).toBe("failed");
		expect(result.directive).toBeUndefined();
		expect(opened).toBe(false);
	});

	it("refuses an invalid configured organization before accessing the store", async () => {
		let opened = false;
		const run: Pick<CommandRunInput, "emitProgress"> = {
			emitProgress: () => undefined,
		};
		const input: PrepareInput = {
			action: "up",
			projectDir: "/tmp/hobo-ci",
			whatIf: false,
			yes: false,
			run: run as CommandRunInput,
		};
		const result = await prepareGithubConnection(input, {
			env: {
				HOBO_CI_GITHUB_OWNER: "..",
				HOBO_CI_GITHUB_OWNER_TYPE: "Organization",
			},
			openStore: async () => {
				opened = true;
				throw new Error("unexpected store access");
			},
		});
		expect(result).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_GITHUB_OWNER_INVALID" },
		});
		expect(opened).toBe(false);
	});
});
