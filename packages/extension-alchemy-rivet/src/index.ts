import { AlchemyIacError } from "@hobo/iac-alchemy";
import {
	bindRivetStandaloneSource,
	type RivetStandaloneSource,
	rivetStandaloneResource,
} from "@hobo/iac-alchemy/rivet/standalone";
import {
	createRivetDurableTopicActor,
	createRivetDurableTopicBusActor,
	isRivetDurableTopicBinding,
	isRivetDurableTopicBusBinding,
	RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	RIVET_DURABLE_TOPIC_BUS_LIMITS,
	RIVET_DURABLE_TOPIC_LOG_CAPABILITIES,
	RIVET_DURABLE_TOPIC_LOG_LIMITS,
	type RivetDurableTopicBinding,
	type RivetDurableTopicBusBinding,
} from "@hobo/runtime-rivet";

export type {
	RivetDurableTopicBinding,
	RivetDurableTopicBusBinding,
	RivetDurableTopicBusOptions,
	RivetDurableTopicContext,
	RivetDurableTopicOptions,
} from "@hobo/runtime-rivet";
export {
	createRivetDurableTopicActor,
	createRivetDurableTopicBusActor,
	isRivetDurableTopicBinding,
	isRivetDurableTopicBusBinding,
	RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	RIVET_DURABLE_TOPIC_BUS_LIMITS,
	RIVET_DURABLE_TOPIC_LOG_CAPABILITIES,
	RIVET_DURABLE_TOPIC_LOG_LIMITS,
};

export type RivetDurableTopicSource =
	RivetStandaloneSource<RivetDurableTopicBinding>;
export type RivetDurableTopicBusSource =
	RivetStandaloneSource<RivetDurableTopicBusBinding>;

export function bindRivetDurableTopicSource(
	input: RivetDurableTopicSource,
): RivetDurableTopicSource {
	const source = bindRivetStandaloneSource(
		input,
		isRivetDurableTopicBinding,
		"topic",
	);
	if (source.binding.semanticDigest !== source.sourceFence.environmentDigest)
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			"the topic actor does not match the host-attested environment",
		);
	return source;
}

export function rivetDurableTopicResource(input: RivetDurableTopicSource) {
	const source = bindRivetDurableTopicSource(input);
	return rivetStandaloneResource(
		source,
		(binding) =>
			isRivetDurableTopicBinding(binding) &&
			binding.semanticDigest === source.sourceFence.environmentDigest,
		"topic",
		"rivet-async-topic",
	);
}

export function bindRivetDurableTopicBusSource(
	input: RivetDurableTopicBusSource,
): RivetDurableTopicBusSource {
	const source = bindRivetStandaloneSource(
		input,
		isRivetDurableTopicBusBinding,
		"topic bus",
	);
	if (source.binding.semanticDigest !== source.sourceFence.environmentDigest)
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			"the topic bus actor does not match the host-attested environment",
		);
	return source;
}

export function rivetDurableTopicBusResource(
	input: RivetDurableTopicBusSource,
) {
	const source = bindRivetDurableTopicBusSource(input);
	return rivetStandaloneResource(
		source,
		(binding) =>
			isRivetDurableTopicBusBinding(binding) &&
			binding.semanticDigest === source.sourceFence.environmentDigest,
		"topic bus",
		"rivet-async-topic-bus",
	);
}
