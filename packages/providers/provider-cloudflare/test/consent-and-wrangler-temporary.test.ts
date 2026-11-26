/**
 * Consent evidence and the `wrangler deploy --temporary` driver.
 *
 * These two files sit either side of the anonymous-account path and each holds
 * a property that is invisible in its signature.
 *
 * **Consent is a recorded fact, not a constant in a request body.** Cloudflare
 * requires acceptance of its Terms and Privacy Policy before an account may be
 * created. The temptation is to hard-code `acceptTermsOfService: true` and move
 * on; what this parser enforces instead is that somebody actually accepted, that
 * the evidence names *these* documents rather than some other pair of URLs, and
 * that the subject reference is opaque. A `subjectRef` carrying an email address
 * would put a contact identifier into a ledger that a receipt is allowed to
 * quote — which is the one thing an anonymous-provisioning path must not do.
 *
 * **The wrangler driver must deploy with no credentials present.** The whole
 * point of `--temporary` is a station nobody had to authenticate to create. If a
 * developer's `CLOUDFLARE_API_TOKEN` leaked into the child environment the
 * deploy would silently land in *their real account* and stay there after the
 * temporary TTL expired — a durable resource created by a path that promises
 * nothing durable. The scrub is the safety property; the output parse is what
 * stops an apparently-successful deploy returning a station URL nothing can
 * reach.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	CLOUDFLARE_PRIVACY_URL,
	CLOUDFLARE_TERMS_URL,
	CONSENT_ACCEPTANCE_METHODS,
	createInMemoryConsentLedger,
	parseConsentEvidence,
} from "../src/temporary-account-consent.js";
import { TemporaryAccountError } from "../src/temporary-account-errors.js";
import {
	deployTemporaryWithWrangler,
	parseWranglerTemporaryOutput,
} from "../src/wrangler-temporary.js";

const VALID = {
	subjectRef: "subject-0001",
	termsUrl: CLOUDFLARE_TERMS_URL,
	privacyUrl: CLOUDFLARE_PRIVACY_URL,
	acceptedAtMs: 1_700_000_000_000,
	acceptanceMethod: "explicit-checkbox",
};

/** The reason code a `CONSENT_REQUIRED` refusal carries in its details. */
function reasonOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(TemporaryAccountError);
		expect((error as TemporaryAccountError).code).toBe("CONSENT_REQUIRED");
		return String((error as TemporaryAccountError).reason);
	}
	throw new Error("expected the consent parser to refuse this input");
}

describe("parseConsentEvidence", () => {
	it("returns the evidence when acceptance is properly recorded", () => {
		expect(parseConsentEvidence(VALID)).toEqual(VALID);
	});

	it("accepts each recognised acceptance method", () => {
		// Three methods because acceptance can happen in three places — a UI
		// checkbox, a CLI prompt, an API attestation — and a ledger entry that
		// could not say which would make an audit unable to reconstruct how the
		// user was asked.
		for (const acceptanceMethod of CONSENT_ACCEPTANCE_METHODS) {
			expect(
				parseConsentEvidence({ ...VALID, acceptanceMethod }).acceptanceMethod,
			).toBe(acceptanceMethod);
		}
	});

	it("fails closed when no evidence was recorded at all", () => {
		// The default must be refusal. Treating `undefined` as "probably fine"
		// would create an account on a user's behalf with no record that they
		// were ever asked.
		expect(reasonOf(() => parseConsentEvidence(undefined))).toBe("MISSING");
	});

	it("refuses a subject reference that is not opaque enough to be one", () => {
		for (const subjectRef of ["abc", "", "has space", "sub/ref", "ünïcode"]) {
			expect(
				reasonOf(() => parseConsentEvidence({ ...VALID, subjectRef })),
			).toBe("INVALID_SUBJECT");
		}
	});

	it("accepts a 4-character reference and refuses a 3-character one", () => {
		// The lower bound exists so a reference is long enough to be a real
		// locator rather than an initial or a single digit that would collide
		// across users.
		expect(() =>
			parseConsentEvidence({ ...VALID, subjectRef: "abcd" }),
		).not.toThrow();
		expect(
			reasonOf(() => parseConsentEvidence({ ...VALID, subjectRef: "abc" })),
		).toBe("INVALID_SUBJECT");
	});

	it("accepts a 128-character reference and refuses 129", () => {
		expect(() =>
			parseConsentEvidence({ ...VALID, subjectRef: "a".repeat(128) }),
		).not.toThrow();
		expect(
			reasonOf(() =>
				parseConsentEvidence({ ...VALID, subjectRef: "a".repeat(129) }),
			),
		).toBe("INVALID_SUBJECT");
	});

	it("refuses an email-shaped reference — but reports it as malformed, not as PII", () => {
		// FINDING, pinned rather than changed. `SUBJECT_LOOKS_LIKE_PII` is
		// unreachable. The shape check runs first and `SUBJECT_REF` is
		// `^[A-Za-z0-9._:-]{4,128}$`, which has no `@` in its character class — so
		// every email-shaped reference is rejected as INVALID_SUBJECT before the
		// `EMAIL_SHAPED` test is ever reached.
		//
		// The *refusal* is correct and the PII never lands in the ledger, so this
		// is not a leak. What is lost is the diagnosis: an operator who put an
		// email in a consent record is told their reference is malformed rather
		// than that they supplied a contact identifier, and the distinct reason
		// code that exists precisely to tell them so never appears in a log.
		//
		// Recorded here so the dead branch is not deleted as unused — the intent
		// behind it is right, and the fix is to run the PII test before the shape
		// test, not to drop it.
		expect(
			reasonOf(() =>
				parseConsentEvidence({ ...VALID, subjectRef: "user@example.com" }),
			),
		).toBe("INVALID_SUBJECT");
	});

	it("refuses evidence naming a different terms document", () => {
		// Consent is to a specific document. Evidence citing some other URL is
		// evidence that the user agreed to something else, which is worse than no
		// evidence because it looks satisfied.
		for (const termsUrl of [
			"https://example.com/terms",
			"http://www.cloudflare.com/terms/",
			`${CLOUDFLARE_TERMS_URL}?ref=x`,
			"",
		]) {
			expect(reasonOf(() => parseConsentEvidence({ ...VALID, termsUrl }))).toBe(
				"WRONG_TERMS_URL",
			);
		}
	});

	it("refuses evidence naming a different privacy document", () => {
		expect(
			reasonOf(() =>
				parseConsentEvidence({
					...VALID,
					privacyUrl: "https://example.com/privacy",
				}),
			),
		).toBe("WRONG_PRIVACY_URL");
	});

	it("refuses a timestamp that is not a positive epoch-millisecond integer", () => {
		// Zero and negatives are the tells of an uninitialised field; a fractional
		// or NaN value is a parse that already went wrong upstream. Any of them
		// would produce a ledger entry claiming acceptance at a time that never
		// happened.
		for (const acceptedAtMs of [
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(
				reasonOf(() => parseConsentEvidence({ ...VALID, acceptedAtMs })),
			).toBe("INVALID_TIMESTAMP");
		}
	});

	it("refuses an unrecognised acceptance method", () => {
		for (const acceptanceMethod of ["assumed", "EXPLICIT-CHECKBOX", ""]) {
			expect(
				reasonOf(() => parseConsentEvidence({ ...VALID, acceptanceMethod })),
			).toBe("INVALID_METHOD");
		}
	});

	it("lists the permitted methods in the refusal message", () => {
		// So the caller can fix the input from the error rather than reading the
		// constant.
		try {
			parseConsentEvidence({ ...VALID, acceptanceMethod: "assumed" });
			expect.unreachable("an unrecognised method must be refused");
		} catch (error) {
			for (const method of CONSENT_ACCEPTANCE_METHODS) {
				expect((error as Error).message).toContain(method);
			}
		}
	});

	it("drops any field the input carried beyond the evidence shape", () => {
		// The parser rebuilds the record rather than spreading the input. An
		// extra field — a name, an IP, a session cookie — would otherwise ride
		// into the ledger unnoticed, which is exactly the PII leak the opaque
		// subjectRef rule exists to prevent.
		const parsed = parseConsentEvidence({
			...VALID,
			email: "user@example.com",
			ip: "203.0.113.7",
		} as never);
		expect(Object.keys(parsed).sort()).toEqual([
			"acceptanceMethod",
			"acceptedAtMs",
			"privacyUrl",
			"subjectRef",
			"termsUrl",
		]);
	});
});

describe("in-memory consent ledger", () => {
	it("assigns a hobo-consent locator to a recorded acceptance", async () => {
		// The locator is what a receipt carries *instead of* the evidence, so it
		// must be an addressable reference rather than a copy of the record.
		const ledger = createInMemoryConsentLedger();
		const record = await ledger.record(parseConsentEvidence(VALID));
		expect(record.evidenceRef).toMatch(
			/^hobo-consent:\/\/cloudflare-temporary\/consent-\d{6}$/u,
		);
	});

	it("keeps the accepted evidence alongside the ledger's own timestamp", () => {
		// Two times, deliberately: when the user accepted and when we wrote it
		// down. Collapsing them would make a late-written record look like a late
		// acceptance.
		const ledger = createInMemoryConsentLedger({ nowMs: () => 42 });
		return ledger.record(parseConsentEvidence(VALID)).then((record) => {
			expect(record.acceptedAtMs).toBe(VALID.acceptedAtMs);
			expect(record.recordedAtMs).toBe(42);
		});
	});

	it("issues a distinct reference per acceptance", async () => {
		// Two users accepting must not share one evidence reference, or a receipt
		// would point at somebody else's consent.
		const ledger = createInMemoryConsentLedger();
		const first = await ledger.record(parseConsentEvidence(VALID));
		const second = await ledger.record(parseConsentEvidence(VALID));
		expect(second.evidenceRef).not.toBe(first.evidenceRef);
	});

	it("finds a record by its reference", async () => {
		const ledger = createInMemoryConsentLedger();
		const record = await ledger.record(parseConsentEvidence(VALID));
		expect(await ledger.find(record.evidenceRef)).toEqual(record);
	});

	it("answers undefined for a reference it never issued", async () => {
		// Not a throw. "No such consent" is a normal answer to an audit question
		// about an unknown reference.
		expect(
			await createInMemoryConsentLedger().find("hobo-consent://nope"),
		).toBeUndefined();
	});

	it("lists what it holds, in order of recording", async () => {
		const ledger = createInMemoryConsentLedger();
		await ledger.record(parseConsentEvidence(VALID));
		await ledger.record(
			parseConsentEvidence({ ...VALID, subjectRef: "subject-0002" }),
		);
		expect(ledger.list().map((r) => r.subjectRef)).toEqual([
			"subject-0001",
			"subject-0002",
		]);
	});

	it("honours injected clock and id generators", () => {
		// Both are injectable so a test can assert on an exact ledger entry, and
		// so a production deployment can swap in a real id source rather than a
		// per-process counter that would collide across replicas.
		const ledger = createInMemoryConsentLedger({
			nowMs: () => 7,
			nextId: () => "fixed",
		});
		return ledger.record(parseConsentEvidence(VALID)).then((record) => {
			expect(record.evidenceRef).toBe(
				"hobo-consent://cloudflare-temporary/fixed",
			);
			expect(record.recordedAtMs).toBe(7);
		});
	});

	it("starts empty", () => {
		expect(createInMemoryConsentLedger().list()).toEqual([]);
	});
});

describe("parseWranglerTemporaryOutput", () => {
	const STATION = "https://hobo-station-abc.workers.dev";
	const CLAIM = "https://dash.cloudflare.com/claim/xyz";

	it("reads the station and claim URLs out of wrangler's chatter", () => {
		expect(
			parseWranglerTemporaryOutput(
				`Deployed hobo-station\n  ${STATION}\nClaim: ${CLAIM}\n`,
				"",
			),
		).toEqual({ stationUrl: STATION, claimUrl: CLAIM });
	});

	it("reads them from stderr as well, because wrangler splits its output", () => {
		// Both streams are searched. Reading only stdout would make the parse
		// depend on which stream a given wrangler version chose, and the failure
		// would look like a deploy that produced no URL.
		expect(
			parseWranglerTemporaryOutput("", `${STATION}\n${CLAIM}\n`).stationUrl,
		).toBe(STATION);
	});

	it("strips a trailing slash from the station URL", () => {
		// So the URL can be joined to a path without producing `//`, which some
		// edges normalise and others route differently.
		expect(
			parseWranglerTemporaryOutput(`${STATION}/\nClaim: ${CLAIM}`, "")
				.stationUrl,
		).toBe(STATION);
	});

	it("does not mistake a claim URL for the station URL", () => {
		// The discriminator is the word `claim`. Returning the claim URL as the
		// station would hand back an address that serves a hand-off page instead
		// of the deployed worker — a station that looks live and serves nothing.
		const claimOnWorkers = "https://hobo-claim-abc.workers.dev";
		const parsed = parseWranglerTemporaryOutput(
			`${claimOnWorkers}\n${STATION}\n`,
			"",
		);
		expect(parsed.stationUrl).toBe(STATION);
	});

	it("falls back to a workers.dev claim URL when no other claim link appears", () => {
		// The `?? workers.find(…)` arm: some wrangler versions put the claim on
		// the same domain. Without the fallback a perfectly good deploy would be
		// reported as unparseable.
		const claimOnWorkers = "https://hobo-claim-abc.workers.dev";
		expect(
			parseWranglerTemporaryOutput(`${STATION}\n${claimOnWorkers}\n`, "")
				.claimUrl,
		).toBe(claimOnWorkers);
	});

	it("refuses output with no workers.dev URL at all", () => {
		// A zero-exit deploy that printed no URL is not a success — it is a
		// wrangler whose output shape we no longer understand. Returning an empty
		// station URL would push that discovery to whoever tried to open it.
		expect(() => parseWranglerTemporaryOutput("Deployed.", "")).toThrow(
			/no workers\.dev URL was parsed/u,
		);
	});

	it("refuses output with a station but no claim link", () => {
		// A station nobody can claim expires and takes the deployment with it.
		// Better to fail at the parse, where the output is still in hand.
		expect(() => parseWranglerTemporaryOutput(STATION, "")).toThrow(
			/no claim URL was parsed/u,
		);
	});
});

describe("deployTemporaryWithWrangler", () => {
	const created: string[] = [];

	afterEach(() => {
		for (const dir of created.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	/** A temp workspace the driver writes its wrangler project into. */
	function workspace(): string {
		const dir = mkdtempSync(path.join(tmpdir(), "hobo-cf-wrangler-"));
		created.push(dir);
		return dir;
	}

	/**
	 * A stand-in for the `wrangler` binary: a node script that prints `stdout`,
	 * writes the environment it was given to `env.json`, and exits with `code`.
	 * Shelling out for real is not an option here — the whole point of the
	 * driver is what it does to a child process.
	 */
	function fakeWrangler(
		dir: string,
		options: { stdout?: string; stderr?: string; code?: number } = {},
	): string {
		const bin = path.join(dir, "fake-wrangler.mjs");
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				"import { writeFileSync } from 'node:fs';",
				"import path from 'node:path';",
				`writeFileSync(path.join(${JSON.stringify(dir)}, 'env.json'), JSON.stringify(process.env));`,
				`writeFileSync(path.join(${JSON.stringify(dir)}, 'argv.json'), JSON.stringify(process.argv.slice(2)));`,
				`process.stdout.write(${JSON.stringify(options.stdout ?? "")});`,
				`process.stderr.write(${JSON.stringify(options.stderr ?? "")});`,
				`process.exit(${options.code ?? 0});`,
			].join("\n"),
			{ mode: 0o755 },
		);
		return bin;
	}

	const OUTPUT =
		"https://hobo-station-s1.workers.dev\nClaim: https://dash.cloudflare.com/claim/s1\n";

	it("returns a temporary, anonymous station from a successful deploy", async () => {
		const dir = workspace();
		const result = await deployTemporaryWithWrangler({
			stationId: "s1",
			cwd: dir,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		expect(result.stationUrl).toBe("https://hobo-station-s1.workers.dev");
		expect(result.claimUrl).toBe("https://dash.cloudflare.com/claim/s1");
		expect(result.anonymous).toBe(true);
		expect(result.temporary).toBe(true);
		expect(result.providerId).toBe("cloudflare");
	});

	it("reports the account as temporary rather than inventing an id", async () => {
		// There is no account — that is the point of `--temporary`. A fabricated
		// account id would make a receipt claim a tenancy that does not exist.
		const dir = workspace();
		const result = await deployTemporaryWithWrangler({
			stationId: "s1",
			cwd: dir,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		expect(result.accountId).toBe("temporary");
	});

	it("stamps an expiry in the future", async () => {
		// The TTL is what tells a caller the station is not durable. An expiry in
		// the past — or none — would let a station be treated as permanent
		// infrastructure.
		const dir = workspace();
		const result = await deployTemporaryWithWrangler({
			stationId: "s1",
			cwd: dir,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
	});

	it("scrubs every Cloudflare credential from the child environment", async () => {
		// The safety property of the whole path. If a developer's real token
		// reached the child, `--temporary` would deploy into their production
		// account and leave a durable worker behind after the TTL — created by a
		// path that promised nothing durable, and attributed to nobody.
		const dir = workspace();
		const bin = fakeWrangler(dir, { stdout: OUTPUT });
		const saved = {
			CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
			CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
			CF_API_TOKEN: process.env.CF_API_TOKEN,
		};
		process.env.CLOUDFLARE_API_TOKEN = "leaked-token";
		process.env.CLOUDFLARE_API_KEY = "leaked-key";
		process.env.CF_API_TOKEN = "leaked-cf";
		try {
			await deployTemporaryWithWrangler({
				stationId: "s1",
				cwd: dir,
				wranglerBin: bin,
			});
			const childEnv = JSON.parse(
				readFileSync(path.join(dir, "env.json"), "utf8"),
			) as Record<string, string>;
			expect(childEnv.CLOUDFLARE_API_TOKEN).toBeUndefined();
			expect(childEnv.CLOUDFLARE_API_KEY).toBeUndefined();
			expect(childEnv.CF_API_TOKEN).toBeUndefined();
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("invokes wrangler with deploy --temporary", async () => {
		// The flag is the difference between an anonymous station and a deploy
		// into whatever account wrangler can find.
		const dir = workspace();
		await deployTemporaryWithWrangler({
			stationId: "s1",
			cwd: dir,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		expect(
			JSON.parse(readFileSync(path.join(dir, "argv.json"), "utf8")),
		).toEqual(["deploy", "--temporary"]);
	});

	it("writes a wrangler project naming the derived script", async () => {
		const dir = workspace();
		await deployTemporaryWithWrangler({
			stationId: "s1",
			cwd: dir,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		const toml = readFileSync(path.join(dir, "wrangler.toml"), "utf8");
		expect(toml).toContain('main = "station.js"');
		expect(toml).toContain("compatibility_date");
		expect(
			readFileSync(path.join(dir, "station.js"), "utf8").length,
		).toBeGreaterThan(0);
	});

	it("derives a worker name that Cloudflare will accept from any station id", async () => {
		// Station ids come from callers and carry slashes, colons, and capitals.
		// Cloudflare worker names may not, and an invalid name is rejected by the
		// API rather than sanitised — so the sanitisation has to happen here.
		const dir = workspace();
		const result = await deployTemporaryWithWrangler({
			stationId: "Tenant/ACME:station 01",
			cwd: dir,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		expect(result.scriptName).toMatch(/^[a-z0-9-]+$/u);
		expect(result.scriptName).not.toContain("/");
	});

	it("truncates a long station id rather than emitting an over-long name", async () => {
		const dir = workspace();
		const result = await deployTemporaryWithWrangler({
			stationId: "a".repeat(200),
			cwd: dir,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		expect(result.scriptName.length).toBeLessThanOrEqual(64);
	});

	it("honours an explicit script name", async () => {
		const dir = workspace();
		const result = await deployTemporaryWithWrangler({
			stationId: "s1",
			scriptName: "explicit-name",
			cwd: dir,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		expect(result.scriptName).toBe("explicit-name");
		expect(readFileSync(path.join(dir, "wrangler.toml"), "utf8")).toContain(
			'name = "explicit-name"',
		);
	});

	it("honours an injected worker module", async () => {
		// So a caller can deploy something other than the default station worker
		// without this driver having to know about it.
		const dir = workspace();
		await deployTemporaryWithWrangler({
			stationId: "s1",
			workerModule: "export default { fetch: () => new Response('hi') };",
			cwd: dir,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		expect(readFileSync(path.join(dir, "station.js"), "utf8")).toContain(
			"new Response('hi')",
		);
	});

	it("surfaces wrangler's stderr when the deploy fails", async () => {
		// The message is the only diagnostic a caller gets. Replacing it with a
		// generic failure would send an operator to the wrong place — a quota
		// error and an auth error need opposite responses.
		const dir = workspace();
		await expect(
			deployTemporaryWithWrangler({
				stationId: "s1",
				cwd: dir,
				wranglerBin: fakeWrangler(dir, {
					stderr: "wrangler: temporary deploys are rate limited",
					code: 1,
				}),
			}),
		).rejects.toThrow(/rate limited/u);
	});

	it("falls back to stdout when a failing wrangler said nothing on stderr", async () => {
		const dir = workspace();
		await expect(
			deployTemporaryWithWrangler({
				stationId: "s1",
				cwd: dir,
				wranglerBin: fakeWrangler(dir, { stdout: "no account found", code: 2 }),
			}),
		).rejects.toThrow(/no account found/u);
	});

	it("reports a generic failure when a failing wrangler said nothing at all", async () => {
		// A silent non-zero exit still has to produce an error a caller can act
		// on rather than an empty message.
		const dir = workspace();
		await expect(
			deployTemporaryWithWrangler({
				stationId: "s1",
				cwd: dir,
				wranglerBin: fakeWrangler(dir, { code: 3 }),
			}),
		).rejects.toThrow(/wrangler deploy --temporary failed/u);
	});

	it("reports a missing wrangler binary as a failure rather than hanging", async () => {
		// The spawn `error` handler. Without it a missing binary would reject the
		// promise from somewhere the caller cannot see, or never settle it.
		const dir = workspace();
		await expect(
			deployTemporaryWithWrangler({
				stationId: "s1",
				cwd: dir,
				wranglerBin: path.join(dir, "does-not-exist"),
			}),
		).rejects.toThrow();
	});

	it("refuses a zero-exit deploy whose output carried no URL", async () => {
		// Exit code zero is not the same as a station. This is the parse boundary
		// doing its job at the end of the real driver path.
		const dir = workspace();
		await expect(
			deployTemporaryWithWrangler({
				stationId: "s1",
				cwd: dir,
				wranglerBin: fakeWrangler(dir, { stdout: "Total Upload: 1 KiB\n" }),
			}),
		).rejects.toThrow(/no workers\.dev URL was parsed/u);
	});

	it("creates the working directory when the caller names one that is absent", async () => {
		// `mkdir(work, { recursive: true })`. A caller pointing at a fresh path is
		// the normal case; failing on it would make the driver usable only from a
		// directory somebody had already made.
		const dir = workspace();
		const nested = path.join(dir, "deep", "nested");
		await deployTemporaryWithWrangler({
			stationId: "s1",
			cwd: nested,
			wranglerBin: fakeWrangler(dir, { stdout: OUTPUT }),
		});
		expect(
			readFileSync(path.join(nested, "station.js"), "utf8").length,
		).toBeGreaterThan(0);
	});

	it("runs node scripts at all in this environment", () => {
		// Guards the fixture itself: every assertion above depends on the fake
		// wrangler actually executing. If it silently did not, the failure-path
		// tests would pass for the wrong reason.
		const dir = workspace();
		const bin = fakeWrangler(dir, { stdout: "ok" });
		expect(spawnSync(bin, [], { encoding: "utf8" }).stdout).toBe("ok");
	});
});
