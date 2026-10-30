import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cue = join(
	root,
	".tools/cue/v0.14.0",
	process.platform === "win32" ? "cue.exe" : "cue",
);
const schema = join(packageRoot, "data-models/hosting_credential_scope.cue");
const fixture = readFileSync(
	join(packageRoot, "contracts/hosting-credentials/valid.json"),
	"utf8",
);

function vet(input: string) {
	const dir = mkdtempSync(join(tmpdir(), "hosting-credential-cue-"));
	try {
		const file = join(dir, "proof.json");
		writeFileSync(file, input);
		return spawnSync(
			cue,
			["vet", "-d", "#HostingCredentialScopeAttestation", schema, file],
			{ encoding: "utf8", timeout: 15000 },
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("hosting credential scope CUE boundary", () => {
	it("accepts bounded metadata-only credential proof syntax", () => {
		const result = vet(fixture);
		expect(result.status, result.stderr || result.error?.message).toBe(0);
	});
	it.each([
		[
			"a credential-bearing URL",
			fixture.replace("vault://hosting/aws", "https://user:secret@example.com"),
		],
		[
			"a malformed digest",
			fixture.replace(
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"not-a-digest",
			),
		],
		[
			"expiry beyond the native binding",
			fixture.replace('"expiresAtMs": 9000', '"expiresAtMs": 11000'),
		],
		[
			"a fractional timestamp",
			fixture.replace('"issuedAtMs": 2000', '"issuedAtMs": 2000.5'),
		],
		[
			"an unsigned proof",
			fixture.replace(
				'"ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
				'""',
			),
		],
		[
			"an embedded untrusted key",
			fixture.replace(
				'"signature":',
				'"publicKey": "attacker-key", "signature":',
			),
		],
	])("rejects %s", (_description, document) => {
		const result = vet(document);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
	});
});
