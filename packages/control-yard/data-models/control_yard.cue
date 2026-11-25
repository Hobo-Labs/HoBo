package control_yard

// CUE constraints for every protobuf message in control_yard.proto.

#YardZoneRef: {
	zone_id:  string
	anchor_x: number
	anchor_y: number
}

#BoVisualState: {
	state:         "idle" | "walking" | "occupying" | "resolving" | "error"
	animation_id:  string & =~"^bo\\."
	zone_id:       string
	facing:        "east" | "west"
}

#CostMeterVisual: {
	fill:          number & >=0 & <=1
	heat:          number & >=0 & <=1
	quota_used:    number & >=0
	quota_limit:   number & >=0
	spend_cap_usd: number & >=0
}

#TrafficVisual: {
	rate:   number & >=0 & <=1
	active: bool
}

#GenerativeSheetRef: {
	kind:       string
	title:      string
	confirm_op: string
}
