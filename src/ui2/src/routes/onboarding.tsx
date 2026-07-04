import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/onboarding")({
  head: () => ({ meta: [{ title: "Set up — OpenSmartCharge" }] }),
  component: () => (
    <div className="min-h-screen bg-background">
      <Outlet />
    </div>
  ),
});
