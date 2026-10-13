import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import "highlight.js/styles/github-dark.css";
import "./index.css";
import { AgentPage } from "./pages/AgentPage.tsx";
import { AgentsTab } from "./pages/AgentsTab.tsx";
import { CodeTab } from "./pages/CodeTab.tsx";
import { CommitPage } from "./pages/CommitPage.tsx";
import { CommitsTab } from "./pages/CommitsTab.tsx";
import { Home } from "./pages/Home.tsx";
import { IntentsTab } from "./pages/IntentsTab.tsx";
import { NewRepo } from "./pages/NewRepo.tsx";
import { RepoLayout } from "./pages/RepoLayout.tsx";
import { SettingsTab } from "./pages/SettingsTab.tsx";
import { NotFound, RouteError, Shell } from "./pages/Shell.tsx";
import { UserPage } from "./pages/UserPage.tsx";
import { SessionProvider } from "./session.tsx";

const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Home /> },
      { path: "new", element: <NewRepo /> },
      { path: ":owner", element: <UserPage /> },
      {
        path: ":owner/:name",
        element: <RepoLayout />,
        children: [
          { index: true, element: <CodeTab /> },
          { path: "commits", element: <CommitsTab /> },
          { path: "commit/:sha", element: <CommitPage /> },
          { path: "agents", element: <AgentsTab /> },
          { path: "agents/:agentId", element: <AgentPage /> },
          { path: "intents", element: <IntentsTab /> },
          { path: "settings", element: <SettingsTab /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
