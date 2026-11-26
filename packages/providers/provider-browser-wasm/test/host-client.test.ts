/**
 * The host-origin client and the way it maps a failed response onto a code.
 *
 * Two GETs, each parsed on the way back, and the mapping between them is where
 * the judgement lives.
 *
 * **The origin's own fault envelope beats the HTTP status.** A host serving
 * these routes can say *why* it refused — `GUEST_NOT_FOUND`, `HOST_UNSUPPORTED`
 * — and that is more precise than the status it happened to use. A 400 carrying
 * `HOST_UNSUPPORTED` means the page cannot run this guest at all; a bare 400
 * means the request was malformed. Reading only the status would collapse those
 * into one, and the caller would retry something that can never succeed.
 *
 * **A read is safe to repeat, so 5xx is retryable.** Nothing on these routes
 * mutates the origin. That is the opposite of the writer-side rule elsewhere in
 * the repo, and it is right for the same reason: what makes a retry dangerous is
 * the possibility that the first attempt took effect.
 *
 * **An unparseable body still has to produce a diagnosis.** When the fault
 * envelope does not parse, the first 256 bytes are redacted and carried instead
 * — because a host that answered with an HTML error page has still told you
 * something, and dropping it leaves a status code and nothing else.
 */
import { describe, expect, it } from "vitest";
import { createHostAssetClient, errorForHostResponse } from "../src/client.js";
import {
	type BrowserWasmProviderError,
	redactHostText,
} from "../src/errors.js";
import { HOST_FAULT_SCHEMA } from "../src/manifest.js";
import { guestManifestPath, HOST_CAPABILITIES_PATH } from "../src/placement.js";
import type {
	HostAssetTransport,
	TransportResponse,
} from "../src/transport.js";

const ORIGIN = "https://app.example";

function bytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(
		typeof value === "string" ? value : JSON.stringify(value),
	);
}

function response(
	overrides: Partial<TransportResponse> & { status: number },
): TransportResponse {
	return {
		headers: {},
		body: new Uint8Array(),
		...overrides,
	};
}

function fault(code: string, extra: Record<string, unknown> = {}) {
	return bytes({
		schemaVersion: HOST_FAULT_SCHEMA,
		code,
		guestId: "guest-1",
		...extra,
	});
}

/** A transport that answers each requested path from a fixed map. */
function transportFor(routes: Record<string, TransportResponse>) {
	const seen: string[] = [];
	const transport: HostAssetTransport = {
		async request(request) {
			seen.push(request.url);
			const path = new URL(request.url).pathname;
			return routes[path] ?? response({ status: 404 });
		},
	};
	return { transport, seen };
}

describe("errorForHostResponse", () => {
	const context = { what: "a bundle for guest-1" };

	it("maps a 404 to an unavailable bundle", () => {
		expect(errorForHostResponse(response({ status: 404 }), context).code).toBe(
			"BUNDLE_UNAVAILABLE",
		);
	});

	it("maps a GUEST_NOT_FOUND fault to unavailable whatever the status", () => {
		// The envelope beats the status. A host that used a 200 or a 400 to carry
		// "no such guest" still means the guest is not there, and a caller that
		// read only the status would report a contract change instead.
		for (const status of [200, 400, 403, 409]) {
			expect(
				errorForHostResponse(
					response({ status, body: fault("GUEST_NOT_FOUND") }),
					context,
				).code,
			).toBe("BUNDLE_UNAVAILABLE");
		}
	});

	it("maps a HOST_UNSUPPORTED fault to host-unsupported", () => {
		// The distinction that matters most: this page cannot run this guest at
		// all. Collapsing it into a generic 4xx would invite a retry that can
		// never succeed.
		expect(
			errorForHostResponse(
				response({ status: 400, body: fault("HOST_UNSUPPORTED") }),
				context,
			).code,
		).toBe("HOST_UNSUPPORTED");
	});

	it("prefers the fault code over a 5xx status", () => {
		// A 500 that says HOST_UNSUPPORTED is not a transient server error, and
		// marking it retryable would spin.
		const error = errorForHostResponse(
			response({ status: 500, body: fault("HOST_UNSUPPORTED") }),
			context,
		);
		expect(error.code).toBe("HOST_UNSUPPORTED");
		expect(error.retryable).toBe(false);
	});

	it("maps an unexplained 5xx to a retryable unavailable bundle", () => {
		// Retryable because nothing on these routes mutates the origin — a read
		// repeated costs a round trip and changes nothing. That is exactly the
		// property the writer-side rule elsewhere in the repo lacks.
		for (const status of [500, 502, 503, 504]) {
			const error = errorForHostResponse(response({ status }), context);
			expect(error.code).toBe("BUNDLE_UNAVAILABLE");
			expect(error.retryable).toBe(true);
		}
	});

	it("maps any other status to a contract change", () => {
		// A 401 or a 418 on a public asset route is not a situation this client
		// models. Naming it a contract change says so, rather than guessing.
		for (const status of [400, 401, 403, 418, 429]) {
			const error = errorForHostResponse(response({ status }), context);
			expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
			expect(error.retryable).toBe(false);
		}
	});

	it("carries the status and what was being fetched in the detail", () => {
		// The `what` is what makes two identical 404s distinguishable — one for a
		// manifest, one for a bundle.
		const detail = errorForHostResponse(response({ status: 404 }), context)
			.detail as Record<string, unknown>;
		expect(detail.status).toBe(404);
		expect(detail.what).toBe("a bundle for guest-1");
	});

	it("carries the fault code and message when the envelope parsed", () => {
		const detail = errorForHostResponse(
			response({
				status: 400,
				body: fault("HOST_UNSUPPORTED", { message: "no SharedArrayBuffer" }),
			}),
			context,
		).detail as Record<string, unknown>;
		expect(detail.faultCode).toBe("HOST_UNSUPPORTED");
		expect(detail.message).toBe("no SharedArrayBuffer");
	});

	it("omits the fault code entirely when no envelope parsed", () => {
		// Conditional spread. A `faultCode: ""` in a receipt would read as a host
		// that sent an empty code rather than one that sent no envelope at all.
		const detail = errorForHostResponse(
			response({ status: 500, body: bytes("upstream timeout") }),
			context,
		).detail as Record<string, unknown>;
		expect(Object.hasOwn(detail, "faultCode")).toBe(false);
	});

	it("falls back to the raw body when the envelope does not parse", () => {
		// A host that answered with an HTML error page has still told you
		// something. Dropping it would leave a status code and nothing else.
		const detail = errorForHostResponse(
			response({ status: 502, body: bytes("<h1>Bad Gateway</h1>") }),
			context,
		).detail as Record<string, unknown>;
		expect(String(detail.message)).toContain("Bad Gateway");
	});

	it("redacts a secret in an unparseable body", () => {
		// The fallback path reads arbitrary origin bytes into a message that
		// reaches a console and a receipt. A session token in an error page would
		// otherwise ride along.
		const detail = errorForHostResponse(
			response({
				status: 500,
				body: bytes("failed for Bearer s3cr3ttoken99"),
			}),
			context,
		).detail as Record<string, unknown>;
		expect(String(detail.message)).not.toContain("s3cr3ttoken99");
	});

	it("truncates a large unparseable body rather than carrying all of it", () => {
		// Only the first 256 bytes are read, then redacted to 180. An unbounded
		// error page in a detail field would be copied into every log line that
		// mentioned the failure.
		const detail = errorForHostResponse(
			response({ status: 500, body: bytes("a".repeat(4096)) }),
			context,
		).detail as Record<string, unknown>;
		expect(String(detail.message).length).toBeLessThanOrEqual(181);
	});

	it("omits an empty message rather than carrying a blank one", () => {
		const detail = errorForHostResponse(
			response({ status: 500, body: new Uint8Array() }),
			context,
		).detail as Record<string, unknown>;
		expect(Object.hasOwn(detail, "message")).toBe(false);
	});

	it("redacts a message the host supplied in a valid envelope", () => {
		// Parsed does not mean trusted. A host fault message is host text like
		// any other.
		const detail = errorForHostResponse(
			response({
				status: 400,
				body: fault("HOST_UNSUPPORTED", {
					message: "denied for Bearer s3cr3ttoken99",
				}),
			}),
			context,
		).detail as Record<string, unknown>;
		expect(String(detail.message)).not.toContain("s3cr3ttoken99");
		expect(String(detail.message)).toBe(
			redactHostText("denied for Bearer s3cr3ttoken99", 512),
		);
	});

	it("names what was being fetched in the message, not just the detail", () => {
		// The message is what a developer sees first. "the host origin has no
		// bundle" without saying which guest would send them looking.
		expect(
			errorForHostResponse(response({ status: 404 }), context).message,
		).toContain("a bundle for guest-1");
	});
});

describe("createHostAssetClient", () => {
	const CAPABILITIES = bytes({
		schemaVersion: "hobo.browser-wasm.host-capabilities/v1",
		origin: ORIGIN,
		crossOriginIsolated: true,
		dedicatedWorkers: true,
		persistence: "transient-memory",
		maxMemoryBytes: 512 * 1024 * 1024,
	});

	it("reports the origin it was built for", () => {
		const { transport } = transportFor({});
		expect(createHostAssetClient({ transport, origin: ORIGIN }).origin).toBe(
			ORIGIN,
		);
	});

	it("fetches host capabilities from the documented path", async () => {
		const { transport, seen } = transportFor({
			[HOST_CAPABILITIES_PATH]: response({ status: 200, body: CAPABILITIES }),
		});
		await createHostAssetClient({
			transport,
			origin: ORIGIN,
		}).fetchHostCapabilities();
		expect(seen[0]).toBe(`${ORIGIN}${HOST_CAPABILITIES_PATH}`);
	});

	it("returns a parsed record, never the response", async () => {
		// The whole point of the client: the only code that knows what the host's
		// documents look like is the parser. A caller receiving a response would
		// have to re-derive that knowledge.
		const { transport } = transportFor({
			[HOST_CAPABILITIES_PATH]: response({ status: 200, body: CAPABILITIES }),
		});
		const capabilities = await createHostAssetClient({
			transport,
			origin: ORIGIN,
		}).fetchHostCapabilities();
		expect(capabilities.origin).toBe(ORIGIN);
		expect(capabilities.dedicatedWorkers).toBe(true);
	});

	it("maps a non-200 on the capabilities route through the error mapper", async () => {
		const { transport } = transportFor({
			[HOST_CAPABILITIES_PATH]: response({ status: 503 }),
		});
		try {
			await createHostAssetClient({
				transport,
				origin: ORIGIN,
			}).fetchHostCapabilities();
			expect.unreachable("a 503 must be reported");
		} catch (error) {
			expect((error as BrowserWasmProviderError).code).toBe(
				"BUNDLE_UNAVAILABLE",
			);
			expect(
				((error as BrowserWasmProviderError).detail as Record<string, unknown>)
					.what,
			).toBe("host capabilities");
		}
	});

	it("fetches a guest manifest from the guest's own path", async () => {
		// The path carries the guest id, so two guests on one origin cannot read
		// each other's manifest by asking for a shared route.
		const { transport, seen } = transportFor({});
		await createHostAssetClient({ transport, origin: ORIGIN })
			.fetchGuestManifest("guest-1")
			.catch(() => undefined);
		expect(seen[0]).toBe(`${ORIGIN}${guestManifestPath("guest-1")}`);
	});

	it("names the guest in the failure when its manifest is missing", async () => {
		// A 404 for "some manifest" is unactionable on a page hosting several
		// guests.
		try {
			await createHostAssetClient({
				transport: transportFor({}).transport,
				origin: ORIGIN,
			}).fetchGuestManifest("guest-1");
			expect.unreachable("a missing manifest must be reported");
		} catch (error) {
			expect((error as Error).message).toContain("guest-1");
			expect((error as BrowserWasmProviderError).code).toBe(
				"BUNDLE_UNAVAILABLE",
			);
		}
	});

	it("strips trailing slashes from the origin before joining", async () => {
		// Without the strip the URL would contain `//`, which the transport guard
		// refuses as an un-normalized path — turning a cosmetic configuration
		// difference into a hard failure.
		const { transport, seen } = transportFor({
			[HOST_CAPABILITIES_PATH]: response({ status: 200, body: CAPABILITIES }),
		});
		await createHostAssetClient({
			transport,
			origin: `${ORIGIN}///`,
		}).fetchHostCapabilities();
		expect(seen[0]).toBe(`${ORIGIN}${HOST_CAPABILITIES_PATH}`);
	});

	it("guards every request, so a cross-origin route is refused", async () => {
		// The client wraps the caller's transport rather than using it raw. A
		// client built against one origin must not be able to fetch from another,
		// however its paths were constructed.
		const { transport } = transportFor({});
		await expect(
			createHostAssetClient({
				transport,
				origin: ORIGIN,
			}).fetchComponent({
				guestId: "guest-1",
				componentPath: "https://cdn.evil.example/g.wasm",
			} as never),
		).rejects.toThrow();
	});
});
