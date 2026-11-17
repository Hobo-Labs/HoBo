import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	createFetchTransport,
	createStrictRunnerPodClient,
	DEFAULT_TRANSPORT_POLICY,
	type StrictRunnerPodBinding,
} from "../src/index.js";

const api = new URL(process.env.HOBO_KUBERNETES_API ?? "");
const namespace = process.env.HOBO_KUBERNETES_DISPOSABLE_NAMESPACE ?? "";
const ownerUid = process.env.HOBO_KUBERNETES_OWNER_UID ?? "";
assert.equal(api.protocol, "http:");
assert.equal(api.hostname, "127.0.0.1");
assert.match(namespace, /^hobo-acceptance-[a-z0-9-]+$/u);
assert.match(ownerUid, /^[0-9a-f-]{36}$/u);

const image =
	"registry.k8s.io/pause@sha256:7031c1b283388d2c2e09b57badb803c05ebed362dc88d84b480cc47f72a21097";
const binding: StrictRunnerPodBinding = {
	connectionId: "acceptance-connection",
	namespace,
	slotId: randomUUID(),
	claimId: "acceptance-claim",
	accountId: "acceptance-account",
	profileId: "acceptance-profile",
	ownerName: "runner-owner",
	ownerUid,
	serviceAccount: "runner",
	runnerImage: image,
	hookImage: image,
	startFenceUrl: "https://controller.example/v1/fleet/start-fence",
	cpu: "100m",
	memory: "128Mi",
};
const client = createStrictRunnerPodClient({
	transport: createFetchTransport({ fetchImpl: fetch }),
	apiServerUrl: api.origin,
	policy: { ...DEFAULT_TRANSPORT_POLICY, allowInsecureLoopback: true },
});
const created = await client.create(binding);
assert.equal(created.created, true);
assert.equal((await client.create(binding, created.uid)).created, false);
await assert.rejects(client.create(binding), { code: "PROVISIONING_CONFLICT" });
await assert.rejects(
	client.create({ ...binding, profileId: "changed" }, created.uid),
	{
		code: "PROVISIONING_CONFLICT",
	},
);
assert.equal(await client.remove(binding, created.uid), true);
process.stdout.write(
	"strict Kubernetes Pod: create, identity verification, conflict and deletion passed\n",
);
