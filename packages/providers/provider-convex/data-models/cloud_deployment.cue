// CUE constraints for cloud_deployment.proto (plan 0024 WP13).
package provider_convex

#ConvexDeploymentName: =~"^[a-z][a-z0-9-]{0,62}[a-z0-9]$"

#ConvexCloudDeploymentOutputs: {
	teamId:         =~"^[0-9]{1,20}$"
	projectId:      =~"^[0-9]{1,20}$"
	deploymentName: #ConvexDeploymentName
	deploymentType: "prod" | "dev" | "preview" | "custom"
	// The URL is derived from the observed name, never from desired input.
	deploymentUrl:      "https://\(deploymentName).convex.cloud"
	servingEndpoint:    deploymentUrl
	ready:              bool
	operationConfirmed: bool
	operationTerminal:  bool
	absenceConfirmed:   false
	lifecycleStatus:    "ready" | "pending" | "failed" | "absent"
	// Honesty: the resolver never claims to have seen the code version.
	codeVersionObserved: false
	// No artifact identity can be claimed without observing the code.
	artifactDigest?: _|_
}
