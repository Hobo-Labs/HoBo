import { useEffect } from "react";
import { installPlausibleAnalytics } from "./plausibleAnalytics";

export function PlausibleAnalytics() {
  useEffect(() => {
    installPlausibleAnalytics(
      document,
      import.meta.env.REACT_APP_PLAUSIBLE_DOMAIN,
      import.meta.env.PROD,
    );
  }, []);
  return null;
}
