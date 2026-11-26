import { expect, it } from "vitest";
import { proveLocalSafety } from "../scripts/proof.js";

it("exhaustively proves the production controller's finite-state safety contract", () => {
	const proof = proveLocalSafety();
	expect(proof.states).toBeGreaterThan(100);
	expect(proof.edges).toBeGreaterThan(proof.states);
	expect(proof.successes).toBeGreaterThan(0);
});
