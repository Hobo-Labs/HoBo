import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ShellHost } from "../src/interactive-shell.js";
import { slashItemForInput } from "../src/interactive-shell.js";
import { loopbackFetchUrl } from "../src/occupancy-endpoints.js";
import { createDefaultShellHost } from "../src/shell-host.js";

// The interactive shell's `/sessions serve` (no `--host`) runs `session
// serve`, whose answer is to start the loopback session browser, which
// `hobo-code session serve` then does. The shell printed that answer and
// started nothing. It now starts the browser, shows where it is, and closes it
// with the shell.

const roots: string[] = [];
const hosts: ShellHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose?.();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

/** Whether anything answers at `url` (the browser's named URL, on loopback). */
async function answers(url: string): Promise<boolean> {
	try {
		const response = await fetch(loopbackFetchUrl(url));
		await response.arrayBuffer();
		return true;
	} catch {
		return false;
	}
}

describe("the shell's /sessions serve", () => {
	it("starts the session browser, shows where it is, and closes it with the shell", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-shell-serve-"));
		roots.push(root);
		const hoboHome = join(root, "home");
		const project = join(root, "project");
		mkdirSync(project);
		const host = createDefaultShellHost({
			hoboHome,
			cwd: project,
			env: { PATH: process.env.PATH ?? "", HOBO_HOME: hoboHome },
		});
		hosts.push(host);
		const item = slashItemForInput("/sessions serve");
		expect(item?.argv).toEqual(["session", "serve"]);
		const text = await host.runVerb(item?.argv ?? []);
		const browser = /^browser: (\S+)$/mu.exec(text)?.[1];
		expect(browser, text).toBeDefined();
		expect(text).toMatch(/^evidence report: /mu);
		expect(await answers(browser ?? "")).toBe(true);
		await host.dispose?.();
		expect(await answers(browser ?? "")).toBe(false);
	}, 60_000);
});
