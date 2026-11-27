import { ImmutableJournalError as CoreError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { ImmutableJournalError as RoutingError } from "../src/index.js";

describe("immutable journal error identity", () => {
	it("shares the constructor across core and backend routing", () => {
		expect(RoutingError).toBe(CoreError);
		const error = new RoutingError("head-conflict");
		expect(error).toBeInstanceOf(CoreError);
		expect(error.reason).toBe("head-conflict");
		expect(error.message).toBe("immutable journal head-conflict");
	});
});
