import {
  Calendar,
  ChevronDown,
  ChevronUp,
  LayoutDashboard,
  LayoutTemplate,
  Settings,
  Sheet,
  X,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { Link, routes } from "wasp/client/router";
import Logo from "../../client/static/logo.svg";
import { cn } from "../../client/utils";
import { SidebarLinkGroup } from "./SidebarLinkGroup";

interface SidebarProps {
  sidebarOpen: boolean;
  setSidebarOpen: (arg: boolean) => void;
}

export function Sidebar({ sidebarOpen, setSidebarOpen }: SidebarProps) {
  const location = useLocation();
  const { pathname } = location;

  const trigger = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);

  const storedSidebarExpanded = localStorage.getItem("sidebar-expanded");
  const [sidebarExpanded, setSidebarExpanded] = useState(
    storedSidebarExpanded === null ? false : storedSidebarExpanded === "true",
  );

  useEffect(() => {
    const clickHandler = ({ target }: PointerEvent) => {
      if (!sidebar.current || !trigger.current) return;
      const targetNode = target instanceof Node ? target : null;
      if (
        !sidebarOpen ||
        sidebar.current.contains(targetNode) ||
        trigger.current.contains(targetNode)
      )
        return;
      setSidebarOpen(false);
    };
    document.addEventListener("click", clickHandler);
    return () => document.removeEventListener("click", clickHandler);
  });

  useEffect(() => {
    const keyHandler = ({ keyCode }: KeyboardEvent) => {
      if (!sidebarOpen || keyCode !== 27) return;
      setSidebarOpen(false);
    };
    document.addEventListener("keydown", keyHandler);
    return () => document.removeEventListener("keydown", keyHandler);
  });

  useEffect(() => {
    localStorage.setItem("sidebar-expanded", sidebarExpanded.toString());
    if (sidebarExpanded) {
      document.querySelector("body")?.classList.add("sidebar-expanded");
    } else {
      document.querySelector("body")?.classList.remove("sidebar-expanded");
    }
  }, [sidebarExpanded]);

  return (
    <aside
      ref={sidebar}
      className={cn(
        "bg-muted z-9999 w-72.5 absolute left-0 top-0 flex h-screen flex-col overflow-y-hidden border-r duration-300 ease-linear lg:static lg:translate-x-0",
        {
          "translate-x-0": sidebarOpen,
          "-translate-x-full": !sidebarOpen,
        },
      )}
    >
      <div className="py-5.5 lg:py-6.5 flex items-center justify-between gap-2 px-6">
        <Link to={routes.LandingPageRoute.to}>
          <img src={Logo} alt="Logo" width={50} />
        </Link>

        <button
          ref={trigger}
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-controls="sidebar"
          aria-expanded={sidebarOpen}
          className="block lg:hidden"
        >
          <X />
        </button>
      </div>

      <div className="no-scrollbar flex flex-col overflow-y-auto duration-300 ease-linear">
        <nav className="mt-5 px-4 py-4 lg:mt-9 lg:px-6">
          <div>
            <h3 className="text-muted-foreground mb-4 ml-4 text-sm font-semibold">
              MENU
            </h3>

            <ul className="mb-6 flex flex-col gap-1.5">
              <NavLink
                to={routes.AdminRoute.to}
                end
                className={({ isActive }) =>
                  cn(
                    "text-muted-foreground hover:bg-accent hover:text-accent-foreground group relative flex items-center gap-2.5 rounded-sm px-4 py-2 font-medium duration-300 ease-in-out",
                    {
                      "bg-accent text-accent-foreground": isActive,
                    },
                  )
                }
              >
                <LayoutDashboard />
                Dashboard
              </NavLink>

              <li>
                <NavLink
                  to={routes.AdminUsersRoute.to}
                  end
                  className={({ isActive }) =>
                    cn(
                      "text-muted-foreground hover:bg-accent hover:text-accent-foreground group relative flex items-center gap-2.5 rounded-sm px-4 py-2 font-medium duration-300 ease-in-out",
                      {
                        "bg-accent text-accent-foreground": isActive,
                      },
                    )
                  }
                >
                  <Sheet />
                  Users
                </NavLink>
              </li>

              <li>
                <NavLink
                  to={routes.AdminSettingsRoute.to}
                  end
                  className={({ isActive }) =>
                    cn(
                      "text-muted-foreground hover:bg-accent hover:text-accent-foreground group relative flex items-center gap-2.5 rounded-sm px-4 py-2 font-medium duration-300 ease-in-out",
                      {
                        "bg-accent text-accent-foreground": isActive,
                      },
                    )
                  }
                >
                  <Settings />
                  Settings
                </NavLink>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-muted-foreground mb-4 ml-4 text-sm font-semibold">
              Extra Components
            </h3>

            <ul className="mb-6 flex flex-col gap-1.5">
              <li>
                <NavLink
                  to={routes.AdminCalendarRoute.to}
                  end
                  className={({ isActive }) =>
                    cn(
                      "text-muted-foreground hover:bg-accent hover:text-accent-foreground group relative flex items-center gap-2.5 rounded-sm px-4 py-2 font-medium duration-300 ease-in-out",
                      {
                        "bg-accent text-accent-foreground": isActive,
                      },
                    )
                  }
                >
                  <Calendar />
                  Calendar
                </NavLink>
              </li>

              <SidebarLinkGroup
                activeCondition={pathname === "/ui" || pathname.includes("ui")}
              >
                {(handleClick, open) => {
                  return (
                    <React.Fragment>
                      <NavLink
                        to="#"
                        className={cn(
                          "text-muted-foreground hover:bg-accent hover:text-accent-foreground group relative flex items-center gap-2.5 rounded-sm px-4 py-2 font-medium duration-300 ease-in-out",
                          {
                            "bg-accent text-accent-foreground":
                              pathname.includes("ui"),
                          },
                        )}
                        onClick={(e) => {
                          e.preventDefault();
                          if (sidebarExpanded) {
                            handleClick();
                          } else {
                            setSidebarExpanded(true);
                          }
                        }}
                      >
                        <LayoutTemplate />
                        UI Elements
                        {open ? <ChevronUp /> : <ChevronDown />}
                      </NavLink>
                      <div
                        className={cn("translate transform overflow-hidden", {
                          hidden: !open,
                        })}
                      >
                        <ul className="mb-5.5 mt-4 flex flex-col gap-2.5 pl-6">
                          <li>
                            <NavLink
                              to={routes.AdminUIButtonsRoute.to}
                              end
                              className={({ isActive }) =>
                                cn(
                                  "text-muted-foreground hover:text-accent group relative flex items-center gap-2.5 rounded-md px-4 font-medium duration-300 ease-in-out",
                                  { "text-accent!": isActive },
                                )
                              }
                            >
                              Buttons
                            </NavLink>
                          </li>
                        </ul>
                      </div>
                    </React.Fragment>
                  );
                }}
              </SidebarLinkGroup>
            </ul>
          </div>
        </nav>
      </div>
    </aside>
  );
}
