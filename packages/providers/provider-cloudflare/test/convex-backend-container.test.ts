/**
 * Anonymous provisioning of a self-hosted Convex backend onto Cloudflare
 * Containers.
 *
 * This is the longest fully-anonymous path in the package: mint a Temporary
 * Account, write a wrangler project, `npm install`, deploy, discover the
 * workers.dev origin, rewrite the scaffold with the real origin, redeploy, wait
 * for readiness, then mint an admin key over a bootstrap-token bridge. Every
 * external edge — the child process, `fetch`, the account — is injectable, which
 * is what makes the whole sequence testable without a cloud account, and what
 * these tests exercise.
 *
 * Three properties carry the weight.
 *
 * **Every failure must carry the claim URL.** A Temporary Account is a real
 * Cloudflare account that exists whether or not the deploy on top of it
 * succeeded. An error that dropped `claimUrl` would strand that account:
 * created, unreachable, unclaimable, and billing to nobody until it expired.
 * That is why the error type has the field at all, and why it is asserted on
 * every failing branch below rather than only on the happy one.
 *
 * **The Containers 403 is diagnosed, not reported as a generic deploy failure.**
 * Cloudflare does not grant the Containers runtime on Temporary Accounts. That
 * is a platform limitation with a known workaround — claim the account — and
 * reporting it as "wrangler deploy failed" would send someone debugging their
 * worker instead.
 *
 * **The scaffold is written twice on purpose.** The worker module embeds its own
 * origin, which is not known until after the first deploy returns one. Skipping
 * the second write would leave a backend whose self-reported origin is a
 * placeholder — reachable, apparently healthy, and handing clients an address
 * that resolves to nothing.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	assertCloudflareContainersSupportedForConvex,
	CONVEX_API_PORT,
	CONVEX_BACKEND_OCI_IMAGE,
	CONVEX_HTTP_ACTIONS_PORT,
	ConvexCloudflareContainersError,
	type ConvexCloudflareSpawn,
	materializeConvexCloudflareBackendScaffold,
	parseWorkersDevUrl,
	provisionConvexBackendOnCloudflare,
} from "../src/convex-backend-container.js";
import { type JsonValue, parseJsonValue } from "../src/json.js";
import type { TemporaryPreviewAccount } from "../src/temporary-station.js";

const ACCOUNT: TemporaryPreviewAccount = {
	accountId: "acct-temporary",
	apiToken: "temp-token",
	claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=abc",
};

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-cf-convex-"));
	dirs.push(dir);
	return dir;
}

/** Records every child invocation and answers from a scripted queue. */
function recordingSpawn(
	results: ReadonlyArray<{
		exitCode?: number;
		stdout?: string;
		stderr?: string;
	}>,
) {
	const calls: Array<{ command: string; args: readonly string[] }> = [];
	let index = 0;
	const spawn: ConvexCloudflareSpawn = async ({ command, args }) => {
		calls.push({ command, args });
		const result = results[Math.min(index, results.length - 1)];
		index += 1;
		return {
			exitCode: result?.exitCode ?? 0,
			stdout: result?.stdout ?? "",
			stderr: result?.stderr ?? "",
		};
	};
	return { spawn, calls };
}

const OK_SPAWN = [
	{}, // npm install
	{ stdout: "Deployed to https://hobo-convex-x.acct.workers.dev\n" },
	{}, // redeploy
];

/**
 * Stubs answer with real `Response` objects, because the module reads both
 * `json()` and `text()`: the account-subdomain lookup takes `json()`, while the
 * admin-key bridge takes `text()` and runs it through `parseJsonValue` rather
 * than trusting `json()`'s `any`. A hand-built stub offering only one of the two
 * does not fail as a wrong answer -- it fails as `response.text is not a
 * function`, from inside the module, which reads as a bug in the code under
 * test.
 */
function jsonResponse(body: JsonValue): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

/** A response that carries nothing but its status. */
function statusOnly(status: number): Response {
	return new Response(null, { status });
}

/** A fetch that answers `/version` and the admin-key bridge, nothing else. */
function happyFetch(adminKey = "convex-admin-key") {
	const seen: string[] = [];
	const impl: typeof fetch = async (url, init) => {
		const href = String(url);
		seen.push(href);
		if (href.endsWith("/version")) return statusOnly(200);
		if (href.endsWith("/.hobo/admin-key")) {
			return jsonResponse({ adminKey });
		}
		void init;
		return jsonResponse({ success: true });
	};
	return { impl, seen };
}

async function provisionOk() {
	const dir = workDir();
	const { spawn, calls } = recordingSpawn(OK_SPAWN);
	const fetched = happyFetch();
	const result = await provisionConvexBackendOnCloudflare({
		workDir: dir,
		temporaryAccount: ACCOUNT,
		spawn,
		fetchImpl: fetched.impl,
	});
	return { result, dir, calls, seen: fetched.seen };
}

describe("published constants", () => {
	it("pins the Convex backend image and its two ports", () => {
		// The ports are baked into the generated worker module, so a drift here
		// produces a container that starts and a worker that talks to the wrong
		// socket — a backend that is up and unreachable.
		expect(CONVEX_BACKEND_OCI_IMAGE).toContain("convex");
		expect(CONVEX_API_PORT).toBe(3210);
		expect(CONVEX_HTTP_ACTIONS_PORT).toBe(3211);
	});
});

describe("assertCloudflareContainersSupportedForConvex", () => {
	it("permits a temporary account rather than refusing it up front", () => {
		// Deliberately a no-op, and worth pinning as such. Temporary *is* the
		// intended path; the older behaviour refused it here, which blocked the
		// anonymous attempt before it could produce the 403 evidence that makes
		// the platform limitation visible. The refusal now happens where the
		// evidence is — at the deploy — carrying the claim URL with it.
		expect(() =>
			assertCloudflareContainersSupportedForConvex({ temporaryAccount: true }),
		).not.toThrow();
		expect(() =>
			assertCloudflareContainersSupportedForConvex({}),
		).not.toThrow();
	});
});

describe("parseWorkersDevUrl", () => {
	it("finds a workers.dev URL in either stream", () => {
		expect(parseWorkersDevUrl("https://app-1.acct.workers.dev", "")).toBe(
			"https://app-1.acct.workers.dev",
		);
		expect(
			parseWorkersDevUrl("", "deployed to https://app-1.acct.workers.dev"),
		).toBe("https://app-1.acct.workers.dev");
	});

	it("strips a trailing slash", () => {
		// So the origin can be concatenated with `/http` and `/version` without
		// producing a double slash that some edges route differently.
		expect(parseWorkersDevUrl("https://a.b.workers.dev/", "")).toBe(
			"https://a.b.workers.dev",
		);
	});

	it("answers null rather than throwing when there is no URL", () => {
		// Null is a real answer here: the caller falls back to asking the API for
		// the account subdomain. Throwing would turn a recoverable case into a
		// failed provision.
		expect(parseWorkersDevUrl("Total Upload: 1 KiB", "")).toBeNull();
	});

	it("takes the first URL when wrangler prints several", () => {
		expect(
			parseWorkersDevUrl(
				"https://first.acct.workers.dev\nhttps://second.acct.workers.dev",
				"",
			),
		).toBe("https://first.acct.workers.dev");
	});
});

describe("materializeConvexCloudflareBackendScaffold", () => {
	async function scaffold(overrides: Record<string, string> = {}) {
		const dir = workDir();
		await materializeConvexCloudflareBackendScaffold({
			workDir: dir,
			workerName: "hobo-convex-test",
			image: CONVEX_BACKEND_OCI_IMAGE,
			cloudOrigin: "https://origin.example.workers.dev",
			siteOrigin: "https://origin.example.workers.dev/http",
			bootstrapToken: "boot-token",
			...overrides,
		});
		return dir;
	}

	it("creates the nested src directory rather than requiring one", async () => {
		// `mkdir(..., { recursive: true })`. The caller hands us an empty temp
		// directory; failing on the missing `src` would make the function usable
		// only after somebody else prepared the tree.
		const dir = await scaffold();
		expect(
			readFileSync(path.join(dir, "src", "index.ts"), "utf8").length,
		).toBeGreaterThan(0);
	});

	it("writes a wrangler config binding the Convex image", async () => {
		const dir = await scaffold();
		const config = readFileSync(path.join(dir, "wrangler.jsonc"), "utf8");
		expect(config).toContain(CONVEX_BACKEND_OCI_IMAGE);
		expect(config).toContain("hobo-convex-test");
	});

	it("writes a package.json naming the worker", async () => {
		const dir = await scaffold();
		const manifest = parseJsonValue(
			readFileSync(path.join(dir, "package.json"), "utf8"),
		);
		expect(manifest).toMatchObject({ name: "hobo-convex-test" });
	});

	it("embeds the origins into the worker module", async () => {
		// The worker reports these to clients. They are baked in at scaffold time
		// rather than read from a binding, which is exactly why the scaffold has
		// to be written a second time once the real origin is known.
		const dir = await scaffold();
		const module = readFileSync(path.join(dir, "src", "index.ts"), "utf8");
		expect(module).toContain("https://origin.example.workers.dev");
		expect(module).toContain("https://origin.example.workers.dev/http");
	});

	it("carries the bootstrap token into the wrangler config", async () => {
		// The token is what authorises the one admin-key mint. Without it in the
		// deployed config the bridge would reject the provisioner's own call.
		const dir = await scaffold();
		expect(readFileSync(path.join(dir, "wrangler.jsonc"), "utf8")).toContain(
			"boot-token",
		);
	});

	it("overwrites a previous scaffold in place", async () => {
		// The second write is the whole mechanism for replacing the placeholder
		// origin. Appending, or refusing because the file exists, would leave the
		// placeholder deployed.
		const dir = workDir();
		const common = {
			workDir: dir,
			workerName: "w",
			image: CONVEX_BACKEND_OCI_IMAGE,
			bootstrapToken: "t",
		};
		await materializeConvexCloudflareBackendScaffold({
			...common,
			cloudOrigin: "https://placeholder.workers.dev",
			siteOrigin: "https://placeholder.workers.dev/http",
		});
		await materializeConvexCloudflareBackendScaffold({
			...common,
			cloudOrigin: "https://real.workers.dev",
			siteOrigin: "https://real.workers.dev/http",
		});
		const module = readFileSync(path.join(dir, "src", "index.ts"), "utf8");
		expect(module).toContain("https://real.workers.dev");
		expect(module).not.toContain("placeholder");
	});
});

describe("mock mode", () => {
	it("returns a workers.dev-shaped result without spawning or fetching", async () => {
		// The CI and examples path. It must not shell out or reach the network,
		// or every example run would need a Cloudflare account.
		const { spawn, calls } = recordingSpawn([]);
		const result = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			mock: true,
			spawn,
		});
		expect(result.mocked).toBe(true);
		expect(result.backendUrl).toMatch(/^https:\/\/.+\.mock\.workers\.dev$/u);
		expect(calls).toEqual([]);
	});

	it("marks the mocked account distinctly so it cannot be mistaken for real", async () => {
		// `temporary-mock`, not a plausible account id. A receipt quoting this
		// must be recognisable as a mock at a glance rather than sending someone
		// looking for an account that was never created.
		const result = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			mock: true,
		});
		expect(result.accountId).toBe("temporary-mock");
		expect(result.adminKey.startsWith("hobo-cf-mock|")).toBe(true);
		expect(result.claimUrl).toContain("mock-");
	});

	it("still reports itself as anonymous and temporary", async () => {
		const result = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			mock: true,
		});
		expect(result.anonymous).toBe(true);
		expect(result.temporary).toBe(true);
		expect(result.mode).toBe("cloudflare-containers");
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("does not put the whole bootstrap token in the mock admin key", async () => {
		// Sliced to 32 characters. A mock key is printed and pasted freely, and a
		// full token in it would teach people that tokens are safe to paste.
		const result = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			mock: true,
			bootstrapToken: "b".repeat(64),
		});
		expect(result.adminKey).toBe(`hobo-cf-mock|${"b".repeat(32)}`);
	});
});

describe("naming and defaults", () => {
	it("derives a stable worker name from the working directory", async () => {
		// Deterministic, so re-running a provision for the same project targets
		// the same worker instead of littering the account with new ones.
		const dir = workDir();
		const first = await provisionConvexBackendOnCloudflare({
			workDir: dir,
			mock: true,
		});
		const second = await provisionConvexBackendOnCloudflare({
			workDir: dir,
			mock: true,
		});
		expect(second.workerName).toBe(first.workerName);
		expect(first.workerName).toMatch(/^hobo-convex-[0-9a-f]{8}$/u);
	});

	it("derives different names for different working directories", async () => {
		const a = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			mock: true,
		});
		const b = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			mock: true,
		});
		expect(b.workerName).not.toBe(a.workerName);
	});

	it("honours an explicit worker name and image", async () => {
		const result = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			workerName: "explicit-worker",
			image: "ghcr.io/example/convex:pinned",
			mock: true,
		});
		expect(result.workerName).toBe("explicit-worker");
		expect(result.image).toBe("ghcr.io/example/convex:pinned");
	});

	it("treats a whitespace-only override as absent", async () => {
		// `?.trim() || default`. A blank string reaching the wrangler config would
		// produce a worker with no name, which Cloudflare rejects with an error
		// far less legible than this default.
		const result = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			workerName: "   ",
			image: "  ",
			mock: true,
		});
		expect(result.workerName).toMatch(/^hobo-convex-/u);
		expect(result.image).toBe(CONVEX_BACKEND_OCI_IMAGE);
	});

	it("generates a fresh bootstrap token when none is supplied", async () => {
		// Random per provision. A fixed default would let anyone who read the
		// source mint an admin key against somebody else's backend.
		const a = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			mock: true,
		});
		const b = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			mock: true,
		});
		expect(b.adminKey).not.toBe(a.adminKey);
	});
});

describe("the full anonymous provision", () => {
	it("returns the resolved backend URL and the minted admin key", async () => {
		const { result } = await provisionOk();
		expect(result.backendUrl).toBe("https://hobo-convex-x.acct.workers.dev");
		expect(result.adminKey).toBe("convex-admin-key");
		expect(result.mocked).toBe(false);
	});

	it("attributes the result to the temporary account and its claim URL", async () => {
		// The claim URL on the *success* path too: the account is still temporary
		// and still needs claiming, or the backend disappears with it.
		const { result } = await provisionOk();
		expect(result.accountId).toBe("acct-temporary");
		expect(result.claimUrl).toBe(ACCOUNT.claimUrl);
	});

	it("installs before deploying", async () => {
		// wrangler needs the dependencies the generated package.json declares. A
		// deploy first would fail on a missing module rather than on anything to
		// do with Cloudflare.
		const { calls } = await provisionOk();
		expect(calls[0]?.command).toBe("npm");
		expect(calls[0]?.args).toEqual(["install", "--no-fund", "--no-audit"]);
	});

	it("deploys twice, so the second carries the real origin", async () => {
		// The property this whole sequence exists for. The worker module embeds
		// its own origin and the origin is not known until the first deploy
		// answers — so a single deploy would leave a backend advertising a
		// placeholder address to every client that asked.
		const { calls, dir } = await provisionOk();
		const deploys = calls.filter((call) => call.command === "npx");
		expect(deploys).toHaveLength(2);
		expect(deploys[0]?.args).toEqual(["wrangler", "deploy"]);
		expect(readFileSync(path.join(dir, "src", "index.ts"), "utf8")).toContain(
			"https://hobo-convex-x.acct.workers.dev",
		);
	});

	it("deploys without --temporary, using the temporary account's credentials", async () => {
		// Pinned because it looks like an omission and is not: `wrangler deploy
		// --temporary` races the Containers apply, which re-authenticates after a
		// temporary login. The credentials go in the environment instead.
		const { calls } = await provisionOk();
		const deploy = calls.find((call) => call.command === "npx");
		expect(deploy?.args).not.toContain("--temporary");
	});

	it("waits for the backend to answer /version before minting a key", async () => {
		// The admin-key bridge runs inside the container. Minting before the
		// container is up would fail on a cold start and look like an auth
		// problem.
		const { seen } = await provisionOk();
		const versionAt = seen.findIndex((url) => url.endsWith("/version"));
		const keyAt = seen.findIndex((url) => url.endsWith("/.hobo/admin-key"));
		expect(versionAt).toBeGreaterThanOrEqual(0);
		expect(keyAt).toBeGreaterThan(versionAt);
	});

	it("uses the URL wrangler printed rather than asking the API for one", async () => {
		// The fallback exists, but calling the subdomain API when the deploy
		// already told us the answer would be two avoidable round trips on the
		// common path.
		const { seen } = await provisionOk();
		expect(seen.some((url) => url.includes("/workers/subdomain"))).toBe(false);
	});
});

describe("resolving the origin when wrangler printed none", () => {
	/** Deploy output with no URL, forcing the subdomain-API fallback. */
	const SILENT_DEPLOY = [{}, { stdout: "Total Upload: 4 KiB\n" }, {}];

	function fetchWithSubdomain(subdomain?: string) {
		const seen: string[] = [];
		const impl: typeof fetch = async (url) => {
			const href = String(url);
			seen.push(href);
			if (href.endsWith("/version")) return statusOnly(200);
			if (href.endsWith("/.hobo/admin-key")) {
				return jsonResponse({ adminKey: "k" });
			}
			return jsonResponse({
				success: true,
				result: subdomain === undefined ? {} : { subdomain },
			});
		};
		return { impl, seen };
	}

	it("asks the API for the account subdomain and builds the origin from it", async () => {
		const fetched = fetchWithSubdomain("acct");
		const result = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			workerName: "w1",
			temporaryAccount: ACCOUNT,
			spawn: recordingSpawn(SILENT_DEPLOY).spawn,
			fetchImpl: fetched.impl,
		});
		expect(result.backendUrl).toBe("https://w1.acct.workers.dev");
	});

	it("enables the subdomain before reading it", async () => {
		// A freshly created temporary account has workers.dev disabled. Reading
		// without enabling would return no subdomain and fail a provision that
		// would otherwise have worked.
		const fetched = fetchWithSubdomain("acct");
		await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			workerName: "w1",
			temporaryAccount: ACCOUNT,
			spawn: recordingSpawn(SILENT_DEPLOY).spawn,
			fetchImpl: fetched.impl,
		});
		const enableAt = fetched.seen.findIndex((url) =>
			url.includes("/scripts/w1/subdomain"),
		);
		const readAt = fetched.seen.findIndex((url) =>
			url.endsWith("/workers/subdomain"),
		);
		expect(enableAt).toBeGreaterThanOrEqual(0);
		expect(readAt).toBeGreaterThan(enableAt);
	});

	it("continues when the enable call fails, because it is best-effort", async () => {
		// `.catch(() => undefined)`. The subdomain is often already enabled, and
		// a 409 on the enable must not fail a provision whose read then succeeds.
		const seen: string[] = [];
		const impl: typeof fetch = async (url) => {
			const href = String(url);
			seen.push(href);
			if (href.includes("/scripts/")) throw new Error("network blip");
			if (href.endsWith("/version")) return statusOnly(200);
			if (href.endsWith("/.hobo/admin-key")) {
				return jsonResponse({ adminKey: "k" });
			}
			return jsonResponse({ result: { subdomain: "acct" } });
		};
		const result = await provisionConvexBackendOnCloudflare({
			workDir: workDir(),
			workerName: "w1",
			temporaryAccount: ACCOUNT,
			spawn: recordingSpawn(SILENT_DEPLOY).spawn,
			fetchImpl: impl,
		});
		expect(result.backendUrl).toBe("https://w1.acct.workers.dev");
	});

	it("refuses when the account reports no subdomain at all", async () => {
		// Without a subdomain there is no origin, and inventing one would return
		// a backend URL that resolves to nothing — a provision that reports
		// success and hands back a dead address.
		await expect(
			provisionConvexBackendOnCloudflare({
				workDir: workDir(),
				workerName: "w1",
				temporaryAccount: ACCOUNT,
				spawn: recordingSpawn(SILENT_DEPLOY).spawn,
				fetchImpl: fetchWithSubdomain(undefined).impl,
			}),
		).rejects.toThrow(/Workers subdomain missing/u);
	});
});

describe("failures carry the claim URL", () => {
	/**
	 * Every failing branch must name the claim URL, because the temporary
	 * account exists regardless of whether what was deployed onto it worked.
	 */
	async function failureFrom(
		results: ReadonlyArray<{
			exitCode?: number;
			stdout?: string;
			stderr?: string;
		}>,
		fetchImpl?: typeof fetch,
		waitForReadyMs = 0,
	): Promise<ConvexCloudflareContainersError> {
		try {
			await provisionConvexBackendOnCloudflare({
				workDir: workDir(),
				temporaryAccount: ACCOUNT,
				spawn: recordingSpawn(results).spawn,
				fetchImpl: fetchImpl ?? happyFetch().impl,
				waitForReadyMs,
			});
		} catch (error) {
			if (error instanceof ConvexCloudflareContainersError) return error;
			throw error;
		}
		throw new Error("expected the provision to fail");
	}

	it("reports a failed npm install with its stderr", async () => {
		const error = await failureFrom([
			{ exitCode: 1, stderr: "ETARGET no matching version" },
		]);
		expect(error.message).toContain("npm install failed");
		expect(error.message).toContain("ETARGET");
		expect(error.claimUrl).toBe(ACCOUNT.claimUrl);
	});

	it("falls back to stdout when a failing npm said nothing on stderr", async () => {
		const error = await failureFrom([
			{ exitCode: 1, stdout: "npm ERR! code E404" },
		]);
		expect(error.message).toContain("E404");
	});

	it("diagnoses the Containers 403 rather than calling it a deploy failure", async () => {
		// The consequential branch. Cloudflare does not grant the Containers
		// runtime on Temporary Accounts, and reporting that as "wrangler deploy
		// failed" would send someone debugging their own worker for a platform
		// limitation with a known workaround — claim the account.
		const error = await failureFrom([
			{},
			{
				exitCode: 1,
				stderr: "✘ Authentication error [code: 10000]",
			},
		]);
		expect(error.message).toContain("Containers application create");
		expect(error.message).toContain("Temporary Accounts");
		expect(error.claimUrl).toBe(ACCOUNT.claimUrl);
	});

	it("recognises the 403 by any of its three tells", async () => {
		// Cloudflare words this differently depending on which layer refuses.
		// Matching only one spelling would misdiagnose the other two.
		for (const stderr of [
			"Forbidden",
			"POST /accounts/x/containers/applications failed",
			"Authentication error",
		]) {
			const error = await failureFrom([{}, { exitCode: 1, stderr }]);
			expect(error.message).toContain("Containers application create");
		}
	});

	it("sees through the ANSI colouring wrangler writes to a TTY", async () => {
		// wrangler wraps its errors in CSI sequences. A naive substring match
		// against the raw bytes would miss the tell and misdiagnose every
		// coloured 403 — which is to say, every one produced in a terminal.
		const error = await failureFrom([
			{},
			{ exitCode: 1, stderr: "[31mForbidden[0m" },
		]);
		expect(error.message).toContain("Containers application create");
	});

	it("reports an ordinary deploy failure as itself", async () => {
		// The other side of the 403 branch: a genuine worker error must not be
		// dressed up as a platform limitation, or the real cause would never be
		// looked at.
		const error = await failureFrom([
			{},
			{ exitCode: 1, stderr: "SyntaxError in src/index.ts" },
		]);
		expect(error.message).toContain("Anon wrangler deploy failed");
		expect(error.message).toContain("SyntaxError");
		expect(error.claimUrl).toBe(ACCOUNT.claimUrl);
	});

	it("reports a failed redeploy distinctly from the first deploy", async () => {
		// Two different situations: the first deploy failing means nothing was
		// created; the redeploy failing means a worker is live and advertising a
		// placeholder origin. One message for both would hide that difference.
		const error = await failureFrom([
			{},
			{ stdout: "https://w.acct.workers.dev" },
			{ exitCode: 1, stderr: "upload rejected" },
		]);
		expect(error.message).toContain("redeploy (origins) failed");
		expect(error.claimUrl).toBe(ACCOUNT.claimUrl);
	});

	it("gives up on a backend that never becomes ready, naming what it saw", async () => {
		// The last error is carried into the message. "Did not become ready" on
		// its own would not distinguish a container that never started from one
		// answering 503.
		const impl: typeof fetch = async (url) => {
			if (String(url).endsWith("/version")) return statusOnly(503);
			return jsonResponse({ adminKey: "k" });
		};
		const error = await failureFrom(OK_SPAWN, impl);
		expect(error.message).toContain("did not become ready");
	});

	it("refuses when the admin-key bridge rejects the bootstrap token", async () => {
		// The status is in the message because a 401 and a 404 mean different
		// things here: the wrong token versus a worker that never mounted the
		// bridge route.
		const impl: typeof fetch = async (url) => {
			if (String(url).endsWith("/version")) return statusOnly(200);
			return statusOnly(401);
		};
		const error = await failureFrom(OK_SPAWN, impl, 5_000);
		expect(error.message).toContain("Failed to mint Convex admin key");
		expect(error.message).toContain("401");
	});

	it("refuses an admin-key response carrying no usable key", async () => {
		// A 200 with a missing or empty key would otherwise be returned as the
		// admin key, and every later `convex deploy` would fail authenticating
		// with an empty credential.
		for (const body of [{}, { adminKey: "" }, { adminKey: 42 }]) {
			const impl: typeof fetch = async (url) => {
				if (String(url).endsWith("/version")) return statusOnly(200);
				return jsonResponse(body);
			};
			const error = await failureFrom(OK_SPAWN, impl, 5_000);
			expect(error.message).toContain("returned no adminKey");
		}
	});
});

describe("ConvexCloudflareContainersError", () => {
	it("carries a claim URL when one is known", () => {
		const error = new ConvexCloudflareContainersError("boom", "https://claim");
		expect(error.claimUrl).toBe("https://claim");
		expect(error.name).toBe("ConvexCloudflareContainersError");
	});

	it("omits the field entirely when there is no account to claim", () => {
		// Not an empty string. A caller rendering "claim your account at ''"
		// would be worse than one that knew there was nothing to render.
		expect(
			new ConvexCloudflareContainersError("boom").claimUrl,
		).toBeUndefined();
		expect(
			new ConvexCloudflareContainersError("boom", "").claimUrl,
		).toBeUndefined();
	});
});
