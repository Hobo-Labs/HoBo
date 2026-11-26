// CUE constraints for every protobuf type in provider_kubernetes.proto.
//
// The invariants worth writing down here are the ones the apiserver will not
// catch for us, or will only catch after something has already been created:
// a name that is not a DNS-1123 label is rejected by the cluster, but a limit
// below its request is accepted and then throttles or OOM-kills the pod, and a
// Deployment reporting "available" while its controller has not yet observed
// the current generation is a rollout claim about the previous ReplicaSet.

package provider_kubernetes

// RFC 1123 label — the name form Kubernetes uses for namespaces, services and
// most object names. 63 characters, lowercase alphanumerics and hyphens, no
// leading or trailing hyphen.
#Dns1123Label: =~"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$"

// RFC 1123 subdomain — dotted labels, used for Service DNS names.
#Dns1123Subdomain: =~"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$"

// An image reference this package is willing to place. A bare `nginx` is
// rejected on purpose: an unqualified name resolves through whatever default
// registry the node happens to be configured with, which is not a placement
// decision anyone made here.
#ImageRef: =~"^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+(:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@sha256:[0-9a-f]{64})$"

#Uid: =~"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

// `metadata.resourceVersion` is an opaque token the client must echo, never
// interpret — but it is always a non-empty bounded string, and treating it as
// anything richer (an integer, an ordering) is the classic mistake.
#ResourceVersion: =~"^[A-Za-z0-9]{1,64}$"

#KubernetesRolloutPhase: "pending" | "progressing" | "available" | "failed"

// The apiserver's spelling, verbatim. The protobuf zero slot has no wire form
// here: a Namespace whose phase this package cannot name is a contract change,
// not a third lifecycle state.
#KubernetesNamespacePhase: "Active" | "Terminating"

#KubernetesCleanupState: "deleting" | "deleted" | "retained"

#KubernetesResourceQuantity: {
	// 10m is below the CFS quota floor most kubelets enforce; 64 cores is more
	// than this provider will ever ask a single pod for.
	cpu_millicores: uint32 & >=10 & <=64000
	// 4 MiB .. 256 GiB. Below the floor the runtime cannot start; the ceiling
	// is a guard against a unit slip ("512" read as bytes, not MiB).
	memory_bytes: uint64 & >=4194304 & <=274877906944
}

#KubernetesPlacementRequest: {
	workload_name: #Dns1123Label
	namespace:     #Dns1123Label
	image_ref:     #ImageRef
	replicas:      uint32 & >=1 & <=100
	container_port: uint32 & >=1 & <=65535
	requests:      #KubernetesResourceQuantity
	limits:        #KubernetesResourceQuantity
	labels: [#Dns1123Label]: =~"^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$"

	// A limit below its request is accepted by the apiserver and then quietly
	// ruins the workload: the scheduler reserves the request, the kubelet
	// enforces the limit, and the pod is throttled or OOM-killed for the gap.
	_cpu_limit_at_least_request:    true & (limits.cpu_millicores >= requests.cpu_millicores)
	_memory_limit_at_least_request: true & (limits.memory_bytes >= requests.memory_bytes)
}

#KubernetesNamespaceRecord: {
	name:             #Dns1123Label
	uid:              #Uid
	resource_version: #ResourceVersion
	phase:            #KubernetesNamespacePhase
	created_at_ms:    int & >0
	created_by_hobo:  bool
}

#KubernetesDeploymentRecord: {
	name:                #Dns1123Label
	namespace:           #Dns1123Label
	uid:                 #Uid
	resource_version:    #ResourceVersion
	generation:          int & >=1
	observed_generation: int & >=0
	desired_replicas:    uint32 & >=1 & <=100
	updated_replicas:    uint32
	ready_replicas:      uint32
	available_replicas:  uint32
	phase:               #KubernetesRolloutPhase
	failure_reason:      string

	// The controller cannot have observed a generation the apiserver has not
	// issued. An available pod is by definition a ready pod, so that ordering
	// holds at every instant; `ready` and `updated` are NOT orderable during a
	// rollout (an old-ReplicaSet pod is ready but not updated, a new one is
	// updated but not yet ready), so no relation between them is asserted.
	_observed_not_ahead: true & (observed_generation <= generation)
	_available_bounded:  true & (available_replicas <= ready_replicas)

	// The surge ceiling is only an invariant because src/placement.ts renders
	// `maxSurge: 1` explicitly rather than inheriting the 25% default. Change
	// the renderer and this bound is a lie.
	_updated_within_surge: true & (updated_replicas <= desired_replicas + 1)
	_ready_within_surge:   true & (ready_replicas <= desired_replicas + 1)

	// "Available" is the only phase that is a promise, so it is the only one
	// with teeth: every desired replica available AND the controller working
	// from the current generation. Without the generation check this reports
	// the previous ReplicaSet's success as the new rollout's.
	if phase == "available" {
		_fully_available: true & (available_replicas >= desired_replicas)
		_current:         true & (observed_generation == generation)
		failure_reason:   ""
	}

	// A rollout is only pending while nothing has observed it.
	if phase == "pending" {
		_unobserved: true & (observed_generation < generation)
	}

	// A failure this package reports must carry the controller's own reason;
	// "failed, cause unknown" is a diagnosis nobody can act on.
	if phase == "failed" {
		failure_reason: =~"^[A-Za-z][A-Za-z0-9]{2,63}$"
	}
}

#KubernetesServiceRecord: {
	name:      #Dns1123Label
	namespace: #Dns1123Label
	// ClusterIP only, and "None" (headless) is not one of them: this record
	// exists so callers have an address, and a headless service has none.
	cluster_ip:  =~"^(([0-9]{1,3}\\.){3}[0-9]{1,3}|[0-9a-fA-F:]{2,45})$"
	port:        uint32 & >=1 & <=65535
	target_port: uint32 & >=1 & <=65535
	cluster_dns_name: #Dns1123Subdomain & =~"\\.svc\\.cluster\\.local$"
}

#KubernetesProvisionReceipt: {
	schema_version: "hobo.provider-kubernetes.receipt/v1"
	provider_id:    "kubernetes"
	resource_class: "kubernetes:deployment"
	placement:      #KubernetesPlacementRequest
	namespace:      #KubernetesNamespaceRecord
	deployment:     #KubernetesDeploymentRecord
	service:        #KubernetesServiceRecord
	// In-cluster only. A receipt that advertised an ingress hostname would be
	// claiming an object this provider never created.
	endpoint_url: =~"^http://[a-z0-9.-]+\\.svc\\.cluster\\.local:[0-9]{1,5}/?$"
	adopted:      bool

	// The three objects belong to one placement or the receipt is describing
	// something other than what was asked for.
	_deployment_named:   true & (deployment.name == placement.workload_name)
	_service_named:      true & (service.name == placement.workload_name)
	_namespace_agrees:   true & (namespace.name == placement.namespace)
	_deployment_scoped:  true & (deployment.namespace == placement.namespace)
	_service_scoped:     true & (service.namespace == placement.namespace)
	_replicas_agree:     true & (deployment.desired_replicas == placement.replicas)
	_target_port_agrees: true & (service.target_port == placement.container_port)

	// Adoption and creation are exclusive: an adopted namespace is one this
	// package found, and only a namespace it created may later be deleted.
	_adoption_consistent: true & (adopted != namespace.created_by_hobo)
}

#KubernetesCleanupOutcome: {
	namespace:      #Dns1123Label
	state:          #KubernetesCleanupState
	observed_at_ms: int & >0
	retained_reason: string

	// Retention is a decision, so it has to name itself. Deletion is an
	// observation, so it must not invent one.
	if state == "retained" {
		retained_reason: =~"^[a-z][a-z0-9-]{2,63}$"
	}
	if state != "retained" {
		retained_reason: ""
	}
}

#KubernetesApiStatus: {
	kind:    "Status"
	status:  "Failure"
	reason:  =~"^[A-Za-z][A-Za-z0-9]{2,63}$"
	message: string & !="" & =~"^[^\\x00-\\x1f]{1,1024}$"
	code:    uint32 & >=400 & <600
}

// ---------------------------------------------------------------------------
// Provider-parity constraints: one constraint per parity message in
// provider_kubernetes.proto.
// ---------------------------------------------------------------------------

#EquivalenceMapping: {
	class:           string & !=""
	port:            string & !=""
	resourceClass:   =~"^kubernetes:"
	providerService: string & !=""
	features: [...string] & !=[]
}

#CapabilityManifestIndex: {
	schema:         "hobo.capability-manifest-index/v1"
	providerId:     "@hobo/provider-kubernetes"
	manifestSchema: "hobo.capability-manifest/v1"
}

// Kubernetes is the one provider whose declared price is a structural zero:
// the API charges nothing for a Deployment, and the nodes are billed by the
// provider underneath. The constraint still pins the decimal-string shape.
#CostFact: {
	port:             string & !=""
	sku:              =~"^kubernetes\\."
	unit:             string & !=""
	marginalPrice:    =~"^[0-9]+\\.[0-9]+$"
	freeTierIncluded: uint
}

#AuthPosture: {
	schema:        "hobo.provider-auth/v1"
	mode:          "svid-federation"
	tokenAudience: =~"^spiffe://hobo/providers/"
	exchange:      "kubernetes:BoundServiceAccountToken"
	staticSecrets: false
}

#RealizedIacResource: {
	name:     string & !=""
	type:     =~"^kubernetes:"
	provider: "kubernetes"
	outputs: [...string] & !=[]
}

#RealizedIacProgram: {
	apiVersion:   "hobo.iac-program/v1"
	kind:         "iac-program"
	provider:     "pulumi"
	deploymentId: string & !=""
	stack:        =~"^kubernetes/"
	resources: [...#RealizedIacResource] & !=[]
}

#YardBindingRow: {
	profile:         =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"
	productId?:      =~"^kubernetes\\.[a-z0-9-]+/v[1-9][0-9]*$"
	connectivityId?: string & !=""
}

#ResolvedResource: {
	productId:  =~"^kubernetes\\."
	action:     "create" | "update" | "adopt" | "noop" | "replace"
	physicalId: string & !=""
	diagnostics: [...string]
}
