import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { browserEnvironment } from "../src/browser-environment.js";

it("omits secret-shaped values even under an allowed desktop name", () => {
	expect(
		browserEnvironment({
			PATH: "/usr/bin",
			HOME: "https://user:password@example.invalid",
			OTHER: "opaque-credential",
		}),
	).toEqual({ PATH: "/usr/bin" });
});

it.skipIf(process.platform !== "linux")(
	"opens setup without passing credentials or loader settings to the browser opener",
	async () => {
		const work = mkdtempSync(path.join(tmpdir(), "hobo-browser-opener-"));
		const resultFile = path.join(work, "received");
		const quotedFile = `'${resultFile.replaceAll("'", "'\\''")}'`;
		writeFileSync(
			path.join(work, "xdg-open"),
			`#!/bin/sh\nprintf '%s\\n' "${"${INNOCENT_ENV-unset}"}" "${"${INFISICAL_TOKEN-unset}"}" "${"${NODE_OPTIONS-unset}"}" "${"${LD_PRELOAD-unset}"}" "${"${BROWSER-unset}"}" "$DISPLAY" "$HOME" > ${quotedFile}\n`,
			{ mode: 0o755 },
		);
		try {
			const launched = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					'import { openInBrowser } from "./src/prepare.ts"; process.env.NODE_OPTIONS = "--no-warnings"; process.env.LD_PRELOAD = "fake-loader"; process.env.BROWSER = "fake-browser"; openInBrowser("https://example.invalid");',
				],
				{
					cwd: fileURLToPath(new URL("../", import.meta.url)),
					encoding: "utf8",
					env: {
						PATH: work,
						HOME: work,
						DISPLAY: ":3",
						INNOCENT_ENV: "opaque-credential",
						INFISICAL_TOKEN: "fake-token",
					},
				},
			);
			expect(launched.status, launched.stderr).toBe(0);
			for (let attempt = 0; attempt < 150; attempt++) {
				if (existsSync(resultFile) && readFileSync(resultFile, "utf8")) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(readFileSync(resultFile, "utf8").trimEnd().split("\n")).toEqual([
				"unset",
				"unset",
				"unset",
				"unset",
				"unset",
				":3",
				work,
			]);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	},
);
