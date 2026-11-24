import { expect, it } from "vitest";
import {
	compareForwardReverse,
	extractWitContract,
	parseInterfacePin,
	parseToolchainLock,
} from "../src/index.js";

it("detects a synchronous component signature against an async topic contract", () => {
	const source = `package hobo:example@0.1.0;
interface messaging {
  publish: async func(message: string) -> string;
}
world app {
  import messaging;
}
`;
	const declared = extractWitContract(source);
	const synchronous = extractWitContract(source.replace("async func", "func"));
	expect(declared.interfaces.messaging?.functions).toEqual([
		{
			name: "publish",
			async: true,
			params: [{ name: "message", type: "string" }],
			result: "string",
		},
	]);
	expect(compareForwardReverse(declared, declared).ok).toBe(true);
	expect(compareForwardReverse(declared, synchronous)).toMatchObject({
		ok: false,
		report: { parity: "drifted", driftedSignatures: ["messaging"] },
	});
});

it("rejects boxed strings at lock and pin boundaries", () => {
	expect(() =>
		parseInterfacePin(Object("wasi:io/streams@0.2.0@stable")),
	).toThrow(/wit\.pin\.invalid/u);
	expect(() =>
		parseToolchainLock({
			schema: "hobo.wit-toolchain-lock/v1",
			package: "hobo:sdk@0.1.0",
			canonical_generator: {
				name: "@bytecodealliance/jco",
				version: "1.2.3",
				role: "canonical",
			},
			compat_floor: {
				wasmtime: "1.2.3",
				componentize_js: "1.2.3",
				wrpc: "1.2.3",
				wasm_cloud: "1.2.3",
			},
			guards: [Object("no-network")],
		}),
	).toThrow(/guard must be non-empty/u);
});
