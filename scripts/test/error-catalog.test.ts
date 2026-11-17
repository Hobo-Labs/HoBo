import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
	CATALOG_PATH,
	type CatalogEntry,
	collectCodes,
	main,
	readSources,
	renderCatalog,
} from "../ci/error-catalog.mts";

const repoRoot = resolve(import.meta.dirname, "../..");

function entry(entries: readonly CatalogEntry[], code: string): CatalogEntry {
	const found = entries.find((candidate) => candidate.code === code);
	assert.ok(found, `${code} is in the catalog`);
	return found;
}

describe("S07 error catalog: collecting codes from source", () => {
	it("reads a code property with its message and remediation", () => {
		const entries = collectCodes(
			new Map([
				[
					"packages/hobo/src/ci-route.ts",
					`const PROJECT_FILE = ".hobo/ci.json";
					export function f(problem: string) {
						return {
							ok: false,
							code: "HOBO_CI_RUNNER_ORDER_INVALID",
							message: \`runnerOrder in \${PROJECT_FILE} cannot be used: \${problem}.\`,
							remediation: ["Fix runnerOrder, or remove it."],
						};
					}`,
				],
			]),
		);
		assert.deepEqual(entries, [
			{
				code: "HOBO_CI_RUNNER_ORDER_INVALID",
				files: ["packages/hobo/src/ci-route.ts"],
				messages: ["runnerOrder in .hobo/ci.json cannot be used: {problem}."],
				remediations: ["Fix runnerOrder, or remove it."],
			},
		]);
	});

	it("reads both branches of a conditional code and of a conditional message", () => {
		const entries = collectCodes(
			new Map([
				[
					"packages/hobo/src/ci-runs.ts",
					`export function f(failed: boolean, rerun: boolean) {
						return {
							ok: !failed,
							code: failed ? "HOBO_CI_RUN_FAILED" : "HOBO_OK",
							message: rerun ? "No failed run found." : "No run found.",
						};
					}`,
				],
			]),
		);
		assert.deepEqual(
			entries.map((found) => found.code),
			["HOBO_CI_RUN_FAILED"],
		);
		assert.deepEqual(entry(entries, "HOBO_CI_RUN_FAILED").messages, [
			"No failed run found.",
			"No run found.",
		]);
	});

	it("reads helpers by their parameter names: code, message, remediation", () => {
		const entries = collectCodes(
			new Map([
				[
					"packages/hobo/src/ci-relay-yard.ts",
					`function refuse(code: string, message: string, remediation: string): never {
						throw new Error(code + message + remediation);
					}
					export function g(camp: string) {
						refuse("HOBO_CI_DEPLOY_NO_CAMP", "No Camp " + camp + ".", "Add a Camp.");
					}`,
				],
				[
					"packages/hobo/src/ci-secret-store.ts",
					`export class Refusal extends Error {
						constructor(readonly code: string, message: string) { super(message); }
					}
					export function h() {
						throw new Refusal("HOBO_CI_SECRET_STORE_BINDING_INVALID", "The binding is not valid.");
					}`,
				],
			]),
		);
		assert.deepEqual(entry(entries, "HOBO_CI_DEPLOY_NO_CAMP"), {
			code: "HOBO_CI_DEPLOY_NO_CAMP",
			files: ["packages/hobo/src/ci-relay-yard.ts"],
			messages: ["No Camp {camp}."],
			remediations: ["Add a Camp."],
		});
		assert.deepEqual(
			entry(entries, "HOBO_CI_SECRET_STORE_BINDING_INVALID").messages,
			["The binding is not valid."],
		);
	});

	it("resolves a code table entry used from another file, and keeps unused refusals", () => {
		const entries = collectCodes(
			new Map([
				[
					"packages/hobo/src/a.ts",
					`export const RELAY_VERIFY_REFUSAL = Object.freeze({
						relayNotReady: "HOBO_CI_DEPLOY_RELAY_NOT_READY",
					} as const);
					export const RELAY_ADOPT_REFUSAL = Object.freeze({
						notFound: "HOBO_CI_ADOPT_NOT_FOUND",
						unused: "HOBO_CI_ADOPT_UNUSED",
						...RELAY_VERIFY_REFUSAL,
					} as const);
					export const RELAY_VERIFY_ORIGIN = Object.freeze({ production: "HOBO_CI_RELAY_URL" });`,
				],
				[
					"packages/hobo/src/b.ts",
					`import { RELAY_ADOPT_REFUSAL } from "./a.js";
					export function f(repository: string) {
						return {
							code: RELAY_ADOPT_REFUSAL.notFound,
							reason: \`No deployment of \${repository}.\`,
							remediation: "Wait for Vercel.",
						};
					}`,
				],
			]),
		);
		assert.deepEqual(
			entries.map((found) => found.code),
			[
				"HOBO_CI_ADOPT_NOT_FOUND",
				"HOBO_CI_ADOPT_UNUSED",
				"HOBO_CI_DEPLOY_RELAY_NOT_READY",
			],
		);
		assert.deepEqual(entry(entries, "HOBO_CI_ADOPT_NOT_FOUND"), {
			code: "HOBO_CI_ADOPT_NOT_FOUND",
			files: ["packages/hobo/src/a.ts", "packages/hobo/src/b.ts"],
			messages: ["No deployment of {repository}."],
			remediations: ["Wait for Vercel."],
		});
		assert.deepEqual(entry(entries, "HOBO_CI_ADOPT_UNUSED").messages, []);
	});

	it("leaves out environment variable names and other HOBO_CI_ strings", () => {
		const entries = collectCodes(
			new Map([
				[
					"packages/ci-gh-actions/src/main.ts",
					`const FLEET_ROUTES_VARIABLE = "HOBO_CI_FLEET_ROUTES";
					function required(env: NodeJS.ProcessEnv, name: string): string { return env[name] ?? ""; }
					function integer(name: string, fallback: number): number { return fallback; }
					export function f(env: NodeJS.ProcessEnv) {
						return [required(env, "HOBO_CI_DB"), env.HOBO_CI_RELAY_URL, integer("HOBO_CI_SLOTS", 2), FLEET_ROUTES_VARIABLE];
					}`,
				],
			]),
		);
		assert.deepEqual(entries, []);
	});

	it("says when a message is composed at run time", () => {
		const entries = collectCodes(
			new Map([
				[
					"packages/hobo/src/ci-init.ts",
					`export function f(lines: string[]) {
						return { ok: false, code: "HOBO_CI_INIT_NOTHING_APPLIED", message: lines.join("\\n") };
					}`,
				],
			]),
		);
		assert.deepEqual(
			entry(entries, "HOBO_CI_INIT_NOTHING_APPLIED").messages,
			[],
		);
		assert.match(renderCatalog(entries), /composed when the command runs/u);
	});
});

describe("S07 error catalog: the page", () => {
	it("renders one section per code, sorted, with an index", () => {
		const page = renderCatalog([
			{
				code: "HOBO_CI_B",
				files: ["packages/hobo/src/b.ts"],
				messages: ["Second <owner>."],
				remediations: ["Do the <thing>."],
			},
			{
				code: "HOBO_CI_A",
				files: ["packages/hobo/src/a.ts"],
				messages: ["First."],
				remediations: [],
			},
		]);
		assert.match(page, /^---\ntype: /u);
		assert.ok(page.indexOf("### HOBO_CI_A") < page.indexOf("### HOBO_CI_B"));
		assert.match(page, /\| \[`HOBO_CI_A`\]\(#hobo_ci_a\) \|/u);
		assert.match(page, /```text\nSecond <owner>\.\n```/u);
		assert.match(page, /- Do the \\<thing>\./u);
		assert.equal(renderCatalog([]), renderCatalog([]));
	});

	it("is fresh: the committed page equals what the source produces", () => {
		const committed = readFileSync(join(repoRoot, CATALOG_PATH), "utf8");
		const fresh = renderCatalog(collectCodes(readSources(repoRoot)));
		assert.equal(
			committed,
			fresh,
			"docs/ci/errors.md is stale: run node --import tsx scripts/ci/error-catalog.mts",
		);
	});

	it("holds the codes the CI commands return, and no setting names", () => {
		const entries = collectCodes(readSources(repoRoot));
		const codes = new Set(entries.map((found) => found.code));
		for (const code of [
			"HOBO_CI_RUNNER_ORDER_INVALID",
			"HOBO_CI_NO_RUNNER",
			"HOBO_CI_NO_WORKFLOWS",
			"HOBO_CI_TOOL_REQUIRED",
			"HOBO_CI_GITHUB_FAILED",
			"HOBO_CI_AUTH_REQUIRED",
			"HOBO_CI_DEPLOY_NO_CAMP",
			"HOBO_CI_ADOPT_NOT_FOUND",
			"HOBO_CI_SECRET_STORE_BINDING_INVALID",
		])
			assert.ok(codes.has(code), `${code} is cataloged`);
		for (const setting of [
			"HOBO_CI_DB",
			"HOBO_CI_RELAY_URL",
			"HOBO_CI_FLEET_ROUTES",
			"HOBO_CI_WEBHOOK_SECRET",
			"HOBO_CI_ACCOUNT_TOKEN",
		])
			assert.ok(!codes.has(setting), `${setting} is a setting, not a code`);
		assert.deepEqual(entry(entries, "HOBO_CI_NO_RUNNER").remediations, [
			"Name a runner type the order holds that can take the job, such as --github ubuntu-24.04.",
		]);
	});

	it("--check fails on a stale page and passes after writing it", () => {
		const root = mkdtempSync(join(tmpdir(), "error-catalog-"));
		try {
			const source = join(root, "packages/hobo/src/ci-x.ts");
			mkdirSync(dirname(source), { recursive: true });
			writeFileSync(
				source,
				`export const f = () => ({ ok: false, code: "HOBO_CI_X", message: "X." });\n`,
			);
			const quiet = { log: () => {}, error: () => {} };
			assert.equal(main(["--check"], root, quiet), 1);
			assert.equal(main([], root, quiet), 0);
			assert.equal(main(["--check"], root, quiet), 0);
			assert.match(
				readFileSync(join(root, CATALOG_PATH), "utf8"),
				/### HOBO_CI_X/u,
			);
			writeFileSync(
				source,
				`export const f = () => ({ ok: false, code: "HOBO_CI_X", message: "Changed." });\n`,
			);
			assert.equal(main(["--check"], root, quiet), 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
