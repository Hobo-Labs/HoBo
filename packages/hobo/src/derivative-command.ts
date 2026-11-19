import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandModule } from "@hobo/cli";
import type { DerivativeDescriptor as DerivativeDescriptorWire } from "./_generated/composition_pb.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";

type DerivativeDescriptor = Pick<DerivativeDescriptorWire, "name" | "version">;

const DESCRIPTOR_FILE = "derivative.json";

function parseDescriptor(raw: JsonValue): DerivativeDescriptor {
	if (!isJsonObject(raw)) {
		throw new TypeError("derivative.json must be a JSON object");
	}
	if (Object.keys(raw).some((key) => key !== "name" && key !== "version")) {
		throw new TypeError("derivative.json contains an unknown field");
	}
	if (!isJsonString(raw.name) || !raw.name.trim()) {
		throw new TypeError("derivative.json.name must be a non-empty string");
	}
	if (!isJsonString(raw.version) || !raw.version.trim()) {
		throw new TypeError("derivative.json.version must be a non-empty string");
	}
	return { name: raw.name, version: raw.version };
}

export function createDerivativeCommand(): CommandModule {
	return {
		async run({ context, flags, args }) {
			const subcommand = args[0] ?? "read";
			if (subcommand !== "read" || args.length > 1) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_DERIVATIVE_USAGE",
					message: "Use `hobo derivative read` to inspect the descriptor.",
					data: { command: "derivative" },
				};
			}
			try {
				const file = path.join(flags.cwd ?? context.cwd, DESCRIPTOR_FILE);
				const descriptor = parseDescriptor(
					JSON.parse(await readFile(file, "utf8")),
				);
				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: `hobo derivative: "${descriptor.name}" v${descriptor.version}`,
					data: { command: "derivative", subcommand, descriptor },
				};
			} catch (error) {
				return {
					ok: false,
					status: "no_descriptor",
					code: "HOBO_DERIVATIVE_NO_DESCRIPTOR",
					message: `hobo derivative: could not read ${DESCRIPTOR_FILE}: ${error instanceof Error ? error.message : String(error)}`,
					remediation: [`Add a ${DESCRIPTOR_FILE} with { name, version }.`],
					data: { command: "derivative" },
				};
			}
		},
	};
}
