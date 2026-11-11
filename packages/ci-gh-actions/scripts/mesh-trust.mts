/**
 * Read or change whom a relay mesh trusts.
 *
 *   HOBO_CI_NATS_URL=nats://127.0.0.1:4222 pnpm --filter @hobo/ci-gh-actions run mesh:trust list
 *   ... run mesh:trust add <publicKey> [--node <nodeId>]
 *   ... run mesh:trust remove <publicKey>
 *   ... run mesh:trust require on|off
 *
 * Every node makes an Ed25519 identity key on first start and signs what it
 * advertises with it. `list` shows the nodes on the board with their public
 * keys and how far this settings would trust each; `add` lists a key (for
 * one node id with `--node`), `remove` takes one off, and `require on` makes
 * nodes rank only listed keys.
 *
 * The settings live in the mesh itself (`trust` in `<namespace>-mesh-config`),
 * so every node reads the same set; nodes pick a change up within a beat (10 s).
 * Whoever can write that bucket decides whom the mesh trusts: protect it with
 * NATS accounts and credentials (HOBO_CI_NATS_TOKEN or _USER/_PASSWORD, or
 * their _FILE forms). HOBO_CI_MESH_NAMESPACE names the mesh, as for a worker.
 */
import process from "node:process";
import { assessMeshTrust, effectiveMeshTrust } from "@hobo/ci/mesh";
import {
	changeMeshTrust,
	meshSettingsFromEnv,
	natsCredentialsFromEnv,
	parseMeshTrustConfig,
} from "@hobo/ci-gh-actions";
import { createNatsMesh } from "@hobo/ci-gh-actions/mesh-nats";

const USAGE =
	"usage: mesh:trust list | add <publicKey> [--node <nodeId>] | remove <publicKey> | require on|off";
const [command, argument, ...rest] = process.argv.slice(2);
const settings = meshSettingsFromEnv(process.env, "mesh-trust");
if (!settings) {
	console.error("HOBO_CI_NATS_URL is not set: there is no mesh to ask.");
	process.exit(2);
}
const node = rest[0] === "--node" ? rest[1] : undefined;
const key = /^[A-Za-z0-9_-]{43}$/;
if (
	!["list", "add", "remove", "require"].includes(command ?? "") ||
	((command === "add" || command === "remove") && !key.test(argument ?? "")) ||
	(command === "require" && argument !== "on" && argument !== "off") ||
	(rest.length > 0 && (command !== "add" || rest[0] !== "--node" || !node))
) {
	console.error(USAGE);
	process.exit(2);
}

const mesh = createNatsMesh({
	servers: settings.servers,
	namespace: settings.namespace,
	replicas: settings.replicas,
	name: "hobo-ci mesh:trust",
	...natsCredentialsFromEnv(process.env),
});
try {
	await Promise.race([
		mesh.ready,
		new Promise((_, reject) =>
			setTimeout(
				() => reject(new Error("NATS did not answer in 10 s")),
				10_000,
			).unref(),
		),
	]);
	if (command === "add")
		await changeMeshTrust(mesh.trust, {
			kind: "add",
			publicKey: argument ?? "",
			nodeId: node,
		});
	if (command === "remove")
		await changeMeshTrust(mesh.trust, {
			kind: "remove",
			publicKey: argument ?? "",
		});
	if (command === "require")
		await changeMeshTrust(mesh.trust, {
			kind: "require",
			requireTrusted: argument === "on",
		});

	const stored = await mesh.trust.read();
	const configured = stored ? parseMeshTrustConfig(stored.value) : undefined;
	if (stored && !configured)
		console.log(
			`The stored trust settings (revision ${stored.revision}) cannot be read by this version.`,
		);
	console.log(
		configured && configured.trustedKeys.length > 0
			? `Trusted keys (revision ${stored?.revision ?? 0}), requireTrusted ${configured.requireTrusted ? "on" : "off"}:`
			: `No keys are listed${configured?.requireTrusted ? " (requireTrusted on)" : ""}: each node trusts only its own key.`,
	);
	for (const entry of configured?.trustedKeys ?? [])
		console.log(
			`  ${entry.publicKey}${entry.nodeId ? `  for node ${entry.nodeId}` : ""}`,
		);
	// What the settings make of the nodes advertising right now. With no keys
	// listed, a node here would trust nobody but itself.
	const policy = effectiveMeshTrust(configured, undefined);
	const nodes = [...(await mesh.board.nodes())].sort((a, b) =>
		a.id.localeCompare(b.id),
	);
	console.log(nodes.length === 0 ? "No node is advertising." : "Nodes:");
	for (const each of nodes)
		console.log(
			`  ${each.id.padEnd(24)} ${assessMeshTrust(each, policy).padEnd(10)} ${each.identity?.publicKey ?? "(unsigned)"}`,
		);
} catch (error) {
	console.error(error instanceof Error ? error.message : "mesh:trust failed");
	process.exitCode = 1;
} finally {
	await mesh.close().catch(() => undefined);
}
