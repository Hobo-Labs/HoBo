import { defineCiPolicy, DesiredCiPolicySchema } from "@hobo/ci";
import { toJsonString } from "@bufbuild/protobuf";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCiServePlan } from "../src/ci-serve.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

const policyJson = (accountId: string) =>
	JSON.parse(
		toJsonString(
			DesiredCiPolicySchema,
			defineCiPolicy({
				accountId,
				tenantId: accountId,
				pool: { label: "hobo", os: "linux", architecture: "x64" },
				providers: [
					{
						id: "gh",
						kind: "github",
						connectionRef: "gh",
						runsOn: "ubuntu-24.04",
					},
				],
				budget: {
					scope: "ci-account",
					currency: "USD",
					period: "manual",
					timeZone: "UTC",
					limitMicros: 1,
				},
				routing: {
					strategy: "lowest-total-incremental-cost",
					noEligibleProvider: "queue",
					unknownAllocation: "zero",
				},
				thresholds: [],
			}),
		),
	);

const remoteProject = {
	defaultEnvironment: "production",
	environments: {
		production: {
			relayOrigin: "https://ci.example.com",
			jobAdmission: "push",
			engines: ["gh-actions"],
			policy: policyJson("prod"),
		},
	},
};

async function projectRoot() {
	const root = await mkdtemp(join(tmpdir(), "hobo-ci-serve-remote-"));
	directories.push(root);
	await mkdir(join(root, ".hobo"), { recursive: true });
	await writeFile(join(root, ".hobo", "ci.json"), JSON.stringify(remoteProject));
	return root;
}

const git = async () => "git@github.com:example/project.git";

describe("hobo ci serve remote mode", () => {
	it("allows non-loopback bind when public origin matches environment", async () => {
		const cwd = await projectRoot();
		const plan = await resolveCiServePlan({
			cwd,
			options: {
				environment: "production",
				host: "0.0.0.0",
				port: "9876",
				origin: "https://ci.example.com",
			},
			env: {},
			git,
		});
		expect(plan.host).toBe("0.0.0.0");
		expect(plan.port).toBe(9876);
		expect(plan.publicOrigin).toBe("https://ci.example.com");
		expect(plan.configRelayOrigin).toBe("https://ci.example.com");
	});

	it("rejects public origin mismatch with selected environment", async () => {
		const cwd = await projectRoot();
		await expect(
			resolveCiServePlan({
				cwd,
				options: {
					environment: "production",
					host: "0.0.0.0",
					origin: "https://other.example.com",
				},
				env: {},
				git,
			}),
		).rejects.toThrow(/does not match environment production relayOrigin/);
	});
});
