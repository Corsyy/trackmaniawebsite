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
      const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 56), shoulderMat);
      shoulder.position.set(x, 0.03, -6);
      scene.add(shoulder);
    }

    const lineMat = new THREE.MeshBasicMaterial({ color: 0xd7e7f2, transparent: true, opacity: 0.36 });
    for (let z = 16; z > -31; z -= 3.8) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.035, 1.2), lineMat);
      stripe.position.set(0, 0.075, z);
      scene.add(stripe);
    }

    const edgeBlue = new THREE.MeshBasicMaterial({ color: 0x64d4e8, transparent: true, opacity: 0.62 });
    for (const x of [-4.05, 4.05]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.04, 56), edgeBlue);
      edge.position.set(x, 0.08, -6);
      scene.add(edge);
    }

    const barrierMat = new THREE.MeshStandardMaterial({ color: 0x0c121d, roughness: 0.62, metalness: 0.24, emissive: 0x02060b, emissiveIntensity: 0.18 });
    const barrierTrimMat = new THREE.MeshBasicMaterial({ color: 0x4e90c9, transparent: true, opacity: 0.36 });
    for (const x of [-4.65, 4.65]) {
      const barrier = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.38, 56), barrierMat);
      barrier.position.set(x, 0.27, -6);
      scene.add(barrier);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.045, 56), barrierTrimMat);
      trim.position.set(x * 0.985, 0.56, -6);
      scene.add(trim);
    }

    const panelMat = new THREE.MeshBasicMaterial({ color: 0x68f0ff, transparent: true, opacity: 0.08 });
    for (let z = 10.8; z > -27; z -= 7.2) {
      for (const x of [-2.25, 2.25]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.025, 0.9), panelMat);
        panel.position.set(x, 0.095, z);
        scene.add(panel);
      }
    }

    const gatePositions = {
      start: { x: 0, z: 13.8, label: "GO", color: 0xf3d46b, kind: "start" },
      cp1: { x: 0, z: 4.0, label: "CP1", color: 0x28a7ff, kind: "checkpoint" },
      cp2: { x: 0, z: -5.8, label: "CP2", color: 0x28a7ff, kind: "checkpoint" },
      cp3: { x: 0, z: -15.6, label: "CP3", color: 0x28a7ff, kind: "checkpoint" },
      finish: { x: 0, z: -25.4, label: "FINISH", color: 0xff3b35, kind: "finish" },
    };

    const gates = {};
    function makeArcTube(width, height, depth, material, segments = 38) {
      const half = width / 2;
      const pts = [];
      for (let i = 0; i <= segments; i++) {
        const t = Math.PI - (Math.PI * i) / segments;
        const x = Math.cos(t) * half;
        const y = 0.25 + Math.sin(t) * height;
        pts.push(new THREE.Vector3(x, y, -depth / 2));
      }
      const frontCurve = new THREE.CatmullRomCurve3(pts);
      const backPts = pts.map((p) => new THREE.Vector3(p.x, p.y, depth / 2));
      const backCurve = new THREE.CatmullRomCurve3(backPts);
      const front = new THREE.Mesh(new THREE.TubeGeometry(frontCurve, segments, 0.075, 10, false), material);
      const back = new THREE.Mesh(new THREE.TubeGeometry(backCurve, segments, 0.075, 10, false), material);
      return { front, back };
    }

    function createGate(slot, data) {
      const group = new THREE.Group();
      const color = data.color;
      const isStart = slot === "start";
      const isFinish = slot === "finish";
      const width = 5.95;
      const archHeight = isFinish ? 2.58 : 2.45;
      const depth = 0.55;

      const archMat = new THREE.MeshStandardMaterial({
        color: isStart ? 0x2d2610 : isFinish ? 0x301212 : 0x102337,
        emissive: color,
        emissiveIntensity: isStart ? 0.18 : isFinish ? 0.2 : 0.14,
        roughness: 0.48,
        metalness: 0.38,
      });
      const faceMat = new THREE.MeshStandardMaterial({
        color: isStart ? 0xe3bb38 : isFinish ? 0xdd2e2e : 0x2196d8,
        emissive: color,
        emissiveIntensity: 0.24,
        roughness: 0.42,
        metalness: 0.32,
      });
      const trimMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isFinish ? 0.78 : 0.62 });
      const ghostMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isFinish ? 0.05 : 0.045, side: THREE.DoubleSide });

      const arch = makeArcTube(width, archHeight, depth, archMat, 44);
      group.add(arch.front, arch.back);

      const connectorTop = new THREE.Mesh(new THREE.BoxGeometry(width - 0.12, 0.09, depth), archMat);
      connectorTop.position.set(0, archHeight + 0.25, 0);
      group.add(connectorTop);

      const postGeo = new THREE.BoxGeometry(0.18, 1.42, depth);
      const leftPost = new THREE.Mesh(postGeo, archMat);
      const rightPost = leftPost.clone();
      leftPost.position.set(-width / 2, 0.78, 0);
      rightPost.position.set(width / 2, 0.78, 0);
      group.add(leftPost, rightPost);

      const footGeo = new THREE.BoxGeometry(0.72, 0.12, 0.86);
      const lf = new THREE.Mesh(footGeo, archMat);
      const rf = lf.clone();
      lf.position.set(-width / 2, 0.06, 0);
      rf.position.set(width / 2, 0.06, 0);
      group.add(lf, rf);

      // Trackmania-style banner strip across the arch.
      const banner = new THREE.Mesh(new THREE.BoxGeometry(width - 0.68, 0.36, 0.07), faceMat);
      banner.position.set(0, archHeight + 0.18, -0.31);
      group.add(banner);
      const bannerBack = banner.clone();
      bannerBack.position.z = 0.31;
      group.add(bannerBack);

      const signTexture = createLabelTexture(data.label, isFinish ? "#fff0f0" : isStart ? "#201c10" : "#eaf6ff", isFinish ? "rgba(255,59,53,.95)" : isStart ? "rgba(255,214,80,.95)" : "rgba(40,167,255,.92)");
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(isFinish ? 2.55 : isStart ? 1.45 : 1.55, 0.44),
        new THREE.MeshBasicMaterial({ map: signTexture, transparent: true, side: THREE.DoubleSide })
      );
      sign.position.set(0, archHeight + 0.21, -0.355);
      group.add(sign);

      const signBack = sign.clone();
      signBack.position.z = 0.355;
      signBack.rotation.y = Math.PI;
      group.add(signBack);

      // Thin inner rim, more like a real TM checkpoint ring than a square doorway.
      const inner = makeArcTube(width - 0.46, archHeight - 0.22, 0.08, trimMat, 38);
      inner.front.position.z = -0.36;
      inner.back.position.z = 0.36;
      group.add(inner.front, inner.back);

      const passPlane = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.8, 1.8), ghostMat);
      passPlane.position.set(0, 1.28, 0);
      group.add(passPlane);

      const roadText = isStart ? "GO" : isFinish ? "FINISH" : data.label;
      const mark = new THREE.Mesh(
        new THREE.PlaneGeometry(isFinish ? 3.2 : 2.35, 0.86),
        new THREE.MeshBasicMaterial({ map: createRoadMarking(roadText, isFinish ? "#ffcaca" : isStart ? "#ffe89a" : "#dffbff"), transparent: true, opacity: isFinish ? 0.34 : 0.28, side: THREE.DoubleSide })
      );
      mark.rotation.x = -Math.PI / 2;
      mark.position.set(0, 0.097, isFinish ? -0.65 : 0.68);
      group.add(mark);

      const localLight = new THREE.PointLight(color, isFinish ? 0.72 : 0.48, 7.5);
      localLight.position.set(0, 2.1, 0.15);
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

    function makeRoundedBox(width, height, depth, radius, material, smooth = 3) {
      // Lightweight rounded look: center box plus small capsule-like edges.
      const group = new THREE.Group();
      const core = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.01, width - radius * 2), height, depth), material);
      group.add(core);
      const sideGeo = new THREE.CapsuleGeometry(radius, Math.max(0.01, depth - radius * 2), smooth + 4, 16);
      for (const x of [-(width / 2 - radius), width / 2 - radius]) {
        const side = new THREE.Mesh(sideGeo, material);
        side.rotation.x = Math.PI / 2;
        side.position.x = x;
        group.add(side);
      }
      return group;
    }

    function makeCarModel() {
      const carGroup = new THREE.Group();

      // v23: simplified, readable Formula/Stadium-style silhouette.
      // This intentionally uses clear car language first: long nose, wide hips,
      // open wheels, front wing, rear wing, dark cockpit, and rear 888 panel.
      // The model points down local -Z; rear is +Z.
      const silver = new THREE.MeshStandardMaterial({
        color: 0xb8c0bc,
        emissive: 0x020303,
        emissiveIntensity: 0.015,
        roughness: 0.30,
        metalness: 0.72,
      });
      const silverLight = new THREE.MeshStandardMaterial({
        color: 0xd3dbd7,
        emissive: 0x030404,
        emissiveIntensity: 0.012,
        roughness: 0.24,
        metalness: 0.76,
      });
      const darkSilver = new THREE.MeshStandardMaterial({
        color: 0x68706d,
        roughness: 0.38,
        metalness: 0.62,
      });
      const carbon = new THREE.MeshStandardMaterial({
        color: 0x06080a,
        roughness: 0.72,
        metalness: 0.25,
      });
      const black = new THREE.MeshStandardMaterial({
        color: 0x030405,
        roughness: 0.68,
        metalness: 0.28,
      });
      const rubber = new THREE.MeshStandardMaterial({
        color: 0x020203,
        roughness: 0.93,
        metalness: 0.02,
      });
      const tireGroove = new THREE.MeshStandardMaterial({
        color: 0x171b1e,
        roughness: 0.82,
        metalness: 0.04,
      });
      const rim = new THREE.MeshStandardMaterial({
        color: 0xcbd2cf,
        roughness: 0.22,
        metalness: 0.88,
      });
      const glass = new THREE.MeshPhysicalMaterial({
        color: 0x101719,
        emissive: 0x020909,
        emissiveIntensity: 0.08,
        roughness: 0.035,
        metalness: 0.02,
        transparent: true,
        opacity: 0.9,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
      });
      const whiteLight = new THREE.MeshBasicMaterial({ color: 0xf4f8f3, transparent: true, opacity: 0.95 });
      const redLight = new THREE.MeshBasicMaterial({ color: 0xff304f, transparent: true, opacity: 0.92 });
      const cyanAccent = new THREE.MeshBasicMaterial({ color: 0x8beaff, transparent: true, opacity: 0.42 });
      const amberSeat = new THREE.MeshBasicMaterial({ color: 0xc99b28, transparent: true, opacity: 0.9 });

      const add = (mesh, x, y, z, rx = 0, ry = 0, rz = 0) => {
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx, ry, rz);
        carGroup.add(mesh);
        return mesh;
      };

      const make = (geo, mat, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => {
        const m = new THREE.Mesh(geo, mat);
        m.scale.set(sx, sy, sz);
        return add(m, x, y, z, rx, ry, rz);
      };

      function makeBarBetween(a, b, radius, mat) {
        const start = new THREE.Vector3(a.x, a.y, a.z);
        const end = new THREE.Vector3(b.x, b.y, b.z);
        const mid = start.clone().add(end).multiplyScalar(0.5);
        const dir = end.clone().sub(start);
        const len = Math.max(0.001, dir.length());
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 10), mat);
        mesh.position.copy(mid);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        carGroup.add(mesh);
        return mesh;
      }

      // Ground-hugging undertray and diffuser so the car reads low/wide.
      make(new THREE.BoxGeometry(0.86, 0.055, 3.65), carbon, 0, 0.19, -0.10);
      make(new THREE.BoxGeometry(1.34, 0.06, 0.46), carbon, 0, 0.20, 1.58, 1, 1, 1, -0.08, 0, 0);

      // Smooth main shell: ellipsoids give a clean rounded body instead of a tick/box.
      make(new THREE.SphereGeometry(1, 42, 18), silver, 0, 0.47, 0.08, 0.50, 0.18, 1.34);
      make(new THREE.SphereGeometry(1, 42, 18), silver, 0, 0.45, 0.82, 0.72, 0.20, 0.64);
      make(new THREE.SphereGeometry(1, 36, 14), silverLight, 0, 0.54, -0.72, 0.34, 0.12, 0.86);

      // Long pointed nose cone, closer to F1/Stadium shape.
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.36, 1.70, 36), silverLight);
      nose.rotation.x = -Math.PI / 2;
      nose.scale.set(0.78, 1.0, 0.30);
      add(nose, 0, 0.42, -1.47);

      // Center ridge/highlight line down the hood.
      make(new THREE.BoxGeometry(0.042, 0.022, 2.18), darkSilver, 0, 0.675, -0.55, 1, 1, 1, -0.035, 0, 0);
      make(new THREE.BoxGeometry(0.030, 0.014, 1.15), cyanAccent, 0, 0.704, -0.84, 1, 1, 1, -0.035, 0, 0);

      // Wide sidepods/hips with visible black intakes. These stop the body reading like a thin bug/tick.
      for (const side of [-1, 1]) {
        make(new THREE.SphereGeometry(1, 32, 14), silver, side * 0.54, 0.43, 0.12, 0.28, 0.13, 0.82);
        make(new THREE.SphereGeometry(1, 32, 14), silver, side * 0.63, 0.43, 0.82, 0.31, 0.14, 0.48);

        const intake = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.18, 0.50), black);
        intake.rotation.y = side * -0.18;
        intake.rotation.z = side * 0.04;
        add(intake, side * 0.78, 0.47, 0.02);

        const lowerCut = new THREE.Mesh(new THREE.BoxGeometry(0.060, 0.07, 0.76), carbon);
        lowerCut.rotation.y = side * -0.10;
        add(lowerCut, side * 0.82, 0.30, -0.42);
      }

      // Compact dark cockpit/canopy with a tiny amber seat detail.
      make(new THREE.BoxGeometry(0.50, 0.065, 0.72), black, 0, 0.695, -0.02, 1, 1, 1, -0.02, 0, 0);
      make(new THREE.SphereGeometry(1, 34, 14, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0, 0.72, -0.04, 0.27, 0.16, 0.43);
      make(new THREE.BoxGeometry(0.20, 0.028, 0.33), carbon, 0, 0.765, -0.03, 1, 1, 1, -0.03, 0, 0);
      make(new THREE.BoxGeometry(0.035, 0.026, 0.30), amberSeat, -0.055, 0.787, -0.035, 1, 1, 1, 0.04, 0, 0);
      make(new THREE.BoxGeometry(0.035, 0.026, 0.30), amberSeat, 0.055, 0.787, -0.035, 1, 1, 1, 0.04, 0, 0);

      // Front wing assembly. This makes it read as a proper open-wheel race car from every angle.
      make(new THREE.BoxGeometry(1.72, 0.055, 0.18), carbon, 0, 0.25, -2.08);
      make(new THREE.BoxGeometry(1.42, 0.045, 0.15), carbon, 0, 0.29, -1.84);
      make(new THREE.BoxGeometry(0.045, 0.28, 0.34), carbon, -0.91, 0.31, -2.00, 1, 1, 1, 0, 0.10, 0);
      make(new THREE.BoxGeometry(0.045, 0.28, 0.34), carbon, 0.91, 0.31, -2.00, 1, 1, 1, 0, -0.10, 0);

      // Front black face and small headlights/intakes.
      make(new THREE.BoxGeometry(0.46, 0.13, 0.055), black, 0, 0.405, -2.08);
      make(new THREE.BoxGeometry(0.16, 0.032, 0.06), whiteLight, -0.18, 0.44, -2.115, 1, 1, 1, 0, 0.10, 0);
      make(new THREE.BoxGeometry(0.16, 0.032, 0.06), whiteLight, 0.18, 0.44, -2.115, 1, 1, 1, 0, -0.10, 0);

      // Rear 888 panel and rear wing, like the reference rear shot.
      make(new THREE.BoxGeometry(1.05, 0.27, 0.075), black, 0, 0.43, 1.68);
      for (const x of [-0.25, 0, 0.25]) {
        make(new THREE.BoxGeometry(0.095, 0.13, 0.082), whiteLight, x, 0.455, 1.725);
      }
      make(new THREE.BoxGeometry(0.22, 0.035, 0.082), redLight, -0.43, 0.275, 1.725);
      make(new THREE.BoxGeometry(0.22, 0.035, 0.082), redLight, 0.43, 0.275, 1.725);

      make(new THREE.BoxGeometry(1.62, 0.075, 0.22), carbon, 0, 0.91, 1.84);
      make(new THREE.BoxGeometry(1.44, 0.055, 0.16), carbon, 0, 0.78, 1.71);
      make(new THREE.BoxGeometry(0.055, 0.36, 0.28), carbon, -0.86, 0.78, 1.82);
      make(new THREE.BoxGeometry(0.055, 0.36, 0.28), carbon, 0.86, 0.78, 1.82);
      makeBarBetween({ x: -0.42, y: 0.50, z: 1.42 }, { x: -0.58, y: 0.82, z: 1.78 }, 0.016, carbon);
      makeBarBetween({ x: 0.42, y: 0.50, z: 1.42 }, { x: 0.58, y: 0.82, z: 1.78 }, 0.016, carbon);

      // Wheels: bigger, wider open-wheel stance.
      const wheels = [];
      const wheelSpecs = [
        { z: -1.40, r: 0.36, w: 0.31, x: 1.05 },
        { z:  1.12, r: 0.43, w: 0.35, x: 1.12 },
      ];
      for (const spec of wheelSpecs) {
        for (const side of [-1, 1]) {
          const wheelGroup = new THREE.Group();
          const tireMesh = new THREE.Mesh(new THREE.CylinderGeometry(spec.r, spec.r, spec.w, 64), rubber);
          tireMesh.rotation.z = Math.PI / 2;
          wheelGroup.add(tireMesh);

          const groove1 = new THREE.Mesh(new THREE.TorusGeometry(spec.r * 0.86, 0.014, 8, 52), tireGroove);
          groove1.rotation.y = Math.PI / 2;
          groove1.position.x = -0.012;
          wheelGroup.add(groove1);

          const groove2 = groove1.clone();
          groove2.position.x = 0.012;
          wheelGroup.add(groove2);

          const rimOuter = new THREE.Mesh(new THREE.CylinderGeometry(spec.r * 0.56, spec.r * 0.56, spec.w + 0.014, 48), rim);
          rimOuter.rotation.z = Math.PI / 2;
          wheelGroup.add(rimOuter);

          const rimInner = new THREE.Mesh(new THREE.CylinderGeometry(spec.r * 0.36, spec.r * 0.36, spec.w + 0.020, 40), black);
          rimInner.rotation.z = Math.PI / 2;
          wheelGroup.add(rimInner);

          const hub = new THREE.Mesh(new THREE.CylinderGeometry(spec.r * 0.13, spec.r * 0.13, spec.w + 0.026, 32), silverLight);
          hub.rotation.z = Math.PI / 2;
          wheelGroup.add(hub);

          for (let i = 0; i < 8; i++) {
            const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.028, spec.r * 0.48), rim);
            spoke.rotation.z = Math.PI / 2;
            spoke.rotation.y = (Math.PI * 2 / 8) * i;
            wheelGroup.add(spoke);
          }

          wheelGroup.position.set(side * spec.x, 0.39, spec.z);
          carGroup.add(wheelGroup);
          wheels.push(wheelGroup);
        }
      }

      // Suspension arms, visible but clean.
      const armMat = new THREE.MeshStandardMaterial({ color: 0x313a38, roughness: 0.45, metalness: 0.72 });
      for (const side of [-1, 1]) {
        makeBarBetween({ x: side * 0.28, y: 0.35, z: -1.26 }, { x: side * 0.86, y: 0.42, z: -1.50 }, 0.017, armMat);
        makeBarBetween({ x: side * 0.32, y: 0.48, z: -1.06 }, { x: side * 0.86, y: 0.43, z: -1.28 }, 0.014, armMat);
        makeBarBetween({ x: side * 0.20, y: 0.29, z: -1.72 }, { x: side * 0.82, y: 0.34, z: -1.58 }, 0.016, armMat);

        makeBarBetween({ x: side * 0.46, y: 0.37, z: 0.88 }, { x: side * 0.94, y: 0.43, z: 1.15 }, 0.018, armMat);
        makeBarBetween({ x: side * 0.48, y: 0.50, z: 1.30 }, { x: side * 0.94, y: 0.44, z: 1.02 }, 0.015, armMat);
        makeBarBetween({ x: side * 0.55, y: 0.30, z: 1.52 }, { x: side * 0.92, y: 0.35, z: 1.32 }, 0.016, armMat);
      }

      carGroup.userData.wheels = wheels;
      carGroup.scale.set(1.13, 1.13, 1.13);
      return carGroup;
    }

    const car = makeCarModel();
    scene.add(car);

    const path = {
      start: new THREE.Vector3(0, 0, 15.3),
      cp1: new THREE.Vector3(0, 0, 4.0),
      cp2: new THREE.Vector3(0, 0, -5.8),
      cp3: new THREE.Vector3(0, 0, -15.6),
      finish: new THREE.Vector3(0, 0, -25.4),
    };

    let currentSlot = "start";
    let targetCamera = new THREE.Vector3(0, 6.45, 18.4);
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
      targetCamera = new THREE.Vector3(car.position.x * 0.22, 6.4, car.position.z + 11.8);
      camera.position.copy(targetCamera);
      camera.lookAt(car.position.x * 0.16, 0.62, car.position.z - 6.8);
    }

    function hitGate(slot) {
      const gate = gates[slot];
      if (!gate) return;
      gate.scale.set(1.018, 1.018, 1.018);
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
        // Drive cleanly through the checkpoint instead of settling back into the arch.
        to.z -= slot === "finish" ? 1.85 : 1.35;
        const duration = slot === "finish" ? 1780 : 1500;
        const start = performance.now();
        let gateHit = false;
        const gateZ = path[slot].z;

        function step(now) {
          const raw = Math.min(1, (now - start) / duration);
          const t = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
          const x = from.x + (to.x - from.x) * t;
          const z = from.z + (to.z - from.z) * t;
          const nextT = Math.min(1, t + 0.018);
          const nx = from.x + (to.x - from.x) * nextT;
          const nz = from.z + (to.z - from.z) * nextT;
          const dx = nx - x;
          const dz = nz - z;
          const yaw = Math.atan2(-dx, -dz);
          setCarAt(new THREE.Vector3(x, 0, z), yaw);

          targetCamera.set(x * 0.30, 5.95, z + 10.9);

          if (!gateHit && z <= gateZ + 0.12) {
            gateHit = true;
            hitGate(slot);
          }

          if (raw < 1) {
            requestAnimationFrame(step);
          } else {
            currentSlot = slot;
            if (!gateHit) hitGate(slot);
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
      camera.lookAt(car.position.x * 0.16, 0.62, car.position.z - 6.8);
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

    console.info("Prize Runs 3D scene ready - v22 stadium car silhouette pass");
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
