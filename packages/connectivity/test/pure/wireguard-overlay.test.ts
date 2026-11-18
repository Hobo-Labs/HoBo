import { parseTenantId } from "@hobo/core";
import { describe, expect, it, vi } from "vitest";

import {
	createWireguardOverlay,
	type WireguardRunner,
} from "../../src/overlay/wireguard.js";

const tenantId = parseTenantId("tenant-a");

describe("wireguard overlay", () => {
	it("reads an existing interface", async () => {
		const run = vi.fn<WireguardRunner>((command) =>
			command === "wg"
				? { ok: true, stdout: "private\tpublic-key\t51820\toff\n", stderr: "" }
				: {
						ok: true,
						stdout: JSON.stringify([
							{ addr_info: [{ local: "10.42.0.2" }, { local: "fd42::2" }] },
						]),
						stderr: "",
					},
		);
		const overlay = createWireguardOverlay({ run });

		const result = await overlay.join({
			tenantId,
			hostname: "yard-a",
			tags: [],
		});

		expect(result).toMatchObject({
			provider: "wireguard",
			ready: true,
			identity: {
				nodeId: "wireguard:public-key",
				overlayIps: ["10.42.0.2", "fd42::2"],
			},
		});
	});

	it("starts and stops a configured interface", async () => {
		let active = false;
		const run = vi.fn<WireguardRunner>((command, args) => {
			if (command === "wg-quick") {
				active = args[0] === "up";
				return { ok: true, stdout: "", stderr: "" };
			}
			if (command === "wg") {
				return active
					? {
							ok: true,
							stdout: "private\tpublic-key\t51820\toff\n",
							stderr: "",
						}
					: { ok: false, stdout: "", stderr: "missing" };
			}
			return { ok: true, stdout: "[]", stderr: "" };
		});
		const overlay = createWireguardOverlay({
			configPath: "/etc/wireguard/hobo0.conf",
			run,
		});

		expect(
			await overlay.join({ tenantId, hostname: "yard-a", tags: [] }),
		).toMatchObject({ ready: true });
		await overlay.leave();

		expect(run).toHaveBeenCalledWith("wg-quick", [
			"down",
			"/etc/wireguard/hobo0.conf",
		]);
	});

	it("fails closed when the interface is unavailable", async () => {
		const overlay = createWireguardOverlay({
			run: () => ({ ok: false, stdout: "", stderr: "missing" }),
		});

		const result = await overlay.join({
			tenantId,
			hostname: "yard-a",
			tags: [],
		});

		expect(result.ready).toBe(false);
		expect(result.notes).toContain("missing");
	});
});
