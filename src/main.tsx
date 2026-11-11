import { ErrorNotice } from "@cadence/screen-ui";
import "@cadence/screen-ui/styles.css";
import { createRoot } from "react-dom/client";
import { channel } from "./bridge/channel";
import { installSandboxFormActions } from "./bridge/sandboxForms";
import MinutesScreen from "./features/minutes/MinutesScreen";
import "./features/minutes/minutes.css";

const outlet =
  document.getElementById("cadence-screen-root") ??
  document.getElementById("root") ??
  document.body.appendChild(Object.assign(document.createElement("div"), { id: "root" }));

const root = createRoot(outlet);
try {
  installSandboxFormActions(document);
  channel.start();
  root.render(<MinutesScreen />);
} catch (e) {
  root.render(
    <ErrorNotice>
      {e instanceof Error ? e.message : "Meeting minutes bridge unavailable"}
    </ErrorNotice>,
  );
}
