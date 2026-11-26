import { readFile } from "node:fs/promises";

import { collectBindleManifest, parseManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import { describe, expect, it } from "vitest";

import { parseIncidentReport, statusApi } from "../src/api.js";
import definition from "../src/bindle.js";
import { statusWeb } from "../src/webapp.js";

describe("self-host-yard bindle", () => {
	it("wires status web -> status api", () => {
		expect(Object.keys(definition.resources)).toEqual(["api", "web"]);
		expect(definition.edges).toEqual([{ from: "web", to: "api" }]);
	});

	it("parses at the boundary: a derived IncidentReport or a typed refusal", () => {
		const parsed = parseIncidentReport({
			component: " event-store ",
			note: "disk latency",
		});
		expect(parsed.component).toBe("event-store");
		expect(parsed.note).toBe("disk latency");
		expect(() => parseIncidentReport({ component: "", note: "x" })).toThrow(
			TypeError,
		);
		expect(() => parseIncidentReport("event-store")).toThrow(TypeError);
	});

	it("serves the status page and accepts a parsed incident", async () => {
		const bound = definition.entrypoint("api");
		expect(bound).toBeTypeOf("function");
		// SAFETY: assertion to `bound?.() as typeof statusApi` is required at this boundary.
		const fetchHandler = bound?.() as typeof statusApi;

		const status = await fetchHandler(
			new Request("http://self-host-yard.test/status"),
		);
		expect(status.status).toBe(200);
		// SAFETY: assertion to `(await status.json()) as { components: { component: string }[]; }` is required at this boundary.
		const page = (await status.json()) as {
			components: { component: string }[];
		};
		expect(page.components.map((entry) => entry.component)).toEqual([
			"yard-control-plane",
			"event-store",
			"status-api",
		]);

		const accepted = await fetchHandler(
			new Request("http://self-host-yard.test/incidents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ component: "event-store", note: "disk full" }),
			}),
		);
		expect(accepted.status).toBe(202);
		expect(await accepted.json()).toMatchObject({
			component: "event-store",
			note: "disk full",
		});

		const refused = await fetchHandler(
			new Request("http://self-host-yard.test/incidents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ component: "", note: "" }),
			}),
		);
		expect(refused.status).toBe(400);
	});

	it("serves the status web page", async () => {
		const response = statusWeb(new Request("http://self-host-yard.test/"));
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("self-host-yard");
	});

	it("compiles deterministically through the loader adapter, matching the committed manifest artifact", async () => {
		const first = collectBindleManifest(targetFromBindleDefinition(definition));
		const second = collectBindleManifest(
			targetFromBindleDefinition(definition),
		);

		expect(first.bindleId).toBe("self-host-yard");
		expect(first.resources).toEqual(["api", "web"]);
		expect(second.manifestHash).toBe(first.manifestHash);
		expect(second.manifest).toEqual(first.manifest);

		// The committed hobo.bindle.json (what `hobo plan`/`up`/`down` read from
		// this project dir) is exactly the source compile — one manifest, two
		// representations, and it still parses through the manifest boundary.
		// SAFETY: assertion to `ON.parse( await readFile(new URL("../hobo.bindle.json", import.meta.url), "utf8"), ) as unknown; ` is required at this boundary.
		const artifact = JSON.parse(
			await readFile(new URL("../hobo.bindle.json", import.meta.url), "utf8"),
		) as unknown;
		expect(artifact).toEqual(first.manifest.value);
		expect(parseManifest(artifact).value).toEqual(first.manifest.value);
	});
});
