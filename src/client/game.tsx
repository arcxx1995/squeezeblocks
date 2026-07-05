import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OnlineGame } from "./OnlineGame";
import "./game.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root not found");

createRoot(container).render(
  <StrictMode>
    <OnlineGame />
  </StrictMode>,
);
