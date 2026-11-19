import type { CommandModule, CommandRunInput } from "@hobo/cli";
import { type ConnectPage, startConnectPage } from "@hobo/connect-ui";
import { describe, expect, it } from "vitest";

import { createProviderCeremonyUp } from "../src/provider-ceremony.js";

// hobo up holds a ceremony for providers: a resource no connected provider
// serves opens the setup page, offers the providers for its port, connects
// the chosen one and runs up again.

const rejected = {
	ok: false,
	status: "rejected",
	code: "HOBO_PLAN_REJECTED",
	message:
		"hobo up rejected: plan rejected: 1 resource(s) could not be satisfied",
	remediation: [
		"db (capability.port-unavailable): no registered provider advertises port sql",
	],
	data: {
		command: "up",
		remediations: [
			{
				resource: "db",
				code: "capability.port-unavailable",
				requiredPort: "sql",
				requiredFeatures: [],
				missing: [],
				remediation: "…",
			},
		],
	},
};

function fakeUp(
	results: Awaited<ReturnType<CommandModule["run"]>>[],
): CommandModule & { readonly runs: () => number } {
	let runs = 0;
	return {
		runs: () => runs,
		run: async () => results[Math.min(runs++, results.length - 1)] ?? rejected,
	};
}

function fakeAdd(heldIds: readonly string[] = []) {
	const calls: string[] = [];
	const seen = new Set<string>();
	const add: CommandModule = {
		run: async (input) => {
			const id = input.args[0] ?? "";
			calls.push(id);
			const held = heldIds.includes(id) && !seen.has(id);
			seen.add(id);
			return {
				ok: true,
				status: "installed",
				code: "HOBO_OK",
				message: `added ${id}`,
				data: { provider: id, approved: !held },
			};
		},
	};
	return { add, calls };
}

function input(whatIf = false): CommandRunInput {
	const run: Pick<CommandRunInput, "emitProgress" | "args" | "verb"> & {
		flags: { whatIf: boolean };
	} = {
		emitProgress: () => undefined,
		args: [],
		verb: "up",
		flags: { whatIf },
	};
	// SAFETY: the ceremony reads only emitProgress, flags.whatIf, verb and args.
	return run as CommandRunInput;
}

const candidates = (port: string) =>
	port === "sql" ? ["neon", "supabase"] : [];

describe("hobo up's provider ceremony", () => {
	it("closes the real page if progress reporting or browser launch throws", async () => {
		for (const failure of ["progress", "browser"] as const) {
			const { add } = fakeAdd();
			const run = input();
			let page: ConnectPage | undefined;
			const closeGrace: number[] = [];
			try {
				await expect(
					createProviderCeremonyUp(fakeUp([rejected]), {
						add,
						candidates,
						interactive: true,
						startPage: async (options) => {
							page = await startConnectPage(options);
							const started = page;
							return {
								...started,
								async close(options) {
									closeGrace.push(options?.graceMs ?? 0);
									await started.close(options);
								},
							};
						},
						openBrowser: () => {
							if (failure === "browser") throw new Error("browser failed");
						},
					}).run(
						failure === "progress"
							? {
									...run,
									emitProgress: () => {
										throw new Error("progress failed");
									},
								}
							: run,
					),
				).rejects.toThrow(`${failure} failed`);
				expect(page).toBeDefined();
				expect(closeGrace).toEqual([0]);
				if (page === undefined) throw new Error("page did not start");
				await expect(
					fetch(page.url, { signal: AbortSignal.timeout(1_000) }),
				).rejects.toThrow();
			} finally {
				await page?.close({ graceMs: 0 });
			}
		}
	});

	it("passes a plan that resolves straight through", async () => {
		const up = fakeUp([
			{ ok: true, status: "deployed", code: "HOBO_OK", message: "ok" },
		]);
		const { add, calls } = fakeAdd();
		const result = await createProviderCeremonyUp(up, {
			add,
			candidates,
			interactive: true,
		}).run(input());
		expect(result.code).toBe("HOBO_OK");
		expect(calls).toEqual([]);
	});

	it("headless or --what-if: keeps the rejection and names the hobo add that satisfies it", async () => {
		for (const [interactive, whatIf] of [
			[false, false],
			[true, true],
		] as const) {
			const { add, calls } = fakeAdd();
			const result = await createProviderCeremonyUp(fakeUp([rejected]), {
				add,
				candidates,
				interactive,
			}).run(input(whatIf));
			expect(result.code).toBe("HOBO_PLAN_REJECTED");
			expect(result.remediation).toContain(
				"db (port sql): hobo add neon | supabase",
			);
			expect(calls).toEqual([]);
		}
	});

	it("says so when no installable provider offers the port", async () => {
		const { add } = fakeAdd();
		const result = await createProviderCeremonyUp(fakeUp([rejected]), {
			add,
			candidates: () => [],
			interactive: true,
		}).run(input());
		expect(result.remediation?.join(" ")).toMatch(
			/no installable provider offers it/,
		);
	});

	it("asks which provider to connect, connects it (approving a held one), and runs up again", async () => {
		const up = fakeUp([
			rejected,
			{
				ok: true,
				status: "deployed",
				code: "HOBO_OK",
				message: "deployed",
				data: {},
			},
		]);
		const { add, calls } = fakeAdd(["supabase"]);
		const asked: string[] = [];
		let browsing: Promise<unknown> = Promise.resolve();
		const result = await createProviderCeremonyUp(up, {
			add,
			candidates,
			interactive: true,
			openBrowser: (url) => {
				browsing = (async () => {
					const view = await fetch(`${url}view`).then((res) => res.json());
					expect(view.step).toBe("configure");
					const specText = JSON.stringify(view.spec);
					expect(specText).toMatch(/approve.*on hold/i);
					expect(specText).toMatch(/approves.*on hold/i);
					expect(specText).toMatch(/provider:db/);
					const fieldLabel = specText.match(
						/"label"\s*:\s*"([^"]*provider[^"]*)"/i,
					)?.[1];
					if (fieldLabel) asked.push(fieldLabel);
					await fetch(`${url}action`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "connect.submit",
							params: { "provider:db": "supabase" },
						}),
					});
					await fetch(`${url}view`);
				})();
			},
		}).run(input());
		await browsing;
		expect(asked.length).toBeGreaterThan(0);
		// Registered held, then approved by the second add.
		expect(calls).toEqual(["supabase", "supabase"]);
		expect(up.runs()).toBe(2);
		expect(result).toMatchObject({
			code: "HOBO_OK",
			data: { connectedProviders: ["supabase"] },
		});
	});
});
