import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { StoreProvider } from "./store"
import "./styles.css"

const root = document.querySelector("#root")
if (root === null) throw new Error("AgentChat root element is missing")

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
)
