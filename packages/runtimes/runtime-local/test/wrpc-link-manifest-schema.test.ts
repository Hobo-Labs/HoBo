import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import {
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
	WrpcLinkManifestSchema,
} from "@hobo/core";
import { expect, it } from "vitest";
import { createInProcessTransport, createWrpcLinkLayer } from "../src/index.js";
import { parseJsonValue } from "../src/json.js";

const cueFile = fileURLToPath(
	new URL("../../../core/data-models/wrpc_link_manifest.cue", import.meta.url),
);

function vetManifest(manifest: string) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-wrpc-manifest-"));
	try {
		const fixture = join(directory, "manifest.json");
		writeFileSync(fixture, manifest);
		const result = spawnSync(
			"cue",
			["vet", cueFile, fixture, "-d", "#WrpcLinkManifest", "-c"],
			{ encoding: "utf8" },
		);
		if (result.error) throw result.error;
		return { status: result.status, stderr: result.stderr };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

it("round-trips a runtime link manifest through protobuf and vets its constraints", () => {
	const store = new ProviderHandlerStore();
	const layer = createWrpcLinkLayer({
		store,
		transport: createInProcessTransport({ store }),
		compatibilityFloor: "1.2.0",
	});
	const interfaceId = parseInterfaceId("wasi:keyvalue/store@1.2.0");
	const pin = {
		interfaceId,
		stability: "stable" as const,
		versions: [parseWireVersion("1.2.0")],
	};
	layer.registerComponent({ id: "api", imports: [pin] });
	layer.registerProvider({
		id: "kv",
		exports: [pin],
		handlers: { [interfaceId]: { get: () => ({ value: "ok" }) } },
	});
	layer.establishLink({
		componentId: "api",
		importInterface: interfaceId,
		providerId: "kv",
		exportInterface: interfaceId,
	});

	const manifest = layer.manifestIr();
	const wire = fromJson(
		WrpcLinkManifestSchema,
		parseJsonValue(JSON.stringify(manifest)),
	);
	const restored = fromBinary(
		WrpcLinkManifestSchema,
		toBinary(WrpcLinkManifestSchema, wire),
	);
	expect(toJson(WrpcLinkManifestSchema, restored)).toEqual(manifest);

	const valid = vetManifest(JSON.stringify(manifest));
	expect(valid.status, valid.stderr).toBe(0);
	const invalid = vetManifest(
		JSON.stringify({ ...manifest, schema: "hobo.manifest.wrpc-links/v2" }),
	);
	expect(invalid.status).not.toBe(0);
});
