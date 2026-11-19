import { existsSync, readdirSync, readFileSync } from "node:fs";

import { capability } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CD_TICK_SCHEDULE } from "../../hobo-cd/src/bindle.js";
import cdYard, {
	CD_PLACEMENT,
	CD_PLATFORM,
	cdJunction,
} from "../deploy/yard.js";

const packageUrl = new URL("../", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, packageUrl), "utf8");

const PlatformConfig = z.object({
	functions: z.record(
		z.string(),
		z.object({
			maxDuration: z.number().optional(),
			experimentalTriggers: z
				.array(
					z.object({
						type: z.string(),
						topic: z.string(),
						maxConcurrency: z.number().optional(),
					}),
				)
				.optional(),
			includeFiles: z.string().optional(),
		}),
	),
	schedules: z.record(
		z.string(),
		z.object({ schedule: z.string(), topic: z.string() }),
	),
	rewrites: z
		.array(z.object({ source: z.string(), destination: z.string() }))
		.optional(),
	routes: z
		.array(
			z.object({
				src: z.string(),
				dest: z.string(),
				transforms: z
					.array(
						z.object({
							type: z.string(),
							op: z.string(),
							args: z.string(),
						}),
					)
					.optional(),
			}),
		)
		.optional(),
});
const platform = PlatformConfig.parse(JSON.parse(text("vercel.json")));

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
		).toEqual([
			{
				type: "queue/v2beta",
				topic: CD_PLATFORM.topic,
				maxConcurrency: CD_PLATFORM.maxConcurrency,
			},
		]);
		expect(CD_PLATFORM.maxConcurrency).toBe(1);
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

	it("declares production and preview camps for git delivery", () => {
		expect(cdYard.camps.map((camp) => camp.id)).toEqual([
			"hobo-cd/production",
			"hobo-cd/preview",
		]);
		expect(cdYard.camps.map((camp) => camp.envType)).toEqual([
			"production",
			"preview",
		]);
	});

	it("routes every request path to the real HTTP entry", () => {
		expect(platform.rewrites).toBeUndefined();
		expect(platform.routes).toEqual([
			{
				src: "/(.*)",
				dest: "/api/cd",
				transforms: [{ type: "request.path", op: "set", args: "/$1" }],
			},
		]);
		const destination = platform.routes?.[0]?.dest ?? "";
		expect(destination).toBe(
			`/api/${CD_PLATFORM.httpEntry.replace(/^api\//u, "").replace(/\.ts$/u, "")}`,
		);
		expect(existsSync(new URL(CD_PLATFORM.httpEntry, packageUrl))).toBe(true);
		expect(text(CD_PLATFORM.httpEntry)).toContain('from "../src/entry.js"');
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
