(function injectMentionToastStyles() {
  if (document.getElementById("mention-toast-styles")) return;

  const style = document.createElement("style");
  style.id = "mention-toast-styles";

  style.textContent = `
    .mention-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      max-width: 280px;
      padding: .7rem .9rem;
      border-radius: 14px;
      border: 1px solid rgba(109,251,255,.18);
      background: rgba(16,25,42,.96);
      color: #dff7ff;
      font-size: .9rem;
      font-weight: 850;
      box-shadow: 0 16px 36px rgba(0,0,0,.24);
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
      transition: all .2s ease;
      z-index: 99999;
      cursor: pointer;
    }

    .mention-toast.show {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }

    .mention-toast:hover {
      background: #16233a;
    }
  `;

  document.head.appendChild(style);
})();

(function ensureToastExists() {
  if (!document.getElementById("globalMentionToast")) {
    const div = document.createElement("div");
    div.id = "globalMentionToast";
    div.className = "mention-toast";
    document.body.appendChild(div);
  }
})();

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
