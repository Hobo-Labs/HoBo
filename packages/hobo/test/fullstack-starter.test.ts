import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHobo } from "@hobo/cli";
import { expect, it } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { serveProjectOnLocalYard } from "../src/wasm-host.js";

it("serves and updates the fullstack starter through the local yard", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-fullstack-starter-"));
	try {
		const scaffold = await runHobo(["new", "notes", "-t", "fullstack"], {
			cwd: root,
		});
		expect(scaffold.exitCode).toBe(0);
		const hoboHome = join(root, "home");
		initBareMetalYard({ hoboHome, componentHost: "local" });
		const server = await serveProjectOnLocalYard({
			projectDir: join(root, "notes"),
			hoboHome,
			port: 0,
			componentHost: "local",
		});
		try {
			const home = await fetch(`${server.primaryUrl}/`);
			expect(home.status).toBe(200);
			expect(home.headers.get("content-type")).toContain("text/html");
			expect(await home.text()).toContain("Your first note lives here.");

			const saved = await fetch(`${server.primaryUrl}/note`, {
				method: "POST",
				body: new URLSearchParams({ message: "Coffee & tea" }),
				redirect: "manual",
			});
			expect(saved.status).toBe(303);
			expect(saved.headers.get("location")).toBe("/?saved=1");
			const updated = await fetch(`${server.primaryUrl}/?saved=1`);
			const updatedPage = await updated.text();
			expect(updatedPage).toContain("Coffee &amp; tea");
			expect(updatedPage).toContain("Note saved.");

			const invalid = await fetch(`${server.primaryUrl}/note`, {
				method: "POST",
				body: new URLSearchParams({ message: " " }),
			});
			expect(invalid.status).toBe(400);
			const api = await fetch(`${server.primaryUrl}/app`);
			expect(await api.json()).toEqual({
				template: "fullstack",
				path: "/app",
				record: { key: "home", value: { message: "Coffee & tea" } },
			});
		} finally {
			await server.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
