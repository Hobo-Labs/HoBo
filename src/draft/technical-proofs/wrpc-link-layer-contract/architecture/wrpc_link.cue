package wrpc_link

#Semver: =~#"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"#

#InterfaceId: string & !="" & =~#"^[a-z][a-z0-9-]*:[a-z0-9-]+/[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$"#

#Transport: "in-process" | "lattice"
#BoundaryMode: "live"
#Stability: "stable" | "preview" | "experimental"
#RejectedCode: "version-incompatible"
#RejectedReason: "no-shared-minor" | "shared-minor-below-floor"

#InterfacePin: {
	interface_id: #InterfaceId
	stability:    #Stability
	versions:     [...#Semver]
}

#NegotiatedWire: {
	interface_id: #InterfaceId
	version:      #Semver
	minor:        string & =~#"^[0-9]+\.[0-9]+$"#
	stability:    #Stability
	floor:        #Semver
}

#LinkEstablished: {
	component_id:     string & !=""
	import_interface: #InterfaceId
	provider_id:      string & !=""
	export_interface: #InterfaceId
	transport:        #Transport
	boundary_mode:    #BoundaryMode
	negotiated_wire:  #NegotiatedWire
}

#LinkCalled: {
	component_id:     string & !=""
	import_interface: #InterfaceId
	provider_id:      string & !=""
	export_interface: #InterfaceId
	operation:        string & !=""
	boundary_mode:    #BoundaryMode
	transport:        #Transport
	codec:            string & !=""
	deadline?:        string & =~#"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$"#
}

#LinkRejected: {
	code:         #RejectedCode
	reason:       #RejectedReason
	component_id: string & !=""
	provider_id:  string & !=""
	interface_id: #InterfaceId
	floor:        #Semver
}
