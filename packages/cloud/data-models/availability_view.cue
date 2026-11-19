package cloud

#AvailabilityRatio: number & >=0 & <=1

#AvailabilityNode: {
	type: *"component" | "redundant-set"
	availability?: #AvailabilityRatio
	provider?: string & !=""
	dependsOn?: [...string & !=""]
	members?: [...string & !=""]
	sharedDependencies?: [...string & !=""]
	if type == "redundant-set" {
		members: [string & !="", ...string & !=""]
		availability?: _|_
		provider?: _|_
		dependsOn?: []
	}
	if type == "component" {
		members?: []
		sharedDependencies?: []
	}
}
#AvailabilityGraph: {
	root: string & !=""
	nodes: {[string]: #AvailabilityNode}
	defaultHopAvailability?: #AvailabilityRatio
}
#AvailabilityViewRequest: {
	graph: #AvailabilityGraph
	observedAvailability?: #AvailabilityRatio | null
	availabilitySlo?: #AvailabilityRatio | null
	conservativeUnratedAvailability?: #AvailabilityRatio
	divergenceThreshold?: #AvailabilityRatio
}
#AvailabilityWarning: {
	code: string & !=""
	message: string & !=""
	node?: string & !=""
	provider?: string & !=""
	assumedAvailability?: #AvailabilityRatio
	estimatedAvailability?: #AvailabilityRatio
	observedAvailability?: #AvailabilityRatio
	availabilitySlo?: #AvailabilityRatio
	gap?: #AvailabilityRatio
	sharedDependencies?: [...string & !=""]
	hardGate?: false
}
#AvailabilityIssue: {
	code: string & !=""
	message: string & !=""
}
#AvailabilityNodeEstimate: {
	type: "component" | "redundant-set"
	availability: #AvailabilityRatio
}
#AvailabilityBreakdown: {
	byNode: {[string]: #AvailabilityNodeEstimate}
	countedNodes: [...string & !=""]
}
#AvailabilitySummary: {
	estimated: string & !=""
	observed: string & !=""
	estimateObservedGap: string & !=""
}
#AvailabilityDeployAssessment: {
	effect: "allow" | "warn"
	warnings: [...#AvailabilityWarning]
}
#AvailabilityView: {
	schema: "hobo.availability-view/v1"
	status: "estimated" | "invalid-graph"
	estimatedAvailability?: #AvailabilityRatio | null
	estimatedDowntimeMinutesPerYear?: (number & >=0) | null
	observedAvailability?: #AvailabilityRatio | null
	availabilitySlo?: #AvailabilityRatio | null
	summary: #AvailabilitySummary
	canDeploy: #AvailabilityDeployAssessment
	warnings: [...#AvailabilityWarning]
	errors: [...#AvailabilityIssue]
	breakdown: #AvailabilityBreakdown
	if status == "estimated" {
		estimatedAvailability: #AvailabilityRatio
		estimatedDowntimeMinutesPerYear: number & >=0
		errors: []
	}
	if status == "invalid-graph" {
		estimatedAvailability?: null
		estimatedDowntimeMinutesPerYear?: null
		canDeploy: effect: "warn"
		errors: [#AvailabilityIssue, ...#AvailabilityIssue]
	}
}
