package data_models


#ApiBaseUrl: string & =~"^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$"

#K8sLabel: string & =~"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$"

#K8sName: string & =~"^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$"

#HubKind:  "HUB_KIND_OCM" | "HUB_KIND_KARMADA" | "HUB_KIND_CLUSTER_INVENTORY"
#KubeAuth: "KUBE_AUTH_BEARER" | "KUBE_AUTH_EXEC"

#DepartureAction: "DEPARTURE_ACTION_DELETE" | "DEPARTURE_ACTION_ORPHAN" | "DEPARTURE_ACTION_ORPHAN_DATA"

#CampId: string & =~"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$"

#KubeHubRecord: {
	schemaVersion: "hobo.cd-kube-fleet.hub/v1"
	name:          string & =~"^[a-z0-9][a-z0-9-]{0,62}$"
	kind:          #HubKind
	apiBaseUrl:    #ApiBaseUrl
	credentialRef: string & !=""
	auth:          #KubeAuth | *"KUBE_AUTH_BEARER"
	timeoutMs?:    int & >=1000 & <=120000
}

#CampClusterRecord: {
	campId:  #CampId
	cluster: #K8sLabel
}

#OcmRealizerRecord: {
	schemaVersion:    "hobo.cd-kube-fleet.ocm/v1"
	hub:              #KubeHubRecord & {kind: "HUB_KIND_OCM"}
	clusters:         [...#CampClusterRecord] & [_, ...]
	departureAction?: #DepartureAction
}

#KarmadaRealizerRecord: {
	schemaVersion:    "hobo.cd-kube-fleet.karmada/v1"
	hub:              #KubeHubRecord & {kind: "HUB_KIND_KARMADA"}
	clusters:         [...#CampClusterRecord] & [_, ...]
	departureAction?: #DepartureAction
}

#ClusterProfileImportRecord: {
	schemaVersion:        "hobo.cd-kube-fleet.cluster-profiles/v1"
	hub:                  #KubeHubRecord
	namespace?:           #K8sLabel
	yardId:               string & !=""
	stationId:            string & !=""
	provider:             string & !=""
	envType:              string & !=""
	regions:              [...(string & !="")] & [_, ...]
	campIdPrefix?:        string & =~"^[a-z0-9-]{0,32}$"
	labelSelector?:       {[string & =~"^([a-z0-9.-]{1,253}/)?[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$"]: string & =~"^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$"}
	watchTimeoutSeconds?: int & >=1 & <=300
}

#KubeObjectRefRecord: {
	group?:     string & =~"^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?)?$"
	version:    string & =~"^v[0-9]+((alpha|beta)[0-9]+)?$"
	kind:       string & =~"^[A-Z][A-Za-z0-9]{0,62}$"
	resource:   string & =~"^[a-z][a-z0-9]{0,62}$"
	namespace?: #K8sLabel
	name:       #K8sName
}

#ImportedClusterRecord: {
	campId:            #CampId
	profileNamespace:  #K8sLabel
	profileName:       #K8sName
	clusterManager?:   string
	kubernetesVersion?: string
	accessProviders?:  [...(string & !="")]
	resourceVersion?:  string
}
