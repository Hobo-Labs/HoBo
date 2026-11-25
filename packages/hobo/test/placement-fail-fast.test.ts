/**
 * The two refusals `resolveBindlePlacement` makes before it touches anything.
 *
 * Both run ahead of yard equipping and toolchain downloads, and that ordering
 * is the point: a Bindle that names a provider, or needs a runtime this yard
 * does not have, is wrong no matter what the toolchain says, and finding out
 * after a wasmtime download is a worse experience for the same answer.
 *
 * `runtime-requirements.test.ts` covers the missing-runtime refusal against a
 * yard that has been initialised. This file covers the other refusal — a Bindle
 * that selects a provider — and, for both, the case where **no yard is
 * configured at all**.
 *
 * That second half is where the untested code was. Every existing placement
 * test calls `initBareMetalYard` first, so `yardConfig` is never null, and the
 * whole set of fallbacks a rejection uses to describe a context that does not
 * exist yet — `yardConfig?.name ?? "local"`, `?.componentHost ?? DEFAULT`,
 * `campId ?? "unplaced"` — went unexercised. A rejection is a document an
 * operator reads and tooling parses; it has to be complete even when it is
 * describing the absence of a yard, because `undefined` in those fields is
 * exactly the state a first-run user is in.
 *
 * **Provider selection is a refusal, not an error.** It comes back as a
 * `rejected` PlacementResult with a reason code and remediation, rather than a
 * thrown exception, so the CLI can print it the same way it prints every other
 * placement rejection.
 */
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
	// Deliberately NOT initBareMetalYard: this is a first-run HOBO_HOME, which
	// is the state the fallbacks below exist for.
	const dir = await mkdtemp(join(tmpdir(), "hobo-placement-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

const simple = () =>
	bindle("shop", (b) => {
		const api = b.api();
		return { api };
	});

/** The same definition with a provider pinned onto it, as an authored one may be. */
function providerPinned(): BindleDefinition {
	const pinned = { ...simple(), provider: "aws" };
	return pinned;
}

describe("a Bindle that selects a provider", () => {
	it("is rejected rather than thrown", async () => {
		// The CLI prints rejections; an exception here would escape that path and
		// surface as an internal error instead of a placement answer.
		const placement = await resolveBindlePlacement({
			definition: providerPinned(),
			hoboHome: await unconfiguredHome(),
			yard: null,
		});
		expect(placement.outcome).toBe("rejected");
	});

	it("carries a machine-readable reason on the placement plane", async () => {
		// Tooling branches on the code, not the message.
		const placement = await resolveBindlePlacement({
			definition: providerPinned(),
			hoboHome: await unconfiguredHome(),
			yard: null,
		});
		const reasons = placement.resolution.rejection?.reasons ?? [];
		expect(reasons).toHaveLength(1);
		expect(reasons[0]?.plane).toBe("placement");
		expect(reasons[0]?.code).toBe("bindle-provider-selection-forbidden");
		// The receipt names the check that refused, so a rejection can be traced
		// to the gate that produced it rather than to placement in general.
		expect(placement.resolution.rejection?.requestId).toBe(
			"bindle-provider-check",
		);
	});

	it("tells the operator what to do instead", async () => {
		// A refusal without a remedy just relocates the problem. The remediation
		// has to name the alternative -- declare a provider-specific Yard -- not
		// only the prohibition.
		const placement = await resolveBindlePlacement({
			definition: providerPinned(),
			hoboHome: await unconfiguredHome(),
			yard: null,
		});
		expect(placement.remediation?.length ?? 0).toBeGreaterThan(1);
		expect(placement.remediation?.join(" ")).toMatch(/Yard/u);
	});

	it("refuses before checking runtimes", async () => {
		// Ordering matters: a Bindle that both pins a provider and needs an
		// uninstalled runtime must report the provider pin, because that is the
		// error the author can act on without installing anything.
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
	// Every existing placement test initialises a yard first, so these
	// fallbacks -- the ones a first-run user actually hits -- were unexercised.

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
		// Not undefined: the field is printed and serialised, and "undefined" in
		// a rejection reads as a bug rather than as "you have no yard yet".
		expect((await rejectionWithNoYard()).yardName).toBe("local");
	});

	it("still reports a component host", async () => {
		const placement = await rejectionWithNoYard();
		expect(placement.componentHost).toEqual(expect.any(String));
		expect(placement.componentHost.length).toBeGreaterThan(0);
	});

	it("marks the camp 'unplaced' when the caller named none", async () => {
		// The honest word for it. A generated camp id here would imply a
		// placement that never happened.
		expect((await rejectionWithNoYard()).campId).toBe("unplaced");
	});

	it("keeps a caller-supplied camp id even in a rejection", async () => {
		// So the operator can tell which of several attempted placements this
		// rejection belongs to.
		expect((await rejectionWithNoYard("camp-7")).campId).toBe("camp-7");
	});

	it("reports no provider and no explicit provider pins", async () => {
		// 'none' rather than the provider the Bindle asked for: reporting the
		// refused value as the resolved one would be actively misleading.
		const placement = await rejectionWithNoYard();
		expect(placement.providerId).toBe("none");
		expect(placement.explicitProviders).toEqual([]);
	});

	it("marks the broker uninitialized rather than inventing an id", async () => {
		// No broker was consulted -- the refusal happens before one is started --
		// and the rejection says so on both the result and the receipt.
		const placement = await rejectionWithNoYard();
		expect(placement.brokerId).toBe("uninitialized");
		expect(placement.resolution.rejection?.brokerId).toBe("uninitialized");
	});

	it("emits no events for a placement that never reached the broker", async () => {
		// An event stream implies something happened. Nothing did.
		expect((await rejectionWithNoYard()).resolution.events).toEqual([]);
	});
});
