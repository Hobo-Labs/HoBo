export type DaprDeployMode = "self-hosted" | "kubernetes";

// domain-view: parse-don't-validate parsed/derived type; wire form is DaprRuntimeConfig in data-models/runtime_dapr.proto.
export interface DaprRuntimeConfig {
	readonly campId: string;
	readonly tenantId: string;
	readonly appId: string;
	readonly mode: DaprDeployMode;
	readonly httpEndpoint: string;
	readonly grpcEndpoint?: string;
	readonly placementAddress?: string;
	readonly actorsEnabled: boolean;
	readonly pubsubEnabled: boolean;
	readonly workflowEnabled: boolean;
	readonly defaultPubsubName: string;
	/** Secretless SVID / identity injection binding. */
	readonly svidBindingRef: string;
}

// domain-view: parse-don't-validate parsed/derived type; wire form is DaprComponentSpec in data-models/runtime_dapr.proto.
export interface DaprComponentSpec {
	readonly name: string;
	readonly type: string;
	readonly version: string;
	/** Metadata values are binding refs — never plaintext secrets. */
	readonly metadata: Readonly<Record<string, string>>;
	readonly scopes: readonly string[];
}

// domain-view: parse-don't-validate parsed/derived type; wire form is DaprComponentYaml in data-models/runtime_dapr.proto.
export interface DaprComponentYaml {
	readonly apiVersion: "dapr.io/v1alpha1";
	readonly kind: "Component";
	readonly name: string;
	readonly body: string;
	readonly secretless: true;
}

// domain-view: parse-don't-validate parsed/derived type; wire form is DaprDoctorReport in data-models/runtime_dapr.proto.
export interface DaprDoctorReport {
	readonly daprCliAvailable: boolean;
	readonly runtimeReachable: boolean;
	readonly fidelity: "simulated" | "live";
	readonly notes: readonly string[];
	readonly remediation: readonly string[];
}

export interface DaprWorkflowStepMap {
	readonly hoboStep: string;
	readonly daprActivity: string;
}
