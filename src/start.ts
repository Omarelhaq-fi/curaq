import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
// NOTE: Supabase middleware removed — this app authenticates with Firebase
// (see verifyFirebaseIdToken). The Lovable Supabase boilerplate import
// ("@/integrations/supabase/auth-attacher") doesn't resolve (@/* maps to
// src/*) and broke SSR with a 500 on every page. Supabase env vars aren't
// configured either, so the middleware could never run.

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware],
}));
