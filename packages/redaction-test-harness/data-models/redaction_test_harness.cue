package redaction_test_harness

#GrowthMeasurement: {
	length:     int & >0
	repeat:     int & >=1
	calibrated: bool
	small_ms:   number & >=0
	large_ms:   number & >=0
	ratio:      number & >=0
}

#SweepOutcome: {
	input:    string & !=""
	ratio?:   number & >=0
	hung_ms?: number & >=0
	growth?:  #GrowthMeasurement
}
