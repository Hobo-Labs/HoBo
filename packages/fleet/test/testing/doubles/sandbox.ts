/**
 * Sandbox drivers broken in exactly one way each, keyed by the sandbox logic
 * assertion that must catch the break. Each wraps the fake sandbox driver.
 */
import { randomBytes } from "node:crypto";
import { SandboxTier } from "../../../src/_generated/fleet_pb.js";
import type { Sandbox, SandboxDriver } from "../../../src/ports.js";
import type { SandboxMake } from "../../../src/testing/conformance/sandbox.js";
import { createFakeSandboxDriver } from "../../../src/testing/plumbing/index.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type Patch = Readonly<{
	driver?: (base: SandboxDriver) => Partial<SandboxDriver>;
	sandbox?: (base: Sandbox) => Partial<Sandbox>;
}>;

const broken =
	(patch: Patch): SandboxMake =>
	() => {
		const base = createFakeSandboxDriver(SandboxTier.S1_CONTAINER);
		const driver: SandboxDriver = {
			tier: base.tier,
			available: () => base.available(),
			async create(input) {
				const sandbox = await base.create(input);
				return { ...sandbox, ...patch.sandbox?.(sandbox) };
			},
		};
		return { ...driver, ...patch.driver?.(driver) };
	};

export const BROKEN_SANDBOXES: ReadonlyMap<string, SandboxMake> = new Map([
	[
		"the self-test answers ok",
		broken({
			driver: () => ({
				async available() {
					return {
						ok: false,
						error: { code: "unavailable", message: "self-test failed" },
					};
				},
			}),
		}),
	],
	[
		"each sandbox carries the driver's tier, its own id and its own controlUrl",
		broken({ sandbox: () => ({ tier: SandboxTier.UNSPECIFIED }) }),
	],
	[
		"a second create for one order is refused",
		broken({
			driver: (base) => ({
				create: (input) =>
					base.create({
						...input,
						orderId: `${input.orderId}-${randomBytes(4).toString("hex")}`,
					}),
			}),
		}),
	],
	[
		"nothing runs after destroy",
		broken({ sandbox: () => ({ async destroy() {} }) }),
	],
	[
		"destroy is idempotent",
		broken({
			sandbox: (base) => {
				let destroyed = false;
				return {
					async destroy() {
						if (destroyed) throw new Error("already destroyed");
						destroyed = true;
						await base.destroy();
					},
				};
			},
		}),
	],
	[
		"a secret written with writeSecret never reaches argv or the environment",
		broken({
			sandbox: (base) => {
				const env = new Map<string, string>();
				return {
					async writeSecret(path, bytes) {
						// Broken: hands the secret over through the environment.
						env.set("HOBO_SECRET", decoder.decode(bytes));
						await base.writeSecret(path, bytes);
					},
					async exec(command) {
						if (command.argv[0] === "env") {
							for (const [name, value] of env)
								command.onOutput(encoder.encode(`${name}=${value}\n`));
							return { exitCode: 0 };
						}
						return base.exec(command);
					},
				};
			},
		}),
	],
	[
		"POST <controlUrl>/fence answers from the fence callback",
		broken({
			driver: (base) => ({
				create: (input) => base.create({ ...input, fence: async () => true }),
			}),
		}),
	],
	[
		"an exec whose signal is already aborted does not report success",
		broken({
			sandbox: (base) => ({
				exec: (command) =>
					base.exec({ ...command, signal: new AbortController().signal }),
			}),
		}),
	],
]);
