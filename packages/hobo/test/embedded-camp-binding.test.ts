import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindle } from "@hobo/bindles";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { resolveBindlePlacement } from "../src/broker-runtime.js";

describe("embedded Camp binding", () => {
	async function place(campId: string) {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-embedded-camp-"));
		try {
			initBareMetalYard({ hoboHome, componentHost: "local" });
			return await resolveBindlePlacement({
				definition: bindle("camp-test", (b) => ({ api: b.api() })),
				hoboHome,
				providerId: "@hobo/provider-local-host",
				campId,
			});
		} finally {
			await rm(hoboHome, { recursive: true, force: true });
		}
	}

	it("returns the same explicit Camp as the authorized Yard receipt", async () => {
		const result = await place("camp:blue");
		expect(result.outcome).toBe("resolved");
		expect(result.campId).toBe(result.yardPlacement?.selectedCampId);
		expect(result.campId).toMatch(/\/camp:blue$/);
	});

	it("rejects an explicit Camp in a different Yard", async () => {
		const result = await place("yard:foreign/camp:prod");
		expect(result.outcome).toBe("rejected");
		expect(result.yardPlacement).toBeUndefined();
	});

	it("keeps the requested Camp when the caller changes its options during startup", async () => {
		const hoboHome = await mkdtemp(
			join(tmpdir(), "hobo-embedded-camp-change-"),
		);
		try {
			initBareMetalYard({ hoboHome, componentHost: "local" });
			let changed = false;
			const options = {
				definition: bindle("camp-test", (b) => ({ api: b.api() })),
				hoboHome,
				providerId: "@hobo/provider-local-host",
				campId: "camp:blue",
				emitProgress: () => {
					changed = true;
					options.campId = "yard:foreign/camp:prod";
				},
			};
			const result = await resolveBindlePlacement(options);
			expect(changed).toBe(true);
			expect(result.outcome).toBe("resolved");
			expect(result.campId).toMatch(/\/camp:blue$/);
			expect(result.campId).toBe(result.yardPlacement?.selectedCampId);
		} finally {
			await rm(hoboHome, { recursive: true, force: true });
		}
	});

	it("reports the original Camp when a changed request is rejected", async () => {
		const hoboHome = await mkdtemp(
			join(tmpdir(), "hobo-embedded-camp-rejection-"),
		);
		try {
			initBareMetalYard({ hoboHome, componentHost: "local" });
			const options = {
				definition: bindle("camp-test", (b) => ({ api: b.api() })),
				hoboHome,
				providerId: "@hobo/provider-local-host",
				campId: "yard:foreign/camp:prod",
				emitProgress: () => {
					options.campId = "camp:blue";
				},
			};
			const result = await resolveBindlePlacement(options);
			expect(result.outcome).toBe("rejected");
			expect(result.campId).toBe("yard:foreign/camp:prod");
		} finally {
			await rm(hoboHome, { recursive: true, force: true });
		}
	});

	it("returns the authorized Camp for generated local identities", async () => {
		const hoboHome = await mkdtemp(
			join(tmpdir(), "hobo-embedded-camp-generated-"),
		);
		try {
			initBareMetalYard({ hoboHome, componentHost: "local" });
			const definition = bindle("camp-test", (b) => ({ api: b.api() }));
			await fc.assert(
				fc.asyncProperty(
					fc.array(fc.constantFrom("a", "b", "c", "0", "1"), {
						minLength: 1,
						maxLength: 8,
					}),
					async (characters) => {
						const campId = `camp:${characters.join("")}`;
						const result = await resolveBindlePlacement({
							definition,
							hoboHome,
							providerId: "@hobo/provider-local-host",
							campId,
						});
						expect(result.outcome).toBe("resolved");
						expect(result.campId).toBe(`yard:local/${campId}`);
						expect(result.campId).toBe(result.yardPlacement?.selectedCampId);
					},
				),
				{ seed: 614_586, numRuns: 20 },
			);
		} finally {
			await rm(hoboHome, { recursive: true, force: true });
		}
	}, 120_000);
});
