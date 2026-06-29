import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

(function () {
  "use strict";

  const SUPABASE_URL = "https://kpypacgyudnqysgxaqcs.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtweXBhY2d5dWRucXlzZ3hhcWNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMjk0NjAsImV4cCI6MjA5MjcwNTQ2MH0.m-FTFpALNBwk-ns10CmzCvTyHS4VApQsTbdnQZNG_cM";

  const $ = (id) => document.getElementById(id);

  const SLOT_LABELS = {
    cp1: "Checkpoint 1",
    cp2: "Checkpoint 2",
    cp3: "Checkpoint 3",
    finish: "Finish",
  };

  const THEME_LABELS = {
    stadium: "🏟️ Stadium Sprint",
    stadium_sprint: "🏟️ Stadium Sprint",
    snow: "❄️ Snow Drift",
    snow_drift: "❄️ Snow Drift",
    rally: "🌲 Rally Rush",
    rally_rush: "🌲 Rally Rush",
    desert: "🌵 Desert Dash",
    desert_dash: "🌵 Desert Dash",
    night: "🌙 Night Circuit",
    night_circuit: "🌙 Night Circuit",
    weekly: "🏁 Weekly Shorts Rush",
    weekly_shorts_rush: "🏁 Weekly Shorts Rush",
    totd: "🏆 TOTD Run",
    totd_run: "🏆 TOTD Run",
    community: "💬 Community Circuit",
    kacky_chaos: "🧱 Kacky Chaos",
    champion_circuit: "👑 Champion Circuit",
  };

  let tmeSupabase = null;
  let currentUser = null;
  let isRunning = false;
  let lastRunResult = null;
  let threeRun = null;

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function prettyTier(tier) {
    return String(tier || "standard")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function prettyTheme(theme) {
    return THEME_LABELS[theme] || String(theme || "Prize Run")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatDate(value) {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return "";
    }
  }

  function setMsg(text, type = "") {
    const el = $("runMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `run-status-msg ${type}`.trim();
  }

  function initSupabase() {
    if (!window.supabase?.createClient) return null;
    window.__tmeSupabase = window.__tmeSupabase || window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage,
        storageKey: "tme-supabase-auth",
        flowType: "implicit",
      },
    });
    return window.__tmeSupabase;
  }

  function normalizeReward(raw) {
    const reward = raw || {};
    const item = reward.item && typeof reward.item === "object" ? reward.item : null;
    const type = reward.type || reward.kind || (reward.category === "parts" ? "parts" : "item");
    const parts = Number(reward.parts ?? reward.parts_awarded ?? reward.paddock_parts ?? 0);

    if (type === "parts") {
      return {
        slot: reward.slot || "cp1",
        label: reward.label || SLOT_LABELS[reward.slot] || reward.slot || "Checkpoint",
        type: "parts",
        parts,
        title: reward.title || `+${parts.toLocaleString()} Paddock Parts`,
        description: reward.description || "Checkpoint cleared. Parts were added to your Paddock balance.",
        tier: reward.tier || "clean",
      };
    }

    if (type === "no_bonus" || type === "bonus_miss") {
      return {
        slot: reward.slot || "cp2",
        label: reward.label || SLOT_LABELS[reward.slot] || "Checkpoint 2",
        type: "no_bonus",
        title: reward.title || "No bonus item",
        description: reward.description || "You still cleared the checkpoint. The Finish reward is guaranteed.",
        tier: reward.tier || "standard",
      };
    }

    const source = item || reward;
    return {
      slot: reward.slot || "finish",
      label: reward.label || SLOT_LABELS[reward.slot] || reward.slot || "Reward",
      type: type === "bonus_item" ? "bonus_item" : "item",
      id: source.id || reward.id || null,
      item_key: source.item_key || reward.item_key || "",
      icon: source.icon || reward.icon || "🎁",
      name: source.name || reward.name || "Reward",
      description: source.description || reward.description || "Saved to your Paddock collection.",
      category: source.category || reward.category || "reward",
      tier: source.tier || reward.tier || "standard",
      theme: source.theme || reward.theme || "general",
      parts: Number(reward.parts ?? reward.parts_awarded ?? 0),
      was_duplicate: Boolean(reward.was_duplicate),
    };
  }

  function rewardHistoryLabel(raw) {
    const reward = normalizeReward(raw);
    if (reward.type === "parts") return `⚙️ +${reward.parts.toLocaleString()} Parts`;
    if (reward.type === "no_bonus") return "🎲 Bonus missed";
    return `${reward.icon || "🎁"} ${reward.name || "Reward"}`;
  }

  function renderRewardPlaceholders() {
    const placeholders = {
      cp1: ["Paddock Parts", "Checkpoint 1 gives a small parts payout."],
      cp2: ["Bonus Chance", "Checkpoint 2 can hit a bonus item or parts."],
      cp3: ["Paddock Parts", "Checkpoint 3 gives a bigger parts payout."],
      finish: ["Finish Reward", "The Finish line gives the guaranteed cosmetic reward."],
    };
    const grid = $("rewardGrid");
    if (!grid) return;
    grid.innerHTML = ["cp1", "cp2", "cp3", "finish"].map((slot) => `
      <article class="reward-card" id="reward-${slot}">
        <div class="reward-slot">${SLOT_LABELS[slot]}</div>
        <div class="reward-name">${placeholders[slot][0]}</div>
        <div class="reward-desc">${placeholders[slot][1]}</div>
        <span class="tier-chip tier-standard">Waiting</span>
      </article>
    `).join("");
  }

  function updateMiniRoute(slot) {
    const order = ["start", "cp1", "cp2", "cp3", "finish"];
    const index = order.indexOf(slot);
    document.querySelectorAll(".mini-step").forEach((el) => {
      const step = el.getAttribute("data-mini");
      if (order.indexOf(step) <= index) el.classList.add("hit");
      else el.classList.remove("hit");
    });
    const progress = $("miniRouteProgress");
    if (progress) progress.style.width = `${Math.max(0, index) * 21.5}%`;
  }

  function resetRunVisuals() {
    const countdown = $("prizeCountdown");
    if (countdown) {
      countdown.classList.remove("show");
      countdown.textContent = "3";
    }
    updateMiniRoute("start");
    const shareBox = $("shareResultBox");
    if (shareBox) shareBox.classList.remove("show");
    renderRewardPlaceholders();
    if (threeRun) threeRun.reset();
  }

  function revealReward(rawReward) {
    const reward = normalizeReward(rawReward);
    const slot = reward.slot || "cp1";
    const card = $(`reward-${slot}`);
    if (!card) return;
    const duplicate = reward.was_duplicate ? ` <span style="color:rgba(255,255,255,.65)">Duplicate copy</span>` : "";

    if (reward.type === "parts") {
      card.innerHTML = `
        <div class="reward-slot">${escapeHtml(SLOT_LABELS[slot] || slot)} • Parts</div>
        <div class="reward-name">⚙️ +${reward.parts.toLocaleString()} Paddock Parts</div>
        <div class="reward-desc">${escapeHtml(reward.description)}</div>
        <span class="tier-chip tier-clean">Checkpoint Bonus</span>
      `;
      card.classList.add("revealed", "reward-kind-parts");
      return;
    }

    if (reward.type === "no_bonus") {
      card.innerHTML = `
        <div class="reward-slot">${escapeHtml(SLOT_LABELS[slot] || slot)} • Bonus Chance</div>
        <div class="reward-name">🎲 ${escapeHtml(reward.title)}</div>
        <div class="reward-desc">${escapeHtml(reward.description)}</div>
        <span class="tier-chip tier-standard">Checkpoint Clear</span>
      `;
      card.classList.add("revealed");
      return;
    }

    card.innerHTML = `
      <div class="reward-slot">${escapeHtml(SLOT_LABELS[slot] || slot)} • ${escapeHtml(reward.category || "reward")}</div>
      <div class="reward-name">${escapeHtml(reward.icon || "🎁")} ${escapeHtml(reward.name || "Reward")}</div>
      <div class="reward-desc">${escapeHtml(reward.description || "Saved to your Paddock collection.")}${duplicate}</div>
      ${reward.parts > 0 ? `<div class="reward-parts">⚙️ +${reward.parts.toLocaleString()} Paddock Parts</div>` : ""}
      <span class="tier-chip tier-${escapeHtml(reward.tier || "standard")}">${escapeHtml(prettyTier(reward.tier))}</span>
    `;
    card.classList.add("revealed", slot === "finish" ? "reward-kind-finish" : "reward-kind-bonus");
    if (reward.was_duplicate) card.classList.add("duplicate-reward");
  }

  function showCountdown() {
    const el = $("prizeCountdown");
    if (!el) return Promise.resolve();
    el.classList.add("show");
    return (async () => {
      for (const part of ["3", "2", "1", "GO!"]) {
        el.textContent = part;
        await sleep(part === "GO!" ? 520 : 620);
      }
      el.classList.remove("show");
    })();
  }

  function updateStatusCards(status) {
    const freeUsed = Boolean(status?.free_run_used_today);
    const tickets = Number(status?.extra_tickets || 0);
    const canRun = Boolean(status?.can_start_run);
    const parts = Number(status?.paddock_parts || 0);
    const streak = Number(status?.current_streak || 0);
    const best = Number(status?.best_streak || 0);

    if ($("freeRunValue")) $("freeRunValue").textContent = freeUsed ? "Used" : "Ready";
    if ($("ticketValue")) $("ticketValue").textContent = tickets.toLocaleString();
    if ($("canRunValue")) $("canRunValue").textContent = canRun ? "Yes" : "No";
    if ($("partsValue")) $("partsValue").textContent = parts.toLocaleString();
    if ($("streakValue")) $("streakValue").textContent = streak.toLocaleString();
    if ($("bestStreakValue")) $("bestStreakValue").textContent = `Best streak: ${best.toLocaleString()}`;
    if ($("partsHint")) $("partsHint").textContent = `Parts: ${parts.toLocaleString()}`;

    const startBtn = $("startRunBtn");
    if (!startBtn) return;
    startBtn.disabled = !canRun || isRunning;
    if (!canRun && freeUsed && tickets <= 0) startBtn.textContent = "Come Back Tomorrow";
    else if (freeUsed && tickets > 0) startBtn.textContent = "Use Extra Ticket";
    else startBtn.textContent = "Start Daily Run";
  }

  async function loadPrizeStatus() {
    try {
      const { data, error } = await tmeSupabase.rpc("get_my_prize_status_v2");
      if (error) throw error;
      const status = Array.isArray(data) ? data[0] : data;
      updateStatusCards(status || {});
      return status;
    } catch (err) {
      console.warn("Could not load prize status:", err);
      setMsg(err.message || "Could not load Prize Run status.", "error");
      const startBtn = $("startRunBtn");
      if (startBtn) startBtn.disabled = true;
      return null;
    }
  }

  async function loadRecentHistory() {
    const box = $("historyList");
    if (!box) return;
    try {
      let query = tmeSupabase
        .from("prize_run_history")
        .select("id,user_id,run_type,theme,rewards,used_ticket,created_at")
        .order("created_at", { ascending: false })
        .limit(6);
      if (currentUser?.id) query = query.eq("user_id", currentUser.id);
      const { data, error } = await query;
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) {
        box.innerHTML = `<div class="empty-state">No Prize Runs yet. Start your first run above.</div>`;
        return;
      }
      box.innerHTML = rows.map((row) => {
        const rewards = Array.isArray(row.rewards) ? row.rewards : [];
        const names = rewards.map((r) => rewardHistoryLabel(r)).join(" • ");
        return `
          <article class="history-item">
            <div class="history-top">
              <span>${escapeHtml(prettyTheme(row.theme))}</span>
              <span>${escapeHtml(row.used_ticket ? "Ticket" : "Daily")}</span>
            </div>
            <div class="history-meta">${escapeHtml(formatDate(row.created_at))}</div>
            <div class="history-meta">${escapeHtml(names || "Rewards saved")}</div>
          </article>
        `;
      }).join("");
    } catch (err) {
      console.warn("Could not load Prize Run history:", err);
      box.innerHTML = `<div class="empty-state">Could not load run history.</div>`;
    }
  }

  function buildShareText(result) {
    const rewards = Array.isArray(result?.rewards) ? result.rewards : [];
    const lines = [
      "🏁 Prize Run Complete!",
      `Theme: ${prettyTheme(result?.theme)}`,
      "",
      ...rewards.map((raw) => {
        const reward = normalizeReward(raw);
        if (reward.type === "parts") return `${SLOT_LABELS[reward.slot] || reward.slot}: ⚙️ +${reward.parts.toLocaleString()} Paddock Parts`;
        if (reward.type === "no_bonus") return `${SLOT_LABELS[reward.slot] || reward.slot}: 🎲 No bonus item`;
        const dupe = reward.was_duplicate ? ` duplicate (+${Number(reward.parts || 0)} parts)` : "";
        return `${SLOT_LABELS[reward.slot] || reward.slot}: ${reward.icon || "🎁"} ${reward.name || "Reward"} [${prettyTier(reward.tier)}]${dupe}`;
      }),
      "",
      "trackmaniaevents.com/prize-runs",
    ];
    return lines.join("\n");
  }

  function showShareResult(result) {
    const box = $("shareResultBox");
    const text = $("shareResultText");
    if (!box || !text) return;
    text.value = buildShareText(result);
    box.classList.add("show");
  }

  async function animateRun(result) {
    const rewards = Array.isArray(result?.rewards) ? result.rewards : [];
    const theme = result?.theme || "stadium";
    const themeEl = $("themeLabel");
    if (themeEl) themeEl.textContent = prettyTheme(theme);

    resetRunVisuals();
    await showCountdown();

    const order = ["cp1", "cp2", "cp3", "finish"];
    if (!threeRun || !threeRun.ready) {
      for (const slot of order) {
        await sleep(650);
        updateMiniRoute(slot);
        const reward = rewards.find((r) => r.slot === slot);
        if (reward) revealReward(reward);
      }
      return;
    }

    for (const slot of order) {
      setMsg(`Driving to ${SLOT_LABELS[slot] || slot}…`);
      await threeRun.driveTo(slot);
      updateMiniRoute(slot);
      const reward = rewards.find((r) => r.slot === slot);
      if (reward) revealReward(reward);
      if (slot === "finish") setMsg("Finish cleared. Reward saved to your Paddock.", "success");
      await sleep(slot === "finish" ? 760 : 520);
    }
  }

  async function startRun() {
    if (isRunning) return;
    isRunning = true;
    const startBtn = $("startRunBtn");
    if (startBtn) startBtn.disabled = true;
    setMsg("Starting your Prize Run…");
    try {
      const { data, error } = await tmeSupabase.rpc("start_prize_run");
      if (error) throw error;
      setMsg("Run started. Clear the gates!", "success");
      await animateRun(data);
      lastRunResult = data;
      showShareResult(data);
      setMsg("Prize Run complete. Parts and reward saved to your Paddock.", "success");
      await Promise.all([loadPrizeStatus(), loadRecentHistory()]);
    } catch (err) {
      console.warn("Prize Run failed:", err);
      setMsg(err.message || "Could not start Prize Run.", "error");
      await loadPrizeStatus();
    } finally {
      isRunning = false;
    }
  }

  function hasWebGL() {
    try {
      const canvas = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")));
    } catch {
      return false;
    }
  }

  function makeMat(color, emissive = 0x000000, roughness = 0.55, metalness = 0.25) {
    return new THREE.MeshStandardMaterial({
      color,
      emissive,
      roughness,
      metalness,
    });
  }

  function createLabelTexture(text, textColor = "#eaf0ff", accent = "#68f0ff") {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const radius = 26;
    const x = 20;
    const y = 28;
    const w = canvas.width - 40;
    const h = canvas.height - 56;

    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fillStyle = "rgba(7, 10, 18, 0.86)";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = accent;
    ctx.stroke();

    ctx.font = "900 54px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = textColor;
    ctx.fillText(String(text || ""), canvas.width / 2, canvas.height / 2 + 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function createRoadMarking(text, color = "#dffbff") {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 192;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "900 76px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.88;
    ctx.fillText(String(text || ""), canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function createThreeRun() {
    const mount = $("threeMount");
    const stage = $("trackStage");
    if (stage) stage.classList.add("three-loading");
    if (!mount || !stage || !hasWebGL()) {
      if (stage) stage.classList.add("no-webgl");
      return { ready: false, reset() {}, driveTo: async () => {} };
    }

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch (err) {
      console.warn("WebGL renderer failed:", err);
      stage.classList.remove("three-loading");
      stage.classList.remove("three-loading");
      stage.classList.add("no-webgl");
      return { ready: false, reset() {}, driveTo: async () => {} };
    }

    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.innerHTML = "";
    mount.appendChild(renderer.domElement);
    stage.classList.remove("three-loading");
    stage.classList.add("three-ready");

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x05070c, 18, 70);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
    camera.position.set(0, 6.15, 17.2);

    const ambient = new THREE.AmbientLight(0xffffff, 1.05);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.85);
    keyLight.position.set(-5, 8, 8);
    scene.add(keyLight);

    const cyanLight = new THREE.PointLight(0x68f0ff, 2.9, 30);
    cyanLight.position.set(0, 4, 2);
    scene.add(cyanLight);

    const goldLight = new THREE.PointLight(0xf5d98a, 1.65, 24);
    goldLight.position.set(2, 3, -14);
    scene.add(goldLight);

    const roadMat = new THREE.MeshStandardMaterial({ color: 0x182231, roughness: 0.66, metalness: 0.18, emissive: 0x06101a, emissiveIntensity: 0.22 });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(8.8, 43, 1, 1), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, -4);
    scene.add(road);

    const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x0a0f1a, roughness: 0.72, metalness: 0.1 });
    for (const x of [-5.05, 5.05]) {
      const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 43), shoulderMat);
      shoulder.position.set(x, 0.03, -4);
      scene.add(shoulder);
    }

    const lineMat = new THREE.MeshBasicMaterial({ color: 0xd7e7f2, transparent: true, opacity: 0.36 });
    for (let z = 14; z > -23; z -= 3.6) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.035, 1.2), lineMat);
      stripe.position.set(0, 0.075, z);
      scene.add(stripe);
    }

    const edgeBlue = new THREE.MeshBasicMaterial({ color: 0x64d4e8, transparent: true, opacity: 0.62 });
    for (const x of [-4.05, 4.05]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.04, 43), edgeBlue);
      edge.position.set(x, 0.08, -4);
      scene.add(edge);
    }

    const barrierMat = new THREE.MeshStandardMaterial({ color: 0x0c121d, roughness: 0.62, metalness: 0.24, emissive: 0x02060b, emissiveIntensity: 0.18 });
    const barrierTrimMat = new THREE.MeshBasicMaterial({ color: 0x4e90c9, transparent: true, opacity: 0.36 });
    for (const x of [-4.65, 4.65]) {
      const barrier = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.38, 43), barrierMat);
      barrier.position.set(x, 0.27, -4);
      scene.add(barrier);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.045, 43), barrierTrimMat);
      trim.position.set(x * 0.985, 0.56, -4);
      scene.add(trim);
    }

    const panelMat = new THREE.MeshBasicMaterial({ color: 0x68f0ff, transparent: true, opacity: 0.08 });
    for (let z = 10.8; z > -18.5; z -= 5.6) {
      for (const x of [-2.25, 2.25]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.025, 0.9), panelMat);
        panel.position.set(x, 0.095, z);
        scene.add(panel);
      }
    }

    const gatePositions = {
      start: { x: 0, z: 12.4, label: "START", color: 0x8bd9e6 },
      cp1: { x: -0.55, z: 4.6, label: "CP1", color: 0x8bd9e6 },
      cp2: { x: 0.55, z: -3.2, label: "CP2", color: 0x8bd9e6 },
      cp3: { x: -0.25, z: -10.9, label: "CP3", color: 0x8bd9e6 },
      finish: { x: 0, z: -18.2, label: "FINISH", color: 0xf3d46b },
    };

    const gates = {};
    function createGate(slot, data) {
      const group = new THREE.Group();
      const color = data.color;
      const isFinish = slot === "finish";
      const frameMat = new THREE.MeshStandardMaterial({
        color: isFinish ? 0x2a2413 : 0x152231,
        emissive: color,
        emissiveIntensity: isFinish ? 0.18 : 0.12,
        roughness: 0.58,
        metalness: 0.32,
      });
      const trimMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isFinish ? 0.68 : 0.52 });
      const glassMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isFinish ? 0.07 : 0.055, side: THREE.DoubleSide });

      const postGeo = new THREE.BoxGeometry(0.18, 2.25, 0.26);
      const left = new THREE.Mesh(postGeo, frameMat);
      const right = new THREE.Mesh(postGeo, frameMat);
      left.position.set(-2.55, 1.12, 0);
      right.position.set(2.55, 1.12, 0);
      group.add(left, right);

      const top = new THREE.Mesh(new THREE.BoxGeometry(5.25, 0.2, 0.28), frameMat);
      top.position.set(0, 2.28, 0);
      group.add(top);

      const leftFoot = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.55), frameMat);
      const rightFoot = leftFoot.clone();
      leftFoot.position.set(-2.55, 0.07, 0);
      rightFoot.position.set(2.55, 0.07, 0);
      group.add(leftFoot, rightFoot);

      const topGlow = new THREE.Mesh(new THREE.BoxGeometry(4.65, 0.045, 0.055), trimMat);
      topGlow.position.set(0, 2.43, -0.08);
      group.add(topGlow);

      const leftGlow = new THREE.Mesh(new THREE.BoxGeometry(0.045, 1.78, 0.055), trimMat);
      const rightGlow = leftGlow.clone();
      leftGlow.position.set(-2.34, 1.15, -0.08);
      rightGlow.position.set(2.34, 1.15, -0.08);
      group.add(leftGlow, rightGlow);

      const hitPlane = new THREE.Mesh(new THREE.PlaneGeometry(4.55, 1.55), glassMat);
      hitPlane.position.set(0, 1.32, 0.03);
      group.add(hitPlane);

      const signTexture = createLabelTexture(data.label, isFinish ? "#fff4bf" : "#eaf6ff", isFinish ? "rgba(243,212,107,.78)" : "rgba(139,217,230,.62)");
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(isFinish ? 2.35 : 1.55, 0.48),
        new THREE.MeshBasicMaterial({ map: signTexture, transparent: true, side: THREE.DoubleSide })
      );
      sign.position.set(0, 2.82, -0.04);
      group.add(sign);

      if (slot === "start" || slot === "finish") {
        const mark = new THREE.Mesh(
          new THREE.PlaneGeometry(slot === "finish" ? 3.2 : 2.75, 1.05),
          new THREE.MeshBasicMaterial({ map: createRoadMarking(data.label, isFinish ? "#fff1a0" : "#dffbff"), transparent: true, opacity: 0.44, side: THREE.DoubleSide })
        );
        mark.rotation.x = -Math.PI / 2;
        mark.position.set(0, 0.095, isFinish ? -0.9 : 0.95);
        group.add(mark);
      }

      const localLight = new THREE.PointLight(color, isFinish ? 0.85 : 0.55, 6);
      localLight.position.set(0, 2.15, 0.4);
      group.add(localLight);

      group.position.set(data.x, 0, data.z);
      scene.add(group);
      return group;
    }

    Object.entries(gatePositions).forEach(([slot, data]) => {
      gates[slot] = createGate(slot, data);
    });

    function makeWedgeGeometry(width, height, length, frontHeight, rearHeight) {
      const w = width / 2;
      const l = length / 2;
      const verts = new Float32Array([
        -w, 0, -l,   w, 0, -l,   w, 0, l,   -w, 0, l,
        -w, frontHeight, -l,   w, frontHeight, -l,   w, rearHeight, l,   -w, rearHeight, l,
      ]);
      const idx = [
        0, 1, 2, 0, 2, 3,
        4, 7, 6, 4, 6, 5,
        0, 4, 5, 0, 5, 1,
        1, 5, 6, 1, 6, 2,
        2, 6, 7, 2, 7, 3,
        3, 7, 4, 3, 4, 0,
      ];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    }

    function makeCarModel() {
      const carGroup = new THREE.Group();

      const bluePaint = new THREE.MeshStandardMaterial({
        color: 0x105bd8,
        emissive: 0x03102b,
        emissiveIntensity: 0.12,
        roughness: 0.34,
        metalness: 0.58,
      });
      const bluePanel = new THREE.MeshStandardMaterial({
        color: 0x1b7cff,
        emissive: 0x031a40,
        emissiveIntensity: 0.14,
        roughness: 0.32,
        metalness: 0.48,
      });
      const deepBlue = new THREE.MeshStandardMaterial({
        color: 0x083c9b,
        emissive: 0x020917,
        emissiveIntensity: 0.08,
        roughness: 0.42,
        metalness: 0.5,
      });
      const carbon = new THREE.MeshStandardMaterial({
        color: 0x04070d,
        emissive: 0x000104,
        emissiveIntensity: 0.06,
        roughness: 0.7,
        metalness: 0.3,
      });
      const darkPanel = new THREE.MeshStandardMaterial({
        color: 0x0a111d,
        emissive: 0x000307,
        emissiveIntensity: 0.05,
        roughness: 0.52,
        metalness: 0.48,
      });
      const whiteTrim = new THREE.MeshStandardMaterial({
        color: 0xe8eef7,
        emissive: 0x070b13,
        emissiveIntensity: 0.08,
        roughness: 0.28,
        metalness: 0.52,
      });
      const glass = new THREE.MeshPhysicalMaterial({
        color: 0x9ee9ff,
        emissive: 0x062837,
        emissiveIntensity: 0.22,
        roughness: 0.08,
        metalness: 0.02,
        transmission: 0.08,
        transparent: true,
        opacity: 0.78,
        clearcoat: 0.8,
        clearcoatRoughness: 0.12,
      });
      const tire = new THREE.MeshStandardMaterial({ color: 0x010207, roughness: 0.84, metalness: 0.08 });
      const tireSide = new THREE.MeshStandardMaterial({ color: 0x080d14, roughness: 0.72, metalness: 0.12 });
      const rim = new THREE.MeshStandardMaterial({ color: 0xbfc9d8, roughness: 0.24, metalness: 0.8 });
      const brake = new THREE.MeshStandardMaterial({ color: 0x24324c, roughness: 0.44, metalness: 0.55 });
      const lightMat = new THREE.MeshBasicMaterial({ color: 0xa8f7ff, transparent: true, opacity: 0.92 });
      const tailMat = new THREE.MeshBasicMaterial({ color: 0xff3156, transparent: true, opacity: 0.86 });

      const add = (mesh, x, y, z, rx = 0, ry = 0, rz = 0) => {
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx, ry, rz);
        carGroup.add(mesh);
        return mesh;
      };

      // A smoother stadium-style silhouette made from rounded capsules/cones instead of stacked boxes.
      const undertray = add(new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.055, 3.05), carbon), 0, 0.22, 0.02);
      undertray.rotation.x = 0.015;

      const mainShell = new THREE.Mesh(new THREE.CapsuleGeometry(0.44, 1.32, 8, 28), bluePaint);
      mainShell.rotation.x = Math.PI / 2;
      mainShell.scale.set(1.18, 0.42, 0.72);
      add(mainShell, 0, 0.47, 0.12);

      const upperSpine = new THREE.Mesh(new THREE.CapsuleGeometry(0.23, 1.56, 7, 24), deepBlue);
      upperSpine.rotation.x = Math.PI / 2;
      upperSpine.scale.set(0.82, 0.32, 0.6);
      add(upperSpine, 0, 0.66, 0.08);

      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.54, 4, 1, false), bluePanel);
      nose.rotation.x = -Math.PI / 2;
      nose.rotation.y = Math.PI / 4;
      nose.scale.set(0.78, 1, 0.38);
      add(nose, 0, 0.42, -1.28);

      const noseTop = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.028, 1.58), whiteTrim);
      noseTop.rotation.x = -0.045;
      add(noseTop, 0, 0.62, -1.22);

      const noseSideL = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.025, 1.24), whiteTrim);
      const noseSideR = noseSideL.clone();
      noseSideL.rotation.z = 0.07;
      noseSideR.rotation.z = -0.07;
      add(noseSideL, -0.25, 0.545, -1.14);
      add(noseSideR, 0.25, 0.545, -1.14);

      const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.38, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), glass);
      cockpit.scale.set(0.82, 0.9, 1.2);
      add(cockpit, 0, 0.76, -0.18);

      const cockpitRim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.024, 8, 32), carbon);
      cockpitRim.scale.set(0.78, 0.46, 1);
      cockpitRim.rotation.x = Math.PI / 2;
      add(cockpitRim, 0, 0.755, -0.2);

      const haloBar = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.84), carbon);
      add(haloBar, 0, 0.98, -0.26, -0.07, 0, 0);
      const haloCross = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.05, 0.055), carbon);
      add(haloCross, 0, 0.94, -0.1);

      const airbox = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.28, 6, 18), carbon);
      airbox.rotation.x = Math.PI / 2;
      airbox.scale.set(0.9, 0.55, 0.6);
      add(airbox, 0, 1.02, 0.37);

      const engineCover = new THREE.Mesh(new THREE.CapsuleGeometry(0.31, 0.74, 7, 24), bluePaint);
      engineCover.rotation.x = Math.PI / 2;
      engineCover.scale.set(1.12, 0.36, 0.82);
      add(engineCover, 0, 0.53, 1.03);

      const sidepodL = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.94, 6, 20), bluePanel);
      sidepodL.rotation.x = Math.PI / 2;
      sidepodL.rotation.z = 0.04;
      sidepodL.scale.set(1.1, 0.52, 0.74);
      const sidepodR = sidepodL.clone();
      sidepodR.rotation.z = -0.04;
      add(sidepodL, -0.74, 0.42, 0.18);
      add(sidepodR, 0.74, 0.42, 0.18);

      const intakeL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.38), darkPanel);
      const intakeR = intakeL.clone();
      add(intakeL, -0.94, 0.47, -0.11, 0, 0.08, 0);
      add(intakeR, 0.94, 0.47, -0.11, 0, -0.08, 0);

      const frontWing = new THREE.Group();
      const fwMain = new THREE.Mesh(new THREE.BoxGeometry(1.98, 0.055, 0.22), carbon);
      fwMain.position.set(0, 0.22, -2.08);
      const fwTop = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.045, 0.10), whiteTrim);
      fwTop.position.set(0, 0.285, -2.17);
      const fwEndL = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.26, 0.42), carbon);
      const fwEndR = fwEndL.clone();
      fwEndL.position.set(-0.95, 0.31, -2.05);
      fwEndR.position.set(0.95, 0.31, -2.05);
      const fwDiveL = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.032, 0.08), whiteTrim);
      const fwDiveR = fwDiveL.clone();
      fwDiveL.position.set(-0.58, 0.34, -2.0);
      fwDiveR.position.set(0.58, 0.34, -2.0);
      frontWing.add(fwMain, fwTop, fwEndL, fwEndR, fwDiveL, fwDiveR);
      carGroup.add(frontWing);

      const rearWing = new THREE.Group();
      const rearMain = new THREE.Mesh(new THREE.BoxGeometry(2.08, 0.07, 0.34), whiteTrim);
      rearMain.position.set(0, 0.96, 1.74);
      rearMain.rotation.x = -0.08;
      const rearBlade = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.052, 0.18), carbon);
      rearBlade.position.set(0, 0.78, 1.55);
      rearBlade.rotation.x = -0.05;
      const rwLeft = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.54, 0.38), carbon);
      const rwRight = rwLeft.clone();
      rwLeft.position.set(-0.94, 0.81, 1.65);
      rwRight.position.set(0.94, 0.81, 1.65);
      const pylonL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.045), carbon);
      const pylonR = pylonL.clone();
      pylonL.position.set(-0.28, 0.69, 1.52);
      pylonR.position.set(0.28, 0.69, 1.52);
      rearWing.add(rearMain, rearBlade, rwLeft, rwRight, pylonL, pylonR);
      carGroup.add(rearWing);

      const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.09, 0.32), carbon);
      diffuser.rotation.x = -0.14;
      add(diffuser, 0, 0.31, 1.75);

      const headLeft = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.032, 0.055), lightMat);
      const headRight = headLeft.clone();
      add(headLeft, -0.18, 0.46, -1.96);
      add(headRight, 0.18, 0.46, -1.96);

      const tailLeft = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.038, 0.055), tailMat);
      const tailRight = tailLeft.clone();
      add(tailLeft, -0.33, 0.48, 1.72);
      add(tailRight, 0.33, 0.48, 1.72);

      const wheels = [];
      for (const x of [-0.98, 0.98]) {
        for (const z of [-0.86, 0.92]) {
          const wheelGroup = new THREE.Group();
          const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.255, 40), tire);
          wheel.rotation.z = Math.PI / 2;
          wheelGroup.add(wheel);

          const sideWall = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.018, 8, 32), tireSide);
          sideWall.rotation.y = Math.PI / 2;
          wheelGroup.add(sideWall);

          const outerRim = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.272, 32), rim);
          outerRim.rotation.z = Math.PI / 2;
          wheelGroup.add(outerRim);

          const innerDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.092, 0.284, 24), brake);
          innerDisc.rotation.z = Math.PI / 2;
          wheelGroup.add(innerDisc);

          for (let i = 0; i < 8; i++) {
            const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.044, 0.18), rim);
            spoke.rotation.z = Math.PI / 2;
            spoke.rotation.y = (Math.PI / 4) * i;
            wheelGroup.add(spoke);
          }

          wheelGroup.position.set(x, 0.31, z);
          carGroup.add(wheelGroup);
          wheels.push(wheelGroup);
        }
      }

      const suspensionMat = new THREE.MeshStandardMaterial({ color: 0x121925, roughness: 0.5, metalness: 0.62 });
      for (const z of [-0.86, 0.92]) {
        const axle = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.035, 0.04), suspensionMat);
        add(axle, 0, 0.36, z);
      }
      for (const side of [-1, 1]) {
        for (const z of [-0.86, 0.92]) {
          const arm = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.026, 0.035), suspensionMat);
          arm.position.set(side * 0.56, 0.42, z + (z < 0 ? 0.12 : -0.12));
          arm.rotation.y = side * (z < 0 ? -0.18 : 0.18);
          carGroup.add(arm);
        }
      }

      carGroup.userData.wheels = wheels;
      carGroup.scale.set(1.08, 1.08, 1.08);
      return carGroup;
    }

    const car = makeCarModel();
    scene.add(car);

    const path = {
      start: new THREE.Vector3(0, 0, 14.0),
      cp1: new THREE.Vector3(-0.55, 0, 4.6),
      cp2: new THREE.Vector3(0.55, 0, -3.2),
      cp3: new THREE.Vector3(-0.25, 0, -10.9),
      finish: new THREE.Vector3(0, 0, -18.2),
    };

    let currentSlot = "start";
    let targetCamera = new THREE.Vector3(0, 6.15, 17.2);
    let rafId = 0;
    const clock = new THREE.Clock();

    function resize() {
      // The account/auth wrapper can be hidden when this script first boots.
      // If the canvas is sized while hidden, WebGL renders at 1x1 until a resize
      // event happens. DevTools opening triggers that resize, which is why the
      // scene appeared only after pressing F12. Use the visible parent as a
      // fallback and retry after layout settles.
      const mountRect = mount.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const width = Math.max(320, Math.floor(mountRect.width || stageRect.width || mount.clientWidth || stage.clientWidth || 640));
      const height = Math.max(320, Math.floor(mountRect.height || stageRect.height || mount.clientHeight || stage.clientHeight || 440));

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.15 : 1.6));
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    }

    function setCarAt(vec, yaw = 0) {
      // The car model points down the local -Z axis, which is also the route direction.
      // A yaw of 0 means the nose faces forward toward the finish.
      car.position.set(vec.x, 0.14, vec.z);
      car.rotation.y = yaw;
    }

    function reset() {
      currentSlot = "start";
      setCarAt(path.start, 0);
      Object.entries(gates).forEach(([slot, group]) => {
        group.scale.set(1, 1, 1);
        group.traverse((obj) => {
          if (obj.material?.emissive && obj.material.emissive.setHex) {
            const c = slot === "finish" ? 0xf5d98a : 0x68f0ff;
            obj.material.emissive.setHex(c);
            obj.material.emissiveIntensity = 0.35;
          }
        });
      });
      targetCamera = new THREE.Vector3(car.position.x * 0.32, 6.2, car.position.z + 10.8);
      camera.position.copy(targetCamera);
      camera.lookAt(car.position.x * 0.22, 0.58, car.position.z - 5.9);
    }

    function hitGate(slot) {
      const gate = gates[slot];
      if (!gate) return;
      gate.scale.set(1.035, 1.035, 1.035);
      gate.traverse((obj) => {
        if (obj.material?.emissive && obj.material.emissive.setHex) {
          obj.material.emissiveIntensity = 1.25;
        }
      });
      const light = new THREE.PointLight(slot === "finish" ? 0xf3d46b : 0x8bd9e6, 3.2, 10);
      light.position.set(gate.position.x, 2, gate.position.z);
      scene.add(light);
      setTimeout(() => scene.remove(light), 520);
    }

    function driveTo(slot) {
      return new Promise((resolve) => {
        const from = car.position.clone();
        const to = path[slot].clone();
        const duration = slot === "finish" ? 1700 : 1450;
        const start = performance.now();

        function step(now) {
          const raw = Math.min(1, (now - start) / duration);
          const t = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
          const x = from.x + (to.x - from.x) * t;
          const z = from.z + (to.z - from.z) * t;
          const nextT = Math.min(1, t + 0.02);
          const nx = from.x + (to.x - from.x) * nextT;
          const nz = from.z + (to.z - from.z) * nextT;
          const dx = nx - x;
          const dz = nz - z;
          const yaw = Math.atan2(-dx, -dz);
          setCarAt(new THREE.Vector3(x, 0, z), yaw);

          targetCamera.set(x * 0.34, 6.1, z + 10.6);

          if (raw < 1) {
            requestAnimationFrame(step);
          } else {
            currentSlot = slot;
            hitGate(slot);
            resolve();
          }
        }

        requestAnimationFrame(step);
      });
    }

    function render() {
      const elapsed = clock.getElapsedTime();
      Object.values(gates).forEach((gate, index) => {
        gate.position.y = Math.sin(elapsed * 1.1 + index) * 0.012;
      });
      car.position.y = 0.14 + Math.sin(elapsed * 9) * 0.014;
      if (car.userData.wheels) {
        car.userData.wheels.forEach((wheel) => {
          wheel.rotation.x -= 0.18;
        });
      }

      camera.position.lerp(targetCamera, 0.04);
      camera.lookAt(car.position.x * 0.22, 0.58, car.position.z - 5.8);
      cyanLight.position.set(car.position.x, 3.5, car.position.z + 1.5);
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(render);
    }

    window.addEventListener("resize", resize, { passive: true });

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(() => resize());
      observer.observe(stage);
      observer.observe(mount);
    }

    // Extra layout passes for GitHub Pages/mobile/browser cache weirdness.
    // This prevents the blank canvas until DevTools/resize issue.
    requestAnimationFrame(resize);
    setTimeout(resize, 80);
    setTimeout(resize, 250);
    setTimeout(resize, 700);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      } else if (!document.hidden && !rafId) {
        rafId = requestAnimationFrame(render);
      }
    });

    resize();
    reset();
    rafId = requestAnimationFrame(render);

    console.info("Prize Runs 3D scene ready - v16 clean route");
    return { ready: true, reset, driveTo, resize };
  }

  function setupNav() {
    const btn = $("navToggle");
    const nav = $("primary-nav");
    if (!btn || !nav || btn.dataset.tmeBound) return;
    btn.dataset.tmeBound = "1";

    function closeGroups() {
      nav.querySelectorAll(".nav-group.open").forEach((group) => group.classList.remove("open"));
    }

    function setOpen(open) {
      nav.classList.toggle("show", open);
      nav.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open) closeGroups();
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!nav.classList.contains("show") && !nav.classList.contains("open"));
    });

    nav.querySelectorAll(".nav-drop-btn").forEach((dropBtn) => {
      dropBtn.addEventListener("click", (e) => {
        if (window.innerWidth > 900) return;
        e.preventDefault();
        e.stopPropagation();
        const group = dropBtn.closest(".nav-group");
        const wasOpen = group?.classList.contains("open");
        closeGroups();
        if (group) group.classList.toggle("open", !wasOpen);
      });
    });

    nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setOpen(false)));
    document.addEventListener("click", (e) => {
      if (!nav.contains(e.target) && e.target !== btn) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });
    window.addEventListener("resize", () => {
      if (window.innerWidth > 900) setOpen(false);
    });
  }

  function setupAuthDropdown() {
    const wrap = document.querySelector(".auth-user-dropdown");
    const btn = $("authUserBtn");
    const menu = $("authUserMenu");
    if (!wrap || !btn || !menu || btn.dataset.tmeAuthToggleBound) return;
    btn.dataset.tmeAuthToggleBound = "1";

    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      menu.classList.toggle("show");
    });

    document.addEventListener("click", (event) => {
      if (!wrap.contains(event.target)) menu.classList.remove("show");
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") menu.classList.remove("show");
    });
  }

  function fallbackName(user) {
    return user?.user_metadata?.username || user?.user_metadata?.name || user?.email?.split("@")[0] || "Account";
  }

  function setHeaderGuest() {
    if ($("authUserLabel")) $("authUserLabel").textContent = "Login / Register";
    if ($("authMenuUsername")) $("authMenuUsername").textContent = "Guest";
    if ($("authMenuEmail")) $("authMenuEmail").textContent = "";
    if ($("authMenuAccountBtn")) $("authMenuAccountBtn").textContent = "Login / Register";
    if ($("authMenuLogoutBtn")) $("authMenuLogoutBtn").style.display = "none";
  }

  function setHeaderUser(name, email) {
    if ($("authUserLabel")) $("authUserLabel").textContent = name || "Account";
    if ($("authMenuUsername")) $("authMenuUsername").textContent = name || "Account";
    if ($("authMenuEmail")) $("authMenuEmail").textContent = email || "";
    if ($("authMenuAccountBtn")) $("authMenuAccountBtn").textContent = "Account";
    if ($("authMenuLogoutBtn")) $("authMenuLogoutBtn").style.display = "";
  }

  async function syncHeaderAuth(user) {
    if (!tmeSupabase) {
      setHeaderGuest();
      return;
    }

    try {
      if (!user) {
        setHeaderGuest();
        return;
      }

      let displayName = fallbackName(user);
      try {
        const res = await tmeSupabase
          .from("profiles")
          .select("username,email")
          .eq("id", user.id)
          .maybeSingle();
        if (!res.error && res.data?.username) displayName = res.data.username;
      } catch {}

      setHeaderUser(displayName, user.email || "");
    } catch (err) {
      console.warn("Header auth sync failed:", err);
      setHeaderGuest();
    }
  }

  function setupHeaderButtons() {
    const accountBtn = $("authMenuAccountBtn");
    const logoutBtn = $("authMenuLogoutBtn");
    if (accountBtn && !accountBtn.dataset.tmeBound) {
      accountBtn.dataset.tmeBound = "1";
      accountBtn.addEventListener("click", () => {
        const label = $("authUserLabel")?.textContent || "";
        window.location.href = label === "Login / Register" ? "/" : "/account";
      });
    }

    if (logoutBtn && !logoutBtn.dataset.tmeBound) {
      logoutBtn.dataset.tmeBound = "1";
      logoutBtn.addEventListener("click", async () => {
        try {
          if (tmeSupabase?.auth?.signOut) await tmeSupabase.auth.signOut();
        } catch (err) {
          console.warn("Logout failed:", err);
        }
        window.location.href = "/";
      });
    }
  }

  async function bootPrizePage() {
    if ($("year")) $("year").textContent = new Date().getFullYear();
    setupNav();
    setupAuthDropdown();
    setupHeaderButtons();

    const toTop = $("toTop");
    if (toTop) {
      window.addEventListener("scroll", () => toTop.classList.toggle("show", window.scrollY > 500), { passive: true });
      toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    }

    tmeSupabase = initSupabase();
    threeRun = createThreeRun();
    resetRunVisuals();

    if ($("startRunBtn")) $("startRunBtn").addEventListener("click", startRun);
    if ($("refreshStatusBtn")) $("refreshStatusBtn").addEventListener("click", async () => {
      setMsg("Refreshing status…");
      await Promise.all([loadPrizeStatus(), loadRecentHistory()]);
      setMsg("Status refreshed.", "success");
    });
    if ($("copyShareBtn")) $("copyShareBtn").addEventListener("click", async () => {
      const text = $("shareResultText")?.value || (lastRunResult ? buildShareText(lastRunResult) : "");
      try {
        await navigator.clipboard.writeText(text);
        setMsg("Prize Run result copied for Discord.", "success");
      } catch {
        setMsg("Could not copy automatically. Select the share text and copy it manually.", "error");
      }
    });

    if (!tmeSupabase) {
      if ($("lockedWrap")) $("lockedWrap").classList.remove("hidden");
      if ($("authedWrap")) $("authedWrap").classList.add("hidden");
      if ($("lockedMessage")) $("lockedMessage").textContent = "Supabase failed to load. Refresh the page and try again.";
      setHeaderGuest();
      return;
    }

    try {
      const { data } = await tmeSupabase.auth.getSession();
      currentUser = data?.session?.user || null;
      await syncHeaderAuth(currentUser);

      tmeSupabase.auth.onAuthStateChange((_event, session) => {
        currentUser = session?.user || null;
        syncHeaderAuth(currentUser);
      });

      if (!currentUser) {
        if ($("lockedWrap")) $("lockedWrap").classList.remove("hidden");
        if ($("authedWrap")) $("authedWrap").classList.add("hidden");
        return;
      }

      if ($("lockedWrap")) $("lockedWrap").classList.add("hidden");
      if ($("authedWrap")) $("authedWrap").classList.remove("hidden");
      if (threeRun?.resize) {
        requestAnimationFrame(() => threeRun.resize());
        setTimeout(() => threeRun.resize(), 120);
      }
      await Promise.all([loadPrizeStatus(), loadRecentHistory()]);
    } catch (err) {
      console.warn("Prize page failed:", err);
      if ($("lockedWrap")) $("lockedWrap").classList.remove("hidden");
      if ($("lockedMessage")) $("lockedMessage").textContent = err.message || "Prize Runs failed to load.";
      setHeaderGuest();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootPrizePage, { once: true });
  } else {
    bootPrizePage();
  }
})();
