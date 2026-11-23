package hobo

#CiFleetHost: {
	provider: "hostinger"
	id: =~"^[1-9][0-9]{0,18}$"
	hostname: string
	state: string & !=""
	plan: string
	ipv4: string
	actionsLock: "" | "unlocked" | "locked"
}

#CiFleetStatus: {
	provider: "hostinger"
	hosts: [...#CiFleetHost]
}

#CiFleetPowerAction: {
	provider: "hostinger"
	host: #CiFleetHost
	action: "restart" | "start"
	actionId: =~"^[1-9][0-9]{0,18}$"
	actionState: string & !=""
}

#KubernetesName: =~"^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$"

#CiFleetCachePatchOperation: {
	op: "test" | "add"
	path: =~"^/(metadata/resourceVersion|spec/template/spec/[A-Za-z0-9/_-]+)$"
	valueJson: string & !=""
}

#CiFleetCachePrewarm: {
	job: "" | #KubernetesName
	ref: "" | =~"^[0-9a-f]{40}$"
	state: "absent" | "planned" | "created" | "exists" | "succeeded" | "failed" | "running"
}

#CiFleetCacheScaleSet: {
	name: #KubernetesName
	namespace: #KubernetesName
	cachesMounted: bool
	patchState: "current" | "planned" | "applied"
	patch: [...#CiFleetCachePatchOperation]
	prewarm?: #CiFleetCachePrewarm
}

#CiFleetCaches: {
	cluster: =~"^[A-Za-z0-9_-]{1,80}$"
	namespace: #KubernetesName
	mode: "plan" | "apply" | "status"
	scaleSets: [...#CiFleetCacheScaleSet]
}

CiFleetHost: #CiFleetHost
CiFleetStatus: #CiFleetStatus
CiFleetPowerAction: #CiFleetPowerAction
CiFleetCachePatchOperation: #CiFleetCachePatchOperation
CiFleetCachePrewarm: #CiFleetCachePrewarm
CiFleetCacheScaleSet: #CiFleetCacheScaleSet
CiFleetCaches: #CiFleetCaches
