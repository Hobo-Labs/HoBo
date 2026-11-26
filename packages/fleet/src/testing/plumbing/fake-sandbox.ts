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
