import {
	createRivetDurableTopicActor,
	isRivetDurableTopicBinding,
	RIVET_DURABLE_TOPIC_LOG_CAPABILITIES,
	RIVET_DURABLE_TOPIC_LOG_LIMITS,
	type RivetDurableTopicBinding,
} from "@hobo/runtime-rivet";
import { AlchemyIacError } from "./plan.js";
import {
	bindRivetStandaloneSource,
	type RivetStandaloneSource,
	rivetStandaloneResource,
} from "./rivet-standalone.js";
import { captureAlchemySourceFence } from "./source-fence.js";

export type {
	RivetDurableTopicBinding,
	RivetDurableTopicContext,
	RivetDurableTopicOptions,
} from "@hobo/runtime-rivet";
export {
	createRivetDurableTopicActor,
	isRivetDurableTopicBinding,
	RIVET_DURABLE_TOPIC_LOG_CAPABILITIES,
	RIVET_DURABLE_TOPIC_LOG_LIMITS,
};

/**
 * A standalone retained topic log, not a synchronous HoBo topic or a message
 * bus. The host must attest that the environment digest covers this actor's
 * complete executable/dependency closure, identity, fixed capability profile,
 * behavior-affecting configuration, and build/upload environment.
 */
export type RivetDurableTopicSource =
	RivetStandaloneSource<RivetDurableTopicBinding>;

function bindingMatches(environmentDigest: string) {
	return (binding: RivetDurableTopicBinding): boolean =>
		isRivetDurableTopicBinding(binding) &&
		binding.semanticDigest === environmentDigest;
}

/** Authenticate the exact branded actor, source, registry and exclusive pool. */
export function bindRivetDurableTopicSource(
	input: RivetDurableTopicSource,
): RivetDurableTopicSource {
	const snapshot = Object.freeze({ ...input });
	const sourceFence = captureAlchemySourceFence(snapshot.sourceFence);
	if (!sourceFence || sourceFence.sourceDigest !== snapshot.sourceDigest)
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"the topic requires a host-verified immutable source and artifact fence",
		);
	const source = Object.freeze({ ...snapshot, sourceFence });
	return bindRivetStandaloneSource(
		source,
		bindingMatches(sourceFence.environmentDigest),
		"topic",
	);
}

/** Construct the real Alchemy Rivet DurableObject for the partial topic log. */
export function rivetDurableTopicResource(input: RivetDurableTopicSource) {
	const source = bindRivetDurableTopicSource(input);
	return rivetStandaloneResource(
		source,
		bindingMatches(source.sourceFence.environmentDigest),
		"topic",
		"rivet-async-topic",
	);
}
