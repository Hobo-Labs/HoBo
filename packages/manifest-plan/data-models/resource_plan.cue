package hobo

// CUE constraints for the plan manifest wire records. One constraint per
// protobuf message in resource_plan.proto.

// Property keys that read as a secret value rather than a locator. Kept
// character-for-character identical to CREDENTIAL_KEY_PATTERN in
// packages/yards/src/canonical.ts: a Yard and the plan its rows produce must
// not disagree about what counts as a credential, and a second spelling is
// exactly how that divergence starts.
#PlanCredentialKeyPattern: "(?i)(secret|password|token|credential|private[_-]?key|api[_-]?key)"

// An arbitrary JSON value, matching google.protobuf.Value.
//
// Deliberately wider than hobo.cloud.v1's `{[_]: string}`: realization
// parameters are provider-native and real ones carry non-strings, so a
// string-only constraint rejects values the planner emits today.
#PlanParameterValue:
	null |
	bool |
	number |
	string |
	[...#PlanParameterValue] |
	{[string]: #PlanParameterValue}

#NonPortableRows: {
	values: [...string & !=""]
}

#ResourcePlan: {
	name:     string & !=""
	port:     string & !=""
	provider: string & !=""
	deps: [...string]

	// No `!= ""` on these three, matching hobo.cloud.v1. See the README:
	// admitting "" here is a gap, not a decision, and tightening it is a
	// change to the plan contract rather than to this package.
	strategy?:     string
	region?:       string
	deploymentId?: string

	productId?: string & !=""

	// Keys are locators, never values. A credential-shaped key is refused, the
	// same refusal the Yard binding rows these are merged from already carry.
	realizationParameters?: {[!~#PlanCredentialKeyPattern]: #PlanParameterValue}

	nonPortableRows?: [...string & !=""]
}

#DeploymentPlan: {
	schema: "hobo.deployment-plan/v1"
	resources: [...#ResourcePlan]
	dependencyOrder: [...string]
	objective: string & !=""
}
