import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function htmlRedirect(url: string) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
    },
  });
}

function errorRedirect(message: string) {
  const siteUrl = Deno.env.get("SITE_URL") || "https://trackmaniaevents.com";
  const url = new URL(`${siteUrl}/account`);
  url.searchParams.set("tm_oauth", "error");
  url.searchParams.set("message", message.slice(0, 180));
  return htmlRedirect(url.toString());
}

async function getDisplayName(accessToken: string, accountId: string) {
  try {
    const url = new URL("https://api.trackmania.com/api/display-names");
    url.searchParams.append("accountId[]", accountId);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) return "";

    const data = await res.json();

    if (Array.isArray(data)) {
      const found = data.find((row) => row?.accountId === accountId);
      return found?.displayName || "";
    }

    if (data && typeof data === "object") {
      return data[accountId] || data.displayName || "";
    }

    return "";
  } catch {
    return "";
  }
}

serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const TRACKMANIA_CLIENT_ID = Deno.env.get("TRACKMANIA_CLIENT_ID")!;
    const TRACKMANIA_CLIENT_SECRET = Deno.env.get("TRACKMANIA_CLIENT_SECRET")!;
    const TRACKMANIA_REDIRECT_URI = Deno.env.get("TRACKMANIA_REDIRECT_URI")!;
    const SITE_URL = Deno.env.get("SITE_URL") || "https://trackmaniaevents.com";

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return errorRedirect("Missing OAuth code or state.");
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: stateRow, error: stateError } = await supabaseAdmin
      .from("trackmania_oauth_states")
      .select("state,user_id,expires_at")
      .eq("state", state)
      .maybeSingle();

    if (stateError || !stateRow) {
      return errorRedirect("OAuth state was not found.");
    }

    if (new Date(stateRow.expires_at).getTime() < Date.now()) {
      await supabaseAdmin
        .from("trackmania_oauth_states")
        .delete()
        .eq("state", state);

      return errorRedirect("OAuth state expired. Try again.");
    }

    await supabaseAdmin
      .from("trackmania_oauth_states")
      .delete()
      .eq("state", state);

    const tokenBody = new URLSearchParams();
    tokenBody.set("grant_type", "authorization_code");
    tokenBody.set("client_id", TRACKMANIA_CLIENT_ID);
    tokenBody.set("client_secret", TRACKMANIA_CLIENT_SECRET);
    tokenBody.set("code", code);
    tokenBody.set("redirect_uri", TRACKMANIA_REDIRECT_URI);

    const tokenRes = await fetch("https://api.trackmania.com/api/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody,
    });

    const tokenJson = await tokenRes.json().catch(() => null);

    if (!tokenRes.ok || !tokenJson?.access_token) {
      console.error("Trackmania token exchange failed", tokenRes.status, tokenJson);
      return errorRedirect("Trackmania token exchange failed.");
    }

    const accessToken = tokenJson.access_token;

    const userRes = await fetch("https://api.trackmania.com/api/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const tmUser = await userRes.json().catch(() => null);

    if (!userRes.ok || !tmUser) {
      console.error("Trackmania user fetch failed", userRes.status, tmUser);
      return errorRedirect("Could not fetch Trackmania user.");
    }

    const accountId =
      tmUser.accountId ||
      tmUser.account_id ||
      tmUser.id ||
      tmUser.sub ||
      "";

    if (!accountId) {
      console.error("No account id in Trackmania user response", tmUser);
      return errorRedirect("Trackmania user response did not include an account ID.");
    }

    const displayName =
      tmUser.displayName ||
      tmUser.display_name ||
      tmUser.name ||
      tmUser.login ||
      (await getDisplayName(accessToken, accountId)) ||
      "";

    const { error: updateError } = await supabaseAdmin
      .from("profiles")
      .upsert(
        {
          id: stateRow.user_id,
          trackmania_account_id: accountId,
          trackmania_display_name: displayName || null,
          trackmania_verified: true,
          trackmania_linked_at: new Date().toISOString(),
          trackmania_auth_provider: "oauth",
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "id",
        }
      );

    if (updateError) {
      console.error("Profile update failed", updateError);
      return errorRedirect(updateError.message || "Could not update profile.");
    }

    const successUrl = new URL(`${SITE_URL}/account`);
    successUrl.searchParams.set("tm_oauth", "success");

    return htmlRedirect(successUrl.toString());
  } catch (err) {
    console.error("OAuth callback failed", err);
    return errorRedirect(err?.message || "OAuth callback failed.");
  }
});
