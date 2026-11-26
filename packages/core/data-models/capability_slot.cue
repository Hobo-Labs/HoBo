// CUE constraints for every protobuf type in capability_slot.proto. These are
// load-bearing for ADR-0157 authoring: the slot vocabulary is closed so an
// unknown slot is refused rather than defaulted, the profile must match the
// ADR-0151 grammar <family>.<path>/v<major> so selection can key off it, at
// least one of product_id / connectivity_id must be non-empty (a binding that
// narrows nothing would silently match everything), property keys are never
// credential-shaped, and a refusal always carries one of the five codes.

package core

#CapabilitySlot: "web" | "api" | "service" | "data" | "kv" | "bucket" | "queue" | "topic" | "secretRef" | "webhook"

#CapabilityProfileId: =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[1-9][0-9]*$"

#SlotBindingErrorCode: "SLOT_BINDING_SLOT_INVALID" | "SLOT_BINDING_PROFILE_INVALID" | "SLOT_BINDING_EMPTY_CONSTRAINT" | "SLOT_BINDING_CREDENTIAL_PROPERTY" | "SLOT_BINDING_PROPERTY_NOT_JSON"

#SlotBindingRecord: {
	contract: "hobo.slot-binding/v1"
	slot:     #CapabilitySlot
	profile:  #CapabilityProfileId
	// A binding must narrow selection by product, by connectivity, or by
	// both; an empty pair is refused at the parse boundary.
	product_id:      string
	connectivity_id: string
	if product_id == "" {
		connectivity_id: !=""
	}
	if connectivity_id == "" {
		product_id: !=""
	}
	// Non-sensitive configuration only, JSON-encoded values under keys sorted
	// by code unit. The credential-key screen
	// (secret|password|token|credential|private[_-]?key|api[_-]?key) is a
	// negative match, which RE2 — and therefore CUE — cannot express; it is
	// enforced at the `slotBinding()` parse boundary, which refuses with
	// SLOT_BINDING_CREDENTIAL_PROPERTY before a record ever reaches this shape.
	properties: [=~"^\\S+$"]: string
}

#SlotBindingRefusalRecord: {
	code:    #SlotBindingErrorCode
	slot:    #CapabilitySlot | ""
	message: string & !=""
}
