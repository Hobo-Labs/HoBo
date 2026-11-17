import { readdirSync, readFileSync } from "node:fs";

import { capability } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { CD_TICK_SCHEDULE } from "../../hobo-cd/src/bindle.js";
import cdYard, {
	CD_PLACEMENT,
	CD_PLATFORM,
	cdJunction,
} from "../deploy/yard.js";

// The CD Yard, vercel.json and the CD Bindle say the same thing.

const packageUrl = new URL("../", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, packageUrl), "utf8");

type PlatformConfig = {
	functions: Record<
		string,
		{
			maxDuration?: number;
			experimentalTriggers?: { type: string; topic: string }[];
			includeFiles?: string;
		}
	>;
	schedules: Record<string, { schedule: string; topic: string }>;
};
// SAFETY: vercel.json is this package's own committed platform configuration.
const platform = JSON.parse(text("vercel.json")) as PlatformConfig;

describe("HoBo.CD on Vercel: Yard, platform and Bindle agree", () => {
	it("schedules the tick at the Bindle's cadence, onto the tick's topic", () => {
		expect(CD_PLATFORM.cron).toBe(CD_TICK_SCHEDULE.cron);
		expect(platform.schedules).toEqual({
			[CD_PLATFORM.schedule]: {
				schedule: CD_PLATFORM.cron,
				topic: CD_PLATFORM.topic,
			},
		});
		expect(
			platform.functions[CD_PLATFORM.tickEntry]?.experimentalTriggers,
		).toEqual([{ type: "queue/v2beta", topic: CD_PLATFORM.topic }]);
	});

	it("gives each entry the Yard's duration and the committed store binding", () => {
		for (const entry of [CD_PLATFORM.httpEntry, CD_PLATFORM.tickEntry]) {
			expect(platform.functions[entry]?.maxDuration).toBe(
				CD_PLATFORM.maxDuration,
			);
			expect(platform.functions[entry]?.includeFiles).toBe(
				"deploy/secret-store.binding.json",
			);
		}
	});

	it("names the project Vercel builds from this directory", () => {
		expect(cdYard.providerId).toBe("vercel");
		expect(cdYard.properties).toMatchObject({
			project: CD_PLACEMENT.project,
			rootDirectory: CD_PLACEMENT.rootDirectory,
		});
		expect(CD_PLACEMENT.rootDirectory).toBe("packages/cd-vercel");
	});

	it("joins the journal and config Yards, which hold their own rows", () => {
		const names = cdJunction.yards.map((yard) => yard.name);
		expect(names).toEqual(["hobo-cd", "hobo-cd-journal", "hobo-cd-config"]);
		const profiles = cdYard.bindings.map((row) => row.profile);
		expect(profiles).toContain(capability.api.http);
		expect(profiles).toContain(capability.service.scheduled);
		expect(profiles).not.toContain(capability.data.postgres);
	});

	it("keeps the declaration out of what the functions import", () => {
		for (const dir of ["api", "src", "src/_generated"])
			for (const entry of readdirSync(new URL(`${dir}/`, packageUrl), {
				withFileTypes: true,
			}))
				if (entry.isFile())
					expect(text(`${dir}/${entry.name}`)).not.toMatch(/deploy\/yard/u);
	});
});
