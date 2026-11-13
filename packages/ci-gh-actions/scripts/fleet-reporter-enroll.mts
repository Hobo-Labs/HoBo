/**
 * Prints the enrollment entry for this box's fleet verdict reporter
 * (ADR-0180; operating step G2 in packages/ci-vercel/README.md):
 *
 *   node packages/ci-gh-actions/scripts/fleet-reporter-enroll.mts \
 *     --key-file <path> --id <reporter id> --account <account id> \
 *     --labels hobo,hobo-trunk
 *
 * It loads the reporter's Ed25519 key (the mesh key, `HOBO_CI_MESH_KEY_FILE`
 * or `mesh-node.key` beside the journal; made with safe file modes if there
 * is none) and prints one JSON line, the public half only, to add to the
 * `reporters` list of `HOBO_CI_FLEET_REPORTERS_JSON` on the hosted relay.
 * The private key never leaves its file.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import { FLEET_REPORTER_ID, loadMeshIdentity } from "@hobo/ci-gh-actions";

const USAGE =
	"usage: fleet-reporter-enroll.mts --key-file <path> --id <reporter id> --account <account id> --labels hobo,hobo-trunk";
const LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function fail(message: string): never {
	console.error(`${message}\n${USAGE}`);
	process.exit(2);
}

let values: Record<string, string | undefined>;
try {
	values = parseArgs({
		options: {
			"key-file": { type: "string" },
			id: { type: "string" },
			account: { type: "string" },
			labels: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	}).values;
} catch (error) {
	fail(error instanceof Error ? error.message : "invalid arguments");
}
const keyFile = values["key-file"];
const id = values.id ?? "";
const account = values.account ?? "";
const labels = (values.labels ?? "")
	.split(",")
	.map((label) => label.trim().toLowerCase())
	.filter((label) => label !== "");
if (!keyFile) fail("--key-file is required");
if (!FLEET_REPORTER_ID.test(id)) fail("--id must match ^[A-Za-z0-9_-]{1,64}$");
if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(account))
	fail("--account must be an account id");
if (labels.length === 0 || !labels.every((label) => LABEL.test(label)))
	fail("--labels must be a comma-separated list of runner labels");

const identity = await loadMeshIdentity(keyFile);
console.log(
	JSON.stringify({
		id,
		publicKey: identity.publicKey,
		accountId: account,
		labels: [...new Set(labels)],
	}),
);
