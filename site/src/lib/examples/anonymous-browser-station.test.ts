import { describe, expect, it } from "vitest";

import { createAnonymousBrowserStation } from "./anonymous-browser-station.js";

describe("anonymous browser Environment Station", () => {
	it("provisions a blob station endpoint with no bridge or Bindle", () => {
		const host = createAnonymousBrowserStation({
			stationId: "station:browser:test:cloudflare",
			targetId: "cloudflare",
			yardId: "yard:cloudflare",
			label: "Cloudflare",
			capabilities: ["http", "kv", "queue", "container"],
		});
		expect(host.endpointUrl.startsWith("blob:")).toBe(true);
		expect(() => host.revoke()).not.toThrow();
	});
});
