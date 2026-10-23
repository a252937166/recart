import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/source-sans-3";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { Atmosphere } from "./components/fx";
import { Page } from "./components/Shell";
import { navigate, ToastHost, useConfig, useFetch, usePath, type Config } from "./lib/core";
import { Demo, DemoIntro } from "./pages/Demo";
import { Developers } from "./pages/Developers";
import { Evidence } from "./pages/Evidence";
import { Home } from "./pages/Home";
import { Merchants } from "./pages/Merchants";
import { Review } from "./pages/Review";

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, true), [to]);
  return null;
}

function NewDemo({ cfg }: { cfg: Config | null }) {
  const { data } = useFetch<{ state: any }>("/api/state");
  return <DemoIntro cfg={cfg} state={data?.state ?? null} />;
}

const TITLES: Record<string, string> = { "/": "ReCart — recover the whole order", "/demo": "Guided demo · ReCart", "/merchants": "For merchants · ReCart", "/developers": "Developers · ReCart", "/evidence": "Evidence · ReCart" };

function App() {
  const path = usePath().split("?")[0]!.replace(/\/$/, "") || "/";
  const cfg = useConfig();
  useEffect(() => { document.title = TITLES[path] ?? (path.startsWith("/review/") ? "Review your order · ReCart" : path.startsWith("/demo") || path.startsWith("/case/") ? TITLES["/demo"]! : "ReCart"); }, [path]);
  const caseMatch = /^\/case\/([0-9a-f-]{36})$/.exec(path);
  const review = /^\/review\/(rvw_[A-Za-z0-9_-]+)$/.exec(path);
  let page: React.ReactNode;
  if (path === "/") page = <Home cfg={cfg} />;
  else if (path === "/demo") page = <Demo cfg={cfg} view="buyer" />;
  else if (path === "/demo/store") page = <Demo cfg={cfg} view="store" />;
  else if (path === "/demo/messages") page = <Demo cfg={cfg} view="messages" />;
  else if (path === "/demo/start" || path === "/judges") page = <NewDemo cfg={cfg} />;
  else if (caseMatch) page = <Demo cfg={cfg} view="buyer" caseId={caseMatch[1]!} />;
  else if (path === "/store") page = <Redirect to="/demo/store" />;
  else if (path === "/inbox") page = <Redirect to="/demo/messages" />;
  else if (review) page = <Review token={review[1]!} />;
  else if (path === "/merchants") page = <Merchants cfg={cfg} />;
  else if (path === "/developers") page = <Developers cfg={cfg} />;
  else if (path === "/evidence") page = <Evidence cfg={cfg} />;
  else page = <Page cfg={cfg}><div className="wrap" style={{ paddingTop: 64 }}><h1>Page not found</h1><p style={{ marginTop: 12 }}>That address does not exist. <a href="/">Go to the home page</a>.</p></div></Page>;
  return <><Atmosphere />{page}<ToastHost /></>;
}

if (typeof IntersectionObserver !== "undefined" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) document.documentElement.classList.add("io");
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
