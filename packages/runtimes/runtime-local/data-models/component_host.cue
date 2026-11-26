package component_host

#InterfaceId: string & =~"^[a-z][a-z0-9-]*:[a-z0-9-]+/[a-z0-9-]+@[0-9]+\\.[0-9]+\\.[0-9]+$"

#BoundaryMode: "live" | "mock" | "record" | "replay" | "fork" | "shadow" | "fault"

#LinkTransport: "in-process"

#ComponentDescriptor: {
	id:      string & !=""
	imports: [...#InterfaceId]
	leases?: [...string & !=""]
}

#ProviderDescriptor: {
	id: string & !=""
}

#LinkRecord: {
	component_id:      string & !=""
	import_interface:  #InterfaceId
	provider_id:       string & !=""
	export_interface:  #InterfaceId
	boundary_mode:     #BoundaryMode | *"live"
	transport:         #LinkTransport | *"in-process"
}

#ComponentLoaded: {
	component_id: string & !=""
	engine:       string & !=""
}

#LinkEstablished: {
	component_id:      string & !=""
	import_interface:  #InterfaceId
	provider_id:       string & !=""
	export_interface:  #InterfaceId
	boundary_mode:     #BoundaryMode | *"live"
	transport:         #LinkTransport | *"in-process"
}

#LinkCalled: {
	component_id:      string & !=""
	import_interface:  #InterfaceId
	provider_id:       string & !=""
	export_interface:  #InterfaceId
	operation:         string & !=""
	boundary_mode:     #BoundaryMode | *"live"
	transport:         #LinkTransport | *"in-process"
}

#ComponentInvoked: {
	component_id: string & !=""
	interface:    #InterfaceId
	operation:    string & !=""
}

#ComponentTrapped: {
	component_id: string & !=""
	interface:    #InterfaceId
	message:      string & !=""
}

#ComponentTornDown: {
	component_id: string & !=""
}
