package provider_convex

#ConvexDeploymentName: =~"^[a-z][a-z0-9-]{0,62}[a-z0-9]$"

#ConvexCloudDeploymentOutputs: {
	teamId:         =~"^[0-9]{1,20}$"
	projectId:      =~"^[0-9]{1,20}$"
	deploymentName: #ConvexDeploymentName
	deploymentType: "prod" | "dev" | "preview" | "custom"
	deploymentUrl:      "https://\(deploymentName).convex.cloud"
	servingEndpoint:    deploymentUrl
	ready:              bool
	operationConfirmed: bool
	operationTerminal:  bool
	absenceConfirmed:   false
	lifecycleStatus:    "ready" | "pending" | "failed" | "absent"
	codeVersionObserved: false
	artifactDigest?: _|_
}
