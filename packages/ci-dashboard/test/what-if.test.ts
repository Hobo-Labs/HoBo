import { describe, expect, it } from "vitest";
import {
	blankQuestion,
	questionFromRoutes,
	type WhatIfQuestion,
	whatIf,
} from "../src/index.js";
import { decided, machine, NOW, order, REPOSITORY } from "./support/records.js";

const ORDER = order(
	JSON.stringify({
		steps: [
			{ key: "machine" },
			{ key: "github", minutesLimitPercent: 80 },
			{ key: "depot" },
			{ key: "github" },
		],
	}),
).order;

function question(changes: Partial<WhatIfQuestion> = {}): WhatIfQuestion {
	return {
		...blankQuestion(REPOSITORY, ORDER),
		labels: new Map([
			["machine", "self-hosted"],
			["github", "ubuntu-24.04"],
			["depot", "depot-ubuntu-24.04"],
		]),
		startedBy: "42",
		...changes,
	};
}

describe("the what-if walk", () => {
	it("takes an online machine with a free slot first", () => {
		const answer = whatIf(ORDER, question(), [machine({ id: "m-a" })], NOW);
		expect(answer.outcome).toBe("routed");
		expect(answer.step).toBe("machine");
		expect(answer.runner).toBe("hobo-machine-m-a");
	});

	it("passes over an offline machine and names why", () => {
		const answer = whatIf(
			ORDER,
			question(),
			[machine({ id: "m-a", lastSeenMs: NOW - 10 * 60_000 })],
			NOW,
		);
		expect(answer.step).toBe("github");
		expect(answer.skipped.map((entry) => entry.reason)).toEqual(["no_machine"]);
	});

	it("keeps a public repository off machines", () => {
		const answer = whatIf(
			ORDER,
			question({ public: true }),
			[machine({ id: "m-a" })],
			NOW,
		);
		expect(answer.step).toBe("github");
		expect(answer.skipped[0]?.reason).toBe("public_repository");
	});

	it("applies the minutes limit only when minutes are measured", () => {
		const offline = [machine({ id: "m-a", lastSeenMs: 1 })];
		expect(whatIf(ORDER, question(), offline, NOW).step).toBe("github");
		const over = whatIf(
			ORDER,
			question({ minutesUsedPercent: 90 }),
			offline,
			NOW,
		);
		expect(over.step).toBe("depot");
		expect(over.skipped.map((entry) => entry.reason)).toEqual([
			"no_machine",
			"minutes_limit",
		]);
	});

	it("passes over a runner type marked as failing to start jobs", () => {
		const answer = whatIf(
			ORDER,
			question({
				minutesUsedPercent: 90,
				unhealthy: new Set(["depot"]),
			}),
			[],
			NOW,
		);
		expect(answer.step).toBe("github");
		expect(answer.skipped.map((entry) => entry.reason)).toContain(
			"provider_unhealthy",
		);
	});

	it("waits on a full machine when nothing else fits", () => {
		const answer = whatIf(
			ORDER,
			question({ labels: new Map([["machine", "self-hosted"]]) }),
			[machine({ id: "m-a", slots: 1, busy: 1 })],
			NOW,
		);
		expect(answer.outcome).toBe("waiting");
		expect(answer.runner).toBe("hobo-machine-m-a");
	});

	it("answers none with the reason when no named step can take it", () => {
		const answer = whatIf(
			ORDER,
			question({ labels: new Map([["machine", "gpu"]]) }),
			[machine({ id: "m-a" })],
			NOW,
		);
		expect(answer.outcome).toBe("none");
		expect(answer.reason).toMatch(/^No runner available\./u);
	});

	it("seeds the question from the newest decision of the repository", () => {
		const seeded = questionFromRoutes(REPOSITORY, ORDER, [
			decided({ minutesAgo: 1, step: "github", runner: "ubuntu-24.04" }),
		]);
		expect(seeded.labels.get("machine")).toBe("self-hosted");
		expect(seeded.labels.get("github")).toBe("ubuntu-24.04");
		expect(seeded.labels.get("depot")).toBe("");
		expect(seeded.startedBy).toBe("42");
		expect(seeded.public).toBe(false);
	});
});
