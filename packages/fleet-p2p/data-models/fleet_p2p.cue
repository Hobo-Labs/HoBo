package data_models

#FleetP2pConfig: {
	relayUrls: [...string & (=~"^https://[^\\s@]+$" | =~"^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?(/[^\\s]*)?$")]
}

#FleetP2p: #FleetP2pConfig
