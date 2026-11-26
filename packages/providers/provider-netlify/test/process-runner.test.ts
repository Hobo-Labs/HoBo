/**
 * The subprocess boundary.
 *
 * The anonymous deploy path is a CLI invocation, so argv *is* the attack
 * surface. These tests are the reason there is no string form of the API: a
 * hostile site name has to come out the other side as one inert element, and
 * the only way to be sure of that is to look at the array.
 */
import { describe, expect, it } from "vitest";

import {
	ANONYMOUS_ENV_ALLOWLIST,
	anonymousDeployEnv,
	assertInertArgument,
	buildAnonymousDeployArgv,
	isNetlifyProviderError,
	NETLIFY_CLI_PACKAGE,
	NETLIFY_CLI_PACKAGE_SPEC,
	NETLIFY_CLI_VERSION,
	PERMANENT_CREDENTIAL_ENV_KEYS,
} from "../src/index.js";

/** Payloads that would be catastrophic through a shell. */
const HOSTILE_SITE_NAMES = [
	"; rm -rf /",
	"$(id)",
	"`id`",
	"site && curl evil.example",
	"site | tee /etc/passwd",
	"site\nnewline",
	"site$IFS$9",
] as const;

const HOSTILE_PUBLISH_DIRS = [
	"../../etc/passwd",
	"dist/../../../root",
	"dist; rm -rf /",
	"dist$(whoami)",
] as const;

describe("the CLI version is pinned, not floating", () => {
	it("names one exact release", () => {
		expect(NETLIFY_CLI_VERSION).toBe("27.1.1");
		expect(NETLIFY_CLI_PACKAGE).toBe("netlify-cli");
		expect(NETLIFY_CLI_PACKAGE_SPEC).toBe("netlify-cli@27.1.1");
	});

	it("passes the pin to npx as a package spec, not as a bare name", () => {
		const argv = buildAnonymousDeployArgv({ publishDir: "dist" });
		expect(argv).toContain(NETLIFY_CLI_PACKAGE_SPEC);
		// A bare `netlify-cli` would resolve to whatever is cached, which is the
		// unpinned behaviour this constant exists to prevent.
		expect(argv).not.toContain(NETLIFY_CLI_PACKAGE);
	});

	it("puts the CLI's own arguments after `--`, so npx cannot claim them", () => {
		const argv = buildAnonymousDeployArgv({ publishDir: "dist" });
		const separator = argv.indexOf("--");
		expect(separator).toBeGreaterThan(0);
		expect(argv.indexOf("deploy")).toBeGreaterThan(separator);
		expect(argv.indexOf("--allow-anonymous")).toBeGreaterThan(separator);
	});
});

describe("the documented anonymous flags are the ones actually sent", () => {
	it("deploys anonymously, without a build, in JSON", () => {
		const argv = buildAnonymousDeployArgv({ publishDir: "dist" });
		expect(argv).toContain("--allow-anonymous");
		expect(argv).toContain("--json");
		// The pre-claim profile is prebuilt static assets; running a build here
		// would execute repository-authored commands on the anonymous path.
		expect(argv).toContain("--no-build");
		expect(argv[argv.indexOf("--dir") + 1]).toBe("dist");
	});
});

describe("a hostile site name is one inert argv element", () => {
	for (const siteName of HOSTILE_SITE_NAMES) {
		it(`passes ${JSON.stringify(siteName)} through untouched and unsplit`, () => {
			const argv = buildAnonymousDeployArgv({ publishDir: "dist", siteName });

			// One element, byte for byte what the caller asked for. Not escaped,
			// not quoted, not rewritten — there is no shell to escape it for.
			const occurrences = argv.filter((element) => element === siteName);
			expect(occurrences).toHaveLength(1);
			expect(argv[argv.indexOf("--site-name") + 1]).toBe(siteName);

			// Nothing leaked into a neighbouring element: no element merely
			// *contains* the payload, which is what string concatenation and
			// shell splitting would both produce.
			const contaminated = argv.filter(
				(element) => element !== siteName && element.includes(siteName),
			);
			expect(contaminated).toEqual([]);
		});
	}

	it("keeps shell metacharacters out of every other element", () => {
		const argv = buildAnonymousDeployArgv({
			publishDir: "dist",
			siteName: "; rm -rf /",
			deployMessage: "$(id) && echo pwned",
		});
		const structural = argv.filter(
			(element) =>
				element !== "; rm -rf /" && element !== "$(id) && echo pwned",
		);
		for (const element of structural) {
			expect(element).not.toMatch(/[;`$|&\n]/u);
		}
	});
});

describe("a path-traversal publish directory is an argument, not a command", () => {
	for (const publishDir of HOSTILE_PUBLISH_DIRS) {
		it(`passes ${JSON.stringify(publishDir)} as a single element`, () => {
			const argv = buildAnonymousDeployArgv({ publishDir });
			expect(argv.filter((element) => element === publishDir)).toHaveLength(1);
			expect(argv[argv.indexOf("--dir") + 1]).toBe(publishDir);
		});
	}

	it("leaves traversal semantics to the runner's cwd, not to string surgery", () => {
		// Rewriting the path would deploy a directory the caller did not name.
		// The value survives; confinement is the runner's `cwd`.
		const argv = buildAnonymousDeployArgv({ publishDir: "../../etc/passwd" });
		expect(argv).toContain("../../etc/passwd");
	});
});

describe("argument arrays stop shell injection but not option injection", () => {
	it("refuses a site name that would be read as a flag", () => {
		// `--prod` in a value position is the injection argv cannot prevent.
		expect(() =>
			buildAnonymousDeployArgv({ publishDir: "dist", siteName: "--prod" }),
		).toThrowError(/option injection/u);
	});

	it("refuses a publish directory that would be read as a flag", () => {
		expect(() =>
			buildAnonymousDeployArgv({ publishDir: "--cwd=/" }),
		).toThrowError(/option injection/u);
	});

	it("refuses a null byte, which execve would truncate at", () => {
		expect(() =>
			buildAnonymousDeployArgv({ publishDir: "dist\u0000/etc/passwd" }),
		).toThrowError(/null byte/u);
	});

	it("refuses an empty publish directory", () => {
		expect(() => buildAnonymousDeployArgv({ publishDir: "" })).toThrowError(
			/must not be empty/u,
		);
	});

	it("bounds a site name at the DNS label length Netlify can host", () => {
		expect(() =>
			buildAnonymousDeployArgv({
				publishDir: "dist",
				siteName: "a".repeat(64),
			}),
		).toThrowError(/63 character limit/u);
	});

	it("reports refusals as typed provider errors", () => {
		try {
			assertInertArgument("--prod", "site name");
			expect.unreachable("a flag-shaped value must be refused");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			expect(isNetlifyProviderError(error)).toBe(true);
			if (isNetlifyProviderError(error)) {
				expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
			}
		}
	});

	it("checks rather than sanitizes, so an accepted value is unchanged", () => {
		expect(assertInertArgument("; rm -rf /", "site name")).toBe("; rm -rf /");
	});
});

describe("an anonymous deploy cannot see a Netlify credential", () => {
	it("drops every permanent credential from the child environment", () => {
		const env = anonymousDeployEnv({
			PATH: "/usr/bin",
			HOME: "/home/hobo",
			NETLIFY_AUTH_TOKEN: "FAKE-not-a-real-token-0000",
			NETLIFY_ACCESS_TOKEN: "FAKE-not-a-real-token-0001",
			NETLIFY_TOKEN: "FAKE-not-a-real-token-0002",
			NETLIFY_API_TOKEN: "FAKE-not-a-real-token-0003",
			AWS_SECRET_ACCESS_KEY: "FAKE-not-a-real-key-0004",
		});

		for (const key of PERMANENT_CREDENTIAL_ENV_KEYS) {
			expect(env[key]).toBeUndefined();
		}
		// An allowlist, so an unrelated ambient secret is also absent without
		// anyone having had to think of it.
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(Object.values(env).join("|")).not.toMatch(/FAKE-not-a-real/u);
	});

	it("keeps only the allowlisted variables plus non-interactive defaults", () => {
		const env = anonymousDeployEnv({ PATH: "/usr/bin", HOME: "/home/hobo" });
		expect(env.PATH).toBe("/usr/bin");
		expect(env.CI).toBe("1");
		expect(env.NETLIFY_CLI_TELEMETRY_DISABLED).toBe("1");
		for (const key of Object.keys(env)) {
			const knownKeys: readonly string[] = [
				...ANONYMOUS_ENV_ALLOWLIST,
				"CI",
				"NETLIFY_CLI_TELEMETRY_DISABLED",
				"NO_COLOR",
			];
			const known = knownKeys.includes(key);
			expect(known, `unexpected variable ${key}`).toBe(true);
		}
	});

	it("would make a claimable site secretly owned if a token leaked in", () => {
		// Documents the consequence the allowlist prevents: an authenticated
		// deploy still succeeds, so no test downstream would notice.
		const env = anonymousDeployEnv({ NETLIFY_AUTH_TOKEN: "FAKE-token" });
		expect(env.NETLIFY_AUTH_TOKEN).toBeUndefined();
	});
});
