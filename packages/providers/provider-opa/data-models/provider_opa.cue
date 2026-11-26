// CUE constraints for every protobuf type in provider_opa.proto, so the
// architecture guard can confirm the Rego decision document is bounded at
// parse time.

package provider_opa

#RegoDecisionReason: {
	plane:   "policy" | "contracts" | "billing" | "placement" | "connectors" | "residency"
	code:    string & !=""
	message: string & !=""
}

#RegoDecisionResult: {
	effect: "allow" | "allow-degraded" | "deny" | "require-approval"
	reasons: [...#RegoDecisionReason]
	policy_ids: [...string & !=""]
}
