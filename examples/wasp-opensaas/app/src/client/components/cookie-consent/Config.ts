import type { CookieConsentConfig } from "vanilla-cookieconsent";
import { legalLinks } from "./legalLinks";

declare global {
  interface Window {
    dataLayer: unknown[];
  }
}

export const getConfig = () => {
  const config: CookieConsentConfig = {
    root: "body",
    autoShow: true,
    disablePageInteraction: false,
    hideFromBots: import.meta.env.PROD,
    mode: "opt-in",
    revision: 0,

    cookie: {
      name: "cc_cookie",
      domain: location.hostname,
      path: "/",
      sameSite: "Lax",
      expiresAfterDays: 365,
    },

    guiOptions: {
      consentModal: {
        layout: "box",
        position: "bottom right",
        equalWeightButtons: true,
        flipButtons: false,
      },
    },

    categories: {
      necessary: {
        enabled: true,
        readOnly: true,
      },
      analytics: {
        autoClear: {
          cookies: [
            {
              name: /^_ga/,
            },
            {
              name: "_gid",
            },
          ],
        },

        services: {
          ga: {
            label: "Google Analytics",
            onAccept: () => {
              try {
                const GA_ANALYTICS_ID = import.meta.env
                  .REACT_APP_GOOGLE_ANALYTICS_ID;
                if (!GA_ANALYTICS_ID.length) {
                  throw new Error("Google Analytics ID is missing");
                }
                window.dataLayer = window.dataLayer || [];
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                function gtag(..._args: unknown[]) {
                  // eslint-disable-next-line prefer-rest-params
                  window.dataLayer.push(arguments);
                }
                gtag("js", new Date());
                gtag("config", GA_ANALYTICS_ID);

                const script = document.createElement("script");
                script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ANALYTICS_ID}`;
                script.async = true;
                document.body.appendChild(script);
              } catch (error) {
                console.error(error);
              }
            },
            onReject: () => {},
          },
        },
      },
    },

    language: {
      default: "en",
      translations: {
        en: {
          consentModal: {
            title: "We use cookies",
            description:
              "We use cookies primarily for analytics to enhance your experience. By accepting, you agree to our use of these cookies. You can manage your preferences at any time.",
            acceptAllBtn: "Accept all",
            acceptNecessaryBtn: "Reject all",
            footer: legalLinks(
              import.meta.env.REACT_APP_PRIVACY_POLICY_URL,
              import.meta.env.REACT_APP_TERMS_URL,
              location.origin,
            ),
          },
          preferencesModal: {
            sections: [],
          },
        },
      },
    },
  };

  return config;
};
