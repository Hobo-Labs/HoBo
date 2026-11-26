import { bindle, bucket, data, kv, secret, secretRef } from "../src/index.js";
import type { AllowVerbsFor, ResourceHandle, SecretRef } from "../src/types.js";

type BindlesModule = typeof import("../src/index.js");
type KvHandle = ReturnType<typeof kv>;
type BucketHandle = ReturnType<typeof bucket>;

type _KvAllow = AllowVerbsFor<"kv">;
type _AssertKvAllow = _KvAllow extends "get" | "set" | "delete" ? true : never;
const _kvAllowCheck: _AssertKvAllow = true;

const state = kv("state");
state.get("session-1");
state.set("session-1", { expiresAt: "later" });
state.delete("session-1");
state.allow("get").get("session-1");

// @ts-expect-error kv handles do not expose publish.
type _KvPublish = KvHandle["publish"];

// @ts-expect-error kv allow verbs are get/set/delete only.
const _badKvVerb: AllowVerbsFor<"kv"> = "publish";

const files = bucket("files");
files.read("avatar.png");
files.write("avatar.png", new Uint8Array());
files.delete("avatar.png");

// @ts-expect-error bucket handles do not expose queue verbs.
type _BucketEnqueue = BucketHandle["enqueue"];

data("records").query({ text: "needle" });

const managedSecrets = secret("payment-secrets");
managedSecrets.access("stripe");

// @ts-expect-error secretRef reads a value; it is not a catalog resource handle.
const _secretRefAsHandle: ResourceHandle<"secret"> =
	secretRef("STRIPE_API_KEY");

// @ts-expect-error search is the query side of data, not an exported catalog factory.
type _SearchExport = BindlesModule["search"];

type _SecretRefNotHandle =
	ResourceHandle<"secret"> extends SecretRef ? never : true;
const _secretRefCheck: _SecretRefNotHandle = true;

// Builder surface: the new catalog kinds narrow allow() to their verbs.
bindle("builder-verbs", (b) => ({
	nightly: b.schedule(),
	beta: b.flag().allow("eval", "change"),
	sessions: b.auth().allow("verify", "session"),
	signer: b.crypto().allow("encrypt", "decrypt", "sign", "verify"),
	alerts: b.notify().allow("send"),
	safety: b.guardrail().allow("check"),
	ab: b.experiment().allow("assign", "expose", "analyze"),
	deploy: b.rollout().allow("start", "step", "promote", "rollback"),
	realtime: b.websocket().allow("accept", "send", "broadcast"),
	worker: b.job().allow("submit"),
	panel: b.ui().allow("render", "drive"),
}));

bindle("builder-bad-verbs", (b) => ({
	// @ts-expect-error flag allows eval/change only, not publish.
	beta: b.flag().allow("publish"),
	// @ts-expect-error rollout allows start/step/promote/rollback only.
	deploy: b.rollout().allow("dequeue"),
}));
