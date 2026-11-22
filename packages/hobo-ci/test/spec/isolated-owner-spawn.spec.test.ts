import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";

import {
	PrivateOwnerDispatchError,
	PrivateOwnerRequestError,
} from "../../src/isolated-owner-errors.js";
import {
	createIsolatedOwnerFetch,
	type PrivateOwnerChildLauncher,
} from "../../src/isolated-owner-fetch.js";
import { ownerRequest } from "../../src/isolated-owner-wire.js";

const launch = vi.fn<PrivateOwnerChildLauncher>();

beforeEach(() => {
	launch.mockReset();
});

it("times out a stalled request body before launching the child", async () => {
	vi.useFakeTimers();
	try {
		const body = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => undefined),
			cancel: () => new Promise<void>(() => undefined),
		});
		const pending = createIsolatedOwnerFetch({}, launch)(
			"https://fixture.invalid/",
			{ method: "POST", body, duplex: "half" } as const,
		).catch((error) => error);
		await vi.advanceTimersByTimeAsync(120_000);
		const result = await Promise.race([pending, Promise.resolve(undefined)]);
		expect(result).toBeInstanceOf(PrivateOwnerRequestError);
		expect(launch).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});

it("refuses a body that closes after the preparation deadline", async () => {
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	try {
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				now = 120_001;
				controller.close();
			},
		});
		await expect(
			createIsolatedOwnerFetch({}, launch)("https://fixture.invalid/", {
				method: "POST",
				body,
				duplex: "half",
			} as const),
		).rejects.toBeInstanceOf(PrivateOwnerRequestError);
		expect(launch).not.toHaveBeenCalled();
	} finally {
		clock.mockRestore();
	}
});

it("rechecks the preparation deadline immediately before spawning", async () => {
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	try {
		const options = {
			get maxResponseBytes() {
				now = 120_001;
				return 1024;
			},
		};
		await expect(
			createIsolatedOwnerFetch({}, launch, options)("https://fixture.invalid/"),
		).rejects.toBeInstanceOf(PrivateOwnerRequestError);
		expect(launch).not.toHaveBeenCalled();
	} finally {
		clock.mockRestore();
	}
});

it("refuses before sending when the deadline expires during child launch", async () => {
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	const stdin = new PassThrough();
	const end = vi.spyOn(stdin, "end");
	const child = Object.assign(new EventEmitter(), {
		stdin,
		stdout: new PassThrough(),
		kill: vi.fn(),
	});
	launch.mockImplementation(() => {
		now = 120_001;
		return child;
	});
	try {
		await expect(
			createIsolatedOwnerFetch({}, launch)("https://fixture.invalid/"),
		).rejects.toBeInstanceOf(PrivateOwnerRequestError);
		expect(end).not.toHaveBeenCalled();
		expect(child.kill).toHaveBeenCalledOnce();
	} finally {
		clock.mockRestore();
	}
});

it("keeps a response received after the dispatch deadline uncertain", async () => {
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdin,
		stdout,
		kill: vi.fn(),
	});
	stdin.on("end", () => {
		stdout.once("end", () => {
			now = 120_001;
			child.emit("close", 0);
		});
		stdout.end(
			JSON.stringify({
				ok: true,
				url: "https://fixture.invalid/",
				redirected: false,
				type: "basic",
				status: 200,
				statusText: "OK",
				headers: [],
				body: "",
			}),
		);
	});
	stdin.resume();
	launch.mockReturnValue(child);
	try {
		await expect(
			createIsolatedOwnerFetch({}, launch)("https://fixture.invalid/"),
		).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
	} finally {
		clock.mockRestore();
	}
});

it("sanitizes cancellation during body preparation before dispatch", async () => {
	const controller = new AbortController();
	const marker = "fixture-private-abort-reason";
	const body = new ReadableStream<Uint8Array>({
		pull: () => new Promise<void>(() => undefined),
	});
	const pending = createIsolatedOwnerFetch({}, launch)(
		"https://fixture.invalid/",
		{
			method: "POST",
			body,
			duplex: "half",
			signal: controller.signal,
		} as const,
	);
	controller.abort(marker);
	const failure = await pending.catch((error) => error);
	expect(failure).toBeInstanceOf(DOMException);
	expect(failure.name).toBe("AbortError");
	expect(String(failure)).not.toContain(marker);
	expect(launch).not.toHaveBeenCalled();
});

it("sanitizes a bodyless request that was already canceled", async () => {
	const controller = new AbortController();
	const marker = "fixture-private-abort-reason";
	controller.abort(marker);
	const failure = await createIsolatedOwnerFetch({}, launch)(
		"https://fixture.invalid/",
		{ signal: controller.signal },
	).catch((error) => error);
	expect(failure).toBeInstanceOf(DOMException);
	expect(failure.name).toBe("AbortError");
	expect(String(failure)).not.toContain(marker);
	expect(launch).not.toHaveBeenCalled();
});

it("sanitizes synchronous launch failures and keeps request data out of arguments and environment", async () => {
	const marker = "fixture-private-spawn-value";
	launch.mockImplementation(() => {
		throw new Error(marker);
	});
	const send = createIsolatedOwnerFetch(
		{
			HTTPS_PROXY: `https://fixture:${marker}@127.0.0.1:8888`,
		},
		launch,
	);
	const failure = await send(`https://fixture.invalid/${marker}`, {
		method: "POST",
		headers: { authorization: `Bearer ${marker}` },
		body: marker,
	}).catch((error) => error);
	expect(failure).toBeInstanceOf(PrivateOwnerRequestError);
	expect(String(failure)).not.toContain(marker);
	expect(launch).toHaveBeenCalledOnce();
	expect(JSON.stringify(launch.mock.calls)).not.toContain(marker);
});

it.each([
	false,
	true,
])("classifies an asynchronous child error according to whether spawn occurred (%s)", async (spawned) => {
	const marker = "fixture-private-child-error";
	const childProcess = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		kill: vi.fn(),
	});
	launch.mockImplementation(() => {
		queueMicrotask(() => {
			if (spawned) childProcess.emit("spawn");
			childProcess.emit("error", new Error(marker));
		});
		return childProcess;
	});
	const failure = await createIsolatedOwnerFetch({}, launch)(
		"https://fixture.invalid",
		{
			method: "POST",
			body: marker,
		},
	).catch((error) => error);
	expect(failure).toBeInstanceOf(
		spawned ? PrivateOwnerDispatchError : PrivateOwnerRequestError,
	);
	expect(String(failure)).not.toContain(marker);
});

it.each([
	"throws",
	"emits",
] as const)("sanitizes a synchronous pipe failure when kill %s", async (mode) => {
	const marker = "fixture-private-pipe-error";
	const stdin = new PassThrough();
	vi.spyOn(stdin, "end").mockImplementation(() => {
		throw new Error(marker);
	});
	const childProcess = Object.assign(new EventEmitter(), {
		stdin,
		stdout: new PassThrough(),
		kill: vi.fn(),
	});
	childProcess.kill.mockImplementation(() => {
		if (mode === "throws") throw new Error(marker);
		childProcess.emit("error", new Error(marker));
	});
	launch.mockReturnValue(childProcess);
	const failure = await createIsolatedOwnerFetch({}, launch)(
		"https://fixture.invalid",
		{
			method: "POST",
			body: marker,
		},
	).catch((error) => error);
	expect(failure).toBeInstanceOf(PrivateOwnerDispatchError);
	expect(String(failure)).not.toContain(marker);
	expect(childProcess.kill).toHaveBeenCalledOnce();
});

it("handles child and pipe errors after cancellation during launch", async () => {
	const marker = "fixture-private-cancel-error";
	const controller = new AbortController();
	const childProcess = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		kill: vi.fn(),
	});
	launch.mockImplementation(() => {
		controller.abort();
		queueMicrotask(() => {
			childProcess.emit("error", new Error(marker));
			childProcess.stdin.emit("error", new Error(marker));
			childProcess.stdout.emit("error", new Error(marker));
		});
		return childProcess;
	});
	const failure = await createIsolatedOwnerFetch({}, launch)(
		"https://fixture.invalid",
		{
			method: "POST",
			body: marker,
			signal: controller.signal,
		},
	).catch((error) => error);
	expect(failure).toBeInstanceOf(DOMException);
	expect(failure.name).toBe("AbortError");
	expect(String(failure)).not.toContain(marker);
	expect(childProcess.kill).toHaveBeenCalledOnce();
});

it("sends the supported request properties over the private pipe", async () => {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const childProcess = Object.assign(new EventEmitter(), {
		stdin,
		stdout,
		kill: vi.fn(),
	});
	const parts: Buffer[] = [];
	let received: ReturnType<typeof ownerRequest.parse> | undefined;
	stdin.on("data", (part: Buffer) => parts.push(part));
	stdin.on("end", () => {
		received = ownerRequest.parse(JSON.parse(Buffer.concat(parts).toString()));
		stdout.once("end", () => childProcess.emit("close", 0));
		stdout.end(
			JSON.stringify({
				ok: true,
				runId: received.run.id,
				url: "https://fixture.invalid/path",
				redirected: false,
				type: "basic",
				status: 200,
				statusText: "OK",
				headers: [],
				body: "",
			}),
		);
	});
	launch.mockReturnValue(childProcess);
	await createIsolatedOwnerFetch({}, launch)("https://fixture.invalid/path", {
		cache: "no-store",
		credentials: "include",
		integrity: "sha256-fixture",
		keepalive: true,
		mode: "same-origin",
		redirect: "manual",
		referrer: "https://fixture.invalid/private",
		referrerPolicy: "no-referrer",
	});
	expect(received).toMatchObject({
		cache: "no-store",
		credentials: "include",
		integrity: "sha256-fixture",
		keepalive: true,
		mode: "same-origin",
		redirect: "manual",
		referrer: "https://fixture.invalid/private",
		referrerPolicy: "no-referrer",
	});
});

it("preserves a highly fragmented request body across the private pipe", async () => {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdin,
		stdout,
		kill: vi.fn(),
	});
	const packets: Buffer[] = [];
	let received: ReturnType<typeof ownerRequest.parse> | undefined;
	stdin.on("data", (part: Buffer) => packets.push(part));
	stdin.on("end", () => {
		received = ownerRequest.parse(
			JSON.parse(Buffer.concat(packets).toString()),
		);
		stdout.once("end", () => child.emit("close", 0));
		stdout.end(
			JSON.stringify({
				ok: true,
				runId: received.run.id,
				url: "https://fixture.invalid/",
				redirected: false,
				type: "basic",
				status: 200,
				statusText: "OK",
				headers: [],
				body: "",
			}),
		);
	});
	launch.mockReturnValue(child);
	let position = 0;
	const expected = Buffer.alloc(70_000, 42);
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (position === expected.length) controller.close();
			else {
				controller.enqueue(expected.subarray(position, position + 1));
				position += 1;
			}
		},
	});
	await createIsolatedOwnerFetch({}, launch)("https://fixture.invalid/", {
		method: "POST",
		body,
		duplex: "half",
	} as const);
	expect(received?.body === expected.toString("base64")).toBe(true);
});

it("refuses an oversized child response without exposing its contents", async () => {
	const marker = "fixture-private-child-body";
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdin,
		stdout,
		kill: vi.fn(),
	});
	stdin.on("end", () => {
		stdout.once("end", () => child.emit("close", 0));
		stdout.end(
			JSON.stringify({
				ok: true,
				url: "https://fixture.invalid/",
				redirected: false,
				type: "basic",
				status: 200,
				statusText: "OK",
				headers: [],
				body: Buffer.from(marker).toString("base64"),
			}),
		);
	});
	stdin.resume();
	launch.mockReturnValue(child);
	const failure = await createIsolatedOwnerFetch({}, launch, {
		maxResponseBytes: 2,
	})("https://fixture.invalid/").catch((error) => error);
	expect(failure).toBeInstanceOf(PrivateOwnerDispatchError);
	expect(String(failure)).not.toContain(marker);
});

it("rejects a response that is not bound to the dispatched run", async () => {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdin,
		stdout,
		kill: vi.fn(),
	});
	stdin.resume();
	stdin.on("end", () => {
		stdout.once("end", () => child.emit("close", 0));
		stdout.end(
			JSON.stringify({
				ok: true,
				runId: "00000000-0000-4000-8000-000000000099",
				url: "https://fixture.invalid/",
				redirected: false,
				type: "basic",
				status: 200,
				statusText: "OK",
				headers: [],
				body: "",
			}),
		);
	});
	launch.mockReturnValue(child);
	await expect(
		createIsolatedOwnerFetch({}, launch)("https://fixture.invalid/"),
	).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
});
