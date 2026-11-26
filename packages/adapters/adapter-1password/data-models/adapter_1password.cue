package adapter_1password

// Constraints for @hobo/adapter-1password's records. Field names are the
// protobuf JSON names. Closed: a record cannot carry a token or a value.

#Id: string & =~"^[a-z0-9]{26}$"

#OnePasswordBinding: close({
	vaultId:  #Id
	authMode: "service-account" | "desktop-app"
	accountName?: string & =~"^[^\\n]{1,100}$"
	if authMode == "desktop-app" {accountName: string}
})

#OnePasswordSecretRef: close({
	vaultId: #Id
	itemId:  #Id
	fieldId: "password"
})

// The flat fixture corpus holds bindings.
#Adapter1password: #OnePasswordBinding
