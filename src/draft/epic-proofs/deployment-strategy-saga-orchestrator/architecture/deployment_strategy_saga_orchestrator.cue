package deployment_strategy_saga_orchestrator

#DeploymentStrategySagaOrchestratorRecord: {
	issue:   string & !=""
	summary: string & !=""
	evidence: [...string]
}

#DeploymentStrategyKind: "recreate" | "blue-green" | "canary" | "progressive"
