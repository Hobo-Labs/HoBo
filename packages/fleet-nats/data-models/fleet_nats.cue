// CUE constraints for every protobuf type in data-models/fleet_nats.proto.
package data_models

import (
	"list"
)

#FleetNatsConfig: {
	servers: [...string & =~"^(tls|wss|nats)://[^\\s]+$"] & list.MinItems(1)
	tenant:   string & =~"^[a-z0-9][a-z0-9-]{0,62}$"
	replicas: 1 | 3
}

// Root definition for fixture vetting.
#FleetNats: #FleetNatsConfig
