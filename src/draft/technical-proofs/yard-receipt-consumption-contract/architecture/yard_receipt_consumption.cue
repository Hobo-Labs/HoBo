package yard_receipt_consumption

#ResolutionReceipt: {
	receipt_id:              =~"^receipt-[a-z0-9-]+$"
	protocol_version:        "yard-receipt-consumption/v1"
	issuer:                  "meta-cloud-broker"
	manifest_digest:         =~"^sha256:.+"
	environment_digest:      =~"^sha256:.+"
	catalog_snapshot_digest: =~"^sha256:.+"
	issued_at:               string
	expires_at:              string
	compatibility:           #ReceiptCompatibility
	handoff_facts:           #ReceiptHandoffFacts
	digest:                  =~"^sha256:.+"
	signature:               =~"^signed:meta-cloud-broker:sha256:.+"
}

#ReceiptCompatibility: {
	yard_protocol_version: "yard-receipt-consumption/v1"
}

#ReceiptHandoffFacts: {
	resource_plans: [...#ResourcePlan] & [_, ...]
	gatekeeper_mode: "policy-after-receipt"
}

#ResourcePlan: {
	resource_id: =~"^[a-z][a-z0-9-]*$"
	provider:    =~"^provider\\.[a-z0-9-]+$"
	action:      "provision" | "deploy" | "bind"
}

#ResourceAction: "provision" | "deploy" | "bind"

#YardPlanningInput: {
	receipt_id:                   string
	manifest_digest:              =~"^sha256:.+"
	environment_digest:           =~"^sha256:.+"
	catalog_snapshot_digest:      =~"^sha256:.+"
	resource_plans:               [...#ResourcePlan] & [_, ...]
	planning_authority:           "yard-control-plane"
	resolution_authority:         "meta-cloud-broker"
	may_recompute_broker_mapping: false
}

#GatekeeperDecision: {
	effect:       "allow" | "allow-with-obligation" | "block"
	obligations?: [...string]
}

#ReceiptFailureCode:
	"receipt-required:no-broker-reresolve" |
	"receipt-integrity-failed:digest-or-signature" |
	"receipt-stale:expired" |
	"receipt-incompatible:protocol-version" |
	"admin-mutation-refused:new-receipt-required" |
	"gatekeeper-rewrite-refused:new-receipt-or-policy-decision-required"
