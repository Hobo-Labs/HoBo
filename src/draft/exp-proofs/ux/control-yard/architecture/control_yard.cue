package control_yard_exp

// CUE constraints for every protobuf message in control_yard_exp.proto.

#ControlYardAcceptanceRecord: {
	proof:                 "control-yard"
	adr:                   "ADR-0135"
	zones: [...string]
	packages: [...string]
	no_second_lifecycle:   true
	bo_west_is_not_mirror: true
}
