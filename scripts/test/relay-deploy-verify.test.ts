import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyRelayProbes,
	DEFAULT_PRODUCTION_ORIGIN,
	main,
	parseRelayVerifyArgs,
	RELAY_VERIFY_ATTEMPTS,
	RELAY_VERIFY_RETRY_MS,
	RELAY_VERIFY_TIMEOUT_MS,
	type RelayProbe,
} from "../ci/relay-deploy-verify.mts";

function fetcherFor(
	handler: (
		url: string,
		init: RequestInit | undefined,
	) => Response | Promise<Response>,
): typeof fetch {
	const fetcherImpl: typeof fetch = async (input, init) =>
		handler(new Request(input).url, init);
	return fetcherImpl;
}

const noSleep = async () => {};

function probe(
	status: number,
	bodyText = "",
	ok = status >= 200 && status < 300,
): RelayProbe {
	return { ok, status, bodyText };
}

describe("parseRelayVerifyArgs", () => {
	it("defaults the origin to the Yard's production origin and takes --sha from GITHUB_SHA", () => {
		expect(
			parseRelayVerifyArgs([], {
				GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
			}),
		).toEqual({
			origin: DEFAULT_PRODUCTION_ORIGIN,
			sha: "0123456789abcdef0123456789abcdef01234567",
		});
	});

	it("reads spaced and equals flags, and HOBO_CI_RELAY_URL overrides the default", () => {
		expect(
			parseRelayVerifyArgs(
				[
					"--origin=https://relay.example/",
					"--sha",
					"0123456789abcdef0123456789abcdef01234567",
				],
				{ HOBO_CI_RELAY_URL: "https://elsewhere.example" },
			),
		).toEqual({
			origin: "https://relay.example",
			sha: "0123456789abcdef0123456789abcdef01234567",
		});
	});

	it("rejects a missing or blank sha instead of skipping commit attestation", () => {
		for (const env of [{}, { GITHUB_SHA: "" }, { GITHUB_SHA: "   " }])
			expect(() =>
				parseRelayVerifyArgs(["--origin", "https://relay.example"], env),
			).toThrow(/Missing --sha commit/);
	});

	it("rejects a missing value, an unknown flag, a bad origin and a bad commit", () => {
		expect(() => parseRelayVerifyArgs(["--origin"], {})).toThrow(
			/Missing value for --origin/,
		);
		expect(() => parseRelayVerifyArgs(["--nope"], {})).toThrow(
			/Unknown argument: --nope/,
		);
		expect(() => parseRelayVerifyArgs(["--origin", "not a url"], {})).toThrow(
			/Invalid --origin URL/,
		);
		expect(() =>
			parseRelayVerifyArgs(["--origin", "http://insecure.example"], {}),
		).toThrow(/Invalid --origin URL/);
		expect(() => parseRelayVerifyArgs(["--sha", "abc"], {})).toThrow(
			/Invalid --sha commit/,
		);
	});

	it("does not echo credentials or query tokens from an invalid origin", () => {
		expect(() =>
			parseRelayVerifyArgs(
				[
					"--origin",
					"https://user:synthetic-secret@relay.example/?token=secret",
				],
				{},
			),
		).toThrow(
			/^Invalid --origin URL: expected an HTTPS origin with no credentials, path, query, or fragment$/,
		);
	});
});

describe("classifyRelayProbes", () => {
	const SHA = "0123456789abcdef0123456789abcdef01234567";
	const healthOk = probe(200, JSON.stringify({ ok: true, commit: SHA }));

	it("accepts a relay that serves the asked commit and answers readyz 200", () => {
		expect(
			classifyRelayProbes({
				health: healthOk,
				ready: probe(200, JSON.stringify({ ready: true })),
				sha: SHA,
			}),
		).toEqual({
			ok: true,
			code: "HOBO_RELAY_READY",
			message: expect.any(String),
		});
	});

	it("accepts a relay waiting for its owner's named entries only while the owner hand-off serves", () => {
		const waiting = probe(
			503,
			JSON.stringify({
				ready: false,
				started: false,
				state: "not-configured",
				missing: ["HOBO_CI_GITHUB_APP_ID"],
				invalid: ["HOBO_CI_CONFIG_JSON", "lower case"],
			}),
		);
		const serving = {
			page: probe(200, "<!doctype html>"),
			mailbox: probe(404, JSON.stringify({ error: "not-found" })),
		};
		const accepted = classifyRelayProbes({
			health: healthOk,
			ready: waiting,
			sha: SHA,
			handoff: serving,
		});
		expect(accepted).toMatchObject({
			ok: true,
			awaitingOwner: true,
			code: "HOBO_RELAY_AWAITING_OWNER",
		});
		expect(accepted.message).toContain(
			"missing HOBO_CI_GITHUB_APP_ID; refused HOBO_CI_CONFIG_JSON)",
		);
		expect(
			classifyRelayProbes({
				health: healthOk,
				ready: waiting,
				sha: SHA,
				handoff: {
					...serving,
					mailbox: probe(
						503,
						JSON.stringify({ ready: false, state: "no-mailbox-store" }),
					),
				},
			}),
		).toMatchObject({ ok: false, code: "HOBO_RELAY_OWNER_HANDOFF_DOWN" });
		expect(
			classifyRelayProbes({
				health: healthOk,
				ready: probe(
					503,
					JSON.stringify({
						ready: false,
						started: false,
						state: "not-configured",
					}),
				),
				sha: SHA,
				handoff: serving,
			}),
		).toMatchObject({ ok: false, code: "HOBO_RELAY_NOT_CONFIGURED" });
		expect(
			classifyRelayProbes({
				health: probe(
					200,
					JSON.stringify({ ok: true, commit: "f".repeat(40) }),
				),
				ready: waiting,
				sha: SHA,
				handoff: serving,
			}),
		).toMatchObject({ ok: false, code: "HOBO_RELAY_COMMIT_MISMATCH" });
	});

	it("fails on a healthz that does not answer 200, naming protection on 401", () => {
		expect(
			classifyRelayProbes({
				health: probe(503, ""),
				ready: probe(200, '{"ready":true}'),
				sha: SHA,
			}),
		).toMatchObject({ ok: false, code: "HOBO_RELAY_HEALTH_UNREACHABLE" });
		expect(
			classifyRelayProbes({
				health: probe(401, ""),
				ready: probe(200, '{"ready":true}'),
				sha: SHA,
			}).message,
		).toMatch(/Deployment Protection/);
	});

	it("fails when healthz names another commit or none", () => {
		const other = classifyRelayProbes({
			health: probe(
				200,
				JSON.stringify({
					ok: true,
					commit: "fedcba9876543210fedcba9876543210fedcba98",
				}),
			),
			ready: probe(200, '{"ready":true}'),
			sha: SHA,
		});
		expect(other).toMatchObject({
			ok: false,
			code: "HOBO_RELAY_COMMIT_MISMATCH",
		});
		expect(other.message).toContain("fedcba9876543210fedcba9876543210fedcba98");
		expect(
			classifyRelayProbes({
				health: probe(200, JSON.stringify({ ok: true, commit: null })),
				ready: probe(200, '{"ready":true}'),
				sha: SHA,
			}).code,
		).toBe("HOBO_RELAY_COMMIT_MISMATCH");
	});

	it("gives each startup state its own verdict, distinct from start-failed", () => {
		const state = (state: string) =>
			classifyRelayProbes({
				health: healthOk,
				ready: probe(
					503,
					JSON.stringify({ ready: false, started: false, state }),
				),
				sha: SHA,
			});
		expect(state("config-service-unavailable")).toMatchObject({
			ok: false,
			code: "HOBO_RELAY_CONFIG_SERVICE_UNAVAILABLE",
		});
		expect(state("config-service-unavailable").message).toMatch(
			/config service did not answer/,
		);
		expect(state("not-configured")).toMatchObject({
			ok: false,
			code: "HOBO_RELAY_NOT_CONFIGURED",
		});
		expect(state("not-configured").message).toMatch(
			/holds no valid relay configuration/u,
		);
		expect(state("config-service-denied").code).toBe(
			"HOBO_RELAY_CONFIG_SERVICE_DENIED",
		);
		expect(state("start-failed")).toMatchObject({
			ok: false,
			code: "HOBO_RELAY_START_FAILED",
		});
		expect(state("start-failed").message).toMatch(/did not start/u);
	});

	it("names the parts a started relay reports false, and surfaces a body that mentions neon, quota or the cache", () => {
		const parts = classifyRelayProbes({
			health: healthOk,
			ready: probe(
				503,
				JSON.stringify({
					ready: false,
					configService: true,
					cache: false,
					executionHost: false,
					workers: "starting",
				}),
			),
			sha: SHA,
		});
		expect(parts).toMatchObject({ ok: false, code: "HOBO_RELAY_NOT_READY" });
		expect(parts.message).toMatch(/cache binding/u);
		expect(parts.message).toMatch(/Sandbox execution host/u);
		expect(parts.message).not.toMatch(/config service/u);

		const legacy = classifyRelayProbes({
			health: healthOk,
			ready: probe(
				503,
				JSON.stringify({ ready: false, reason: "neon quota exceeded" }),
			),
			sha: SHA,
		});
		expect(legacy).toMatchObject({ ok: false, code: "HOBO_RELAY_NOT_READY" });
		expect(legacy.message).toMatch(/Neon/u);
		expect(legacy.message).toMatch(/quota/u);

		const emptyReason = classifyRelayProbes({
			health: healthOk,
			ready: probe(503, JSON.stringify({ ready: false })),
			sha: SHA,
		});
		expect(emptyReason.code).toBe("HOBO_RELAY_NOT_READY");
		expect(emptyReason.message).toMatch(/ready is false/u);
	});

	it("fails on a readyz that answered nothing usable", () => {
		expect(
			classifyRelayProbes({
				health: healthOk,
				ready: probe(503, ""),
				sha: SHA,
			}),
		).toMatchObject({ ok: false, code: "HOBO_RELAY_READYZ_UNREACHABLE" });
	});
});

describe("main exit codes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exits 0 once healthz and readyz answer, timing out and retrying per probe", async () => {
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => new AbortController().signal);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const urls: string[] = [];
		const fetcher = fetcherFor(async (url) => {
			urls.push(url);
			if (url.endsWith("/healthz"))
				return new Response(
					JSON.stringify({
						ok: true,
						commit: "0123456789abcdef0123456789abcdef01234567",
					}),
					{ status: 200 },
				);
			if (urls.filter((asked) => asked.endsWith("/readyz")).length < 2)
				return new Response("", { status: 503 });
			return new Response(JSON.stringify({ ready: true }), { status: 200 });
		});
		const sleeps: number[] = [];
		const sleep = async (ms: number) => {
			sleeps.push(ms);
		};

		const code = await main(
			[
				"--origin",
				"https://relay.example",
				"--sha",
				"0123456789abcdef0123456789abcdef01234567",
			],
			{},
			fetcher,
			sleep,
		);

		expect(code).toBe(0);
		expect(urls[0]).toBe("https://relay.example/healthz");
		expect(urls.at(-1)).toBe("https://relay.example/readyz");
		expect(RELAY_VERIFY_TIMEOUT_MS).toBe(15_000);
		expect(RELAY_VERIFY_ATTEMPTS).toBe(3);
		expect(RELAY_VERIFY_RETRY_MS).toBe(5_000);
		expect(timeout).toHaveBeenNthCalledWith(1, 15_000);
		expect(sleeps).toEqual([5_000]);
		expect(error).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalled();
	});

	it("exits 1 with an annotation and the distinct verdict when the relay is down", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetcher = fetcherFor(async (url) =>
			url.endsWith("/healthz")
				? new Response(JSON.stringify({ ok: true, commit: null }), {
						status: 200,
					})
				: new Response(
						JSON.stringify({
							ready: false,
							started: false,
							state: "config-service-unavailable",
						}),
						{ status: 503 },
					),
		);

		const code = await main(
			[
				"--origin",
				"https://relay.example",
				"--sha",
				"0123456789abcdef0123456789abcdef01234567",
			],
			{},
			fetcher,
			noSleep,
		);

		expect(code).toBe(1);
		const text = log.mock.calls.map((call) => call.join(" ")).join("\n");
		expect(text).toMatch(/HOBO_RELAY_COMMIT_MISMATCH/);
		expect(text).toMatch(/::error title=Relay deploy verification::/);
	});

	it("exits 0 and tells the workflow the relay awaits its owner", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const directory = mkdtempSync(join(tmpdir(), "relay-verify-"));
		const output = join(directory, "output");
		writeFileSync(output, "");
		const sha = "0123456789abcdef0123456789abcdef01234567";
		const fetcher = fetcherFor(async (url) => {
			const { pathname } = new URL(url);
			if (pathname === "/healthz")
				return new Response(JSON.stringify({ ok: true, commit: sha }));
			if (pathname === "/readyz")
				return new Response(
					JSON.stringify({
						ready: false,
						started: false,
						state: "not-configured",
						missing: ["HOBO_CI_GITHUB_APP_PRIVATE_KEY"],
						invalid: [],
					}),
					{ status: 503 },
				);
			if (pathname === "/owner-handoff") return new Response("<!doctype html>");
			return new Response(JSON.stringify({ error: "not-found" }), {
				status: 404,
			});
		});
		try {
			expect(
				await main(
					["--origin", "https://relay.example", "--sha", sha],
					{ GITHUB_OUTPUT: output },
					fetcher,
					noSleep,
				),
			).toBe(0);
			expect(readFileSync(output, "utf8")).toBe("awaiting-owner=true\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("exits 1 when the origin cannot be reached at all", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetcher = fetcherFor(async () => {
			throw new Error("network down");
		});

		const code = await main(
			[
				"--origin",
				"https://relay.example",
				"--sha",
				"0123456789abcdef0123456789abcdef01234567",
			],
			{},
			fetcher,
			noSleep,
		);

		expect(code).toBe(1);
		expect(log.mock.calls.map((call) => call.join(" ")).join("\n")).toMatch(
			/HOBO_RELAY_HEALTH_UNREACHABLE/,
		);
	});

	it("exits 2 for invalid arguments and probes nothing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetcher = fetcherFor(() => {
			throw new Error("no request may be sent");
		});

		expect(await main(["--origin", "not a url"], {}, fetcher, noSleep)).toBe(2);
		expect(error).toHaveBeenCalled();
	});
});
