import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLDEN_DEFAULT_SUITE_ID, SILVER_DEFAULT_SUITE_ID } from "@hobo/evals";
import { afterEach, describe, expect, it } from "vitest";
import { campEvalSidecar } from "../src/eval-sidecar.js";
import {
	runEvalSidecarSuite,
	startEvalSidecar,
} from "../src/eval-sidecar-server.js";
import { isJsonObject } from "../src/json.js";
import { loopbackFetchUrl } from "../src/occupancy-endpoints.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots.length = 0;
});

describe("evals sidecar server", () => {
	it("always serves the golden default suite and scores a live run", async () => {
		const project = mkdtempSync(join(tmpdir(), "hobo-eval-server-"));
		roots.push(project);
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "bindle.ts"),
			`export default bindle("shop", (b) => ({ web: b.web() }));\n`,
		);
		const server = await startEvalSidecar({
			campId: "camp:shop",
			projectDir: project,
			port: 0,
		});
		try {
			expect(server.url).toMatch(/evals\.code\..*\.hobo\.localhost/);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const health = (await (
				await fetch(loopbackFetchUrl(server.url))
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				live: boolean;
				suite: {
					defaultSuite: { id: string };
					silverSuite: { id: string };
				};
			};
			expect(health.live).toBe(true);
			expect(health.suite.defaultSuite.id).toBe(GOLDEN_DEFAULT_SUITE_ID);
			expect(health.suite.silverSuite.id).toBe(SILVER_DEFAULT_SUITE_ID);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const run = (await (
				await fetch(new URL("/run", loopbackFetchUrl(server.url)), {
					method: "POST",
				})
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				ok: boolean;
				reports: unknown[];
			};
			expect(run.ok).toBe(true);
			expect(run.reports).toEqual([]);
		} finally {
			await server.close();
		}
	});

	it("scores exact-match of trainable output against blessed examples", async () => {
		const project = mkdtempSync(join(tmpdir(), "hobo-eval-train-"));
		roots.push(project);
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "classify.ts"),
			`
export async function classify(input: { text: string }) {
  "use training";
  return training(async (body) => body, {
    methodRef: "shop.classify",
    intent: "label the ticket",
    contract: {
      examples: [
        { input: { text: "invoice overdue" }, output: { label: "billing" } },
      ],
    },
  });
}
`,
		);
		const server = await startEvalSidecar({
			campId: "camp:shop",
			projectDir: project,
			port: 0,
		});
		try {
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const miss = (await (
				await fetch(new URL("/run", loopbackFetchUrl(server.url)), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						actuals: { "shop.classify": [{ label: "shipping" }] },
					}),
				})
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as { ok: boolean };
			expect(miss.ok).toBe(false);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const hit = (await (
				await fetch(new URL("/run", loopbackFetchUrl(server.url)), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						actuals: { "shop.classify": [{ label: "billing" }] },
					}),
				})
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as { ok: boolean; silver: { ok: boolean } };
			expect(hit.ok).toBe(true);
			expect(hit.silver.ok).toBe(true);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const unseen = (await (
				await fetch(new URL("/run", loopbackFetchUrl(server.url)), {
					method: "POST",
				})
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				ok: boolean;
				silver: { ok: boolean };
				gate: { ok: boolean };
			};
			expect(unseen.silver.ok).toBe(false);
			expect(unseen.ok).toBe(false);
			expect(unseen.gate.ok).toBe(false);
		} finally {
			await server.close();
		}
	});

	it("loads a sibling JS invoker over HTTP when the region file is TypeScript", async () => {
		const project = mkdtempSync(join(tmpdir(), "hobo-eval-sibling-"));
		roots.push(project);
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "classify.ts"),
			`
export async function classify(input: { text: string }) {
  "use training";
  return training(async (body) => body, {
    methodRef: "shop.classify",
    intent: "label the ticket",
    contract: {
      examples: [
        { input: { text: "invoice overdue" }, output: { label: "billing" } },
      ],
    },
  });
}
`,
		);
		writeFileSync(
			join(project, "src", "classify.js"),
			`
export function classify(input) {
  const text = input && input.text ? String(input.text) : "";
  return { label: text.includes("invoice") ? "billing" : "other" };
}
`,
		);
		const server = await startEvalSidecar({
			campId: "camp:shop",
			projectDir: project,
			port: 0,
		});
		try {
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const live = (await (
				await fetch(new URL("/run", loopbackFetchUrl(server.url)), {
					method: "POST",
				})
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				ok: boolean;
				gold: { ok: boolean };
				silver: { ok: boolean };
				gate: { ok: boolean };
			};
			expect(live.silver.ok).toBe(true);
			expect(live.gold.ok).toBe(true);
			expect(live.ok).toBe(true);
			expect(live.gate.ok).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("fails HTTP /run when the sibling JS invoker drifts", async () => {
		const project = mkdtempSync(join(tmpdir(), "hobo-eval-drift-js-"));
		roots.push(project);
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "classify.ts"),
			`
export async function classify(input: { text: string }) {
  "use training";
  return training(async (body) => body, {
    methodRef: "shop.classify",
    intent: "label the ticket",
    contract: {
      examples: [
        { input: { text: "invoice overdue" }, output: { label: "billing" } },
      ],
    },
  });
}
`,
		);
		writeFileSync(
			join(project, "src", "classify.js"),
			`
export function classify() {
  return { label: "shipping" };
}
`,
		);
		const server = await startEvalSidecar({
			campId: "camp:shop",
			projectDir: project,
			port: 0,
		});
		try {
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const live = (await (
				await fetch(new URL("/run", loopbackFetchUrl(server.url)), {
					method: "POST",
				})
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as {
				ok: boolean;
				gold: { ok: boolean };
				silver: { ok: boolean };
				gate: { ok: boolean };
			};
			expect(live.gold.ok).toBe(false);
			expect(live.silver.ok).toBe(false);
			expect(live.ok).toBe(false);
			expect(live.gate.ok).toBe(false);
		} finally {
			await server.close();
		}
	});

	it("loads a CommonJS invoker over HTTP", async () => {
		const project = mkdtempSync(join(tmpdir(), "hobo-eval-cjs-"));
		roots.push(project);
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "route.cjs"),
			`
function route(input) {
  "use training";
  const path = input && input.path ? String(input.path) : "";
  return { dest: path === "/" ? "home" : "other" };
}
const _meta = {
  methodRef: "shop.route",
  intent: "route the request",
  contract: {
    examples: [{ input: { path: "/" }, output: { dest: "home" } }],
  },
};
module.exports = { route };
`,
		);
		const server = await startEvalSidecar({
			campId: "camp:shop",
			projectDir: project,
			port: 0,
		});
		try {
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const live = (await (
				await fetch(new URL("/run", loopbackFetchUrl(server.url)), {
					method: "POST",
				})
			)
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				.json()) as { ok: boolean; silver: { ok: boolean } };
			expect(live.silver.ok).toBe(true);
			expect(live.ok).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("returns JSON for a malformed /run body instead of hanging", async () => {
		const project = mkdtempSync(join(tmpdir(), "hobo-eval-bad-json-"));
		roots.push(project);
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "src", "classify.ts"),
			`
export function classify(input: { text: string }) {
  "use training";
  return training((body) => body, {
    methodRef: "shop.classify",
    intent: "label the ticket",
    contract: {
      examples: [
        { input: { text: "invoice overdue" }, output: { label: "billing" } },
      ],
    },
  });
}
`,
		);
		const server = await startEvalSidecar({
			campId: "camp:shop",
			projectDir: project,
			port: 0,
		});
		try {
			const response = await fetch(
				new URL("/run", loopbackFetchUrl(server.url)),
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{not-json",
				},
			);
			expect(response.headers.get("content-type")).toMatch(/json/);
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const body = (await response.json()) as {
				ok: boolean;
				silver: { ok: boolean };
			};
			expect(body.ok).toBe(false);
			expect(body.silver.ok).toBe(false);
		} finally {
			await server.close();
		}
	});

	it("runs silver fuzz against a live trainable function", () => {
		const suite = campEvalSidecar("camp:shop", {
			trainable: [
				{
					methodRef: "shop.classify",
					file: "src/classify.ts",
					form: "directive",
					grounded: true,
					examples: [
						{
							input: { text: "invoice overdue" },
							output: { label: "billing" },
						},
					],
				},
			],
		});
		const pass = runEvalSidecarSuite({
			suite,
			invokers: {
				"shop.classify": (input) => {
					const text =
						input && isJsonObject(input) && "text" in input
							? // SAFETY: parsed or fixture value is the named domain type after this assertion.
								String(
									// SAFETY: object+text-in guard above proved input.text exists.
									(input as { text?: unknown }).text ?? "",
								)
							: "";
					return { label: text.includes("invoice") ? "billing" : "other" };
				},
			},
		});
		expect(pass.ok).toBe(true);
		expect(pass.gold.ok).toBe(true);
		expect(pass.silver.ok).toBe(true);
		const drift = runEvalSidecarSuite({
			suite,
			invokers: {
				"shop.classify": () => ({ label: "shipping" }),
			},
		});
		expect(drift.silver.ok).toBe(false);
		expect(drift.ok).toBe(false);
	});
});
