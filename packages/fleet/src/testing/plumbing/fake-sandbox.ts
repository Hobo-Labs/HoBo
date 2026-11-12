/**
 * `createFakeSandboxDriver`: a sandbox driver that isolates nothing, for logic
 * tests (design §11.2 step 5, §7.3). Plumbing of the contract commit.
 *
 * - It records every command it is asked to run, as `argv.join(" ")`, in `runs`.
 *   Secrets written with `writeSecret` are kept in memory and never recorded.
 * - It answers the start fence through the `fence` callback given to `create`:
 *   an `exec` whose argv contains `<controlUrl>/fence` stands for
 *   `POST <controlUrl>/fence` with the `ObservedAssignment` JSON on standard
 *   input; it writes `{"allow":true|false}` to the output and exits 0 when
 *   allowed, 1 when refused. Unreadable facts are refused without asking.
 * - Each sandbox is single use: one `create` per order id, nothing runs after
 *   `destroy`, and `destroy` is idempotent.
 * - Every other command "succeeds" with exit code 0 and no output.
 *
 * It proves nothing about isolation; `runSandboxIsolationProbe` fails it.
 */
import type { JsonObject, JsonValue } from "@hobo/core";
import {
	type SandboxTier,
	type WorkOrigin,
	WorkOriginSchema,
} from "../../_generated/fleet_pb.js";
import type {
	ObservedAssignment,
	Sandbox,
	SandboxDriver,
} from "../../ports.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A sandbox driver of the given tier that records what it runs and answers the fence through its callback. Tests only. */
export function createFakeSandboxDriver(
	tier: SandboxTier,
): SandboxDriver & Readonly<{ runs: readonly string[] }> {
	const runs: string[] = [];
	const orders = new Set<string>();
	let created = 0;
	return {
		tier,
		runs,
		async available() {
			return { ok: true, value: { providesDocker: false } };
		},
		async create(input): Promise<Sandbox> {
			if (orders.has(input.orderId))
				throw new Error(
					`a sandbox was already created for order ${input.orderId}`,
				);
			orders.add(input.orderId);
			created += 1;
			const id = `fake-sandbox-${created}`;
			const controlUrl = `http://${id}.sandbox.invalid`;
			const fenceUrl = `${controlUrl}/fence`;
			const secrets = new Map<string, Uint8Array>();
			let destroyed = false;
			const usable = () => {
				if (destroyed) throw new Error(`sandbox ${id} is destroyed`);
			};
			return {
				id,
				tier,
				controlUrl,
				async exec(command) {
					usable();
					runs.push(command.argv.join(" "));
					if (command.signal.aborted) return { exitCode: 130 };
					if (!command.argv.includes(fenceUrl)) return { exitCode: 0 };
					const observed = parseObservedAssignment(
						decoder.decode(command.stdin ?? new Uint8Array()),
					);
					let allow = false;
					if (observed !== undefined) {
						try {
							allow = await input.fence(observed);
						} catch {
							allow = false;
						}
					}
					command.onOutput(encoder.encode(JSON.stringify({ allow })));
					return { exitCode: allow ? 0 : 1 };
				},
				async writeSecret(path, bytes) {
					usable();
					secrets.set(path, bytes.slice());
				},
				async destroy() {
					destroyed = true;
					secrets.clear();
				},
			};
		},
	};
}

/** Parses the fence body; `origin` is the enum number or its name (`WORK_ORIGIN_FORK`). Undefined when anything is missing. */
function parseObservedAssignment(text: string): ObservedAssignment | undefined {
	let value: JsonValue;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const workKey = value.workKey;
	const repository = value.repository;
	const ref = value.ref;
	const author = value.author;
	const origin = parseOrigin(value.origin);
	if (
		!isText(workKey) ||
		!isText(repository) ||
		!isText(ref) ||
		!isText(author) ||
		origin === undefined
	)
		return undefined;
	return { workKey, repository, ref, author, origin };
}

function parseOrigin(value: JsonValue | undefined): WorkOrigin | undefined {
	const match = WorkOriginSchema.values.find((entry) =>
		isText(value) ? entry.name === value : entry.number === value,
	);
	return match?.number;
}

function isText(value: JsonValue | undefined): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

function isRecord(value: JsonValue): value is JsonObject {
	return Object.prototype.toString.call(value) === "[object Object]";
}
