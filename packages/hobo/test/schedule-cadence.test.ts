import { readFileSync } from "node:fs";
import path from "node:path";

import { bindle, cadence, collectBindleManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import { createRegistryFromProviders, plan } from "@hobo/cloud";
import { renderPulumiYamlProgram } from "@hobo/iac-pulumi";
import {
	createCloudflareProvider,
	realizeResourcePlans,
} from "@hobo/provider-cloudflare";
import { describe, expect, it } from "vitest";

import { relayPlatformDrift } from "../src/ci-up-relay.js";
import { toRegistrableProvider } from "../src/compose.js";

function planned(definition: ReturnType<typeof bindle>) {
	const manifest = collectBindleManifest(
		targetFromBindleDefinition(definition),
	).manifest;
	const result = plan(
		manifest,
		{ deploymentId: "cadence" },
		createRegistryFromProviders([
			toRegistrableProvider(createCloudflareProvider()),
		]),
	);
	if (!result.ok) throw new Error(JSON.stringify(result.remediations));
	return result.plan.resources;
}

describe("a schedule's cadence, from the Bindle to the provider", () => {
	it("plans a Worker's Cron Trigger with its cadence and target, and renders it", () => {
		const app = bindle("cadence-app", (b) => {
			const api = b.api();
			const tick = b.schedule().dependsOn(api).with(cadence("*/5 * * * *"));
			return { api, tick };
		});
		const nodes = planned(app);
		const tick = nodes.find((node) => node.name === "tick");
		expect(tick).toMatchObject({
			port: "schedule",
			productId: "cloudflare.cron-triggers/v1",
			realizationParameters: { cron: "*/5 * * * *", target: "api" },
		});
		const { iac } = realizeResourcePlans(
			nodes.map((node) => ({
				...node,
				deps: [...node.deps],
				...(node.realizationParameters !== undefined
					? { realizationParameters: { ...node.realizationParameters } }
					: undefined),
			})),
		);
		const trigger = iac.resources.find((resource) => resource.name === "tick");
		if (trigger === undefined) throw new Error("no trigger realized");
		const yaml = renderPulumiYamlProgram(trigger, { accountId: "acct" });
		expect(yaml).toContain("type: cloudflare:WorkersCronTrigger");
		expect(yaml).toContain('"scriptName":"api"');
		expect(yaml).toContain('"schedules":[{"cron":"*/5 * * * *"}]');
	});

	it("does not run a schedule on a queue as a Cron Trigger", () => {
		const app = bindle("cadence-queue", (b) => {
			const jobs = b.queue().allow("enqueue", "dequeue");
			const tick = b.schedule().dependsOn(jobs).with(cadence("*/15 * * * *"));
			return { jobs, tick };
		});
		const nodes = planned(app);
		const { iac } = realizeResourcePlans(
			nodes.map((node) => ({
				...node,
				deps: [...node.deps],
				...(node.realizationParameters !== undefined
					? { realizationParameters: { ...node.realizationParameters } }
					: undefined),
			})),
		);
		const trigger = iac.resources.find((resource) => resource.name === "tick");
		if (trigger === undefined) throw new Error("no trigger realized");
		expect(() =>
			renderPulumiYamlProgram(trigger, { accountId: "acct" }),
		).toThrow(/Workers script/u);
	});
});

describe("the relay's vercel.json against its plan", () => {
	const RELAY = new URL("../../ci-vercel/", import.meta.url).pathname;

	it("holds the schedule and queue consumers the relay's Bindle declares", async () => {
		expect(await relayPlatformDrift(RELAY)).toEqual([]);
	});

	it("names the difference when the cadence in vercel.json drifts", async () => {
		const committed = JSON.parse(
			readFileSync(path.join(RELAY, "vercel.json"), "utf8"),
		);
		committed.schedules["hobo-ci-repair"].schedule = "0 * * * *";
		expect(
			await relayPlatformDrift(RELAY, async () => JSON.stringify(committed)),
		).toEqual([
			'vercel.json schedules.hobo-ci-repair must be { "schedule": "*/15 * * * *", "topic": "hobo-ci" }',
		]);
	});
});
