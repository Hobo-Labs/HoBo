import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BindleDefinition, bindle } from "@hobo/bindles";
import { afterEach, describe, expect, it } from "vitest";

import { resolveBindlePlacement } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function unconfiguredHome(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hobo-placement-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

const simple = () =>
	bindle("shop", (b) => {
		const api = b.api();
		return { api };
	});

function providerPinned(): BindleDefinition {
	const pinned = { ...simple(), provider: "aws" };
	return pinned;
}

describe("a Bindle that selects a provider", () => {
	it("is rejected rather than thrown", async () => {
		const placement = await resolveBindlePlacement({
			definition: providerPinned(),
			hoboHome: await unconfiguredHome(),
			yard: null,
		});
		expect(placement.outcome).toBe("rejected");
	});

	it("carries a machine-readable reason on the placement plane", async () => {
		const placement = await resolveBindlePlacement({
			definition: providerPinned(),
			hoboHome: await unconfiguredHome(),
			yard: null,
		});
		const reasons = placement.resolution.rejection?.reasons ?? [];
		expect(reasons).toHaveLength(1);
		expect(reasons[0]?.plane).toBe("placement");
		expect(reasons[0]?.code).toBe("bindle-provider-selection-forbidden");
		expect(placement.resolution.rejection?.requestId).toBe(
			"bindle-provider-check",
		);
	});

	it("tells the operator what to do instead", async () => {
		const placement = await resolveBindlePlacement({
			definition: providerPinned(),
			hoboHome: await unconfiguredHome(),
			yard: null,
		});
		expect(placement.remediation?.length ?? 0).toBeGreaterThan(1);
		expect(placement.remediation?.join(" ")).toMatch(/Yard/u);
	});

	it("refuses before checking runtimes", async () => {
		const definition = {
			...bindle("shop", (b) => {
				const redis = b.container({ image: "redis:7" });
				const api = b.api().withReference(redis);
				return { redis, api };
			}),
			provider: "aws",
		};
		const placement = await resolveBindlePlacement({
			definition,
			hoboHome: await unconfiguredHome(),
			yard: null,
		});
		expect(placement.message).not.toMatch(/runtime\(s\)/u);
	});
});

describe("describing a context that does not exist yet", () => {

	async function rejectionWithNoYard(campId?: string) {
		const options = {
			definition: providerPinned(),
			hoboHome: await unconfiguredHome(),
			yard: null,
		};
		return resolveBindlePlacement(
			campId === undefined ? options : { ...options, campId },
		);
	}

	it("names the yard 'local' when none is configured", async () => {
		expect((await rejectionWithNoYard()).yardName).toBe("local");
	});

	it("still reports a component host", async () => {
		const placement = await rejectionWithNoYard();
		expect(placement.componentHost).toEqual(expect.any(String));
		expect(placement.componentHost.length).toBeGreaterThan(0);
	});

	it("marks the camp 'unplaced' when the caller named none", async () => {
		expect((await rejectionWithNoYard()).campId).toBe("unplaced");
	});

	it("keeps a caller-supplied camp id even in a rejection", async () => {
		expect((await rejectionWithNoYard("camp-7")).campId).toBe("camp-7");
	});

	it("reports no provider and no explicit provider pins", async () => {
		const placement = await rejectionWithNoYard();
		expect(placement.providerId).toBe("none");
		expect(placement.explicitProviders).toEqual([]);
	});

	it("marks the broker uninitialized rather than inventing an id", async () => {
		const placement = await rejectionWithNoYard();
		expect(placement.brokerId).toBe("uninitialized");
		expect(placement.resolution.rejection?.brokerId).toBe("uninitialized");
	});

	it("emits no events for a placement that never reached the broker", async () => {
		expect((await rejectionWithNoYard()).resolution.events).toEqual([]);
	});
});
