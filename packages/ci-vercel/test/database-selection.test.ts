import { describe, expect, it, vi } from "vitest";
import { StoreUnavailable } from "../src/bootstrap-entry.js";
import type { RelayDatabase } from "../src/database-connections.js";
import {
	chooseStore,
	classifyStoreFailure,
	STORE_REFUSAL_SQLSTATES,
	type StoreObservation,
} from "../src/database-selection.js";
import {
	createSelectedRelay,
	type SelectableStore,
	type SelectedStore,
	StoreSelectionUndecided,
	selectableStores,
} from "../src/database-selection-relay.js";

function failure(code: string | undefined, message = "connection failed") {
	return code === undefined
		? new Error(message)
		: Object.assign(new Error(message), { code });
}

const serving = (generation: number): StoreObservation => ({
	class: "serving",
	generation,
});
const refusing = (sqlstate = "53000"): StoreObservation => ({
	class: "refusing",
	sqlstate,
});
const unknown: StoreObservation = { class: "unknown", code: "ETIMEDOUT" };

describe("store failure classification", () => {
	it("names the refusals in one place", () => {
		expect(STORE_REFUSAL_SQLSTATES).toEqual({
			codes: ["53000", "3D000"],
			classes: ["28"],
		});
	});

	it.each([
		["53000", "an exhausted plan quota, as Neon sends it"],
		["28P01", "a rejected password"],
		["28000", "a role that may not log in"],
		["3D000", "a database that does not exist"],
	])("treats %s as a refusal: %s", (code) => {
		expect(classifyStoreFailure(failure(code))).toEqual({
			class: "refusing",
			sqlstate: code,
		});
	});

	it.each([
		["57P03", "the server is starting up"],
		["53300", "too many connections"],
		["53100", "disk full"],
		["53200", "out of memory"],
		["08006", "connection failure"],
		["57P01", "terminated by an administrator"],
		["ECONNREFUSED", "nothing listens there"],
		["ECONNRESET", "the connection was reset"],
		["ENOTFOUND", "the name does not resolve"],
		["ETIMEDOUT", "the network timed out"],
		["SELF_SIGNED_CERT_IN_CHAIN", "the certificate is not trusted"],
	])("treats %s as unknown: %s", (code) => {
		expect(classifyStoreFailure(failure(code))).toEqual({
			class: "unknown",
			code,
		});
	});

	it("treats an error without a code, and no error at all, as unknown", () => {
		expect(
			classifyStoreFailure(failure(undefined, "timeout exceeded")),
		).toEqual({ class: "unknown", code: undefined });
		expect(classifyStoreFailure(undefined)).toEqual({
			class: "unknown",
			code: undefined,
		});
	});

	it("never reads the message and never passes on a code that is not a fixed token", () => {
		const leaky = failure(
			"getaddrinfo ENOTFOUND db.example.internal",
			"password authentication failed for postgres://u:p@db.example.internal/x",
		);
		expect(classifyStoreFailure(leaky)).toEqual({
			class: "unknown",
			code: undefined,
		});
	});
});

describe("choosing a store", () => {
	it("takes a single serving candidate and marks it", () => {
		expect(chooseStore([serving(0)])).toEqual({
			status: "chosen",
			index: 0,
			reason: "only-candidate",
			held: 0,
			promote: true,
			atLeast: 1,
		});
		expect(chooseStore([serving(7)])).toMatchObject({
			reason: "only-candidate",
			promote: false,
		});
	});

	it("goes to discovery order on the first run with two serving stores", () => {
		expect(chooseStore([serving(0), serving(0)])).toEqual({
			status: "chosen",
			index: 0,
			reason: "first-run",
			held: 0,
			promote: true,
			atLeast: 1,
		});
	});

	it("chooses and marks the second store when the first refuses", () => {
		expect(chooseStore([refusing("53000"), serving(0)])).toEqual({
			status: "chosen",
			index: 1,
			reason: "previous-refusing",
			held: 0,
			promote: true,
			atLeast: 1,
		});
	});

	it("stays on the second store when the first answers again with an older generation", () => {
		expect(chooseStore([serving(0), serving(5)])).toEqual({
			status: "chosen",
			index: 1,
			reason: "marker",
			held: 5,
			promote: false,
			atLeast: 6,
		});
		expect(chooseStore([serving(3), serving(5)])).toMatchObject({
			index: 1,
			reason: "marker",
			promote: false,
		});
	});

	it("goes to discovery order when two stores hold the same generation", () => {
		expect(chooseStore([serving(5), serving(5)])).toMatchObject({
			index: 0,
			reason: "marker",
			promote: false,
		});
	});

	it("writes a newer generation on a marked store while another refuses", () => {
		// The refusing store cannot be read and may hold anything; the store in
		// use has to outrank it when it answers again.
		expect(chooseStore([serving(5), refusing("28P01")])).toEqual({
			status: "chosen",
			index: 0,
			reason: "previous-refusing",
			held: 5,
			promote: true,
			atLeast: 6,
		});
	});

	it("does not choose while any candidate is unknown", () => {
		const undecided = {
			status: "undecided",
			cause: "unclassified-candidate",
		};
		expect(chooseStore([serving(9), unknown])).toEqual(undecided);
		expect(chooseStore([unknown, serving(0)])).toEqual(undecided);
		expect(chooseStore([refusing(), unknown, serving(4)])).toEqual(undecided);
		expect(chooseStore([unknown])).toEqual(undecided);
	});

	it("does not choose when no candidate serves", () => {
		expect(chooseStore([refusing(), refusing("3D000")])).toEqual({
			status: "undecided",
			cause: "no-serving-candidate",
		});
		expect(chooseStore([])).toEqual({
			status: "undecided",
			cause: "no-serving-candidate",
		});
	});

	it("chooses among three candidates by generation, then by order", () => {
		expect(chooseStore([serving(2), serving(9), serving(4)])).toMatchObject({
			index: 1,
			reason: "marker",
			promote: false,
		});
		expect(chooseStore([refusing(), serving(0), serving(0)])).toMatchObject({
			index: 1,
			reason: "previous-refusing",
			promote: true,
		});
		expect(chooseStore([refusing(), serving(3), serving(8)])).toMatchObject({
			index: 2,
			reason: "previous-refusing",
			promote: true,
			atLeast: 9,
		});
		expect(chooseStore([serving(0), serving(0), serving(0)])).toMatchObject({
			index: 0,
			reason: "first-run",
		});
	});
});

const direct = "postgres://u:p@one.db.example/app";
const other = "postgres://u:p@two.db.example/app";

describe("selectable stores", () => {
	it("lists every attached store the relay could run on, unprefixed first", () => {
		const stores = selectableStores({
			DATABASE_URL: direct,
			DATABASE_URL_UNPOOLED: direct,
			NEW_POSTGRES_URL: other,
			NEW_POSTGRES_URL_NON_POOLING: other,
		});
		expect(stores.map((store) => [store.prefix, store.binding])).toEqual([
			["", "explicit"],
			["NEW_", "supabase"],
		]);
		expect(stores[1]?.connection.direct).toEqual({ connectionString: other });
	});

	it("leaves out a store without a session-scoped connection, and one behind a known pooler", () => {
		const stores = selectableStores({
			DATABASE_URL: direct,
			DATABASE_URL_UNPOOLED: direct,
			// Only a pooled string: repair could not run on it.
			HOBO_TEST_POSTGRES_URL: other,
			POOLED_DATABASE_URL: "postgres://u:p@ep-x-pooler.neon.tech/app",
			POOLED_DATABASE_URL_UNPOOLED: "postgres://u:p@ep-x-pooler.neon.tech/app",
		});
		expect(stores.map((store) => store.prefix)).toEqual([""]);
	});

	it("takes each store's certificate authority from its own prefix", () => {
		const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
		const stores = selectableStores({
			DATABASE_URL: direct,
			DATABASE_URL_UNPOOLED: direct,
			NEW_POSTGRES_URL: other,
			NEW_POSTGRES_URL_NON_POOLING: other,
			NEW_HOBO_CI_DATABASE_CA_CERT: pem,
		});
		expect(stores[0]?.connection.direct).toEqual({ connectionString: direct });
		expect(stores[1]?.connection.direct).toMatchObject({ ssl: { ca: pem } });
	});
});

const origin = "https://ci.hobo.test";
const stores = selectableStores({
	DATABASE_URL: direct,
	DATABASE_URL_UNPOOLED: direct,
	NEW_DATABASE_URL: other,
	NEW_DATABASE_URL_UNPOOLED: other,
});

function storeAt(index: number): SelectableStore {
	const store = stores[index];
	if (!store) throw new Error(`no store ${index}`);
	return store;
}

function selected(index: number): SelectedStore {
	return { store: storeAt(index), generation: 1, reason: "first-run" };
}

function fakeApplication() {
	return {
		handle: vi.fn(async (request: Request) =>
			Response.json({ path: new URL(request.url).pathname }),
		),
		tick: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};
}

describe("the relay on a selected store", () => {
	it("answers liveness without probing any store", async () => {
		const select = vi.fn(async () => selected(0));
		const relay = createSelectedRelay({
			env: { HOBO_CI_PUBLIC_URL: origin },
			stores,
			build: async () => fakeApplication(),
			select,
		});
		const response = await relay.handle(new Request(`${origin}/healthz`));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(select).not.toHaveBeenCalled();
		expect(relay.origin).toBe(origin);
	});

	it("selects once and runs the application on the chosen store's two connections", async () => {
		const select = vi.fn(async () => selected(1));
		const application = fakeApplication();
		const build = vi.fn(async (_database: RelayDatabase) => application);
		const relay = createSelectedRelay({
			env: { HOBO_CI_PUBLIC_URL: origin },
			stores,
			build,
			select,
		});
		const responses = await Promise.all([
			relay.handle(new Request(`${origin}/v1/status`)),
			relay.handle(new Request(`${origin}/readyz`)),
		]);
		await relay.tick({ deliveryId: "delivery-1" });
		expect(await responses[0]?.json()).toEqual({ path: "/v1/status" });
		expect(select).toHaveBeenCalledTimes(1);
		expect(build).toHaveBeenCalledTimes(1);
		const database = build.mock.calls[0]?.at(0);
		expect(database).toMatchObject({
			primary: { connectionString: other },
			direct: { connectionString: other },
		});
		expect(application.tick).toHaveBeenCalledWith({ deliveryId: "delivery-1" });
		await relay.close();
		expect(application.close).toHaveBeenCalledTimes(1);
	});

	it("reports the store unavailable while no store can be named, and backs off", async () => {
		let now = 1_000_000;
		let decided = false;
		const select = vi.fn(async () => {
			if (!decided) throw new StoreSelectionUndecided("unclassified-candidate");
			return selected(0);
		});
		const build = vi.fn(async () => fakeApplication());
		const relay = createSelectedRelay({
			env: { HOBO_CI_PUBLIC_URL: origin },
			stores,
			build,
			select,
			now: () => now,
		});
		const ready = await relay.handle(new Request(`${origin}/readyz`));
		expect(ready.status).toBe(503);
		expect(ready.headers.get("retry-after")).toBe("5");
		expect(await ready.json()).toEqual({
			ready: false,
			reason: "store-unavailable",
		});
		// Inside the back-off nothing is probed again.
		await expect(
			relay.handle(new Request(`${origin}/v1/status`)),
		).rejects.toBeInstanceOf(StoreUnavailable);
		await expect(relay.tick({ deliveryId: "d" })).rejects.toBeInstanceOf(
			StoreUnavailable,
		);
		expect(select).toHaveBeenCalledTimes(1);
		// 5 s after the first failure it asks again, and then waits 10 s.
		now += 5_000;
		await expect(
			relay.handle(new Request(`${origin}/v1/status`)),
		).rejects.toBeInstanceOf(StoreUnavailable);
		expect(select).toHaveBeenCalledTimes(2);
		now += 9_999;
		await expect(
			relay.handle(new Request(`${origin}/v1/status`)),
		).rejects.toBeInstanceOf(StoreUnavailable);
		expect(select).toHaveBeenCalledTimes(2);
		decided = true;
		now += 1;
		expect(
			(await relay.handle(new Request(`${origin}/v1/status`))).status,
		).toBe(200);
		expect(select).toHaveBeenCalledTimes(3);
		expect(build).toHaveBeenCalledTimes(1);
		// Liveness still answers while the store is being left alone.
		expect((await relay.handle(new Request(`${origin}/healthz`))).status).toBe(
			200,
		);
	});

	it("backs off and selects again when the application cannot be built on the chosen store", async () => {
		let now = 0;
		const select = vi.fn(async () => selected(0));
		const refusal = Object.assign(new Error("refused"), { code: "53000" });
		const build = vi
			.fn<() => Promise<ReturnType<typeof fakeApplication>>>()
			.mockRejectedValueOnce(refusal)
			.mockResolvedValue(fakeApplication());
		const relay = createSelectedRelay({
			env: { HOBO_CI_PUBLIC_URL: origin },
			stores,
			build,
			select,
			now: () => now,
		});
		await expect(relay.tick({ deliveryId: "d" })).rejects.toBe(refusal);
		await expect(relay.tick({ deliveryId: "d" })).rejects.toBeInstanceOf(
			StoreUnavailable,
		);
		now += 5_000;
		await relay.tick({ deliveryId: "d" });
		expect(select).toHaveBeenCalledTimes(2);
		// Once the store has carried a request the application stays.
		await relay.tick({ deliveryId: "d" });
		expect(select).toHaveBeenCalledTimes(2);
		expect(build).toHaveBeenCalledTimes(2);
	});
});
