import { bucket, data, kv, secret, secretRef } from "@hobo-draft/bindles-resource-catalog";

// @ts-expect-error search is the query side of data, not an exported catalog factory.
import { search } from "@hobo-draft/bindles-resource-catalog";

const state = kv("state");
state.get("session-1");
state.set("session-1", { expiresAt: "later" });
state.delete("session-1");
state.allow("get").get("session-1");

// @ts-expect-error kv handles do not expose publish.
state.publish({ id: "event-1" });

// @ts-expect-error kv allow verbs are get/set/delete only.
state.allow("publish");

const files = bucket("files");
files.read("avatar.png");
files.write("avatar.png", new Uint8Array());
files.delete("avatar.png");

// @ts-expect-error bucket handles do not expose queue verbs.
files.enqueue("job-1");

data("records").query({ text: "needle" });

const managedSecrets = secret("payment-secrets");
managedSecrets.access("stripe");

// @ts-expect-error secretRef reads a value; it is not a catalog resource handle.
secretRef("STRIPE_API_KEY").access("stripe");

void search;
