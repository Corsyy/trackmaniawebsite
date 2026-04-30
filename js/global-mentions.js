// ===== GLOBAL MENTION LISTENER =====

// prevent duplicate notifications
let lastGlobalMentionId = "";

// fallback getCurrentUser (in case page doesn't have it)
async function getCurrentUserSafe() {
  try {
    if (!window.tmeSupabase) return null;
    const { data } = await window.tmeSupabase.auth.getUser();
    return data?.user || null;
  } catch {
    return null;
  }
}

function showGlobalMentionToast(fromUser) {
  const toast = document.getElementById("globalMentionToast");
  if (!toast) return;

  toast.textContent = `${fromUser || "Someone"} mentioned you in the shoutbox`;

  toast.classList.add("show");

  toast.onclick = () => {
    window.location.href = "/#shoutbox-section";
  };

  setTimeout(() => {
    toast.classList.remove("show");
  }, 6000);
}

function startGlobalMentionListener() {
  if (!window.tmeSupabase) {
    console.warn("Global mentions: Supabase not initialized.");
    return;
  }

  const channel = window.tmeSupabase
    .channel("global-mentions")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "shoutbox_messages" },
      async (payload) => {
        const msg = payload.new;
        if (!msg?.message) return;

        const user = await getCurrentUserSafe();
        if (!user) return;

        const username =
          user.user_metadata?.username ||
          user.email?.split("@")[0] ||
          "";

        if (!username) return;

        const lowerMsg = msg.message.toLowerCase();
        const lowerUser = username.toLowerCase();

        // check mention
        if (!lowerMsg.includes(`@${lowerUser}`)) return;

        // prevent duplicate popups
        if (msg.id === lastGlobalMentionId) return;
        lastGlobalMentionId = msg.id;

        showGlobalMentionToast(msg.username);
      }
    )
    .subscribe((status) => {
      console.log("Global mention listener:", status);
    });
}

// auto start when page loads
window.addEventListener("load", () => {
  startGlobalMentionListener();
});
