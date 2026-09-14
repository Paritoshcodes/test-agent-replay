import { useEffect, useState } from "react";

/**
 * Three routes total (/, /commit/:sha, /run/:runId) -- hand-rolled on the History API rather than adding
 * react-router-dom as a dependency for something this small. Not a general-purpose router: no nested
 * routes, no data loaders, just enough to read window.location and re-render on navigation.
 */

export type Route = { name: "home" } | { name: "commit"; sha: string } | { name: "run"; runId: string };

function parse(pathname: string): Route {
  const commitMatch = pathname.match(/^\/commit\/([^/]+)\/?$/);
  if (commitMatch) return { name: "commit", sha: decodeURIComponent(commitMatch[1]) };
  const runMatch = pathname.match(/^\/run\/([^/]+)\/?$/);
  if (runMatch) return { name: "run", runId: decodeURIComponent(runMatch[1]) };
  return { name: "home" };
}

export function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState<Route>(() => parse(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parse(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState(null, "", path);
    setRoute(parse(path));
  };

  return [route, navigate];
}

export function Link({ to, children, className, onNavigate }: { to: string; children: React.ReactNode; className?: string; onNavigate: (path: string) => void }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let the browser handle open-in-new-tab etc.
        e.preventDefault();
        onNavigate(to);
      }}
    >
      {children}
    </a>
  );
}
