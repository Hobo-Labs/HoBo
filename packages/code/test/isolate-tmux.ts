// Every test file runs against a tmux server of its own, and the shell seats
// no agent CLIs in it. A test that started the shell on a TTY, or ran `mux`,
// reached the developer's own tmux server (the `hobo` session) and started the
// agents it found on PATH there, their real `claude` among them, where they
// outlived the run.
import { afterAll } from "vitest";
import { isolateTmux } from "./tmux-isolation.js";

const tmux = isolateTmux();
afterAll(() => tmux.end());
