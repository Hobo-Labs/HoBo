
package provider_cedar

#CedarDiagnostics: {
	reason: [...string & !=""]
	errors: [...string]
}

#CedarVerdict: {
	decision:    "Allow" | "Deny"
	diagnostics: #CedarDiagnostics
}
