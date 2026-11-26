import { setTimeout as delay } from "node:timers/promises";
import { toJsonString } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	adoPrelude,
	adoSuccess,
	adoTarget,
	createAdoPactBroker,
} from "../../contracts/fixtures/pact-broker.js";
import { AdoProjectSchema } from "../../src/_generated/project_pb.js";
import {
	loadAdoProject,
	parseAdoLiveTarget,
	parseAdoProject,
	verifyLiveAdoPipeline,
} from "../../src/index.js";

const brokers: ReturnType<typeof createAdoPactBroker>[] = [];
afterEach(() => {
	for (const broker of brokers.splice(0)) broker.assertComplete();
});
async function fixture(sequence: readonly string[]) {
	const broker = createAdoPactBroker(sequence);
	brokers.push(broker);
	const { project, pipeline } = await loadAdoProject(
		new URL("../../../..", import.meta.url).pathname,
		"packages/ci-ado/examples/ci.json",
	);
	return {
		broker,
		project,
		pipeline,
		run: (
			options: NonNullable<Parameters<typeof verifyLiveAdoPipeline>[3]> = {},
			targetFields: Partial<typeof adoTarget> = {},
		) =>
			verifyLiveAdoPipeline(
				parseAdoLiveTarget(JSON.stringify({ ...adoTarget, ...targetFields })),
				project,
				pipeline,
				{
					fetch: broker.fetch,
					hostEnvironment: { ADO_TEST_PAT: "fixture-pat" },
					pollMilliseconds: 1,
					...options,
				},
			),
	};
}
const beforeQueue = adoPrelude.slice(0, 2);
const completed = [...adoPrelude, "observe successful pipeline"];
const verified = [...completed, "inspect native pipeline timeline"];

describe("Azure admission edge states", () => {
	it("encodes spaces in project API paths", async () => {
		const f = await fixture([adoPrelude[0], "spaced project lookup"]);
		await expect(f.run({}, { project: "HoBo Project" })).rejects.toThrow(
			/pinned pipeline revision/,
		);
	});
	it("encodes spaces in the pool discovery query", async () => {
		const f = await fixture([
			"spaced pool lookup",
			"missing definition revision",
		]);
		const project = parseAdoProject(
			toJsonString(AdoProjectSchema, { ...f.project, pool: "HoBo Local" }),
		);
		await expect(
			verifyLiveAdoPipeline(
				parseAdoLiveTarget(JSON.stringify(adoTarget)),
				project,
				f.pipeline,
				{
					fetch: f.broker.fetch,
					hostEnvironment: { ADO_TEST_PAT: "fixture-pat" },
				},
			),
		).rejects.toThrow(/pinned pipeline revision/);
	});
	it.each([
		"empty pool inventory",
		"zero pool identity",
		"ambiguous pool inventory",
	])("refuses %s before queueing", async (state) => {
		const f = await fixture([state]);
		await expect(f.run()).rejects.toThrow(/self-hosted/);
	});
	it.each([
		401, 404, 429, 500, 503,
	])("does not retry or echo the HTTP %s error body", async (status) => {
		const f = await fixture([`pool HTTP ${status}`]);
		await expect(f.run()).rejects.toThrow(new RegExp(`HTTP ${status}$`));
	});
	it("accepts vendor extensions without relaxing required fields", async () => {
		const f = await fixture(["unknown vendor fields", ...adoSuccess.slice(1)]);
		await expect(f.run()).resolves.toMatchObject({ runId: 42 });
	});
	it.each([
		"wrong definition identity",
		"missing definition revision",
		"malformed definition",
	])("rejects %s", async (state) => {
		const f = await fixture([adoPrelude[0], state]);
		await expect(f.run()).rejects.toThrow();
	});
	it.each([
		"empty preview",
		"null preview",
		"invalid preview YAML",
		"multiple preview stages",
		"mixed preview roots",
		"duplicate preview job",
		"missing preview pool",
		"hosted image alongside pool",
		"missing publish task",
		"missing download task",
		"missing bundle guard",
		"digest prefix spoof",
		"wrong compiled Bash version",
		"missing inline script",
	])("rejects %s before creating a run", async (state) => {
		const f = await fixture([...beforeQueue, state]);
		await expect(f.run()).rejects.toThrow();
	});
	it.each([
		"missing queued identity",
		"negative queued identity",
		"malformed queued identity",
		"queue HTTP 403",
	])("treats %s as unconfirmed without retry", async (state) => {
		const f = await fixture([...adoPrelude.slice(0, 3), state]);
		await expect(f.run()).rejects.toThrow(/no automatic retry/);
		expect(f.broker.calls).toHaveLength(4);
	});
});

describe("Azure execution and shutdown edge states", () => {
	it.each([
		"notStarted",
		"postponed",
	])("polls %s until terminal success", async (state) => {
		const f = await fixture([
			...adoPrelude,
			`pipeline state ${state}`,
			...adoSuccess.slice(5),
		]);
		await expect(f.run()).resolves.toMatchObject({ result: "succeeded" });
	});
	it.each([
		"canceled",
		"partiallySucceeded",
		"none",
		"unexpected",
	])("does not accept terminal result %s", async (result) => {
		const f = await fixture([...adoPrelude, `pipeline result ${result}`]);
		await expect(f.run()).rejects.toThrow(/did not succeed/);
	});
	it.each([
		"wrong completed run identity",
		"missing run pool",
		"malformed status",
		"status HTTP 503",
		"pipeline state mystery",
		"pipeline state cancelling",
	])("cancels the known run after %s", async (state) => {
		const f = await fixture([
			...adoPrelude,
			state,
			"cancel unfinished pipeline",
			"observe cancelled pipeline",
		]);
		await expect(f.run()).rejects.toThrow();
		expect(f.broker.served.at(-1)).toBe("observe cancelled pipeline");
	});
	it.each([
		"wrong cancelled identity",
		"malformed cancellation status",
	])("refuses to confirm cancellation with %s", async (state) => {
		const f = await fixture([
			...adoPrelude,
			"observe wrong source",
			"cancel unfinished pipeline",
			state,
		]);
		await expect(f.run()).rejects.toThrow(
			/cancellation could not be confirmed/,
		);
	});
	it("polls cancellation and ignores an irrelevant PATCH response body", async () => {
		const f = await fixture([
			...adoPrelude,
			"observe wrong source",
			"malformed cancellation reply",
			"cancellation still pending",
			"observe cancelled pipeline",
		]);
		await expect(f.run()).rejects.toThrow(/provenance/);
	});
	it.each([
		"checks",
		"publish",
		"download",
		"hashes",
	])("requires successful timeline %s", async (name) => {
		const f = await fixture([...completed, `failed timeline ${name}`]);
		await expect(f.run()).rejects.toThrow(/acceptance step/);
	});
	it.each([
		"unfinished verifier job",
		"failed verifier job",
		"missing verifier job",
	])("rejects %s", async (state) => {
		const f = await fixture([...completed, state]);
		await expect(f.run()).rejects.toThrow(/job did not complete/);
	});
	it.each([
		"wrong artifact type",
		"missing artifact resource",
		"wrong artifact prefix",
		"empty artifact suffix",
	])("rejects %s", async (state) => {
		const f = await fixture([...verified, state]);
		await expect(f.run()).rejects.toThrow(/retain.*Pipeline Artifact/);
	});
	it.each([
		["timeline HTTP 403", completed],
		["artifacts HTTP 503", verified],
	] as const)("does not cancel an already finished run after %s", async (state, prefix) => {
		const f = await fixture([...prefix, state]);
		await expect(f.run()).rejects.toThrow(/HTTP/);
	});
});

describe("Azure authentication and transport edges", () => {
	// The only case that waits out the real one-second default poll, so it is the
	// one a stalled runner fails: it took 10.7 s in merge-group run 43318507956.
	it("supports the real process environment and default polling interval", {
		// A timeout given here overrides the config's, so keep HOBO_TEST_TIMEOUT able to raise it.
		timeout: Math.max(60_000, Number(process.env.HOBO_TEST_TIMEOUT) || 0),
	}, async () => {
		const f = await fixture(adoSuccess);
		const previous = process.env.ADO_TEST_PAT;
		process.env.ADO_TEST_PAT = "fixture-pat";
		try {
			await expect(
				verifyLiveAdoPipeline(
					parseAdoLiveTarget(JSON.stringify(adoTarget)),
					f.project,
					f.pipeline,
					{ fetch: f.broker.fetch },
				),
			).resolves.toMatchObject({ runId: 42 });
		} finally {
			if (previous === undefined) delete process.env.ADO_TEST_PAT;
			else process.env.ADO_TEST_PAT = previous;
		}
	});
	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("rejects non-finite polling interval %# without issuing requests", async (pollMilliseconds) => {
		const f = await fixture([]);
		await expect(f.run({ pollMilliseconds })).rejects.toThrow(
			/polling interval/,
		);
	});
	it.each([
		undefined,
		"",
		"$(ADO_TEST_PAT)",
		"bad\rvalue",
		"bad\nvalue",
		"bad\0value",
		"x".repeat(16385),
	])("refuses invalid credential %# before network effects", async (token) => {
		const f = await fixture([]);
		const host: NodeJS.ProcessEnv = {};
		if (token !== undefined) host.ADO_TEST_PAT = token;
		await expect(f.run({ hostEnvironment: host })).rejects.toThrow(
			/authentication is not configured/,
		);
	});
	it("refuses a credential inherited through the environment prototype", async () => {
		const f = await fixture([]);
		const host: NodeJS.ProcessEnv = {};
		Object.setPrototypeOf(host, { ADO_TEST_PAT: "fixture-pat" });
		await expect(f.run({ hostEnvironment: host })).rejects.toThrow(
			/authentication is not configured/,
		);
	});
	it("uses bearer authorization from its recorded Pact", async () => {
		const f = await fixture(["bearer pool authorization"]);
		const stopped = new AbortController();
		const transport: typeof fetch = async (input, init) => {
			const response = await f.broker.fetch(input, init);
			stopped.abort();
			return response;
		};
		await expect(
			f.run(
				{ fetch: transport, signal: stopped.signal },
				{ authentication: "bearer" },
			),
		).rejects.toThrow();
	});
	it("does not issue requests after a pre-aborted signal", async () => {
		const f = await fixture([]);
		await expect(f.run({ signal: AbortSignal.abort() })).rejects.toThrow();
	});
	it("refuses live acceptance when native verification is disabled", async () => {
		const f = await fixture([]);
		const project = parseAdoProject(
			toJsonString(AdoProjectSchema, { ...f.project, verifyArtifacts: false }),
		);
		await expect(
			verifyLiveAdoPipeline(
				parseAdoLiveTarget(JSON.stringify(adoTarget)),
				project,
				f.pipeline,
			),
		).rejects.toThrow(/verifyArtifacts/);
	});
	it("does not expose transport error credential material", async () => {
		const f = await fixture([]);
		const transport: typeof fetch = async () => {
			throw new Error("transport spilled fixture-pat");
		};
		await expect(f.run({ fetch: transport })).rejects.toThrow(
			/^Azure GET transport failed$/,
		);
	});
	it("bounds a response even if its body stalls after headers", async () => {
		const f = await fixture([adoPrelude[0]]);
		const stop = new AbortController();
		let close: (() => void) | undefined;
		let cancelled = false;
		const transport: typeof fetch = async (input, init) => {
			const response = await f.broker.fetch(input, init);
			const bytes = new TextEncoder().encode(await response.text());
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes.subarray(0, 10));
					close = () => controller.close();
				},
				cancel() {
					cancelled = true;
				},
			});
			setTimeout(() => stop.abort(), 10);
			return new Response(body);
		};
		const operation = f.run({ fetch: transport, signal: stop.signal });
		try {
			await expect(
				Promise.race([
					operation,
					delay(200).then(() => {
						throw new Error("response read did not stop");
					}),
				]),
			).rejects.toThrow(/Azure response stopped/);
			expect(cancelled).toBe(true);
		} finally {
			if (!cancelled) close?.();
			await operation.catch(() => undefined);
		}
	});
});

describe("response framing and deadline edges", () => {
	it("accepts exactly one MiB of valid JSON with padding", async () => {
		const f = await fixture(adoSuccess);
		const transport: typeof fetch = async (input, init) => {
			const response = await f.broker.fetch(input, init);
			if (f.broker.served.length !== 1) return response;
			return new Response((await response.text()).padEnd(1024 * 1024, " "));
		};
		await expect(f.run({ fetch: transport })).resolves.toMatchObject({
			runId: 42,
		});
	});
	it.each([
		"oversized",
		"truncated",
		"empty",
		"broken-stream",
	])("refuses %s delivery of a recorded response", async (kind) => {
		const f = await fixture([adoPrelude[0]]);
		const transport: typeof fetch = async (input, init) => {
			const response = await f.broker.fetch(input, init);
			const text = await response.text();
			if (kind === "empty") return new Response(null);
			if (kind === "truncated") return new Response(text.slice(0, -1));
			if (kind === "oversized")
				return new Response(text.padEnd(1024 * 1024 + 1, " "));
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("fixture-pat stream error"));
					},
				}),
			);
		};
		await expect(f.run({ fetch: transport })).rejects.toThrow(/Azure/);
	});
	it("does not wait indefinitely for an HTTP error body's cancellation", async () => {
		const f = await fixture(["pool HTTP 503"]);
		let finishCancel: (() => void) | undefined;
		const transport: typeof fetch = async (input, init) => {
			const response = await f.broker.fetch(input, init);
			const bytes = new TextEncoder().encode(await response.text());
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
					},
					cancel() {
						return new Promise<void>((resolve) => {
							finishCancel = resolve;
						});
					},
				}),
				{ status: response.status },
			);
		};
		const operation = f.run({ fetch: transport });
		try {
			await expect(
				Promise.race([
					operation,
					delay(200).then(() => {
						throw new Error("HTTP cancellation hung");
					}),
				]),
			).rejects.toThrow(/HTTP 503/);
		} finally {
			finishCancel?.();
			await operation.catch(() => undefined);
		}
	});
	it("enforces the overall deadline while polling and reconciles cancellation", async () => {
		const f = await fixture([
			...adoPrelude,
			"observe running pipeline",
			"cancel unfinished pipeline",
			"observe cancelled pipeline",
		]);
		await expect(
			f.run({ pollMilliseconds: 5000 }, { timeoutSeconds: 1 }),
		).rejects.toThrow();
		expect(f.broker.served.at(-1)).toBe("observe cancelled pipeline");
	});
	it("bounds cancellation reconciliation if the provider never becomes terminal", async () => {
		const f = await fixture([
			...adoPrelude,
			"observe wrong source",
			"cancel unfinished pipeline",
			"cancellation still pending",
			"cancellation still pending",
		]);
		await expect(f.run({ pollMilliseconds: 10000 })).rejects.toThrow(
			/cancellation could not be confirmed/,
		);
	}, 20000);
});

it("does not leak a rejected HTTP error-body cleanup promise", async () => {
	const f = await fixture(["pool HTTP 503"]);
	const transport: typeof fetch = async (input, init) => {
		const response = await f.broker.fetch(input, init);
		const bytes = new TextEncoder().encode(await response.text());
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
				},
				cancel() {
					throw new Error("fixture-pat cleanup error");
				},
			}),
			{ status: response.status },
		);
	};
	await expect(f.run({ fetch: transport })).rejects.toThrow(
		/^Azure GET failed with HTTP 503$/,
	);
});

it("bounds missing response headers and releases a transport that settles after abort", async () => {
	const f = await fixture([adoPrelude[0]]);
	const stopped = new AbortController();
	let deliver: (() => void) | undefined;
	let lateCancelled = false;
	const transport: typeof fetch = async (input, init) => {
		const response = await f.broker.fetch(input, init);
		const bytes = new TextEncoder().encode(await response.text());
		return new Promise<Response>((resolve) => {
			deliver = () =>
				resolve(
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(bytes);
							},
							cancel() {
								lateCancelled = true;
								throw new Error("fixture-pat late cleanup error");
							},
						}),
					),
				);
			setTimeout(() => stopped.abort(), 10);
		});
	};
	const operation = f.run({ fetch: transport, signal: stopped.signal });
	try {
		await expect(
			Promise.race([
				operation,
				delay(200).then(() => {
					throw new Error("missing headers hung");
				}),
			]),
		).rejects.toThrow(/^Azure GET transport failed$/);
	} finally {
		deliver?.();
		await operation.catch(() => undefined);
	}
	await delay(0);
	expect(lateCancelled).toBe(true);
});

it("honors cancellation between response chunks before the next read subscribes", async () => {
	const f = await fixture([adoPrelude[0]]);
	const stopped = new AbortController();
	const transport: typeof fetch = async (input, init) => {
		const response = await f.broker.fetch(input, init);
		const bytes = new TextEncoder().encode(await response.text());
		return new Response(
			new ReadableStream(
				{
					pull(controller) {
						controller.enqueue(bytes.subarray(0, 10));
						queueMicrotask(() => stopped.abort());
					},
				},
				{ highWaterMark: 0 },
			),
		);
	};
	await expect(
		f.run({ fetch: transport, signal: stopped.signal }),
	).rejects.toThrow(/^Azure response stopped$/);
});

it("handles abort raised synchronously inside the Fetch port", async () => {
	const f = await fixture([adoPrelude[0]]);
	const stopped = new AbortController();
	let issued: Promise<Response> | undefined;
	const transport: typeof fetch = (input, init) => {
		issued = f.broker.fetch(input, init);
		stopped.abort();
		return issued;
	};
	await expect(
		f.run({ fetch: transport, signal: stopped.signal }),
	).rejects.toThrow(/^Azure GET transport failed$/);
	await issued;
});
