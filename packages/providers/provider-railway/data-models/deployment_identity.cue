package provider_railway

#RailwayDeploymentIdentity: {
	tenantId:      string & !=""
	operationId:   string & !=""
	requestDigest: =~"^sha256:[a-f0-9]{64}$"
	projectId:     =~"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
	environmentId: =~"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
	serviceId:     =~"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
	logicalId:     string & !=""
	deploymentId:  =~"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
	commitSha:     =~"^(?:[a-f0-9]{40}|[a-f0-9]{64})$"
	recordedAtMs:  int & >=0 & <=9007199254740991
}
RailwayDeploymentIdentity: #RailwayDeploymentIdentity
