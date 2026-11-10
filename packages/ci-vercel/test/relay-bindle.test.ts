import { existsSync, readdirSync, readFileSync } from "node:fs";
import { assertNoBindleProviderSelection } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import relay, {
	RELAY_REPAIR_SCHEDULE,
	RELAY_RESOURCES,
	relayConfig,
	relayState,
} from "../src/bindle.js";

// The relay's HoBo declaration (`src/bindle.ts`) against the relay itself: the
// platform configuration Vercel reads (`vercel.json`), the entry files, and the
// settings the source reads. A name changed on one side and not the other
// fails here.

const packageUrl = new URL("../", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, packageUrl), "utf8");

interface PlatformConfig {
	readonly functions?: Readonly<
		Record<
			string,
			{
				readonly experimentalTriggers?: readonly {
					readonly type: string;
					readonly topic?: string;
				}[];
			}
		>
	>;
	readonly routes?: readonly { readonly dest?: string }[];
	readonly schedules?: Readonly<
		Record<string, { readonly schedule: string; readonly topic: string }>
	>;
	readonly crons?: readonly { readonly schedule: string }[];
}

// SAFETY: vercel.json is this package's own committed platform configuration.
const platform = JSON.parse(text("vercel.json")) as PlatformConfig;

const kinds = Object.fromEntries(
	Object.values(relay.resources).map((resource) => [
		resource.name,
		resource.kind,
	]),
);

describe("the relay declared as a HoBo app", () => {
	it("is an HTTP entry, a queue, a schedule, state and a secret store", () => {
		expect(relay.name).toBe("hobo-ci-relay");
		expect(kinds).toEqual({
			[RELAY_RESOURCES.http]: "api",
			[RELAY_RESOURCES.queue]: "queue",
			[RELAY_RESOURCES.schedule]: "schedule",
			[RELAY_RESOURCES.state]: "data",
			[RELAY_RESOURCES.secrets]: "secret",
		});
		expect(relay.resources[RELAY_RESOURCES.queue]?.declaredAllow).toEqual([
			"enqueue",
			"dequeue",
		]);
		expect(relay.resources[RELAY_RESOURCES.secrets]?.declaredAllow).toEqual([
			"access",
		]);
		expect(relay.edges).toEqual(
			expect.arrayContaining([
				{ from: RELAY_RESOURCES.http, to: RELAY_RESOURCES.state },
				{ from: RELAY_RESOURCES.http, to: RELAY_RESOURCES.secrets },
				{ from: RELAY_RESOURCES.http, to: RELAY_RESOURCES.queue },
				{ from: RELAY_RESOURCES.schedule, to: RELAY_RESOURCES.queue },
			]),
		);
	});

	it("names no provider", () => {
		expect(() => assertNoBindleProviderSelection(relay)).not.toThrow();
		const declared = JSON.stringify({ relay, relayConfig, relayState });
		expect(declared).not.toMatch(
			/vercel|neon|aws|azure|gcp|cloudflare|netlify|railway/iu,
		);
	});

	it("asks for PostgreSQL state as a capability, not a product", () => {
		expect(relayState.requiredProfiles.map((p) => p.profileId)).toEqual([
			"data.postgres/v1",
		]);
		const required = relayState.features
			.filter((feature) => feature.necessity === "required")
			.map((feature) => feature.key);
		expect(required.sort()).toEqual([
			"connectivityTransports",
			"jsonb",
			"pooling",
		]);
	});
});

describe("the declaration is not deployed code", () => {
	it("is imported by no entry file and no other source, and is left out of the build", () => {
		const importsIt = /from\s+"[^"]*\/bindle\.js"/u;
		const files = [
			...readdirSync(new URL("api/", packageUrl)).map((name) => `api/${name}`),
			...readdirSync(new URL("src/", packageUrl), { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name !== "bindle.ts")
				.map((entry) => `src/${entry.name}`),
		];
		expect(files.length).toBeGreaterThan(2);
		for (const file of files) expect(text(file), file).not.toMatch(importsIt);
		// The build Vercel runs compiles `src` without it, so it needs neither
		// @hobo/bindles nor @hobo/data-postgres (devDependencies here).
		// SAFETY: tsconfig.json is this package's own committed configuration.
		const build = JSON.parse(text("tsconfig.json")) as {
			readonly exclude?: readonly string[];
		};
		expect(build.exclude).toEqual(["src/bindle.ts"]);
	});
});

describe("the declaration and the platform configuration agree", () => {
	it("consumes the declared queue topic from the queue entry", () => {
		const triggers = Object.entries(platform.functions ?? {}).flatMap(
			([file, settings]) =>
				(settings.experimentalTriggers ?? [])
					.filter((trigger) => trigger.type.startsWith("queue/"))
					.map((trigger) => ({ file, topic: trigger.topic })),
		);
		expect(triggers).toEqual([
			{ file: "api/queue.ts", topic: RELAY_RESOURCES.queue },
		]);
		expect(existsSync(new URL("api/queue.ts", packageUrl))).toBe(true);
	});

	it("routes every request to the declared HTTP entry", () => {
		const destinations = (platform.routes ?? []).map((route) => route.dest);
		expect(destinations).toEqual([`/api/${RELAY_RESOURCES.http}`]);
		expect(
			existsSync(new URL(`api/${RELAY_RESOURCES.http}.ts`, packageUrl)),
		).toBe(true);
	});

	it("sends every queue message to the declared topic, and names repairs after the schedule", () => {
		const entry = text("src/entry.ts");
		const topics = [...entry.matchAll(/queue\.send\(\s*"([^"]+)"/gu)].map(
			(match) => match[1],
		);
		expect(topics.length).toBeGreaterThan(0);
		expect(new Set(topics)).toEqual(new Set([RELAY_RESOURCES.queue]));
		const names = [...entry.matchAll(/\bname:\s*"([^"]+)"/gu)].map(
			(match) => match[1],
		);
		expect(names.length).toBeGreaterThan(0);
		expect(new Set(names)).toEqual(new Set([RELAY_REPAIR_SCHEDULE.name]));
		expect(text("data-models/queue.cue")).toContain(
			`name: "${RELAY_REPAIR_SCHEDULE.name}"`,
		);
	});

	it("declares the repair schedule every 15 minutes, on the queue", () => {
		expect(RELAY_REPAIR_SCHEDULE).toEqual({
			name: "hobo-ci-repair",
			cron: "*/15 * * * *",
			topic: "hobo-ci",
		});
		expect(RELAY_REPAIR_SCHEDULE.name).toBe(RELAY_RESOURCES.schedule);
		expect(RELAY_REPAIR_SCHEDULE.topic).toBe(RELAY_RESOURCES.queue);

		// On this branch `vercel.json` declares no schedule: the hosted relay is
		// ticked by an external trigger calling `GET /internal/tick`, and
		// `test/scheduled-repair.test.ts` pins that. A platform schedule, when
		// `vercel.json` gains one, must be this one and no other: the same name,
		// cadence and topic.
		if (platform.schedules !== undefined) {
			expect(platform.schedules).toEqual({
				[RELAY_REPAIR_SCHEDULE.name]: {
					schedule: RELAY_REPAIR_SCHEDULE.cron,
					topic: RELAY_REPAIR_SCHEDULE.topic,
				},
			});
		}
		// A cron entry would be a second, unauthenticated way to run the repair.
		for (const cron of platform.crons ?? []) {
			expect(cron.schedule).toBe(RELAY_REPAIR_SCHEDULE.cron);
		}
	});
});

describe("the declared settings and the source agree", () => {
	// Every HOBO_CI_*, CRON_SECRET and DATABASE_URL* name the relay's own source
	// mentions. The broker's HOBO_BROKER_* settings belong to another deployable.
	const SETTING =
		/\b(?:HOBO_CI_[A-Z0-9_]+|CRON_SECRET|DATABASE_URL(?:_UNPOOLED)?)\b/gu;
	const sources = readdirSync(new URL("src/", packageUrl), {
		withFileTypes: true,
	})
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => entry.name)
		.filter((name) => name !== "bindle.ts");
	const read = new Set(
		sources.flatMap((name) => text(`src/${name}`).match(SETTING) ?? []),
	);

	it("declares exactly the settings the source reads", () => {
		expect(Object.keys(relayConfig.fields).sort()).toEqual([...read].sort());
	});

	it("marks every credential a secret, and gives none a value", () => {
		const fields = Object.entries(relayConfig.fields);
		const secrets = fields
			.filter(([, field]) => field.sensitive)
			.map(([name]) => name);
		// A name that says what it holds is a secret here too.
		for (const [name, field] of fields) {
			if (/TOKEN|SECRET|KEY|PASSWORD|DATABASE_URL/u.test(name))
				expect(field.sensitive, name).toBe(true);
			expect(field.defaultValue, name).toBeUndefined();
		}
		expect(secrets).toEqual(
			expect.arrayContaining([
				"DATABASE_URL",
				"DATABASE_URL_UNPOOLED",
				"CRON_SECRET",
				"HOBO_CI_CONFIG_JSON",
			]),
		);
		// A secret is never a value set at deploy time.
		for (const [name, field] of fields)
			expect(field.source === "camp-value", name).toBe(!field.sensitive);
	});
});
