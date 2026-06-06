import { createRoot, type Root } from "react-dom/client";

import { App } from "./app";

import "./styles.css";

declare global {
  interface ImportMeta {
    readonly hot?: {
      readonly accept: () => void;
    };
  }

  var malleableCapsuleRoot: Root | undefined;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Capsule root element was not found");
}

const root = globalThis.malleableCapsuleRoot ?? createRoot(rootElement);
globalThis.malleableCapsuleRoot = root;

if (import.meta.hot) {
  import.meta.hot.accept();
}

root.render(<App />);
