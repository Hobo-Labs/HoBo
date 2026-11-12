// "@hobo/cd/sources" (WP2): Freight sources and pull discovery (D3, I15).
import type { CdFactories } from "../ports.js";
import { createFreightSources as create } from "./sources.js";

/** The frozen factory signature; `telemetry` may be added for metrics. */
export const createFreightSources: CdFactories["createFreightSources"] &
	typeof create = create;

export { type Assembled, assemble, definitionDigest, SOURCE_LABEL } from "./assembly.js";
export { backoffDelayMs, jitterFraction } from "./backoff.js";
export * from "./drivers/index.js";
export { SOURCE_CREDENTIAL_SCOPE } from "./http.js";
export { MAX_DISCOVERY_LIMIT, MAX_SUBSCRIPTIONS, PROVENANCE_KINDS, parseFreightSource } from "./parse.js";
export { SOURCE_REASON, type SourceReasonCode } from "./reasons.js";
export { compareVersions, parseSemver, parseSemverRange } from "./selection.js";
export { type DiscoveryOutcome, discoveryOutcome, type FreightSourcesDeps, SOURCE_METRIC } from "./sources.js";
export type { AttestationMaterial, AttestingDriver } from "./types.js";
export { isAttestingDriver } from "./types.js";
export { gitKey, ociKey, purlKey, subscriptionKeys, urlKey } from "./webhooks/keys.js";
export {
	receiveWebhook,
	WEBHOOK_MAX_BODY_BYTES,
	WEBHOOK_RECEIVERS,
	WEBHOOK_SECRET_SCOPE,
	type WebhookReceiver,
	webhookSecretRef,
} from "./webhooks/receivers.js";
