import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";

import {
	PrivateOwnerDispatchError,
	PrivateOwnerRequestError,
} from "../../src/isolated-owner-errors.js";
import {
	createIsolatedOwnerFetch,
	type IsolatedOwnerFetchOptions,
	type PrivateOwnerChildLauncher,
} from "../../src/isolated-owner-fetch.js";
import { ownerRequest } from "../../src/isolated-owner-wire.js";

const launch = vi.fn<PrivateOwnerChildLauncher>();
const fixtureCreate = (
	env: Readonly<Record<string, string | undefined>>,
	launcher: PrivateOwnerChildLauncher,
	options?: Partial<IsolatedOwnerFetchOptions>,
) =>
	createIsolatedOwnerFetch(env, launcher, {
		allowedOrigins: ["https://fixture.invalid"],
		...options,
	});

beforeEach(() => {
	launch.mockReset();
});

it("sanitizes synchronous launch failures and keeps request data out of arguments and environment", async () => {
	const marker = "fixture-private-spawn-value";
	launch.mockImplementation(() => {
		throw new Error(marker);
	});
	const send = fixtureCreate(
		{
			HTTPS_PROXY: `http://fixture:${marker}@127.0.0.1:8888`,
		},
		launch,
		{ allowProxy: true },
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
	const failure = await fixtureCreate({}, launch)(
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
	const failure = await fixtureCreate({}, launch)(
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
	const failure = await fixtureCreate({}, launch)(
		"https://fixture.invalid",
		{
			method: "POST",
			body: marker,
			signal: controller.signal,
		},
	).catch((error) => error);
	expect(failure).toBeInstanceOf(PrivateOwnerDispatchError);
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
				runId: received?.run.id,
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
	await fixtureCreate({}, launch)("https://fixture.invalid/path", {
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
	expect(received?.run.id).toBe(
		launch.mock.calls[0]?.[0].env.HOBO_OWNER_RUN_ID,
	);
	expect(received?.run.secret).toBe(
		launch.mock.calls[0]?.[0].env.HOBO_OWNER_RUN_SECRET,
	);
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
				runId: crypto.randomUUID(),
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
		fixtureCreate({}, launch)("https://fixture.invalid/"),
	).rejects.toBeInstanceOf(PrivateOwnerDispatchError);
});
