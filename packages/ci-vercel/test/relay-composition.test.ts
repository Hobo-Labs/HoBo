import { describe, expect, it } from "vitest";
import { planRelayStore } from "../src/relay-composition.js";

const one = "postgres://u:p@one.db.example/app";
const two = "postgres://u:p@two.db.example/app";
const base = { DATABASE_URL: one, DATABASE_URL_UNPOOLED: one };
const second = { NEW_POSTGRES_URL: two, NEW_POSTGRES_URL_NON_POOLING: two };

describe("which store arrangement the environment asks for", () => {
	it("is the one named database when one store is attached, exactly as before", () => {
		expect(planRelayStore(base)).toEqual({ kind: "environment" });
		expect(planRelayStore({ POSTGRES_URL: two })).toEqual({
			kind: "environment",
		});
		// Nothing to choose from is not an error here; the relay reports it.
		expect(planRelayStore({})).toEqual({ kind: "environment" });
	});

	it("does not choose when a second database is named but the relay could not run on it", () => {
		// A pooled string with no session-scoped partner.
		expect(planRelayStore({ ...base, NEW_POSTGRES_URL: two })).toEqual({
			kind: "environment",
		});
		// A test database variable that happens to end in a known name.
		expect(planRelayStore({ ...base, HOBO_TEST_POSTGRES_URL: two })).toEqual({
			kind: "environment",
		});
	});

	it("does not choose when one database is attached under two sets of names", () => {
		expect(
			planRelayStore({
				...base,
				POSTGRES_URL: one,
				POSTGRES_URL_NON_POOLING: one,
				ALSO_DATABASE_URL: one,
				ALSO_DATABASE_URL_UNPOOLED: one,
			}),
		).toEqual({ kind: "environment" });
	});

	it("leaves an explicit prefix alone when two stores are attached", () => {
		expect(
			planRelayStore({
				...base,
				...second,
				HOBO_CI_DATABASE_ENV_PREFIX: "NEW_",
			}),
		).toEqual({ kind: "environment" });
	});

	it("leaves an explicit fleet alone when two stores are attached", () => {
		const plan = planRelayStore({
			...base,
			...second,
			HOBO_CI_DATABASE_BACKENDS: "old=,new=NEW_",
		});
		expect(plan.kind).toBe("fleet");
		const single = planRelayStore({
			...base,
			...second,
			HOBO_CI_DATABASE_BACKENDS: "new=NEW_",
		});
		expect(single.kind).toBe("fleet");
	});

	it("chooses between two attached stores when nothing says which", () => {
		const plan = planRelayStore({ ...base, ...second });
		if (plan.kind !== "selection") throw new Error(`planned ${plan.kind}`);
		expect(
			plan.stores.map((store) => [
				store.prefix,
				store.connection.primary,
				store.connection.direct,
			]),
		).toEqual([
			["", { connectionString: one }, { connectionString: one }],
			["NEW_", { connectionString: two }, { connectionString: two }],
		]);
	});
});
