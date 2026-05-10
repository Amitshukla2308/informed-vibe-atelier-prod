import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design.css";
import "./atelier-components.css";
import "./omnigraph.css";
import App from "./App";

// Set the theme attribute BEFORE React renders so the first paint already
// has omnigraph CSS applied (otherwise the very first frame of /home etc.
// renders with paper-warm leak before App.tsx's useEffect catches up).
{
  const THEME_EPOCH = "2026-04-25-omnigraph";
  const epoch = localStorage.getItem("atelier.theme.epoch");
  let theme = localStorage.getItem("atelier.theme") || "omnigraph";
  if (epoch !== THEME_EPOCH && (!theme || theme === "paper")) {
    theme = "omnigraph";
    localStorage.setItem("atelier.theme", theme);
    localStorage.setItem("atelier.theme.epoch", THEME_EPOCH);
  }
  document.documentElement.setAttribute("data-theme", theme);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="stage-bg" aria-hidden />
    <App />
  </StrictMode>
);
