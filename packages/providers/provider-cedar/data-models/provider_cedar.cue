// CUE constraints for every protobuf type in provider_cedar.proto, so the
// architecture guard can confirm the Cedar verdict is bounded at parse time.

package provider_cedar

#CedarDiagnostics: {
	reason: [...string & !=""]
	errors: [...string]
}

#CedarVerdict: {
	decision:    "Allow" | "Deny"
	diagnostics: #CedarDiagnostics
}
