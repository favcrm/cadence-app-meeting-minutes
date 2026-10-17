/**
 * `app-screens/v2` entry for the packaged Meeting minutes screen.
 *
 * Bundled as one self-contained IIFE (`client.js`) and mounted into the
 * `#root` element the host's frame document provides. The host has already
 * injected its kit stylesheet and tokens; this bundle adds only its own.
 *
 * This entry never fetches, never evaluates remote code, never touches
 * cookies or credentials, and never writes: every action a person might
 * expect here (recording, starting a run) belongs to the host.
 */
import { createRoot } from "react-dom/client";
import "./style.css";
import Minutes from "./Minutes.jsx";
import { createHostData } from "./host-data.mjs";
import { channelDebug, createReceiver } from "./receiver.mjs";

// Honour the host theme pick the way the board does.
try {
  const theme = window.localStorage.getItem("cadence-theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  }
} catch {
  /* storage unavailable → the system preference applies */
}

const hostData = createHostData();

function mount(target = document.getElementById("root")) {
  if (!target) throw new Error("the frame has no #root element");
  const root = createRoot(target);
  root.render(<Minutes hostData={hostData} />);
  return root;
}

mount();

// The bridge attaches the host's projection to the same store the UI reads.
try {
  const receiver = createReceiver((projection) => hostData.attach(projection));
  window.__MEETING_MINUTES__ = {
    attach: (projection) => hostData.attach(projection),
    read: () => hostData.read(),
    generation: receiver.boot.generation,
    debug: () => ({ ...channelDebug }),
  };
} catch (error) {
  // No bridge (a local `index.html` verification page): the screen shows its
  // honest waiting state instead of inventing data.
  if (typeof console !== "undefined") console.warn("screen bridge unavailable:", error && error.message);
}
