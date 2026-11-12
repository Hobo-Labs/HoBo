import { existsSync, readdirSync, readFileSync } from "node:fs";
import { assertNoBindleProviderSelection } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import relay, {
	RELAY_REPAIR_SCHEDULE,
	RELAY_RESOURCES,
	relayCache,
	relayConfig,
	relayConfigService,
} from "../src/bindle.js";
import { RELAY_QUEUE_TOPICS } from "../src/relay-queue.js";

// The relay's HoBo declaration (`src/bindle.ts`) against the relay itself: the
// platform configuration Vercel reads (`vercel.json`), the entry files, and the
// settings the deployed code reads. A name changed on one side and not the
// other fails here.

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
	it("is an HTTP entry, three queues, a schedule, a cache and a config service: no database", () => {
		expect(relay.name).toBe("hobo-ci-relay");
		expect(kinds).toEqual({
			[RELAY_RESOURCES.http]: "api",
			[RELAY_RESOURCES.queue]: "queue",
			[RELAY_RESOURCES.intake]: "queue",
			[RELAY_RESOURCES.steps]: "queue",
			[RELAY_RESOURCES.schedule]: "schedule",
			[RELAY_RESOURCES.cache]: "kv",
			[RELAY_RESOURCES.config]: "secret",
		});
		expect(Object.values(kinds)).not.toContain("data");
		for (const topic of [
			RELAY_RESOURCES.queue,
			RELAY_RESOURCES.intake,
			RELAY_RESOURCES.steps,
		])
			expect(relay.resources[topic]?.declaredAllow).toEqual([
				"enqueue",
				"dequeue",
			]);
		expect(relay.resources[RELAY_RESOURCES.config]?.declaredAllow).toEqual([
			"access",
		]);
		expect(relay.resources[RELAY_RESOURCES.cache]?.declaredAllow).toEqual([
			"get",
			"set",
			"delete",
		]);
		expect(relay.edges).toEqual(
			expect.arrayContaining([
				{ from: RELAY_RESOURCES.http, to: RELAY_RESOURCES.cache },
				{ from: RELAY_RESOURCES.http, to: RELAY_RESOURCES.config },
				{ from: RELAY_RESOURCES.http, to: RELAY_RESOURCES.queue },
				{ from: RELAY_RESOURCES.http, to: RELAY_RESOURCES.intake },
				{ from: RELAY_RESOURCES.http, to: RELAY_RESOURCES.steps },
				{ from: RELAY_RESOURCES.schedule, to: RELAY_RESOURCES.queue },
			]),
		);
	});

	it("names no provider", () => {
		expect(() => assertNoBindleProviderSelection(relay)).not.toThrow();
		const declared = JSON.stringify({
			relay,
			relayConfig,
			relayCache,
			relayConfigService,
		});
		expect(declared).not.toMatch(
			/vercel|neon|upstash|valkey|infisical|aws|azure|gcp|cloudflare|netlify|railway|postgres/iu,
		);
	});

	it("asks for the cache as a capability: Redis semantics with TTL, increment and compare-and-set", () => {
		expect(relayCache.requiredProfiles.map((p) => p.profileId)).toEqual([
			"kv.redis-compatible/v1",
		]);
		const required = relayCache.features
			.filter((feature) => feature.necessity === "required")
			.map((feature) => feature.key);
		expect(required.sort()).toEqual([
			"atomicCompareAndSet",
			"atomicIncrement",
			"ttl",
		]);
	});

	it("reads its config service and never writes it", () => {
		expect(relayConfigService).toMatchObject({
			access: "read-only",
			authentication: "workload-identity",
		});
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
	it("consumes each declared queue topic from its own queue entry", () => {
		const triggers = Object.entries(platform.functions ?? {}).flatMap(
			([file, settings]) =>
				(settings.experimentalTriggers ?? [])
					.filter((trigger) => trigger.type.startsWith("queue/"))
					.map((trigger) => ({ file, topic: trigger.topic })),
		);
		expect(triggers).toEqual([
			{ file: "api/queue.ts", topic: RELAY_RESOURCES.queue },
			{ file: "api/intake.ts", topic: RELAY_RESOURCES.intake },
			{ file: "api/lease-steps.ts", topic: RELAY_RESOURCES.steps },
		]);
		for (const { file } of triggers) {
			expect(existsSync(new URL(file, packageUrl)), file).toBe(true);
			expect(text(file), file).toContain('from "../src/entry.js"');
		}
	});

	it("routes every request to the declared HTTP entry", () => {
		const destinations = (platform.routes ?? []).map((route) => route.dest);
		expect(destinations).toEqual([`/api/${RELAY_RESOURCES.http}`]);
		expect(
			existsSync(new URL(`api/${RELAY_RESOURCES.http}.ts`, packageUrl)),
		).toBe(true);
	});

	it("sends every queue message to a declared topic, and names repairs after the schedule", () => {
		expect(RELAY_QUEUE_TOPICS).toEqual({
			repair: RELAY_RESOURCES.queue,
			intake: RELAY_RESOURCES.intake,
			steps: RELAY_RESOURCES.steps,
		});
		// Every send names a topic from RELAY_QUEUE_TOPICS, never a literal.
		const sources = readdirSync(new URL("src/", packageUrl))
			.filter((name) => name.endsWith(".ts") && name !== "bindle.ts")
			.map((name) => text(`src/${name}`));
		for (const source of sources) expect(source).not.toMatch(/\.send\(\s*"/u);
		const queueSource = text("src/relay-queue.ts");
		const names = [...queueSource.matchAll(/\bname:\s*"([^"]+)"/gu)].map(
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

describe("the declared settings and the deployed code agree", () => {
	// Every HOBO_CI_* and CRON_SECRET name the deployed code mentions: the
	// sources the queue and HTTP entries reach through their imports. Code
	// off that path (the PostgreSQL composition and the Neon broker, removed
	// in phase 7) is not deployed and declares nothing here.
	const SETTING =
		/\b(?:HOBO_CI_[A-Z0-9_]+|CRON_SECRET|DATABASE_URL(?:_UNPOOLED)?)\b/gu;
	const reached = new Set<string>();
	const pending = readdirSync(new URL("api/", packageUrl)).map(
		(name) => `api/${name}`,
	);
	while (pending.length > 0) {
		const file = pending.pop();
		if (!file || reached.has(file)) continue;
		reached.add(file);
		for (const match of text(file).matchAll(
			/from\s+"(\.{1,2}\/[^"]+)\.js"/gu,
		)) {
			const target = new URL(`${match[1]}.ts`, new URL(file, packageUrl));
			const relative = target.pathname.slice(packageUrl.pathname.length);
			if (existsSync(target) && !relative.startsWith("src/_generated"))
				pending.push(relative);
		}
	}
	const read = new Set(
		[...reached].flatMap((file) => text(file).match(SETTING) ?? []),
	);

	it("reaches the stateless composition and not the PostgreSQL one", () => {
		expect(reached).toContain("src/stateless-composition.ts");
		expect(reached).not.toContain("src/composition.ts");
		expect(reached).not.toContain("src/relay-composition.ts");
		expect(reached).not.toContain("src/runtime-config-client.ts");
		expect([...read].filter((name) => name.startsWith("DATABASE_URL"))).toEqual(
			[],
		);
	});

	it("declares exactly the settings the deployed code reads", () => {
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
				"CRON_SECRET",
				"HOBO_CI_CONFIG_JSON",
				"HOBO_CI_SANDBOX_PROXY_TOKEN_KEY",
			]),
		);
		// A secret is never a value set at deploy time.
		for (const [name, field] of fields)
			expect(field.source === "camp-value", name).toBe(!field.sensitive);
	});
});
