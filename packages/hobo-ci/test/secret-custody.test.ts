import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTrustedVault } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	browserEnvironment,
	ignoredSecretEnvNotice,
	SECRET_ENV_NAMES,
	scopeRunVault,
	secretEnvNames,
	withoutSecretEnv,
} from "../src/secret-custody.js";

const packages = fileURLToPath(new URL("../../", import.meta.url));

/** The lifecycle code that must never read a secret from the environment. */
const LIFECYCLE_SOURCES = [
	"hobo-ci/src",
	"hobo-cd/src",
	"connect-ui/src",
	"hobo/src/cd-store.ts",
	"hobo/src/cd-runtime.ts",
	"hobo/src/ci-relay-deploy.ts",
	"hobo/src/ci-relay-deploy-credential.ts",
	"hobo/src/provider-ceremony.ts",
];

function files(entry: string): string[] {
	const full = path.join(packages, entry);
	if (statSync(full).isFile()) return [full];
	return readdirSync(full, { recursive: true })
		.map((name) => path.join(full, String(name)))
		.filter((name) => /\.tsx?$/u.test(name) && !name.includes("_generated"));
}

describe("secret custody", () => {
	it("omits secret-shaped values even under an allowed desktop name", () => {
		expect(
			browserEnvironment({
				PATH: "/usr/bin",
				HOME: "https://user:password@example.invalid",
				OTHER: "opaque-credential",
			}),
		).toEqual({ PATH: "/usr/bin" });
	});

	it("refuses late writes after a run ends and wipes its underlying vault", () => {
		const underlying = createTrustedVault();
		const scope = scopeRunVault(underlying);
		scope.put("TOKEN", "run-secret");
		scope.clear();
		expect(underlying.names()).toEqual([]);
		expect(scope.reveal("TOKEN")).toBeUndefined();
		expect(() => scope.put("TOKEN", "late-secret")).toThrow(/ended/u);
		expect(underlying.names()).toEqual([]);
	});

	it("names secrets in an environment without their values", () => {
		const env = {
			PATH: "/usr/bin",
			INFISICAL_TOKEN: "tok-value",
			service_credential: "opaque-value",
			HOBO_CD_POSTGRES_URL_NEON: "postgres://u:p@h/db",
			DATABASE_URL: "postgres://u:p@h/db",
			HOBO_CI_PUBLIC_URL: "https://ci.example",
		};
		expect(secretEnvNames(env)).toEqual([
			"DATABASE_URL",
			"HOBO_CD_POSTGRES_URL_NEON",
			"INFISICAL_TOKEN",
			"service_credential",
		]);
		expect(withoutSecretEnv(env)).toEqual({
			PATH: "/usr/bin",
			HOBO_CI_PUBLIC_URL: "https://ci.example",
		});
		const notice = ignoredSecretEnvNotice(env) ?? "";
		expect(notice).toContain("INFISICAL_TOKEN");
		expect(notice).not.toContain("tok-value");
	});

	it.skipIf(process.platform !== "linux")(
		"opens the browser without inheriting unrecognized credentials or loader settings",
		async () => {
			const work = mkdtempSync(path.join(tmpdir(), "hobo-browser-env-"));
			const resultFile = path.join(work, "received");
			// The temporary directory name is generated locally; quote it for sh.
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
						cwd: path.join(packages, "hobo-ci"),
						encoding: "utf8",
						env: {
							PATH: work,
							HOME: work,
							DISPLAY: ":3",
							INNOCENT_ENV: "an-opaque-credential",
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
		30_000,
	);

	it("no lifecycle source reads a secret from the environment", () => {
		const offenders: string[] = [];
		const read =
			/\benv(?:\??\.)\s*([A-Z][A-Z0-9_]*)|\benv\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/gu;
		for (const entry of LIFECYCLE_SOURCES)
			for (const file of files(entry)) {
				const text = readFileSync(file, "utf8");
				for (const match of text.matchAll(read)) {
					const name = match[1] ?? match[2] ?? "";
					if (
						SECRET_ENV_NAMES.has(name) ||
						name.startsWith("HOBO_CD_POSTGRES_URL_")
					)
						offenders.push(`${path.relative(packages, file)}: ${name}`);
				}
			}
		expect(offenders).toEqual([]);
	});
});
