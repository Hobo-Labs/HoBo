// CUE constraints for every protobuf type in data-models/fleet_p2p.proto.
package data_models

#FleetP2pConfig: {
	// https://, or plain http:// on a loopback address (a development relay).
	relayUrls: [...string & (=~"^https://[^\\s@]+$" | =~"^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?(/[^\\s]*)?$")]
}

// Root definition for fixture vetting.
#FleetP2p: #FleetP2pConfig
