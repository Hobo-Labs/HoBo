// CUE constraints for every protobuf type in data-models/fleet_p2p.proto.
package data_models

#FleetP2pConfig: {
	relayUrls: [...string & =~"^https://[^\\s]+$"]
}

// Root definition for fixture vetting.
#FleetP2p: #FleetP2pConfig
