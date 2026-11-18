import { bindle, bucket, data, kv, secret, secretRef } from "../src/index.js";
import type {
	AllowVerbsFor,
	BindleBuilder,
	BindleResource,
	BindleResourceMessage,
	ResourceHandle,
	SecretRef,
} from "../src/types.js";

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

// @ts-expect-error
type _KvPublish = KvHandle["publish"];

// @ts-expect-error
const _badKvVerb: AllowVerbsFor<"kv"> = "publish";

const files = bucket("files");
files.read("avatar.png");
files.write("avatar.png", new Uint8Array());
files.delete("avatar.png");

// @ts-expect-error
type _BucketEnqueue = BucketHandle["enqueue"];

data("records").query({ text: "needle" });

const managedSecrets = secret("payment-secrets");
managedSecrets.access("stripe");

// @ts-expect-error
const _secretRefAsHandle: ResourceHandle<"secret"> =
	secretRef("STRIPE_API_KEY");

// @ts-expect-error
type _SearchExport = BindlesModule["search"];

type _SecretRefNotHandle =
	ResourceHandle<"secret"> extends SecretRef ? never : true;
const _secretRefCheck: _SecretRefNotHandle = true;

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
	// @ts-expect-error
	beta: b.flag().allow("publish"),
	// @ts-expect-error
	deploy: b.rollout().allow("dequeue"),
}));

interface OrderEvent {
	orderId: string;
}
interface ShipmentEvent {
	trackingNumber: string;
}
declare const builder: BindleBuilder;
const orders = builder.queue<OrderEvent>().allow("enqueue").withReference(builder.kv());
const shipments = builder.topic<ShipmentEvent>().with().dependsOn(orders).allow("publish");
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (
	<T>() => T extends B ? 1 : 2
)
	? true
	: false;
const _orderMessage: Equal<BindleResourceMessage<typeof orders>, OrderEvent> = true;
const _shipmentMessage: Equal<BindleResourceMessage<typeof shipments>, ShipmentEvent> = true;
// @ts-expect-error
const _wrongMessage: BindleResource<"queue", ShipmentEvent> = orders;
// @ts-expect-error
state.set("session-1", new Uint8Array());
// @ts-expect-error
files.read(new Uint8Array());
