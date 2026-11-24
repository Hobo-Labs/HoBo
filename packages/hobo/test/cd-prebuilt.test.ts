import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cdStoreCoordinatesText } from "@hobo/hobo-cd";
import { afterAll, describe, expect, it } from "vitest";

import {
	type CdPrebuiltDelivery,
	CdPrebuiltRefusal,
	createCdPrebuiltProvider,
} from "../src/cd-placement.js";
import type { JsonObject } from "../src/json.js";
import type { VercelFetch } from "../src/vercel-client.js";
import type { VercelBuildRunner } from "../src/vercel-prebuilt.js";

const SYNTHETIC_ID = "00000000-0000-0000-0000-000000000000";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const COORDINATES = cdStoreCoordinatesText({
	siteUrl: "https://app.infisical.com",
	projectId: SYNTHETIC_ID,
	environment: "prod",
	secretPath: "/hobo-cd",
	identityId: SYNTHETIC_ID,
});

const work = mkdtempSync(path.join(tmpdir(), "hobo-cd-prebuilt-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Staged = { uid: string; meta: Record<string, string> };

function vercel(initial: Readonly<{ exists: boolean }>) {
	const staged: Staged[] = [];
	const sent: string[] = [];
	const bodies: string[] = [];
	const state = {
		exists: initial.exists,
		production: "dpl_live",
		staged,
		sent,
		bodies,
	};
	const answer = (status: number, body: JsonObject) => ({
		ok: status >= 200 && status < 300,
		status,
		async text() {
			return JSON.stringify(body);
		},
		async json() {
			return body;
		},
	});
	const fetch: VercelFetch = async (url, init) => {
		const { pathname } = new URL(url);
		state.sent.push(`${init.method} ${pathname}`);
		if (init.body !== undefined) state.bodies.push(String(init.body));
		if (
			init.method === "GET" &&
			(pathname === "/v9/projects/hobo-cd" ||
				pathname === "/v9/projects/prj_cd")
		)
			return state.exists
				? answer(200, {
						id: "prj_cd",
						name: "hobo-cd",
						targets: { production: { id: state.production } },
					})
				: answer(404, {
						error: { code: "not_found", message: "Project not found" },
					});
		if (init.method === "POST" && pathname === "/v9/projects") {
			state.exists = true;
			return answer(200, { id: "prj_cd", name: "hobo-cd" });
		}
		if (init.method === "GET" && pathname === "/v6/deployments")
			return answer(200, {
				deployments: state.staged.map((entry) => ({
					uid: entry.uid,
					url: "hobo-cd-staged.vercel.app",
					readyState: "READY",
					target: "production",
					created: 1_794_600_000_000,
					meta: entry.meta,
				})),
			});
		const promote = pathname.match(/^\/v10\/projects\/[^/]+\/promote\/(.+)$/u);
		if (init.method === "POST" && promote) {
			state.production = promote[1] ?? "";
			return answer(201, {});
		}
		return answer(404, { error: { code: "not_found", message: "no" } });
	};
	return { fetch, state };
}

function build(fake: ReturnType<typeof vercel>, bundleFile: string) {
	const bundled: (string | undefined)[] = [];
	const projects: string[] = [];
	const runVercelBuild = (projectId: string): VercelBuildRunner => {
		projects.push(projectId);
		return async (args) => {
			if (args[0] === "build")
				bundled.push(
					existsSync(bundleFile) ? readFileSync(bundleFile, "utf8") : undefined,
				);
			if (args[0] === "deploy") {
				const meta: Record<string, string> = {};
				args.forEach((arg, index) => {
					const value = args[index + 1];
					if (arg === "--meta" && value !== undefined) {
						const at = value.indexOf("=");
						meta[value.slice(0, at)] = value.slice(at + 1);
					}
				});
				fake.state.staged.push({ uid: "dpl_staged", meta });
			}
			return { code: 0, stdout: "", stderr: "" };
		};
	};
	return { runVercelBuild, bundled, projects };
}

function delivery(bundleFile: string): CdPrebuiltDelivery {
	return {
		token: "tok_test",
		teamId: "team_abc",
		project: "hobo-cd",
		rootDirectory: "packages/cd-vercel",
		repoRoot: work,
		sha: SHA,
		bundle: { file: bundleFile, text: COORDINATES },
		emit: () => {},
	};
}

const program = {
	programId: "p-cd-api",
	deploymentId: "hobo-cd",
	resourceId: "cd-api",
	provider: "yard:hobo-cd",
	driver: "test",
	action: "apply" as const,
	stackName: "hobo-cd",
};

describe("createCdPrebuiltProvider", () => {
	it("builds with the store binding bundled in, removes it, and promotes that build", async () => {
		const fake = vercel({ exists: false });
		const bundleFile = path.join(work, "binding-a.json");
		const runs = build(fake, bundleFile);
		const provider = createCdPrebuiltProvider(delivery(bundleFile), {
			fetch: fake.fetch,
			runVercelBuild: runs.runVercelBuild,
			checkoutHead: async () => SHA,
		});
		const outputs = await provider.apply(program);
		expect(runs.bundled).toEqual([COORDINATES]);
		expect(existsSync(bundleFile)).toBe(false);
		expect(runs.projects).toEqual(["prj_cd"]);
		expect(outputs).toMatchObject({
			deploymentId: "dpl_staged",
			target: "production",
			build: "prebuilt",
			projectCreated: "true",
			promotedFrom: "dpl_live",
		});
		expect(fake.state.production).toBe("dpl_staged");
		expect(fake.state.sent).toContain("POST /v9/projects");
		expect(fake.state.bodies).toContain(
			JSON.stringify({ name: "hobo-cd", rootDirectory: "packages/cd-vercel" }),
		);
		expect(fake.state.sent.some((line) => line.includes("/env"))).toBe(false);
		expect(fake.state.sent).not.toContain("POST /v13/deployments");
		expect(fake.state.bodies.join("\n")).not.toContain(SYNTHETIC_ID);
		expect(JSON.stringify(outputs)).not.toContain(SYNTHETIC_ID);
	});

	it("refuses a checkout at another commit, and never writes the binding", async () => {
		const fake = vercel({ exists: true });
		const bundleFile = path.join(work, "binding-b.json");
		const runs = build(fake, bundleFile);
		const provider = createCdPrebuiltProvider(delivery(bundleFile), {
			fetch: fake.fetch,
			runVercelBuild: runs.runVercelBuild,
			checkoutHead: async () => "f".repeat(40),
		});
		const refusal = await provider.apply(program).catch((error) => error);
		expect(refusal).toBeInstanceOf(CdPrebuiltRefusal);
		expect(refusal).toMatchObject({ code: "HOBO_CI_DEPLOY_CHECKOUT_MISMATCH" });
		expect(String(refusal.message)).not.toContain(SYNTHETIC_ID);
		expect(runs.bundled).toEqual([]);
		expect(existsSync(bundleFile)).toBe(false);
		expect(fake.state.staged).toEqual([]);
	});

	it("previews without naming a coordinate", async () => {
		const fake = vercel({ exists: true });
		const provider = createCdPrebuiltProvider(
			delivery(path.join(work, "binding-c.json")),
			{ fetch: fake.fetch },
		);
		const diff = await provider.preview(program);
		expect(diff.summary).toContain("no project variables");
		expect(diff.summary).not.toContain(SYNTHETIC_ID);
		expect(fake.state.sent).toEqual([]);
	});
});
