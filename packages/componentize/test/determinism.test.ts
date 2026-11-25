import { describe, expect, it } from "vitest";

import {
	componentizeHelloBindle,
	DEFAULT_CI_MATRIX,
	PINNED_TOOLCHAIN,
	runWasmtimeSmoke,
	validateWasmComponentArtifact,
} from "../src/index.js";

const HELLO_BINDLE_ROOT = new URL("./fixtures/hello-bindle", import.meta.url);

describe("@hobo/componentize hello-bindle", () => {
	it("builds a wasm component artifact and OCI descriptor", async () => {
		const result = await componentizeHelloBindle({
			sourceRoot: HELLO_BINDLE_ROOT,
			sourceDateEpoch: "2026-01-01T00:00:00.000Z",
		});

		expect(result.component.path).toBe("dist/hello-bindle.component.wasm");
		expect(result.component.mediaType).toBe(
			"application/vnd.wasm.component.v1+wasm",
		);
		expect(result.component.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(result.component.witWorld).toBe(
			"hobo:examples/hello-bindle@0.1.0/service",
		);
		expect(validateWasmComponentArtifact(result.component)).toEqual({
			command: "wasm-tools validate dist/hello-bindle.component.wasm",
			passed: true,
			format: "wasm-component-contract",
		});
		expect(result.oci.manifest.layers[0]?.digest).toBe(result.component.digest);
	});

	it("rebuilds are byte-identical under pinned controls", async () => {
		const first = await componentizeHelloBindle({
			sourceRoot: HELLO_BINDLE_ROOT,
			sourceDateEpoch: "2026-01-01T00:00:00.000Z",
		});
		const second = await componentizeHelloBindle({
			sourceRoot: HELLO_BINDLE_ROOT,
			sourceDateEpoch: "2026-01-01T00:00:00.000Z",
		});

		expect(second.component.digest).toBe(first.component.digest);
		expect(second.component.bytes).toEqual(first.component.bytes);
		expect(first.ciMatrix).toEqual(DEFAULT_CI_MATRIX);
		expect(first.ciMatrix.toolchain.componentizeJs).toBe("0.21.0");
	});

	it("runs wasmtime-shaped smoke for health export", async () => {
		const result = await componentizeHelloBindle({
			sourceRoot: HELLO_BINDLE_ROOT,
			sourceDateEpoch: "2026-01-01T00:00:00.000Z",
		});

		await expect(
			runWasmtimeSmoke(result.component, { exportName: "health" }),
		).resolves.toEqual({
			command: "wasmtime run dist/hello-bindle.component.wasm --invoke health",
			engine: "wasmtime",
			exitCode: 0,
			stdout: "hello-bindle:ok\n",
		});
	});

	it("fails closed on toolchain skew", async () => {
		await expect(
			componentizeHelloBindle({
				sourceRoot: HELLO_BINDLE_ROOT,
				sourceDateEpoch: "2026-01-01T00:00:00.000Z",
				toolchain: { ...PINNED_TOOLCHAIN, jco: "1.24.4" },
			}),
		).rejects.toThrow(
			/componentize\.toolchain_skew: jco expected 1\.24\.3 got 1\.24\.4/,
		);
	});
});
