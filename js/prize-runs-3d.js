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

  function createTextSprite(text, color = "#eaf0ff") {
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "900 52px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(104,240,255,.55)";
    ctx.shadowBlur = 20;
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(3.8, 1.25, 1);
    return sprite;
  }

  function createThreeRun() {
    const mount = $("threeMount");
    const stage = $("trackStage");
    if (!mount || !stage || !hasWebGL()) {
      if (stage) stage.classList.add("no-webgl");
      return { ready: false, reset() {}, driveTo: async () => {} };
    }

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch (err) {
      console.warn("WebGL renderer failed:", err);
      stage.classList.add("no-webgl");
      return { ready: false, reset() {}, driveTo: async () => {} };
    }

    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x05070c, 12, 52);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120);
    camera.position.set(0, 6.4, 18);

    const ambient = new THREE.AmbientLight(0xffffff, 1.3);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
    keyLight.position.set(-5, 8, 8);
    scene.add(keyLight);

    const cyanLight = new THREE.PointLight(0x68f0ff, 4.5, 32);
    cyanLight.position.set(0, 4, 2);
    scene.add(cyanLight);

    const goldLight = new THREE.PointLight(0xf5d98a, 2.3, 24);
    goldLight.position.set(2, 3, -14);
    scene.add(goldLight);

    const roadMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.68, metalness: 0.18 });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(8.2, 38, 1, 1), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, -4);
    scene.add(road);

    const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x0a0f1a, roughness: 0.72, metalness: 0.1 });
    for (const x of [-4.7, 4.7]) {
      const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 38), shoulderMat);
      shoulder.position.set(x, 0.03, -4);
      scene.add(shoulder);
    }

    const lineMat = new THREE.MeshBasicMaterial({ color: 0x68f0ff, transparent: true, opacity: 0.42 });
    for (let z = 13; z > -22; z -= 3.4) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.035, 1.2), lineMat);
      stripe.position.set(0, 0.075, z);
      scene.add(stripe);
    }

    const edgeBlue = new THREE.MeshBasicMaterial({ color: 0x68f0ff, transparent: true, opacity: 0.58 });
    for (const x of [-3.85, 3.85]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 38), edgeBlue);
      edge.position.set(x, 0.08, -4);
      scene.add(edge);
    }

    const gatePositions = {
      start: { x: 0, z: 11.5, label: "START", color: 0x68f0ff },
      cp1: { x: -0.85, z: 4.6, label: "CP1", color: 0x68f0ff },
      cp2: { x: 0.75, z: -2.2, label: "CP2", color: 0x68f0ff },
      cp3: { x: -0.35, z: -9.0, label: "CP3", color: 0x68f0ff },
      finish: { x: 0, z: -16.0, label: "FINISH", color: 0xf5d98a },
    };

    const gates = {};
    function createGate(slot, data) {
      const group = new THREE.Group();
      const color = data.color;
      const gateMat = makeMat(0x172033, color, 0.42, 0.35);
      const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38 });

      const left = new THREE.Mesh(new THREE.BoxGeometry(0.24, 2.25, 0.24), gateMat);
      const right = new THREE.Mesh(new THREE.BoxGeometry(0.24, 2.25, 0.24), gateMat);
      const top = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.22, 0.28), gateMat);
      left.position.set(-2.45, 1.12, 0);
      right.position.set(2.45, 1.12, 0);
      top.position.set(0, 2.28, 0);
      group.add(left, right, top);

      const glow = new THREE.Mesh(new THREE.BoxGeometry(4.25, 0.055, 0.055), glowMat);
      glow.position.set(0, 2.48, 0);
      group.add(glow);

      const sprite = createTextSprite(data.label, slot === "finish" ? "#f5d98a" : "#dffbff");
      sprite.position.set(0, 3.15, 0);
      group.add(sprite);

      group.position.set(data.x, 0, data.z);
      scene.add(group);
      return group;
    }

    Object.entries(gatePositions).forEach(([slot, data]) => {
      gates[slot] = createGate(slot, data);
    });

    const car = new THREE.Group();
    const bodyMat = makeMat(0x1b75ff, 0x073d6d, 0.38, 0.5);
    const trimMat = makeMat(0xeaf0ff, 0x111111, 0.4, 0.35);
    const tireMat = makeMat(0x05070c, 0x000000, 0.7, 0.15);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.38, 2.2), bodyMat);
    body.position.y = 0.42;
    car.add(body);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.24, 0.72), bodyMat);
    nose.position.set(0, 0.35, -1.23);
    car.add(nose);
    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.34, 0.72), trimMat);
    cockpit.position.set(0, 0.78, 0.08);
    car.add(cockpit);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.12, 0.26), trimMat);
    wing.position.set(0, 0.75, 1.15);
    car.add(wing);
    for (const x of [-0.72, 0.72]) {
      for (const z of [-0.72, 0.78]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.18, 18), tireMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(x, 0.24, z);
        car.add(wheel);
      }
    }
    scene.add(car);

    const path = {
      start: new THREE.Vector3(0, 0, 12.8),
      cp1: new THREE.Vector3(-0.85, 0, 4.6),
      cp2: new THREE.Vector3(0.75, 0, -2.2),
      cp3: new THREE.Vector3(-0.35, 0, -9.0),
      finish: new THREE.Vector3(0, 0, -16.0),
    };

    let currentSlot = "start";
    let targetCamera = new THREE.Vector3(0, 6.4, 18);
    let rafId = 0;
    const clock = new THREE.Clock();

    function resize() {
      const rect = mount.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.25 : 1.75));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    function setCarAt(vec, yaw = Math.PI) {
      car.position.set(vec.x, 0.18, vec.z);
      car.rotation.y = yaw;
    }

    function reset() {
      currentSlot = "start";
      setCarAt(path.start, Math.PI);
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
      targetCamera = new THREE.Vector3(car.position.x, 6.8, car.position.z + 10.5);
      camera.position.copy(targetCamera);
      camera.lookAt(car.position.x, 0.3, car.position.z - 6);
    }

    function hitGate(slot) {
      const gate = gates[slot];
      if (!gate) return;
      gate.scale.set(1.08, 1.08, 1.08);
      gate.traverse((obj) => {
        if (obj.material?.emissive && obj.material.emissive.setHex) {
          obj.material.emissiveIntensity = 1.25;
        }
      });
      const light = new THREE.PointLight(slot === "finish" ? 0xf5d98a : 0x68f0ff, 6, 12);
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
          const yaw = Math.atan2(nx - x, nz - z) + Math.PI;
          setCarAt(new THREE.Vector3(x, 0, z), yaw);

          targetCamera.set(x * 0.55, 6.2, z + 10.5);

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
        gate.position.y = Math.sin(elapsed * 1.6 + index) * 0.025;
      });
      car.position.y = 0.18 + Math.sin(elapsed * 9) * 0.018;

      camera.position.lerp(targetCamera, 0.045);
      camera.lookAt(car.position.x * 0.35, 0.55, car.position.z - 5.5);
      cyanLight.position.set(car.position.x, 3.5, car.position.z + 1.5);
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(render);
    }

    window.addEventListener("resize", resize, { passive: true });
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

    return { ready: true, reset, driveTo };
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
