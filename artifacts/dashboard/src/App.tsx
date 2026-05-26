import { Switch, Route, Router as WouterRouter } from "wouter";
import MainAdminPanel from "@/pages/MainAdminPanel";
import WebDashboard from "@/pages/WebDashboard";
import { TopProgressBar } from "@/components/ui/top-progress";

function NotFound() {
  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", color: "#f1f5f9", fontFamily: "system-ui" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 48, fontWeight: 900, color: "#6366f1" }}>404</div>
        <div style={{ fontSize: 14, color: "#94a3b8", marginTop: 8 }}>Page not found</div>
      </div>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/preview/dashboard/MainAdminPanel" component={MainAdminPanel} />
      <Route path="/preview/dashboard/WebDashboard" component={WebDashboard} />
      <Route path="/" component={MainAdminPanel} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <TopProgressBar />
      <Router />
    </WouterRouter>
  );
}

export default App;
