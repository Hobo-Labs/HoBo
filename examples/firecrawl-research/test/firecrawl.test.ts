import { createStationBindleRuntimeContext } from "@hobo/stations";
import { describe, expect, it, vi } from "vitest";

import {
	createFirecrawlResearchBindle,
	type FirecrawlClient,
} from "../src/bindle.js";
import definition from "../src/bindle.js";

describe("firecrawl-research", () => {
	it("declares Firecrawl as a connector rather than a resource", () => {
		expect(Object.keys(definition.resources)).toEqual(["api"]);
		expect(definition.connectors?.firecrawl).toEqual({
			kind: "connector",
			name: "firecrawl",
			target: "firecrawl",
			origin: "https://api.firecrawl.dev",
			auth: {
				protocol: "auth.md",
				discovery: "https://www.firecrawl.dev/auth.md",
			},
			allow: ["search"],
		});
		expect(definition.resources.api?.dependsOn).toContain("connector:firecrawl");
		expect(definition.edges).toContainEqual({
			from: "api",
			to: "connector:firecrawl",
		});
	});

	it("asks the Station for a Connection token before using the vendor SDK", async () => {
		const apiKeys: string[] = [];
		const search = vi.fn(async () => ({
			success: true,
			data: {
				web: [{ title: "HoBo", url: "https://example.com/hobo" }],
			},
		}));
		const createClient = (options: { apiKey: string }): FirecrawlClient => {
			apiKeys.push(options.apiKey);
			return { search };
		};
		const injected = createFirecrawlResearchBindle(createClient);

		const issueToken = vi.fn(async () => ({
			token: "station-issued-firecrawl-token",
			tokenRef: "token:firecrawl:1",
			expiresAt: "2026-08-07T16:00:00.000Z",
			connectionId: "connection:org-firecrawl",
		}));
		const resolve = vi.fn(() => ({
			ref: "connection:org-firecrawl",
			token: issueToken,
		}));

		const runtime = createStationBindleRuntimeContext({
			stationId: "station:developer",
			connections: { resolve },
		});

		const factory = injected.entrypoint("api");
		expect(factory).toBeTypeOf("function");
		// SAFETY: assertion to `factory?.(runtime) as ( request: Request, ) => Promise<Response>` is required at this boundary.
		const handler = factory?.(runtime) as (
			request: Request,
		) => Promise<Response>;
		const response = await handler(
			new Request("https://app.example/research?q=HoBo"),
		);

		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledWith({
			stationId: "station:developer",
			target: "firecrawl",
			origin: "https://api.firecrawl.dev",
			authDiscovery: "https://www.firecrawl.dev/auth.md",
			capabilities: ["search"],
		});
		expect(issueToken).toHaveBeenCalledWith({ action: "search" });
		expect(apiKeys).toEqual(["station-issued-firecrawl-token"]);
		expect(search).toHaveBeenCalledWith("HoBo", { limit: 5 });
	});

	it("rejects an empty research query before resolving a Connection", async () => {
		const resolve = vi.fn();
		const runtime = createStationBindleRuntimeContext({
			stationId: "station:developer",
			connections: { resolve },
		});
		// SAFETY: assertion to `definition.entrypoint("api")?.(runtime) as ( request: Request, ) => Promise<Response>` is required at this boundary.
		const handler = definition.entrypoint("api")?.(runtime) as (
			request: Request,
		) => Promise<Response>;

		const response = await handler(new Request("https://app.example/research"));
		expect(response.status).toBe(400);
		expect(resolve).not.toHaveBeenCalled();
	});
});
