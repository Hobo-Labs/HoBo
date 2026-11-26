package adapter_bitwarden

// Constraints for @hobo/adapter-bitwarden's records. Field names are the
// protobuf JSON names. Closed: a record cannot carry a token or a value.

#Uuid: string & =~"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

#BitwardenBinding: close({
	organizationId: #Uuid
	projectId:      #Uuid
	apiUrl?:        string & =~"^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$"
})

#BitwardenSecretRef: close({
	organizationId: #Uuid
	projectId:      #Uuid
	secretId:       #Uuid
})

// The flat fixture corpus holds bindings.
#AdapterBitwarden: #BitwardenBinding
