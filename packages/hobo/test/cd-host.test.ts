/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof -- SAFETY: Yard fixtures are partial records cast once to the type under test. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampManagement, PromotionState } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import {
	loadDeliveryFile,
	loadRecordsOf,
	parseDeliveryModule,
} from "../src/cd-delivery-module.js";
import { cdRefused, cdWire, parseCdFormat } from "../src/cd-render.js";
import { openCdStore } from "../src/cd-store.js";
import {
	CD_MANAGEMENT_LABEL,
	mergeTopologyReaders,
	staticTopologyReader,
	TopologyConflictError,
	yardTopology,
} from "../src/cd-topology.js";
import { createServeControlCommand } from "../src/serve-control-command.js";
import { promotion, refusal, runInput } from "./support/cd-fakes.js";

function yard(
	name: string,
	camps: { id: string; envType: string; labels?: Record<string, string> }[],
) {
	return {
		kind: "yard",
		name,
		providerId: "vercel",
		regions: ["us-east-1", "us-west-2"],
		labels: { team: "web" },
		camps: camps.map((c) => ({
			kind: "camp",
			id: c.id,
			envType: c.envType,
			labels: c.labels ?? {},
		})),
	} as never;
}

describe("CD topology from Yards (TopologyReader)", () => {
	it("projects Yard-scoped Camps with declared regions only, sorted", () => {
		const camps = yardTopology(
			[
				yard("edge", [
					{ id: "prod", envType: "production" },
					{
						id: "dev",
						envType: "development",
						labels: { [CD_MANAGEMENT_LABEL]: "observe-only" },
					},
				]),
			],
			"st1",
		);
		expect(camps.map((c) => c.campId)).toEqual(["edge/dev", "edge/prod"]);
		expect(camps[1]).toMatchObject({
			yardId: "edge",
			stationId: "st1",
			provider: "vercel",
			regions: ["us-east-1", "us-west-2"],
			envType: "production",
			labels: { team: "web" },
			management: CampManagement.MANAGED,
		});
		expect(camps[0]?.management).toBe(CampManagement.OBSERVE_ONLY);
	});

	it("refuses a Camp declared by two sources instead of overriding", async () => {
		const camps = yardTopology(
			[yard("edge", [{ id: "prod", envType: "production" }])],
			"st1",
		);
		expect(() => staticTopologyReader([...camps, ...camps])).toThrow(
			TopologyConflictError,
		);
		const merged = mergeTopologyReaders([
			staticTopologyReader(camps),
			staticTopologyReader(camps),
		]);
		await expect(merged.camps()).rejects.toThrow(/cd-topology-duplicate-camp/);
	});

	it("merges readers and looks Camps up by id", async () => {
		const a = staticTopologyReader(
			yardTopology([yard("a", [{ id: "x", envType: "dev" }])], "s"),
		);
		const b = staticTopologyReader(
			yardTopology([yard("b", [{ id: "y", envType: "dev" }])], "s"),
		);
		const merged = mergeTopologyReaders([a, b]);
		expect((await merged.camps()).map((c) => c.campId)).toEqual(["a/x", "b/y"]);
		expect((await merged.camp("b/y" as never))?.yardId).toBe("b");
	});
});

describe("CD journal (store selection)", () => {
	it("opens SQLite under the configured path and appends/reads durably", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cd-store-"));
		const opened = await openCdStore(
			{ backend: "sqlite", path: join(dir, "cd", "journal.sqlite") },
			{ now: () => 1_000 },
		);
		expect(opened.backend).toBe("sqlite");
		await opened.store.append(
			"cd-camp-a",
			[{ type: "set.Created", data: { a: 1 } }],
			{
				expectedSeq: 0,
				actor: { kind: "system", id: "t" },
				tenant: "t1",
			},
		);
		const read = [];
		for await (const e of opened.store.readAll()) read.push(e.event.type);
		expect(read).toEqual(["set.Created"]);
		await opened.close();
	});

	it("the memory journal (--simulate) uses the same engine", async () => {
		const opened = await openCdStore(
			{ backend: "memory", simulated: true },
			{ now: () => 1 },
		);
		expect(opened.backend).toBe("memory");
		expect(typeof opened.store.readAll).toBe("function");
		await opened.close();
	});
});

describe("CD rendering", () => {
	it("parses --format and defaults from --json", () => {
		expect(parseCdFormat({})).toEqual({ ok: true, format: "text" });
		expect(parseCdFormat({ json: true })).toEqual({ ok: true, format: "json" });
		expect(parseCdFormat({ format: "json" })).toEqual({
			ok: true,
			format: "json",
		});
		expect(parseCdFormat({ format: "xml" })).toEqual({
			ok: false,
			value: "xml",
		});
	});

	it("serializes records, bigints and nested values to JSON", () => {
		const wire = cdWire({
			p: promotion({ state: PromotionState.FAILED }),
			n: 5n,
			skip: undefined,
			list: [1, "a"],
		});
		expect(wire).toMatchObject({
			p: { promotionId: "prm-1", state: "PROMOTION_STATE_FAILED" },
			n: "5",
			list: [1, "a"],
		});
		expect(wire).not.toHaveProperty("skip");
	});

	it("a refusal without remediation still names a next step", () => {
		const out = cdRefused({
			reasons: refusal("x", "").reasons,
			subcommand: "promote",
			format: "text",
		});
		expect(out.remediation).toEqual(["hobo deploy promote --help"]);
	});
});

describe("delivery as code", () => {
	it("parses records with the generated schemas and refuses wrong types", () => {
		const ok = parseDeliveryModule({
			default: { pipelines: [{ name: "web", bindle: "web" }] },
		});
		expect(ok.ok && ok.value.pipelines[0]?.name).toBe("web");
		const bad = parseDeliveryModule({ pipelines: [{ name: 7 }] });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.message).toMatch(/pipelines\[0\]/);
		const notArray = parseDeliveryModule({ sources: { name: "x" } });
		expect(notArray.ok).toBe(false);
	});

	it("reads a single-record JSON file or an exports JSON file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cd-delivery-"));
		await writeFile(
			join(dir, "w.json"),
			JSON.stringify({ name: "freeze", kind: "WINDOW_KIND_FREEZE" }),
		);
		await writeFile(
			join(dir, "all.json"),
			JSON.stringify({ windows: [{ name: "a" }, { name: "b" }] }),
		);
		const one = await loadRecordsOf("windows", "w.json", { cwd: dir });
		expect(one.ok && one.value.map((w) => w.name)).toEqual(["freeze"]);
		const many = await loadRecordsOf("windows", "all.json", { cwd: dir });
		expect(many.ok && many.value.map((w) => w.name)).toEqual(["a", "b"]);
		const missing = await loadDeliveryFile("nope.json", { cwd: dir });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.code).toBe("delivery-module-unreadable");
	});

	it("loads a real hobo.delivery.ts module through tsx", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cd-delivery-ts-"));
		// A delivery module lives in an ES-module package, as in this repository.
		// Without a package.json the .ts file's module format is ambiguous, and in
		// the shared test worker an earlier file's tsx registration could compile
		// it as CommonJS and evaluate it as ESM (`__filename is not defined`).
		await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
		await writeFile(
			join(dir, "hobo.delivery.ts"),
			'const pipelines: { name: string; bindle: string }[] = [{ name: "web", bindle: "web" }];\nexport { pipelines };\n',
		);
		const loaded = await loadDeliveryFile("hobo.delivery.ts", { cwd: dir });
		expect(loaded.ok && loaded.value.pipelines.map((p) => p.name)).toEqual([
			"web",
		]);
	});
});

describe("hobo serve cd", () => {
	it("starts the conductor service through serve-control-command and reports its URL", async () => {
		const started: Record<string, unknown>[] = [];
		const cmd = createServeControlCommand({
			env: {},
			hoboHome: "/tmp/h",
			once: true,
			log: () => {},
			serveCd: async (input) => {
				started.push({ simulate: input.simulate, port: input.port });
				return {
					ok: true,
					url: "http://127.0.0.1:9",
					port: 9,
					close: async () => {},
				};
			},
		});
		const out = await cmd.run(runInput(["cd"], { simulate: true }));
		expect(out).toMatchObject({ ok: true, code: "HOBO_SERVE_CD_BOUND" });
		expect(started).toEqual([{ simulate: true, port: 8791 }]);
	});

	it("a refused composition is a typed refusal with remediation", async () => {
		const cmd = createServeControlCommand({
			env: {},
			hoboHome: "/tmp/h",
			once: true,
			serveCd: async () => ({
				ok: false,
				code: "compose-store-multinode",
				message: "2 replicas",
				remediation: ["Set HOBO_CD_POSTGRES_URL."],
			}),
		});
		const out = await cmd.run(runInput(["cd"]));
		expect(out).toMatchObject({
			ok: false,
			code: "compose-store-multinode",
			remediation: ["Set HOBO_CD_POSTGRES_URL."],
		});
	});

	it("names both targets on an unknown one", async () => {
		const out = await createServeControlCommand({ env: {} }).run(
			runInput(["nope"]),
		);
		expect(out.message).toMatch(/control, cd/);
	});
});
