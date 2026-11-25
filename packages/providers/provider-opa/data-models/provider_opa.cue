
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
