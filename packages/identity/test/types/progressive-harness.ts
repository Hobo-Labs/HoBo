import {
	createHarness,
	type DeliveryPort,
	type ExperimentPort,
	FeatureFlagStore,
	Harness,
	type HarnessOptions,
	type HarnessPorts,
	type OpenDeliveryEngine,
	type OpenExperimentEngine,
} from "../../src/index.js";

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
type Assert<T extends true> = T;

const store = new FeatureFlagStore();
const direct = new Harness({ store });
const factory = createHarness({ store });

export type DirectDelivery = Assert<
	Equal<typeof direct.delivery, OpenDeliveryEngine>
>;
export type DirectExperiment = Assert<
	Equal<typeof direct.experiment, OpenExperimentEngine>
>;
export type FactoryDelivery = Assert<
	Equal<typeof factory.delivery, OpenDeliveryEngine>
>;
export type FactoryExperiment = Assert<
	Equal<typeof factory.experiment, OpenExperimentEngine>
>;

const defaultPorts: HarnessPorts = factory.ports();
const defaultDelivery: OpenDeliveryEngine = defaultPorts.delivery;
const defaultExperiment: OpenExperimentEngine = defaultPorts.experiment;
defaultDelivery.events.push();
defaultExperiment.events.push();

interface CustomDelivery extends DeliveryPort {
	readonly customDelivery: true;
}

interface CustomExperiment extends ExperimentPort {
	readonly customExperiment: true;
}

declare const customDelivery: CustomDelivery;
declare const customExperiment: CustomExperiment;
const structuralOptions: HarnessOptions = {
	store,
	delivery: customDelivery,
	experiment: customExperiment,
};
structuralOptions.store.get("fixture");
const injected = createHarness({
	store,
	delivery: customDelivery,
	experiment: customExperiment,
});
const constructed = new Harness({
	store,
	delivery: customDelivery,
	experiment: customExperiment,
});

export type InferredDelivery = Assert<
	Equal<typeof injected.delivery, CustomDelivery | OpenDeliveryEngine>
>;
export type InferredExperiment = Assert<
	Equal<typeof constructed.experiment, CustomExperiment | OpenExperimentEngine>
>;
export type PossibleDelivery = Assert<
	Equal<
		Harness<CustomDelivery, CustomExperiment>["delivery"],
		CustomDelivery | OpenDeliveryEngine
	>
>;
export type PossibleExperiment = Assert<
	Equal<
		Harness<CustomDelivery, CustomExperiment>["experiment"],
		CustomExperiment | OpenExperimentEngine
	>
>;
