// Regenerates the committed actions/attest-shaped fixture used by the
// provenance PACT (contracts/artifacts.provenance.pact.json). Everything it
// writes is public material: the throwaway trust root's certificates and
// public keys, the statement, and the signed bundle. Private keys exist only
// in memory while this runs.
//
//   node --import tsx test/provenance/fixtures/generate.ts   (from packages/cd)
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	actionsAttestBundle,
	actionsAttestStatement,
	createTestTrustRoot,
} from "../sigstore-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasm = createHash("sha256").update("api.wasm bytes").digest("hex");
const statement = actionsAttestStatement([{ name: "api.wasm", sha256: wasm }]);
const root = createTestTrustRoot();
const bundle = actionsAttestBundle(root, {
	statement,
	signedAtMs: Date.UTC(2026, 10, 1, 9, 30, 0),
});
writeFileSync(
	join(here, "actions-attest.fixture.json"),
	`${JSON.stringify({ trustedRoot: root.trustedRoot, statement: JSON.parse(statement.toString("utf8")), statementBase64: statement.toString("base64"), bundle }, null, 2)}\n`,
);
