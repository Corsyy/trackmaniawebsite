import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://trackmaniaevents.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function randomState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const TRACKMANIA_CLIENT_ID = Deno.env.get("TRACKMANIA_CLIENT_ID")!;
    const TRACKMANIA_REDIRECT_URI = Deno.env.get("TRACKMANIA_REDIRECT_URI")!;
    const SITE_URL = Deno.env.get("SITE_URL") || "https://trackmaniaevents.com";

    const authHeader = req.headers.get("Authorization") || "";

    const supabaseUserClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const {
      data: { user },
      error: userError,
    } = await supabaseUserClient.auth.getUser();

    if (userError || !user) {
      return json({ error: "You must be logged in first." }, 401);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const state = randomState();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: insertError } = await supabaseAdmin
      .from("trackmania_oauth_states")
      .insert({
        state,
        user_id: user.id,
        expires_at: expiresAt,
      });

    if (insertError) {
      return json({ error: insertError.message }, 500);
    }

    const authorizeUrl = new URL("https://api.trackmania.com/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", TRACKMANIA_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", TRACKMANIA_REDIRECT_URI);
    authorizeUrl.searchParams.set("state", state);

    return json({
      ok: true,
      authorizeUrl: authorizeUrl.toString(),
      returnTo: `${SITE_URL}/account`,
    });
  } catch (err) {
    return json({ error: err?.message || "OAuth start failed." }, 500);
  }
});
