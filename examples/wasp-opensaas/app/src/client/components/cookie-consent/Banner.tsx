import { useEffect } from "react";
import * as CookieConsent from "vanilla-cookieconsent";
import "vanilla-cookieconsent/dist/cookieconsent.css";
import { getConfig } from "./Config";

export function CookieConsentBanner() {
  useEffect(() => {
    CookieConsent.run(getConfig());
  }, []);

  return <div id="cookieconsent"></div>;
}
