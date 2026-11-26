import type { ConnectorBinding } from "@hobo/bindles";
import { describe, expect, it, vi } from "vitest";

import { createStationBindleRuntimeContext } from "../src/connector-context.js";

const binding: ConnectorBinding = {
	kind: "connector",
	definition: {
		kind: "connector-definition",
		id: "firecrawl",
		origin: "https://api.firecrawl.dev",
		auth: {
			protocol: "auth.md",
			discovery: "https://www.firecrawl.dev/auth.md",
		},
		capabilities: ["search"],
	},
	declaredAllow: ["search"],
	allow() {
		return this;
	},
};

describe("Station Bindle connector runtime", () => {
	it("resolves the declaration through Station Connection inventory", async () => {
		const token = vi.fn(async () => ({
			token: "short-lived",
			tokenRef: "token:1",
			expiresAt: "2026-08-07T16:00:00.000Z",
			connectionId: "connection:org",
		}));
		const resolve = vi.fn(() => ({ ref: "connection:org", token }));
		const runtime = createStationBindleRuntimeContext({
			stationId: "station:home",
			connections: { resolve },
		});

		const connection = runtime.connector(binding);
		await connection.token({ action: "search" });

		expect(resolve).toHaveBeenCalledWith({
			stationId: "station:home",
			target: "firecrawl",
			origin: "https://api.firecrawl.dev",
			authDiscovery: "https://www.firecrawl.dev/auth.md",
			capabilities: ["search"],
		});
		expect(token).toHaveBeenCalledWith({ action: "search" });
	});
});
