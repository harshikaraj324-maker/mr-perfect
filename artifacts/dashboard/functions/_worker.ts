/// <reference types="@cloudflare/workers-types" />

const RAILWAY_API = "https://api-server-production-193e.up.railway.app";

type Env = {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      const target = new URL(url.pathname + url.search, RAILWAY_API);
      const proxyReq = new Request(target.toString(), {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      });
      const res = await fetch(proxyReq);
      const newHeaders = new Headers(res.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      newHeaders.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
      return new Response(res.body, { status: res.status, headers: newHeaders });
    }

    return env.ASSETS.fetch(request);
  },
};
