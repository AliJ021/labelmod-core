import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/glass.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("ریشه برنامه پیدا نشد");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
