import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertAcceptanceMarker,
	authorizeLaunch,
	type LaunchIdentity,
	verifyLivePermissions,
} from "../scripts/acceptance.js";

function identity(): LaunchIdentity {
	const leaseId = randomUUID();
	return {
		leaseId,
		provider: "depot",
		executionId: randomUUID(),
		jobId: 5,
		workflowSha256: "a".repeat(64),
		runnerName: `hobo-${leaseId}`,
	};
}
function encoded(value: LaunchIdentity): string {
	return Buffer.from(JSON.stringify(value)).toString("base64");
}
function marker(value: LaunchIdentity): string {
	return `${value.leaseId}|${value.provider}|${value.executionId}|${value.jobId}|${value.workflowSha256}|${value.runnerName}\n`;
}
describe("connected runner acceptance evidence", () => {
	it("binds issued JIT configuration to exactly the dispatched host execution", () => {
		const expected = identity();
		expect(authorizeLaunch(encoded(expected), expected)).toEqual(expected);
		expect(() =>
			assertAcceptanceMarker(marker(expected), expected),
		).not.toThrow();
	});
	it.each([
		["leaseId", randomUUID()],
		["provider", "blacksmith"],
		["executionId", randomUUID()],
		["jobId", 6],
		["workflowSha256", "b".repeat(64)],
		["runnerName", `hobo-${randomUUID()}`],
	])("rejects substituted JIT %s before launching act", (field, value) => {
		const expected = identity();
		expect(() =>
			authorizeLaunch(encoded({ ...expected, [field]: value }), expected),
		).toThrow(/identity/);
	});
	it("rejects absent JIT configuration", () => {
		expect(() => authorizeLaunch("", identity())).toThrow();
	});
	it("rejects even mutually matching configurations with an unbound runner name", () => {
		const expected = { ...identity(), runnerName: "unbound-runner" };
		expect(() => authorizeLaunch(encoded(expected), expected)).toThrow(
			/runner name/,
		);
	});
	it("rejects a skipped original job with no marker", () => {
		expect(() => assertAcceptanceMarker("", identity())).toThrow(/skipped/);
	});
	it("rejects a marker copied from another original job execution", () => {
		const expected = identity();
		expect(() =>
			assertAcceptanceMarker(marker({ ...expected, jobId: 6 }), expected),
		).toThrow(/identity/);
	});
	it("rejects duplicated completion markers", () => {
		const expected = identity();
		expect(() =>
			assertAcceptanceMarker(marker(expected) + marker(expected), expected),
		).toThrow(/skipped/);
	});
});

describe("offline GitHub readiness permission boundary", () => {
	it("checks only repository identity and runner visibility", async () => {
		const calls: string[] = [];
		const probe = async (path: string) => {
			calls.push(path);
			return Response.json(
				path.endsWith("/actions/runners")
					? { total_count: 0, runners: [] }
					: { id: 101, full_name: "org/repo" },
			);
		};
		await expect(
			verifyLivePermissions("org/repo", probe),
		).resolves.toBeUndefined();
		expect(calls).toEqual(["repos/org/repo", "repos/org/repo/actions/runners"]);
	});
	it("fails closed on runner API 403 without claiming live execution", async () => {
		const calls: string[] = [];
		const probe = async (path: string) => {
			calls.push(path);
			return path.endsWith("/actions/runners")
				? Response.json({ message: "Forbidden" }, { status: 403 })
				: Response.json({ id: 101, full_name: "org/repo" });
		};
		await expect(verifyLivePermissions("org/repo", probe)).rejects.toThrow(
			"GitHub runner readiness failed (403); live workflow execution unproven",
		);
		expect(calls).toHaveLength(2);
	});
	it("fails before querying runners when repository identity is inaccessible", async () => {
		const calls: string[] = [];
		const probe = async (path: string) => {
			calls.push(path);
			return Response.json({ message: "Forbidden" }, { status: 403 });
		};
		await expect(verifyLivePermissions("org/repo", probe)).rejects.toThrow(
			/repository readiness failed \(403\)/,
		);
		expect(calls).toEqual(["repos/org/repo"]);
	});
	it("rejects a response for the wrong repository", async () => {
		const probe = async () =>
			Response.json({ id: 202, full_name: "org/other" });
		await expect(verifyLivePermissions("org/repo", probe)).rejects.toThrow(
			/identity mismatch/,
		);
	});
});
