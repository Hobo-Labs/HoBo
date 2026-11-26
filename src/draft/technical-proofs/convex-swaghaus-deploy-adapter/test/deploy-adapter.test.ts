import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	convexImpedanceFindings,
	deployConvexApp,
	describeWorkOsAuthKit,
} from "@hobo/provider-convex";

import {
	ConvexDeployParseError,
	parseDeployReceipt,
	parseDeployRequest,
	parseImpedanceRecords,
	preflightSwaghausShip,
	shipSwaghausConvexApp,
} from "../src/index.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const liveEnv = {
	VITE_WORKOS_CLIENT_ID: "client_live",
	VITE_WORKOS_REDIRECT_URI: "https://swaghaus.example/callback",
	WORKOS_CLIENT_ID: "client_live",
};

describe("convex-swaghaus-deploy-adapter", () => {
	it("mock deploy + WorkOS gate", async () => {
		const result = await deployConvexApp({
			root: ".",
			mock: true,
			deploymentName: "proof",
		});
		expect(result.deploymentUrl).toBe("https://proof.convex.cloud");
		expect(describeWorkOsAuthKit({}).ready).toBe(false);
	});
});

describe("parse boundary", () => {
	it("parses the executor's mock receipt into a refined receipt", async () => {
		const response = await deployConvexApp({
			root: ".",
			mock: true,
			deploymentName: "proof",
		});
		const receipt = parseDeployReceipt(response);
		expect(receipt.mode).toBe("mock");
		expect(receipt.mocked).toBe(true);
		expect(receipt.deploymentUrl).toBe("https://proof.convex.cloud");
	});

	it("refuses a receipt whose mocked flag disagrees with its mode", () => {
		expect(() =>
			parseDeployReceipt({
				ok: true,
				deploymentUrl: "https://proof.convex.cloud",
				deploymentName: "proof",
				mocked: true,
				mode: "cloud",
			}),
		).toThrow(ConvexDeployParseError);
	});

	it("refuses a self-hosted receipt that claims a convex.cloud host", () => {
		expect(() =>
			parseDeployReceipt({
				ok: true,
				deploymentUrl: "https://proof.convex.cloud",
				deploymentName: "proof",
				mocked: false,
				mode: "self-hosted",
			}),
		).toThrow(/self-hosted deployments need an absolute non-convex\.cloud/u);
	});

	it("refuses a cloud URL that does not name the deployment", () => {
		expect(() =>
			parseDeployReceipt({
				ok: true,
				deploymentUrl: "https://someone-else.convex.cloud",
				deploymentName: "proof",
				mocked: false,
				mode: "cloud",
			}),
		).toThrow(/does not name deployment/u);
	});

	it("refuses a Convex app root that escapes the repo", () => {
		expect(() =>
			parseDeployRequest({
				root: "examples/../../etc",
				deploymentName: "proof",
				mock: true,
			}),
		).toThrow(/escapes the repo/u);
	});

	it("refuses an uncredentialed non-mock request", () => {
		expect(() =>
			parseDeployRequest({
				root: "examples/convex-swaghaus",
				deploymentName: "proof",
				mock: false,
			}),
		).toThrow(/fail closed/u);
	});

	it("parses real impedance findings and keeps block on the paradigm code", () => {
		const records = parseImpedanceRecords([
			...convexImpedanceFindings({
				paradigm: "relational",
				features: ["replay", "wit"],
			}),
		]);
		expect(records.filter((record) => record.severity === "block")).toEqual([
			expect.objectContaining({ code: "paradigm-mismatch" }),
		]);
	});

	it("refuses a finding that claims block without a paradigm mismatch", () => {
		expect(() =>
			parseImpedanceRecords([
				{ code: "occ-contention", severity: "block", message: "nope" },
			]),
		).toThrow(/disagrees with code/u);
	});
});

describe("preflight + ship lifecycle", () => {
	it("is not live without deploy credentials", () => {
		const preflight = preflightSwaghausShip({
			root: "examples/convex-swaghaus",
			env: liveEnv,
		});
		expect(preflight.live).toBe(false);
		expect(preflight.missing).toEqual(["CONVEX_DEPLOY_KEY"]);
	});

	it("is live with WorkOS env plus a deploy key", () => {
		const preflight = preflightSwaghausShip({
			root: "examples/convex-swaghaus",
			env: liveEnv,
			deployKey: "prod:swaghaus|deadbeef",
		});
		expect(preflight.live).toBe(true);
		expect(preflight.mode).toBe("cloud");
	});

	it("never claims live in the explicit mock lane", () => {
		const preflight = preflightSwaghausShip({
			root: "examples/convex-swaghaus",
			env: liveEnv,
			deployKey: "prod:swaghaus|deadbeef",
			mock: true,
		});
		expect(preflight.mode).toBe("mock");
		expect(preflight.live).toBe(false);
	});

	it("refuses a live ship before touching the executor", async () => {
		const outcome = await shipSwaghausConvexApp({
			root: "examples/convex-swaghaus",
			deploymentName: "proof",
			env: {},
			spawn: async () => {
				throw new Error("executor must not run without credentials");
			},
		});
		expect(outcome.phase).toBe("refused");
		if (outcome.phase !== "refused") return;
		expect(outcome.preflight.missing).toContain("VITE_WORKOS_CLIENT_ID");
		expect(outcome.preflight.missing).toContain("CONVEX_DEPLOY_KEY");
	});

	it("ships self-hosted through an injected spawn and parses the receipt", async () => {
		const outcome = await shipSwaghausConvexApp({
			root: "examples/convex-swaghaus",
			deploymentName: "proof",
			env: liveEnv,
			selfHostedUrl: "http://127.0.0.1:3210",
			selfHostedAdminKey: "demo|key",
			spawn: async (input) => {
				expect(input.env.CONVEX_SELF_HOSTED_URL).toBe("http://127.0.0.1:3210");
				return {
					exitCode: 0,
					stdout: "Deployed http://127.0.0.1:3210\n",
					stderr: "",
				};
			},
		});
		expect(outcome.phase).toBe("deployed");
		if (outcome.phase !== "deployed") return;
		expect(outcome.receipt.mode).toBe("self-hosted");
		expect(outcome.receipt.mocked).toBe(false);
		expect(outcome.receipt.deploymentUrl).toBe("http://127.0.0.1:3210");
	});
});

describe("documented event architecture stays truthful", () => {
	it("every control-plane fact the README names exists in @hobo/cloud", () => {
		const readme = readFileSync(
			path.join(import.meta.dirname, "..", "README.md"),
			"utf8",
		);
		const catalog = readFileSync(
			path.join(repoRoot, "packages/cloud/src/events.ts"),
			"utf8",
		);
		const named = [
			...new Set(
				[...readme.matchAll(/`([a-z]+\.[A-Z][A-Za-z]+)`/gu)].map(
					(match) => match[1],
				),
			),
		];
		expect(named.length).toBeGreaterThan(0);
		for (const fact of named) {
			expect(catalog, `${fact} is not a real @hobo/cloud fact`).toContain(
				`"${fact}"`,
			);
		}
	});
});
