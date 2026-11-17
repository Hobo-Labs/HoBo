import { describe, expect, it } from "vitest";
import {
	DEFAULT_GITHUB_MACHINE_TYPE,
	type FleetMember,
	isGithubLatestLabel,
	isIsolatedFleetProvider,
	isOverflowRunnerLabel,
	LOCAL_HOST_RUNNER_LABEL,
	queuedDemandLabels,
	selectFleetBackend,
	selectFleetVerification,
	shouldAbortIsolatedFleetLease,
} from "../src/fleet-overflow.js";

function member(
	partial: Pick<FleetMember, "id" | "backend"> & Partial<FleetMember>,
): FleetMember {
	const runsOn =
		partial.runsOn ??
		(partial.backend === "github"
			? DEFAULT_GITHUB_MACHINE_TYPE
			: partial.backend === "arc"
				? "hobo-arc"
				: "hobo");
	return {
		enabled: partial.enabled ?? true,
		runsOn,
		freeSlots: partial.freeSlots ?? 0,
		...partial,
	};
}

const hobo = (
	freeSlots: number,
	extra: Partial<FleetMember> = {},
): FleetMember =>
	member({
		id: "hobo-1",
		backend: "hobo",
		runsOn: "hobo",
		freeSlots,
		...extra,
	});

const arc = (
	freeSlots: number,
	extra: Partial<FleetMember> = {},
): FleetMember =>
	member({
		id: "arc-1",
		backend: "arc",
		runsOn: "hobo-arc",
		freeSlots,
		...extra,
	});

const github = (
	freeSlots: number,
	extra: Partial<FleetMember> = {},
): FleetMember =>
	member({
		id: "gh-1",
		backend: "github",
		runsOn: DEFAULT_GITHUB_MACHINE_TYPE,
		freeSlots,
		...extra,
	});

describe("selectFleetBackend", () => {
	it("stays on hobo when overflow providers are disabled and hobo has slots", () => {
		const sel = selectFleetBackend({
			members: [
				hobo(2),
				arc(5, { enabled: false }),
				github(10, { enabled: false }),
			],
			currentLabels: ["hobo"],
		});
		expect(sel).toEqual({
			backend: "hobo",
			runsOn: "hobo",
			memberId: "hobo-1",
			spilled: false,
		});
	});

	it("does not spill to GitHub when overflow is disabled and hobo has no slots", () => {
		const sel = selectFleetBackend({
			members: [
				hobo(0),
				arc(5, { enabled: false }),
				github(10, { enabled: false }),
			],
			currentLabels: ["hobo"],
		});
		expect(sel).toBeUndefined();
	});

	it("prefers hobo over an enabled github overflow member while hobo has slots", () => {
		const sel = selectFleetBackend({
			members: [hobo(1), github(8, { enabled: true })],
			currentLabels: ["hobo"],
		});
		expect(sel).toEqual({
			backend: "hobo",
			runsOn: "hobo",
			memberId: "hobo-1",
			spilled: false,
		});
	});

	it("spills to github ubuntu-24.04 when hobo is full and github overflow is enabled", () => {
		const sel = selectFleetBackend({
			members: [hobo(0), github(3, { enabled: true, runsOn: "ubuntu-24.04" })],
			currentLabels: ["hobo"],
		});
		expect(sel).toEqual({
			backend: "github",
			runsOn: "ubuntu-24.04",
			memberId: "gh-1",
			spilled: true,
		});
	});

	it("spills to arc before github when hobo is full and arc has slots", () => {
		const sel = selectFleetBackend({
			members: [
				hobo(0),
				github(4, { enabled: true }),
				arc(2, { enabled: true, runsOn: "hobo-arc" }),
			],
			currentLabels: ["hobo"],
		});
		expect(sel).toEqual({
			backend: "arc",
			runsOn: "hobo-arc",
			memberId: "arc-1",
			spilled: true,
		});
	});

	it("spills to an enrolled local box before github, and after arc", () => {
		const local = (freeSlots: number, enabled = true): FleetMember =>
			member({
				id: "local-1",
				backend: "local",
				runsOn: LOCAL_HOST_RUNNER_LABEL,
				freeSlots,
				enabled,
			});
		const pick = (members: FleetMember[]) =>
			selectFleetBackend({ members, currentLabels: ["hobo"] })?.backend;
		expect(pick([hobo(0), github(4), local(1)])).toBe("local");
		expect(pick([hobo(0), github(4), local(1), arc(1)])).toBe("arc");
		// Enrolled but busy, or not enrolled at all: GitHub-hosted is next.
		expect(pick([hobo(0), github(4), local(0)])).toBe("github");
		expect(pick([hobo(0), github(4), local(3, false)])).toBe("github");
		expect(pick([hobo(1), github(4), local(1)])).toBe("hobo");
		expect(
			selectFleetBackend({
				members: [hobo(0), local(1)],
				currentLabels: ["hobo"],
			}),
		).toEqual({
			backend: "local",
			runsOn: "hobo-local-host",
			memberId: "local-1",
			spilled: true,
		});
	});

	it("stays on github when current labels are already ubuntu-24.04", () => {
		const sel = selectFleetBackend({
			members: [hobo(5), github(1, { enabled: true, runsOn: "ubuntu-24.04" })],
			currentLabels: ["ubuntu-24.04"],
		});
		expect(sel).toEqual({
			backend: "github",
			runsOn: "ubuntu-24.04",
			memberId: "gh-1",
			spilled: true,
		});
		expect(sel?.backend).not.toBe("hobo");
	});

	it("stays on arc when current labels are already hobo-arc", () => {
		const sel = selectFleetBackend({
			members: [
				hobo(5),
				arc(1, { enabled: true, runsOn: "hobo-arc" }),
				github(4, { enabled: true }),
			],
			currentLabels: ["hobo-arc"],
		});
		expect(sel).toEqual({
			backend: "arc",
			runsOn: "hobo-arc",
			memberId: "arc-1",
			spilled: true,
		});
	});
});

describe("fleet verification selection", () => {
	it("exhausts the four-tier availability matrix for both signoff settings", () => {
		const states = ["up", "down", "unknown", "disabled"] as const;
		const backends = ["hobo", "arc", "local", "github"] as const;
		for (let mask = 0; mask < 4 ** backends.length; mask += 1) {
			const observed = backends.map((backend, index) => ({
				backend,
				state: states[Math.floor(mask / 4 ** index) % 4] ?? "unknown",
			}));
			const members = observed
				.map(({ backend, state }) =>
					member({
						id: backend,
						backend,
						enabled: state !== "disabled",
						freeSlots: state === "up" ? 1 : 0,
					}),
				)
				.reverse();
			const unknownMembers = observed
				.filter(({ state }) => state === "unknown")
				.map(({ backend }) => backend);
			for (const localSignoffEnabled of [false, true]) {
				const selection = selectFleetVerification({
					members,
					unknownMembers,
					localSignoffEnabled,
				});
				const firstUp = observed.find(({ state }) => state === "up");
				if (firstUp) {
					expect(selection.kind, JSON.stringify(observed)).toBe("runner");
					if (selection.kind === "runner")
						expect(selection.runner.backend).toBe(firstUp.backend);
				} else if (unknownMembers.length) {
					expect(selection).toEqual({
						kind: "wait",
						reason: "availability-unknown",
					});
				} else {
					expect(selection).toEqual(
						localSignoffEnabled
							? { kind: "local-signoff" }
							: { kind: "wait", reason: "no-capacity" },
					);
				}
			}
		}
	});

	it("never treats malformed or contradictory observations as an outage", () => {
		const unknown = { kind: "wait", reason: "availability-unknown" };
		for (const freeSlots of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
			expect(
				selectFleetVerification({
					members: [hobo(freeSlots)],
					unknownMembers: [],
					localSignoffEnabled: true,
				}),
			).toEqual(unknown);
		for (const input of [
			{ members: [hobo(0), hobo(0)], unknownMembers: [] },
			{ members: [hobo(0)], unknownMembers: ["missing"] },
			{ members: [hobo(1)], unknownMembers: ["hobo-1"] },
			{ members: [hobo(0, { id: "" })], unknownMembers: [] },
			{ members: [hobo(0, { id: "   " })], unknownMembers: [] },
			{ members: [hobo(1, { runsOn: "" })], unknownMembers: [] },
			{ members: [hobo(0, { runsOn: "  " })], unknownMembers: [] },
		])
			expect(
				selectFleetVerification({ ...input, localSignoffEnabled: true }),
			).toEqual(unknown);
		// SAFETY: This intentionally models an untyped caller supplying a new
		// backend before the selector knows how to order or interpret it.
		const unsupported = { ...hobo(1), backend: "other" } as FleetMember;
		expect(
			selectFleetVerification({
				members: [unsupported],
				unknownMembers: [],
				localSignoffEnabled: true,
			}),
		).toEqual(unknown);
		// JSON is the boundary here: these represent malformed untyped callers.
		for (const input of [
			{ members: [null], unknownMembers: [], localSignoffEnabled: true },
			{
				members: [{ ...hobo(0), enabled: null }],
				unknownMembers: [],
				localSignoffEnabled: true,
			},
			{
				members: [{ ...hobo(0), id: null }],
				unknownMembers: [],
				localSignoffEnabled: true,
			},
			{
				members: [{ ...hobo(1), runsOn: null }],
				unknownMembers: [],
				localSignoffEnabled: true,
			},
			{ members: [], unknownMembers: [], localSignoffEnabled: "false" },
			{ members: null, unknownMembers: [], localSignoffEnabled: true },
		])
			expect(
				selectFleetVerification(JSON.parse(JSON.stringify(input))),
			).toEqual(unknown);
	});

	it("keeps the normal runner order when local signoff is enabled", () => {
		for (const [members, backend] of [
			[[hobo(1), arc(1), github(1)], "hobo"],
			[[hobo(0), arc(1), github(1)], "arc"],
			[[hobo(0), arc(0), github(1)], "github"],
		] as const) {
			const choice = selectFleetVerification({
				members,
				unknownMembers: [],
				localSignoffEnabled: true,
			});
			expect(choice.kind).toBe("runner");
			if (choice.kind === "runner") expect(choice.runner.backend).toBe(backend);
		}
	});

	it("offers local signoff only when enabled and every enabled runner is known unavailable", () => {
		const members = [hobo(0), arc(0), github(0)];
		expect(
			selectFleetVerification({
				members,
				unknownMembers: [],
				localSignoffEnabled: true,
			}),
		).toEqual({ kind: "local-signoff" });
		expect(
			selectFleetVerification({
				members,
				unknownMembers: [],
				localSignoffEnabled: false,
			}),
		).toEqual({ kind: "wait", reason: "no-capacity" });
		expect(
			selectFleetVerification({
				members,
				unknownMembers: ["gh-1"],
				localSignoffEnabled: true,
			}),
		).toEqual({ kind: "wait", reason: "availability-unknown" });
		expect(
			selectFleetVerification({
				members: [hobo(0), github(0, { enabled: false })],
				unknownMembers: ["gh-1"],
				localSignoffEnabled: true,
			}),
		).toEqual({ kind: "local-signoff" });
	});
});

describe("fleet overflow labels", () => {
	it("rejects ubuntu-latest and accepts a concrete GitHub-hosted image", () => {
		expect(isGithubLatestLabel("ubuntu-latest")).toBe(true);
		expect(isGithubLatestLabel(" ubuntu-latest ")).toBe(true);
		expect(isGithubLatestLabel("ubuntu-24.04")).toBe(false);
		expect(DEFAULT_GITHUB_MACHINE_TYPE).toBe("ubuntu-24.04");
	});

	it("treats a single ARC or GitHub machine label as overflow (not hobo JIT)", () => {
		expect(isOverflowRunnerLabel(["ubuntu-24.04"])).toBe(true);
		expect(isOverflowRunnerLabel(["hobo-arc"])).toBe(true);
		expect(isOverflowRunnerLabel(["hobo"])).toBe(false);
		expect(isOverflowRunnerLabel(["hobo-trunk"])).toBe(false);
		expect(isOverflowRunnerLabel(["hobo", "hobo-trunk"])).toBe(false);
	});

	it("stamps queued demand with the concrete runs-on for github gh-actions offers", () => {
		expect(
			queuedDemandLabels("github", "gh-actions", "ubuntu-24.04", ["hobo"]),
		).toEqual(["ubuntu-24.04"]);
		expect(
			queuedDemandLabels("github", "gh-actions", "ubuntu-24.04", ["hobo"]),
		).not.toEqual(["hobo"]);
		expect(queuedDemandLabels("github", "", "ubuntu-24.04", ["hobo"])).toEqual([
			"ubuntu-24.04",
		]);
	});

	it("keeps hobo labels for isolated and non-gh-actions offers", () => {
		expect(
			queuedDemandLabels("kubernetes", "gh-actions", "hobo-isolated-worker", [
				"hobo-trunk",
			]),
		).toEqual(["hobo-trunk"]);
		expect(
			queuedDemandLabels(
				"kubernetes",
				"isolated-container",
				"hobo-isolated-worker",
				["hobo"],
			),
		).toEqual(["hobo"]);
		expect(
			queuedDemandLabels("kubernetes", "gh-actions", "hobo-arc", ["hobo"]),
		).toEqual(["hobo-arc"]);
	});
});

describe("isIsolatedFleetProvider", () => {
	it("does not treat kubernetes gh-actions ARC as isolated", () => {
		expect(
			isIsolatedFleetProvider("kubernetes", "gh-actions", "hobo-arc"),
		).toBe(false);
	});

	it("treats the hobo box worker as isolated", () => {
		expect(
			isIsolatedFleetProvider(
				"hobo-box-worker",
				"isolated-container",
				"hobo-isolated-worker",
			),
		).toBe(true);
	});

	it("treats kubernetes isolated-container on the isolated worker label as isolated", () => {
		expect(
			isIsolatedFleetProvider(
				"kubernetes",
				"isolated-container",
				"hobo-isolated-worker",
			),
		).toBe(true);
		expect(
			isIsolatedFleetProvider("kubernetes", "isolated-container", "hobo-arc"),
		).toBe(false);
		expect(
			isIsolatedFleetProvider("github", "gh-actions", "ubuntu-24.04"),
		).toBe(false);
	});

	it("aborts vercel and box workers, and kubernetes only when the offer is isolated", () => {
		expect(shouldAbortIsolatedFleetLease("vercel", undefined)).toBe(true);
		expect(shouldAbortIsolatedFleetLease("hobo-box-worker", undefined)).toBe(
			true,
		);
		expect(shouldAbortIsolatedFleetLease("github", undefined)).toBe(false);
		expect(shouldAbortIsolatedFleetLease("kubernetes", undefined)).toBe(false);
		expect(
			shouldAbortIsolatedFleetLease("kubernetes", {
				backend: "gh-actions",
				runsOn: "hobo-arc",
			}),
		).toBe(false);
		expect(
			shouldAbortIsolatedFleetLease("kubernetes", {
				backend: "isolated-container",
				runsOn: "hobo-isolated-worker",
			}),
		).toBe(true);
	});
});
