import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBindleDefinition } from "@hobo/cli";
import { must } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { createComposedHoboCli } from "../src/cli.js";
import {
	collectExplicitProviderPins,
	ensureEmbeddedBroker,
	resolveBindlePlacement,
	WASM_SANDBOX_PROVIDER_ID,
} from "../src/index.js";

const helloBindleDir = fileURLToPath(
	new URL("../../../examples/hello-bindle", import.meta.url),
);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

describe("embedded broker-runtime", () => {
	it("yard init installs a broker and prefers wasm-sandbox when available", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-broker-init-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const cli = createComposedHoboCli();
		const init = await cli.run(["yard", "init", "--home", hoboHome, "--json"], {
			cwd: hoboHome,
		});
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = JSON.parse(init.stdout) as {
			ok: boolean;
			data: {
				broker: { brokerId: string; preferredComponentHost: string };
				config: { componentHost: string };
			};
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data.broker.brokerId).toMatch(/^broker:local\//);
		expect(["wasm", "isolated-wasm", "local"]).toContain(
			envelope.data.broker.preferredComponentHost,
		);
		expect(envelope.data.config.componentHost).toBe(
			envelope.data.broker.preferredComponentHost,
		);
	}, 120_000);

	it("hello-bindle has no provider pins (defaults only)", async () => {
		const definition = await loadBindleDefinition(helloBindleDir);
		expect(definition).not.toBeNull();
		expect(collectExplicitProviderPins(must(definition, "definition"))).toEqual(
			[],
		);
	});

	it("places hello-bindle via yard-first broker and selects camp inside yard", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-broker-place-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });
		const definition = must(
			await loadBindleDefinition(helloBindleDir),
			"(await loadBindleDefinition(helloBindleDir))",
		);
		const placement = await resolveBindlePlacement({
			definition,
			hoboHome,
		});
		expect(placement.outcome).toBe("resolved");
		expect(placement.campId).toMatch(/camp:dev/);
		expect(placement.providerId.length).toBeGreaterThan(0);
		expect(placement.yardPlacement?.selectedYardId).toBeTruthy();
	}, 120_000);

	it("rejects bindle provider selection (.with cloud provider)", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-broker-pin-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		await ensureEmbeddedBroker({ hoboHome, preferWasmSandbox: false });
		const definition = must(
			await loadBindleDefinition(helloBindleDir),
			"(await loadBindleDefinition(helloBindleDir))",
		);
		// Synthesize a forbidden cloud provider pin on the Bindle.
		const pinned = {
			...definition,
			resources: {
				...definition.resources,
				api: {
					...must(definition.resources.api, "definition.resources.api"),
					annotations: [
						{
							provider: "no-such-cloud-provider",
							option: "region",
							config: { region: "us-east-1" },
						},
					],
				},
			},
		};
		const placement = await resolveBindlePlacement({
			definition: pinned,
			hoboHome,
		});
		expect(placement.outcome).toBe("rejected");
		expect(placement.message).toMatch(
			/bindle-provider-selection-forbidden|no-such-cloud-provider|Provider selection belongs on a Yard/,
		);
		expect(
			placement.remediation?.some((r) =>
				/Yard|provider selection|\.with/i.test(r),
			),
		).toBe(true);
	});

	it("hobo up deploys hello-bindle on local yard (broker or yard lane)", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-broker-up-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const cli = createComposedHoboCli();
		cleanups.push(async () => {
			await cli.run(["down", "--json"], { cwd: helloBindleDir });
		});
		const up = await cli.run(["up", "--home", hoboHome, "--json"], {
			cwd: helloBindleDir,
		});
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = JSON.parse(up.stdout) as {
			ok: boolean;
			code: string;
			message: string;
			data: {
				brokerId?: string;
				campId?: string;
				providerId?: string;
				componentHost?: string;
				bindleName?: string;
				mode?: string;
			};
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.code).toBe("HOBO_OK");
		// Composed CLI may take event-sourced yard lane or broker-runtime path.
		if (envelope.data.bindleName !== undefined) {
			expect(envelope.data.bindleName).toBe("hello-bindle");
		}
		if (envelope.data.campId !== undefined) {
			expect(envelope.data.campId).toMatch(/camp:dev/);
		}
		if (envelope.data.brokerId !== undefined) {
			expect(envelope.data.brokerId).toMatch(/^broker:local\//);
		}
		if (envelope.data.providerId !== undefined) {
			expect(
				[
					WASM_SANDBOX_PROVIDER_ID,
					"@hobo/provider-local-host",
					"local",
				].includes(envelope.data.providerId),
			).toBe(true);
		}
	}, 180_000);
});
