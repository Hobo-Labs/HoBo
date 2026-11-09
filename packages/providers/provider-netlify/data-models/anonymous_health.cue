package provider_netlify

#NetlifyAnonymousHealthObservationRecord: {
 httpStatus: int & >=100 & <=599
 markerObserved: bool
 passwordGateObserved: bool
 if markerObserved { httpStatus: 200 }
}
