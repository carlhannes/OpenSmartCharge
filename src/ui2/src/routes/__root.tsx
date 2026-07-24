import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { TabBar } from "@/components/shell/TabBar";
import { useOsc } from "@/lib/mock/store";
import { useLiveSync } from "@/lib/live/useLiveSync";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-7xl font-semibold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          That page doesn't exist. Head back home.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Something went sideways
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Charging keeps running — the app just tripped. Try again.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-full border border-input bg-background px-5 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "OpenSmartCharge — smart EV charging you can actually own" },
      {
        name: "description",
        content:
          "Lean, self-hosted smart charging for EVs. Cheap-hour scheduling, house load balancing, and a ready-when-you-leave promise.",
      },
      { name: "author", content: "OpenSmartCharge" },
      { property: "og:title", content: "OpenSmartCharge" },
      {
        property: "og:description",
        content: "Ready when you leave. Charge on cheap hours, self-hosted.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const [mounted, setMounted] = useState(false);
  const source = useOsc((s) => s.source);
  useLiveSync(); // auto-detects the backend: live via REST/SSE, else falls back to the mock tick
  useEffect(() => {
    setMounted(true);
  }, []);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const chromeless = pathname.startsWith("/onboarding");

  if (chromeless) {
    return (
      <QueryClientProvider client={queryClient}>
        <DemoBanner show={mounted && source === "demo"} />
        <div className="min-h-screen bg-background">
          {mounted ? <Outlet /> : <div className="h-screen" aria-hidden />}
        </div>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <DemoBanner show={mounted && source === "demo"} />
      <div className="min-h-screen bg-background md:grid md:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden border-r border-border/60 md:block">
          <div className="sticky top-0 flex h-screen flex-col">
            <div className="px-5 pt-6 pb-4">
              <div className="flex items-center gap-2">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground">
                  <span className="font-display text-lg font-semibold">◐</span>
                </div>
                <div className="leading-tight">
                  <div className="font-display text-sm font-semibold">OpenSmartCharge</div>
                  <div className="text-[11px] text-muted-foreground">v0.3 · self-hosted</div>
                </div>
              </div>
            </div>
            <TabBar />
          </div>
        </aside>
        <main className="pb-28 md:pb-8">
          {mounted ? <Outlet /> : <div className="h-screen" aria-hidden />}
        </main>
        <div className="md:hidden">
          <TabBar />
        </div>
      </div>
    </QueryClientProvider>
  );
}

function DemoBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="bg-status-warn/10 px-4 py-2 text-center text-xs font-medium text-status-warn">
      Demo data — backend not connected. Start the server on :8080 to go live.
    </div>
  );
}
