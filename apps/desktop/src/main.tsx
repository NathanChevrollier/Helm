import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { error as logError } from "@tauri-apps/plugin-log";

// Erreurs de l'interface inscrites dans le journal local de Helm, pour pouvoir les diagnostiquer.
window.addEventListener("error", (e) => void logError(`interface : ${e.message} (${e.filename}:${e.lineno})`).catch(() => {}));
window.addEventListener("unhandledrejection", (e) => void logError(`interface : ${String(e.reason)}`).catch(() => {}));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
