import { createFileRoute } from "@tanstack/react-router";

const proxy = async ({ request }: { request: Request }) => {
  const { proxyRequest } = await import("@/lib/proxy.server");
  return proxyRequest(request);
};

export const Route = createFileRoute("/$")({
  server: {
    handlers: {
      GET: proxy,
      POST: proxy,
      PUT: proxy,
      PATCH: proxy,
      DELETE: proxy,
      HEAD: proxy,
      OPTIONS: proxy,
    },
  },
});
