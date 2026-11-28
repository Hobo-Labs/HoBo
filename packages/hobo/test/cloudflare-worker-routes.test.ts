import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKER_URL = new URL(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"fixtures",
		"deploy",
		"cloudflare",
		"worker.mjs",
	),
	"file:",
).href;

interface WorkerModule {
	default: { fetch(request: Request): Promise<Response> };
}

async function loadWorker(): Promise<WorkerModule["default"]> {
	// SAFETY: assertion required at this I/O or test boundary.
	const mod = (await import(WORKER_URL)) as WorkerModule;
	return mod.default;
}

describe("hello-bindle Cloudflare worker.mjs route logic (no network)", () => {
	it("GET /hello?name=Ty returns { message: 'hello, Ty' }", async () => {
		const worker = await loadWorker();
		const res = await worker.fetch(
			new Request("https://example.workers.dev/hello?name=Ty"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({ message: "hello, Ty" });
	});

	it("GET /hello with no name defaults to 'world' (same parse boundary as src/api.ts)", async () => {
		const worker = await loadWorker();
		const res = await worker.fetch(
			new Request("https://example.workers.dev/hello"),
		);
		expect(await res.json()).toEqual({ message: "hello, world" });
	});

	it("GET / returns the hello-bindle HTML page", async () => {
		const worker = await loadWorker();
		const res = await worker.fetch(new Request("https://example.workers.dev/"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("<h1>hello-bindle</h1>");
		expect(html).toContain("<!doctype html>");
	});
});
