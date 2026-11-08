import { afterEach, describe, expect, it, vi } from "vitest";
import {
	evaluateReadiness,
	isReadyResponse,
	main,
	parseReadyBody,
	parseRelayArgs,
	printOperatorChecklist,
	RELAY_FETCH_TIMEOUT_MS,
	type ReadyBody,
} from "../ci/verify-relay-dispatch.mts";

function loggedLines(spy: { mock: { calls: unknown[][] } }): string[] {
	return spy.mock.calls.map((call) =>
		call.map((part) => String(part)).join(" "),
	);
}

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

describe("parseRelayArgs", () => {
	it("defaults --relay and --repository", () => {
		expect(parseRelayArgs([], {})).toEqual({
			relay: "https://hobo-ci.vercel.app",
			repository: "Hobo-Labs/HoBo",
		});
	});

	it("reads spaced and equals flags and normalizes the relay URL", () => {
		expect(
			parseRelayArgs(
				["--relay=https://example.test/", "--repository", "acme/widgets"],
				{},
			),
		).toEqual({
			relay: "https://example.test",
			repository: "acme/widgets",
		});
	});

	it("lets --relay override HOBO_CI_RELAY while repository stays from env", () => {
		expect(
			parseRelayArgs(["--relay", "https://from.argv"], {
				HOBO_CI_RELAY: "https://from.env",
				HOBO_CI_REPOSITORY: "env/repo",
			}),
		).toEqual({
			relay: "https://from.argv",
			repository: "env/repo",
		});
	});

	it("uses env fallbacks when flags are absent", () => {
		expect(
			parseRelayArgs([], {
				HOBO_CI_RELAY: "https://from.env/",
				HOBO_CI_REPOSITORY: "env/repo",
			}),
		).toEqual({
			relay: "https://from.env",
			repository: "env/repo",
		});
	});

	it("rejects a missing flag value, an unknown flag, and a bad relay URL", () => {
		expect(() => parseRelayArgs(["--relay"], {})).toThrow(
			/Missing value for --relay/,
		);
		expect(() => parseRelayArgs(["--nope"], {})).toThrow(
			/Unknown argument: --nope/,
		);
		expect(() => parseRelayArgs(["--relay", "not a url"], {})).toThrow(
			/Invalid --relay URL/,
		);
	});
});

describe("isReadyResponse", () => {
	it("accepts only a parsed ready body", () => {
		expect(isReadyResponse({ ready: true } satisfies ReadyBody)).toBe(true);
	});
});

describe("parseReadyBody", () => {
	it("parses ready true and rejects other shapes", () => {
		expect(parseReadyBody(JSON.stringify({ ready: true }))).toEqual({
			ready: true,
		});
		expect(parseReadyBody(JSON.stringify({ ready: false }))).toBeNull();
		expect(parseReadyBody("not-json")).toBeNull();
		expect(parseReadyBody("")).toBeNull();
	});
});

describe("evaluateReadiness", () => {
	const healthOk = { ok: true, status: 200, bodyText: '{"status":"ok"}' };

	it("returns ready when health is ok and readyz body.ready is true", () => {
		expect(
			evaluateReadiness(healthOk, {
				ok: true,
				status: 200,
				bodyText: '{"ready":true}',
			}),
		).toEqual({
			ready: true,
			reasons: [],
		});
	});

	it("returns ready when body.ready is true even if readyz HTTP status is not ok", () => {
		expect(
			evaluateReadiness(healthOk, {
				ok: false,
				status: 503,
				bodyText: '{"ready":true}',
			}).ready,
		).toBe(true);
	});

	it("is not ready when health is not ok", () => {
		const result = evaluateReadiness(
			{ ok: false, status: 503, bodyText: "" },
			{ ok: true, status: 200, bodyText: '{"ready":true}' },
		);
		expect(result.ready).toBe(false);
		expect(result.reasons.join(" ")).toContain("healthz is not ok");
	});

	it("is not ready when body.ready is not true", () => {
		const result = evaluateReadiness(healthOk, {
			ok: true,
			status: 200,
			bodyText: '{"ready":false}',
		});
		expect(result.ready).toBe(false);
		expect(result.reasons).toEqual(["readyz body.ready is not true"]);
	});
});

describe("printOperatorChecklist", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("prints five numbered operator steps for the repository", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printOperatorChecklist("Hobo-Labs/HoBo");
		const lines = loggedLines(spy);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toMatch(/^1\. /);
		expect(lines[0]).toContain("sandbox");
		expect(lines[0]).toContain("HOBO_CI_SANDBOX_*");
		expect(lines[1]).toMatch(/^2\. /);
		expect(lines[1]).toContain("worker health");
		expect(lines[2]).toMatch(/^3\. /);
		expect(lines[2]).toContain("DATABASE_URL");
		expect(lines[3]).toMatch(/^4\. /);
		expect(lines[3]).toContain("GitHub webhooks");
		expect(lines[4]).toMatch(/^5\. /);
		expect(lines[4]).toContain("hobo ci enable");
		expect(lines[4]).toContain("Hobo-Labs/HoBo");
	});

	it("substitutes the given repository", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		printOperatorChecklist("acme/demo");
		const text = loggedLines(spy).join("\n");
		expect(text).toContain("hobo ci enable for acme/demo");
		expect(text).not.toContain("Hobo-Labs/HoBo");
	});
});

describe("main exit codes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exits 0 after healthz and readyz succeed within 15s", async () => {
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => new AbortController().signal);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const urls: string[] = [];
		const fetcher = fetcherFor(async (url) => {
			urls.push(url);
			if (url.endsWith("/healthz")) {
				return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
			}
			return new Response(JSON.stringify({ ready: true }), { status: 200 });
		});

		const code = await main(
			["--relay", "https://relay.example", "--repository", "acme/demo"],
			{},
			fetcher,
		);

		expect(code).toBe(0);
		expect(urls).toEqual([
			"https://relay.example/healthz",
			"https://relay.example/readyz",
		]);
		expect(urls.some((url) => url.includes("acme/demo"))).toBe(false);
		expect(RELAY_FETCH_TIMEOUT_MS).toBe(15_000);
		expect(timeout).toHaveBeenNthCalledWith(1, 15_000);
		expect(timeout).toHaveBeenNthCalledWith(2, 15_000);
		expect(loggedLines(log).join("\n")).not.toContain("HOBO_CI_SANDBOX_");
	});

	it("exits 1 and prints the checklist when the relay is not ready", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetcher = fetcherFor(async (url) => {
			if (url.endsWith("/healthz"))
				return new Response("down", { status: 503 });
			return new Response(JSON.stringify({ ready: false }), { status: 200 });
		});

		const code = await main(["--repository", "acme/demo"], {}, fetcher);

		expect(code).toBe(1);
		expect(loggedLines(error).join("\n")).toContain("Relay not ready");
		const checklist = loggedLines(log).join("\n");
		expect(checklist).toContain("HOBO_CI_SANDBOX_*");
		expect(checklist).toContain("worker health");
		expect(checklist).toContain("DATABASE_URL");
		expect(checklist).toContain("GitHub webhooks");
		expect(checklist).toContain("hobo ci enable for acme/demo");
	});

	it("exits 1 and prints the checklist when the probe fails", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetcher = fetcherFor(async () => {
			throw new Error("network down");
		});

		const code = await main(["--repository", "acme/demo"], {}, fetcher);

		expect(code).toBe(1);
		expect(loggedLines(error).join("\n")).toContain("network down");
		expect(loggedLines(log).join("\n")).toContain(
			"hobo ci enable for acme/demo",
		);
	});

	it("exits 2 for invalid arguments and skips the checklist", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await main(["--nope"], {})).toBe(2);
		expect(await main(["--relay", "not a url"], {})).toBe(2);
		expect(log).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalled();
	});
});
