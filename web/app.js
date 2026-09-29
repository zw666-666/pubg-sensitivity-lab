"use strict";

const $ = (id) => document.getElementById(id);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const DEFAULT = {
  name: "当前方案 · 1200 DPI",
  mouse_model: "EDIFIER HECATE G5M Pro",
  dpi: 1200,
  polling_rate: 1000,
  windows_pointer_speed: 6,
  windows_acceleration: false,
  resolution: "1920×1080",
  refresh_rate: 144,
  aspect_ratio: "16:9",
  general: 40,
  vertical_multiplier: 2,
  aim: 44,
  ads: 46,
  scopes: { red_dot: 44, "2x": 38, "3x": 40, "4x": 37, "6x": 35, "8x": 32, "15x": 26 },
};

function settingsSnapshot(profile) {
  const value = { ...DEFAULT, ...(profile || {}), scopes: { ...DEFAULT.scopes, ...(profile?.scopes || {}) } };
  return {
    mouse_model: value.mouse_model, dpi: value.dpi, polling_rate: value.polling_rate,
    windows_pointer_speed: value.windows_pointer_speed, windows_acceleration: value.windows_acceleration,
    resolution: value.resolution, refresh_rate: value.refresh_rate, aspect_ratio: value.aspect_ratio,
    general: value.general, vertical_multiplier: value.vertical_multiplier, aim: value.aim, ads: value.ads,
    scopes: { ...value.scopes },
  };
}

function activeTestPhase(session = state.session) {
  const recommendation = session?.recommendation;
  if (!session || !recommendation?.candidate) return "baseline";
  return recommendation.next_phase || "candidate";
}

function hasUncomparableLegacyTrials(session) {
  const trials = session?.trials || [];
  return trials.some((trial) => trial.source === "manual" && !trial.phase) && !trials.some((trial) => ["baseline", "candidate"].includes(trial.phase));
}

function settingValue(settings, field) {
  return field.startsWith("scopes.") ? settings.scopes?.[field.split(".")[1]] : settings[field];
}

const MIN_TRAINING_MS = 5000;
const state = {
  data: { profiles: [], sessions: [], calibrations: {} },
  profile: null,
  session: null,
  calibration: null,
  booted: false,
  trainer: {},
};

function makePreviewApi() {
  const key = "pubg_sensitivity_lab_mock_v2";
  const initial = { profiles: [{ id: 1, ...DEFAULT }], sessions: [], calibrations: {} };
  const load = () => {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(initial)); }
    catch { return structuredClone(initial); }
  };
  const save = (data) => localStorage.setItem(key, JSON.stringify(data));
  const fullSession = (data, id) => {
    const session = data.sessions.find((item) => Number(item.id) === Number(id));
    return session ? { ...session, trials: session.trials || [], recommendation: session.recommendation || null } : null;
  };
  return {
    async load_profiles() {
      const data = load();
      return { ...data, sessions: data.sessions.map((item) => ({ ...item, trial_count: item.trials?.length || 0 })) };
    },
    async save_profile(profile) {
      const data = load();
      const saved = { ...DEFAULT, ...profile, id: profile.id || Date.now(), scopes: { ...DEFAULT.scopes, ...(profile.scopes || {}) } };
      const index = data.profiles.findIndex((item) => Number(item.id) === Number(saved.id));
      if (index >= 0) data.profiles[index] = saved; else data.profiles.push(saved);
      save(data);
      return saved;
    },
    async save_calibration(calibration) {
      const data = load();
      const saved = { id: Date.now(), ...calibration, created_at: new Date().toISOString() };
      data.calibrations[String(calibration.profile_id)] = saved;
      save(data);
      return saved;
    },
    async create_session(config) {
      const data = load();
      const session = { id: Date.now(), ...config, baseline_settings: config.baseline_settings || settingsSnapshot(state.profile), trials: [], recommendation: null, created_at: new Date().toISOString() };
      data.sessions.unshift(session);
      save(data);
      return session;
    },
    async get_session(id) { return fullSession(load(), id); },
    async save_trial(trial) {
      const data = load();
      const session = data.sessions.find((item) => Number(item.id) === Number(trial.session_id));
      if (!session) throw new Error("找不到测试会话");
      session.trials = session.trials || [];
      const saved = { id: Date.now(), ...trial, created_at: new Date().toISOString() };
      session.trials.push(saved);
      save(data);
      return saved;
    },
    async calculate_recommendation(id) {
      const data = load();
      const session = fullSession(data, id);
      const all = session?.trials || [];
      const phases = all.filter((trial) => ["baseline", "candidate"].includes(trial.phase));
      const baselines = phases.filter((trial) => trial.phase === "baseline");
      const candidates = phases.filter((trial) => trial.phase === "candidate");
      const previous = session?.recommendation || {};
      let candidate = previous.candidate || null;
      let problem = "等待基准测试";
      let reason = "先按当前完整参数记录基准；基准前不会推荐候选值。";
      if (baselines.length && !candidate) {
        const base = baselines[baselines.length - 1];
        const m = base.metrics || {};
        const impact = base.impact || {};
        const settings = base.settings_snapshot || session.baseline_settings || settingsSnapshot(state.profile);
        const vertical = Number(m.vertical_control || 3) >= 4 || (impact.direction === "up" && Number(m.vertical_control || 3) >= 3);
        const horizontal = Number(m.horizontal_drift || 3) >= 4 || Number(m.shake || 3) >= 4 || Boolean(m.overcompensation) || ["left", "right"].includes(impact.direction);
        const scopeMap = { "红点": ["ads", "开镜模式灵敏度"], "全息": ["ads", "开镜模式灵敏度"], "2倍": ["scopes.2x", "2倍镜灵敏度"], "3倍": ["scopes.3x", "3倍镜灵敏度"], "4倍": ["scopes.4x", "4倍镜灵敏度"], "6倍": ["scopes.6x", "6倍镜灵敏度"], "8倍": ["scopes.8x", "8倍镜灵敏度"], "15倍": ["scopes.15x", "15倍镜灵敏度"] };
        const [field, label] = scopeMap[session.scope] || scopeMap["红点"];
        const changes = [];
        if (vertical && horizontal && session.strategy === "linked" && impact.direction === "up" && Number(settings.vertical_multiplier) < 2) {
          changes.push({ field, label, before: Number(settingValue(settings, field)), after: Math.max(1, Number(settingValue(settings, field)) - 1) });
          changes.push({ field: "vertical_multiplier", label: "垂直灵敏度增强", before: Number(settings.vertical_multiplier), after: Math.min(2, Number(settings.vertical_multiplier) + 0.1) });
        } else if (vertical && !horizontal) {
          const vm = Number(settings.vertical_multiplier);
          if (vm < 2) changes.push({ field: "vertical_multiplier", label: "垂直灵敏度增强", before: vm, after: Math.min(2, vm + 0.1) });
          else changes.push({ field, label, before: Number(settingValue(settings, field)), after: Math.min(100, Number(settingValue(settings, field)) + 1) });
        } else if (horizontal && !vertical) {
          changes.push({ field, label, before: Number(settingValue(settings, field)), after: Math.max(1, Number(settingValue(settings, field)) - 1) });
        }
        if (changes.length && impact.direction && impact.spread) {
          const proposed = structuredClone(settings);
          changes.forEach((change) => { if (change.field.startsWith("scopes.")) proposed.scopes[change.field.split(".")[1]] = change.after; else proposed[change.field] = change.after; });
          candidate = { candidate_id: "candidate-1", settings: proposed, changes, reason: vertical ? "当前信号偏垂直不足，生成小幅可验证候选；其他倍镜保持不变。" : "横向控制信号较突出，生成当前开镜状态的小幅候选。" };
          problem = vertical && horizontal ? "垂直与横向信号互相牵制" : vertical ? "垂直回拉可能不足" : "横向控制或抖动较突出";
          reason = candidate.reason;
        } else {
          problem = "数据不足或问题信号冲突";
          reason = "命中、手感信号不够明确，保持设置并重复基准。";
        }
      }
      let comparison = null;
      if (baselines.length && candidates.length) {
        const pairs = Array.from({ length: Math.min(baselines.length, candidates.length) }, (_, index) => [baselines[index], candidates[index]]);
        const verdicts = pairs.map(([base, option]) => {
          if (JSON.stringify(base.conditions || {}) !== JSON.stringify(option.conditions || {})) return "inconclusive";
          const bi = base.impact || {}; const ci = option.impact || {};
          let objective = 0;
          if (bi.direction !== ci.direction && bi.direction !== "center" && ci.direction !== "center") objective = 0;
          else if (bi.direction !== ci.direction) objective = ci.direction === "center" ? 1 : -1;
          else if (Number(ci.spread) < Number(bi.spread)) objective = 1;
          else if (Number(ci.spread) > Number(bi.spread)) objective = -1;
          const before = base.metrics || {}; const after = option.metrics || {};
          const feelWorse = Number(after.stability || 3) <= Number(before.stability || 3) - 1 || ["vertical_control", "horizontal_drift", "shake"].some((key) => Number(after[key] || 3) >= Number(before[key] || 3) + 1) || (after.overcompensation && !before.overcompensation);
          return objective > 0 && feelWorse ? "tradeoff" : objective > 0 ? "candidate_better" : objective < 0 ? "baseline_better" : "inconclusive";
        });
        const verdict = verdicts.includes("tradeoff") ? "tradeoff" : verdicts.length && verdicts.every((item) => item === "candidate_better") ? "candidate_better" : verdicts.length && verdicts.every((item) => item === "baseline_better") ? "baseline_better" : "inconclusive";
        const reason = verdict === "candidate_better" ? "候选命中表现重复改善且手感未明显恶化；仍建议完成平衡复测。" : verdict === "baseline_better" ? "当前基准的命中表现较好，先不要接受候选。" : verdict === "tradeoff" ? "命中和手感存在取舍，需重复两侧确认。" : "条件不同、方向变化无法区分，或重复结果互相矛盾，暂不能判断。";
        comparison = { verdict, pair_count: pairs.length, pair_verdicts: verdicts, reason };
        problem = ({ candidate_better: "候选初步改善", baseline_better: "当前基准表现更好", tradeoff: "命中与手感存在取舍", inconclusive: "暂不能判断" })[verdict];
      }
      const nextPhase = !baselines.length ? "baseline" : candidate && candidates.length < baselines.length ? "candidate" : "baseline";
      const nextStep = !baselines.length ? "先在 PUBG 完成当前设置基准测试，约 5 个弹匣。" : candidate && !candidates.length ? "手动应用下方候选方案后，固定条件打 5 个弹匣。" : baselines.length === candidates.length ? "当前基准与候选组数相同，下一组先用原基准值测试，再补一组候选；不要凭单轮直接定值。" : "按提示补测样本较少的一侧；不要凭单轮直接定值。";
      const recommendation = {
        status: !baselines.length ? "baseline_required" : candidate && !candidates.length ? "candidate_ready" : comparison?.verdict || "need_repeat",
        problem, confidence: !baselines.length ? "无" : baselines.length >= 2 && candidates.length >= 2 && ["candidate_better", "baseline_better"].includes(comparison?.verdict) ? "较可信（至少两组/侧）" : candidates.length ? "初步（需要复测）" : candidate ? "初步（只有基准）" : "不足",
        reason: candidate?.reason || reason, next_step: nextStep,
        next_phase: nextPhase,
        candidate, changes: candidate?.changes || [], comparison,
        summary: { vertical: baselines.reduce((sum, item) => sum + Number(item.metrics?.vertical_control || 0), 0) / (baselines.length || 1), horizontal: baselines.reduce((sum, item) => sum + Number(item.metrics?.horizontal_drift || 0), 0) / (baselines.length || 1), shake: baselines.reduce((sum, item) => sum + Number(item.metrics?.shake || 0), 0) / (baselines.length || 1) },
      };
      const targetSession = data.sessions.find((item) => Number(item.id) === Number(id));
      if (targetSession) targetSession.recommendation = recommendation;
      save(data);
      return recommendation;
    },
    async run_diagnostic_test(mode, config) {
      const scale = (Number(config.dpi || 1200) / 800) * ((Number(config.aim || 44) + Number(config.ads || 46)) / 90) * Number(config.calibration_factor || 1);
      return { mode, scale: clamp(scale, 0.5, 3), duration: 20, safe: true };
    },
    async export_session(id, format) {
      const session = fullSession(load(), id);
      if (!session) throw new Error("当前没有可导出的会话");
      const blob = new Blob([JSON.stringify({ schema_version: 2, profile: state.profile, session }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `pubg-session-${id}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      return anchor.download;
    },
    async duplicate_session(id) {
      const data = load();
      const source = fullSession(data, id);
      if (!source) throw new Error("找不到要复制的测试会话");
      const copiedId = Date.now();
      const copied = {
        ...source,
        id: copiedId,
        title: `${source.title} · 副本`,
        created_at: new Date().toISOString(),
        recommendation: source.recommendation ? structuredClone(source.recommendation) : null,
        trials: (source.trials || []).map((trial, index) => ({ ...structuredClone(trial), id: copiedId + index + 1, session_id: copiedId })),
      };
      data.sessions.unshift(copied);
      save(data);
      return copied;
    },
    async reset_preview_data() {
      save(structuredClone(initial));
      return true;
    },
    async delete_session(id) {
      const data = load();
      data.sessions = data.sessions.filter((item) => Number(item.id) !== Number(id));
      save(data);
      return true;
    },
  };
}

const previewApi = makePreviewApi();
function backend() { return window.pywebview?.api || previewApi; }

async function call(method, ...args) {
  const target = backend();
  if (typeof target[method] !== "function") throw new Error(`当前环境不支持 ${method}`);
  return target[method](...args);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function errorMessage(error) { return error?.message || String(error || "未知错误"); }

let toastTimer;
function toast(message) {
  const element = $("toast");
  clearTimeout(toastTimer);
  element.textContent = message;
  element.classList.add("show");
  toastTimer = setTimeout(() => element.classList.remove("show"), 2800);
}

function readNumber(id, fallback = 0) {
  const value = Number($(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function go(view) {
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  $$(".nav-item").forEach((element) => {
    const active = element.dataset.view === view;
    element.classList.toggle("active", active);
    if (active) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current");
  });
  if (view === "history") renderHistory();
  if (view === "dashboard") renderDashboard();
}

function profilePayload({ duplicate = false } = {}) {
  return {
    id: duplicate ? null : state.profile?.id,
    name: $("profileName").value.trim() || "未命名方案",
    mouse_model: $("mouseModel").value.trim(),
    dpi: readNumber("dpi", 1200),
    polling_rate: readNumber("pollingRate", 1000),
    windows_pointer_speed: readNumber("windowsPointer", 6),
    windows_acceleration: $("windowsAccel").checked,
    resolution: $("resolution").value.trim(),
    refresh_rate: readNumber("refreshRate", 144),
    aspect_ratio: $("aspectRatio").value.trim(),
    general: readNumber("general", 40),
    vertical_multiplier: readNumber("verticalMultiplier", 2),
    aim: readNumber("aim", 44),
    ads: readNumber("ads", 46),
    scopes: {
      red_dot: Number(state.profile?.scopes?.red_dot ?? 44), "2x": readNumber("scope2x", 38),
      "3x": readNumber("scope3x", 40), "4x": readNumber("scope4x", 37),
      "6x": readNumber("scope6x", 35), "8x": readNumber("scope8x", 32),
      "15x": readNumber("scope15x", 26),
    },
  };
}

function renderProfileSwitcher() {
  const select = $("profileSelect");
  select.innerHTML = state.data.profiles.map((profile) => `<option value="${profile.id}">${esc(profile.name)}</option>`).join("");
  if (state.profile) select.value = String(state.profile.id);
}

function fillProfile(profile) {
  const value = { ...DEFAULT, ...profile, scopes: { ...DEFAULT.scopes, ...(profile?.scopes || {}) } };
  state.profile = value;
  $("profileName").value = value.name;
  $("mouseModel").value = value.mouse_model;
  $("dpi").value = value.dpi;
  $("pollingRate").value = value.polling_rate;
  $("windowsPointer").value = value.windows_pointer_speed;
  $("windowsAccel").checked = Boolean(value.windows_acceleration);
  $("resolution").value = value.resolution;
  $("refreshRate").value = value.refresh_rate;
  $("aspectRatio").value = value.aspect_ratio;
  $("general").value = value.general;
  $("verticalMultiplier").value = value.vertical_multiplier;
  $("aim").value = value.aim;
  $("ads").value = value.ads;
  const scopeIds = { "2x": "scope2x", "3x": "scope3x", "4x": "scope4x", "6x": "scope6x", "8x": "scope8x", "15x": "scope15x" };
  Object.entries(scopeIds).forEach(([key, id]) => { $(id).value = value.scopes[key]; });
  $("pageContext").textContent = value.name;
  $("snapDpi").textContent = value.dpi;
  $("snapGeneral").textContent = value.general;
  $("snapAim").textContent = value.aim;
  $("snapAds").textContent = value.ads;
  $("snapVertical").textContent = Number(value.vertical_multiplier).toFixed(1);
  renderProfileSwitcher();
}

function applyCalibration(calibration) {
  state.calibration = calibration || null;
  if (!calibration) {
    $("calDistance").value = 20;
    $("calDegrees").value = 180;
    $("calRepeats").value = 3;
    $("calFactor").textContent = "1.000";
    $("calibrationStatus").textContent = "还没有保存本次校准。";
    return;
  }
  $("calDistance").value = calibration.distance_cm;
  $("calDegrees").value = calibration.degrees;
  $("calRepeats").value = calibration.repeats;
  $("calFactor").textContent = Number(calibration.factor || 1).toFixed(3);
  $("calibrationStatus").textContent = `已保存校准，可信度 ${calibration.confidence || "中"}。`;
}

async function selectProfile(profileId) {
  const profile = state.data.profiles.find((item) => Number(item.id) === Number(profileId));
  if (!profile) return;
  fillProfile(profile);
  applyCalibration(state.data.calibrations[String(profile.id)]);
  const summary = state.data.sessions.find((item) => Number(item.profile_id) === Number(profile.id));
  state.session = summary ? await call("get_session", summary.id) : null;
  renderDashboard();
  renderFieldSession();
}

function renderDashboard() {
  const savedRecommendation = state.session?.recommendation;
  const recommendation = savedRecommendation?.status ? savedRecommendation : null;
  const summary = recommendation?.summary;
  const sessionCount = Number(state.session?.trials?.length ?? state.session?.trial_count ?? 0);
  $("dashboardProblem").textContent = recommendation?.problem || "尚未开始";
  $("dashboardConfidence").textContent = recommendation ? `可信度 ${recommendation.confidence}` : "等待第一轮测试";
  $("dashboardRecommendation").innerHTML = recommendation
    ? `<strong>${esc(recommendation.problem)}</strong><p>${esc(recommendation.next_step)}</p>`
    : "<strong>先记录当前设置基准</strong><p>进入实战记录，固定同一枪械、倍镜、距离和配件，完成约 5 个弹匣。</p>";
  if ($("dashboardPrimary")) $("dashboardPrimary").textContent = state.session ? "记录下一轮" : "开始第一次测试";
  if ($("dashboardContinue")) {
    $("dashboardContinue").disabled = !state.session;
    $("dashboardContinue").textContent = state.session ? `继续当前会话（${sessionCount} 轮）` : "继续上次测试";
  }
  ["vertical", "horizontal", "shake"].forEach((key) => {
    const value = Number(summary?.[key] || 0);
    const suffix = `${key[0].toUpperCase()}${key.slice(1)}`;
    $(`signal${suffix}`).style.width = `${clamp(value * 20, 0, 100)}%`;
    $(`signal${suffix}Value`).textContent = value ? value.toFixed(1) : "暂无";
  });
}

function updateSessionSummary() {
  const weapon = $("weapon")?.value || "Beryl";
  const scope = $("scope")?.value || "红点";
  const distance = readNumber("distance", 50);
  if ($("sceneWeaponPreview")) $("sceneWeaponPreview").textContent = weapon;
  if ($("sceneScopePreview")) $("sceneScopePreview").textContent = scope;
  if ($("sceneDistancePreview")) $("sceneDistancePreview").textContent = `${distance} 米`;
  if ($("sessionTitle") && !$("sessionTitle").dataset.edited) {
    $("sessionTitle").value = `${weapon} ${scope} ${distance}米`;
  }
}

function lockSessionSetup(locked) {
  const form = $("sessionForm");
  if (!form) return;
  form.classList.toggle("session-locked", locked);
  form.querySelectorAll("input, select").forEach((control) => { control.disabled = locked; });
  const submit = $("sessionSubmitBtn");
  if (submit) {
    submit.disabled = locked;
    submit.textContent = locked ? "当前会话已建立" : "创建后去 PUBG 测试";
  }
}

function updateFieldGuide(count = 0) {
  const steps = $$(".field-guide-steps span");
  const phase = activeTestPhase();
  const activeIndex = !state.session ? 0 : count ? 2 : 1;
  steps.forEach((step, index) => step.classList.toggle("active", index === activeIndex));
  if (!state.session) {
    $("fieldGuideTitle").textContent = "先建立一次基准测试";
    $("fieldGuideText").textContent = "第一轮不改参数，只确认你当前的 Beryl 红点压枪表现。";
    $("trialHint").innerHTML = "<strong>还没开始测试</strong><span>先完成左侧“第 1 步”，再去 PUBG 打 5 个弹匣。</span>";
    return;
  }
  const weapon = state.session.weapon || "Beryl";
  const scope = state.session.scope || "红点";
  const distance = Number(state.session.distance || 50);
  if (hasUncomparableLegacyTrials(state.session)) {
    $("fieldGuideTitle").textContent = "旧记录可回看，但不能做新比较";
    $("fieldGuideText").textContent = "旧轮次没有完整设置快照和弹着记录。它们仍保留在历史中；请新建会话，重新建立可比较的基准。";
    $("trialHint").innerHTML = "<strong>此旧会话仅供查看</strong><span>点击下方“重新建会话”，以当前参数和实际配件条件重新开始。</span>";
    return;
  }
  const nextTrial = count + 1;
  const phaseName = phase === "baseline" ? "基准" : "候选/对照";
  $("fieldGuideTitle").textContent = `第 ${nextTrial} 轮：完成${phaseName}测试`;
  $("fieldGuideText").textContent = `使用 ${weapon}＋${scope}，${distance} 米，完成约 5 个弹匣；姿势、配件和其他条件保持不变。`;
  $("trialHint").innerHTML = `<strong>现在去 PUBG 打 5 个弹匣</strong><span>先看弹着区域相对瞄准点的位置与散布，再填写手感；工具不读取游戏画面。</span>`;
}

function updateActionAvailability() {
  const disabled = !state.session;
  $("exportJson").disabled = disabled;
  $("exportCsv").disabled = disabled;
}

function renderHistory() {
  updateActionAvailability();
  const list = $("historyList");
  const allSessions = state.data.sessions || [];
  const query = ($("historyFilter")?.value || "").trim().toLocaleLowerCase();
  const sessions = query ? allSessions.filter((session) => [session.title, session.weapon, session.scope, session.recommendation?.problem]
    .some((value) => String(value || "").toLocaleLowerCase().includes(query))) : allSessions;
  $("historyCount").textContent = query ? `${sessions.length} / ${allSessions.length} 个会话` : `${allSessions.length} 个会话`;
  if (!allSessions.length) {
    list.innerHTML = '<div class="history-empty">还没有历史会话。先去实战记录完成第一轮。</div>';
    return;
  }
  if (!sessions.length) {
    list.innerHTML = '<div class="history-empty">没有匹配的历史会话。换一个关键词试试。</div>';
    return;
  }
  list.innerHTML = sessions.map((session) => {
    const trials = Number(session.trial_count ?? session.trials?.length ?? 0);
    const diagnosis = session.recommendation?.problem ? ` · ${esc(session.recommendation.problem)}` : "";
    return `<article class="history-card"><div><h3>${esc(session.title)}</h3><p>${esc(session.weapon || "Beryl")} · ${esc(session.scope || "红点")} · ${Number(session.distance || 50)} 米${diagnosis}</p><div class="history-meta"><span>${trials} 轮记录</span><span>${esc(session.created_at || "本地会话")}</span></div></div><div class="history-actions"><button class="text-btn" data-open-session="${session.id}">打开</button><button class="text-btn" data-copy-session="${session.id}">复制</button><button class="text-btn" data-export-session="${session.id}">导出</button><button class="text-btn" data-delete-session="${session.id}">删除</button></div></article>`;
  }).join("");
  $$('[data-open-session]').forEach((button) => button.addEventListener("click", async () => {
    try { state.session = await call("get_session", Number(button.dataset.openSession)); go("field"); renderFieldSession(); }
    catch (error) { toast(`打开失败：${errorMessage(error)}`); }
  }));
  $$('[data-export-session]').forEach((button) => button.addEventListener("click", async () => {
    try { toast(`已导出：${await call("export_session", Number(button.dataset.exportSession), "json")}`); }
    catch (error) { toast(`导出失败：${errorMessage(error)}`); }
  }));
  $$('[data-copy-session]').forEach((button) => button.addEventListener("click", async () => {
    try {
      state.session = await call("duplicate_session", Number(button.dataset.copySession));
      state.data = await call("load_profiles");
      renderHistory();
      renderDashboard();
      toast("会话及其测试记录已复制");
    } catch (error) { toast(`复制失败：${errorMessage(error)}`); }
  }));
  $$('[data-delete-session]').forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("删除这次会话及其测试记录？")) return;
    try {
      const id = Number(button.dataset.deleteSession);
      await call("delete_session", id);
      if (Number(state.session?.id) === id) state.session = null;
      state.data = await call("load_profiles");
      renderHistory();
      renderDashboard();
      toast("会话已删除");
    } catch (error) { toast(`删除失败：${errorMessage(error)}`); }
  }));
}

async function saveProfile(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  try {
    const saved = await call("save_profile", profilePayload());
    state.data = await call("load_profiles");
    await selectProfile(saved.id);
    $("profileStatus").textContent = "已保存";
    toast("参数方案已保存");
  } catch (error) { toast(`保存失败：${errorMessage(error)}`); }
}

async function duplicateProfile() {
  try {
    const payload = profilePayload({ duplicate: true });
    payload.name = `${payload.name} · 副本`;
    const saved = await call("save_profile", payload);
    state.data = await call("load_profiles");
    await selectProfile(saved.id);
    $("profileStatus").textContent = "已另存为新方案";
    toast("新参数方案已创建");
  } catch (error) { toast(`另存失败：${errorMessage(error)}`); }
}

function calibrationFactor() {
  const distance = readNumber("calDistance", 20);
  const degrees = readNumber("calDegrees", 180);
  return clamp((degrees / Math.max(distance, 0.1)) / 9, 0.5, 1.5);
}

function updateCalibrationPreview() { $("calFactor").textContent = calibrationFactor().toFixed(3); }

async function saveCalibration(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  try {
    state.calibration = await call("save_calibration", {
      profile_id: state.profile.id,
      distance_cm: readNumber("calDistance", 20),
      degrees: readNumber("calDegrees", 180),
      repeats: readNumber("calRepeats", 3),
      factor: calibrationFactor(),
      confidence: readNumber("calRepeats", 3) >= 3 ? "中" : "低",
    });
    state.data.calibrations[String(state.profile.id)] = state.calibration;
    applyCalibration(state.calibration);
    toast("校准结果已保存，并会影响训练场映射");
  } catch (error) { toast(`校准保存失败：${errorMessage(error)}`); }
}

async function createSession(event) {
  event.preventDefault();
  if (state.session) return toast("当前会话已经建立；下一轮请在右侧填写，换场景再点“重新建会话”");
  if (!event.currentTarget.reportValidity()) return;
  try {
    state.session = await call("create_session", {
      profile_id: state.profile.id,
      title: $("sessionTitle").value.trim() || "Beryl 红点 50米",
      weapon: $("weapon").value,
      scope: $("scope").value,
      distance: readNumber("distance", 50),
      magazines: 5,
      strategy: $("strategy").value,
      baseline_settings: settingsSnapshot(profilePayload()),
      conditions: { posture: $("posture").value, attachments: $("attachments").value.trim() },
    });
    state.session.trials = [];
    state.session.recommendation = null;
    renderFieldSession();
    toast("新会话已创建");
  } catch (error) { toast(`创建失败：${errorMessage(error)}`); }
}

async function refreshCurrentSession(withRecommendation = false) {
  if (!state.session) return;
  if (withRecommendation) await call("calculate_recommendation", state.session.id);
  state.session = await call("get_session", state.session.id);
  state.data = await call("load_profiles");
  renderFieldSession();
  renderDashboard();
}

async function saveTrial(event) {
  event.preventDefault();
  if (!state.session) return toast("请先创建测试会话");
  if (!event.currentTarget.reportValidity()) return;
  const trialNumber = Number(state.session.trials?.length || state.session.trial_count || 0) + 1;
  const phase = activeTestPhase();
  const recommendation = state.session.recommendation || {};
  if (phase === "candidate" && !$("candidateApplied").checked) return toast("请先在 PUBG 手动应用候选设置，并勾选确认；工具不会替你改游戏设置");
  const candidate = recommendation.candidate;
  const snapshot = phase === "candidate" && candidate?.settings ? candidate.settings : (state.session.baseline_settings || settingsSnapshot(profilePayload()));
  try {
    await call("save_trial", {
      session_id: state.session.id,
      trial_number: trialNumber,
      source: "manual",
      phase,
      candidate_id: phase === "candidate" ? (candidate?.candidate_id || "candidate-1") : null,
      settings_snapshot: snapshot,
      conditions: state.session.conditions || { posture: $("posture").value, attachments: $("attachments").value.trim() },
      impact: { direction: $("impactDirection").value, spread: readNumber("impactSpread", 3) },
      metrics: {
        vertical_control: readNumber("verticalControl", 3),
        horizontal_drift: readNumber("horizontalDrift", 3),
        shake: readNumber("shake", 3),
        overcompensation: $("overcompensation").checked,
        stability: readNumber("stability", 3),
      },
      notes: $("trialNotes").value.trim(),
      variable: "linked-comparison",
    });
    await refreshCurrentSession(true);
    $("trialNotes").value = "";
    $("overcompensation").checked = false;
    $("candidateApplied").checked = false;
    toast(`第 ${trialNumber} 轮已保存`);
  } catch (error) { toast(`记录失败：${errorMessage(error)}`); }
}

function renderFieldSession() {
  if (!state.session) {
    $("sessionStatus").textContent = "还没有开始。先点击左侧按钮。";
    $("saveTrialBtn").disabled = true;
    $("trialNumber").textContent = "01";
    $("sessionTitle").dataset.edited = "";
    if ($("attachments")) $("attachments").value = "";
    lockSessionSetup(false);
    $("fieldRecommendation").innerHTML = '<div><span class="eyebrow">基准 → 候选 → 对照</span><h2>先测当前完整设置</h2><p>完成基准后，工具才会根据弹着和手感生成候选值。</p></div><div class="recommendation-placeholder">--</div>';
    updateSessionSummary();
    updateFieldGuide(0);
    updateActionAvailability();
    return;
  }
  const count = Number(state.session.trials?.length ?? state.session.trial_count ?? 0);
  const legacyOnly = hasUncomparableLegacyTrials(state.session);
  $("sessionStatus").textContent = legacyOnly ? `旧会话：${state.session.title}，${count} 轮历史记录保留；新对比请另建会话。` : `当前会话：${state.session.title}，已记录 ${count} 轮`;
  $("saveTrialBtn").disabled = legacyOnly;
  $("trialNumber").textContent = String(count + 1).padStart(2, "0");
  if ($("strategy")) $("strategy").value = state.session.strategy || "linked";
  $("weapon").value = state.session.weapon || "Beryl";
  $("scope").value = state.session.scope || "红点";
  $("distance").value = state.session.distance || 50;
  $("sessionTitle").value = state.session.title || `${$("weapon").value} ${$("scope").value} ${$("distance").value}米`;
  $("sessionTitle").dataset.edited = "true";
  if ($("posture")) $("posture").value = state.session.conditions?.posture || "站姿";
  if ($("attachments")) $("attachments").value = state.session.conditions?.attachments || "";
  lockSessionSetup(true);
  updateSessionSummary();
  updateFieldGuide(count);
  const phase = activeTestPhase();
  const isCandidate = phase === "candidate" && Boolean(state.session.recommendation?.candidate?.settings);
  $("candidateApplyWrap").classList.toggle("hidden", !isCandidate);
  $("candidateApplied").checked = false;
  $("phaseNotice").innerHTML = isCandidate
    ? `<strong>本轮：候选设置测试</strong><span>先按下方变更表手动调整 PUBG；其他参数和场景条件保持不变，再勾选“已应用”。</span>`
    : `<strong>本轮：${count ? "基准重复测试" : "当前参数基准"}</strong><span>${count ? "使用基准设置，作为与候选的对照；勿按候选值测试。" : "保持当前完整方案不变，不要按推荐改动。"}</span>`;
  $("trialPhaseLabel").textContent = isCandidate ? "候选" : "基准";
  $("saveTrialBtn").textContent = isCandidate ? "确认并保存候选这 5 个弹匣" : "保存基准这 5 个弹匣";
  $("impactDirection").value = "center";
  $("impactSpread").value = "3";
  const recommendation = state.session.recommendation;
  $("fieldRecommendation").innerHTML = legacyOnly
    ? '<div><span class="eyebrow">历史兼容</span><h2>旧轮次不可比较</h2><p>历史记录缺少设置快照或命中方向/散布，工具不会补猜。请新建会话，先记录当前方案基准。</p></div><div class="recommendation-placeholder">仅供回看</div>'
    : recommendation?.status ? renderRecommendation(recommendation) : '<div><span class="eyebrow">基准 → 候选 → 对照</span><h2>先完成当前参数基准</h2><p>第一轮只建立参照，不会提前给你编一个“最佳值”。</p></div><div class="recommendation-placeholder">等待基准</div>';
  updateActionAvailability();
}

function renderRecommendation(recommendation) {
  const changes = recommendation.changes || recommendation.candidate?.changes || [];
  const table = changes.length ? `<div class="candidate-diff"><strong>候选方案（逐项对比）</strong>${changes.map((change) => `<div><span>${esc(change.label)}</span><b>${esc(change.before)} → ${esc(change.after)}</b></div>`).join("")}</div>` : "";
  const comparison = recommendation.comparison ? `<div class="comparison-result"><strong>基准/候选比较：${esc(({ candidate_better: "候选初步改善", baseline_better: "基准更好", tradeoff: "存在取舍", inconclusive: "暂不能判断" })[recommendation.comparison.verdict] || "暂不能判断")}</strong><span>${esc(recommendation.comparison.reason || "")}</span></div>` : "";
  const keep = state.session ? `<p class="keep-conditions"><strong>两侧都保持：</strong>${esc(state.session.weapon)} · ${esc(state.session.scope)} · ${Number(state.session.distance)} 米 · ${esc(state.session.conditions?.posture || "站姿")} · 配件 ${esc(state.session.conditions?.attachments || "无")} · 每组约 5 个弹匣</p>` : "";
  return `<div><span class="eyebrow">实测判断 · 可信度 ${esc(recommendation.confidence || "不足")}</span><h2>${esc(recommendation.problem || "等待数据")}</h2><p>${esc(recommendation.reason || "")}</p>${comparison}${table}${keep}<p><strong>下一步：</strong>${esc(recommendation.next_step || "继续固定条件复测")}</p><p class="stop-rule"><strong>停止条件：</strong>${esc(recommendation.stop_rule || "至少完成基准与候选各两组，并确认命中与手感趋势一致。")}</p></div><div class="recommendation-placeholder">${recommendation.candidate ? `${changes.length} 项<br>待实测` : "不先猜数值"}</div>`;
}

const canvas = $("trainerCanvas");
const ctx = canvas.getContext("2d");

function newTrainerState(mode = state.trainer.mode || "vertical") {
  return { mode, running: false, result: null, config: null, path: [], x: canvas.width / 2, y: canvas.height / 2, targetX: canvas.width / 2, targetY: canvas.height / 2, startedAt: 0, samples: 0, sumXError: 0, sumYError: 0, withinTarget: 0, movementEvents: 0, jerk: 0, lastDx: 0, lastDy: 0 };
}

function trainerMode(mode) {
  if (state.trainer.running) return toast("请先结束当前训练");
  state.trainer.mode = mode;
  $$(".mode-tab").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const copy = {
    vertical: ["VERTICAL CONTROL", "跟随上升目标，保持回拉平滑", "训练会模拟连续后坐力脉冲，观察你是否过量修正。", "垂直训练判断你是否真的需要更高的垂直回拉幅度。"],
    horizontal: ["HORIZONTAL STABILITY", "把准星稳在横向移动目标上", "目标会左右摆动，重点观察高灵敏度下的小幅修正。", "横向训练区分灵敏度过高造成的左右飘和垂直不足。"],
    micro: ["MICRO TRACKING", "跟住小目标，减少多余修正", "目标移动幅度较小，适合观察抖动和微调迟滞。", "微调训练帮助判断是手部抖动，还是灵敏度低导致转向跟不上。"],
  }[mode];
  $("trainerInstruction").innerHTML = `<span class="eyebrow">${copy[0]}</span><strong>${copy[1]}</strong><small>${copy[2]}</small>`;
  $("trainerWhy").textContent = copy[3];
  resetTrainer();
}

function resetTrainer() {
  const mode = state.trainer.mode || "vertical";
  state.trainer = newTrainerState(mode);
  if (document.pointerLockElement) document.exitPointerLock?.();
  $("trainerState").textContent = "准备开始";
  $("trainerState").classList.remove("warning");
  $("trainerStart").textContent = "开始训练";
  $("canvasHint").textContent = "点击开始后，把准星保持在目标区内";
  $("canvasHint").classList.remove("hidden");
  $("trainerScore").textContent = "--";
  $("trainerScoreLabel").textContent = "等待输入";
  $("metricV").textContent = "--";
  $("metricH").textContent = "--";
  $("metricS").textContent = "--";
  $("metricR").textContent = "--";
  $("saveTrainerResult").disabled = true;
  drawTrainer();
}

async function startTrainer() {
  if (state.trainer.running) return finishTrainer();
  try {
    const mode = state.trainer.mode || "vertical";
    const config = await call("run_diagnostic_test", mode, { dpi: state.profile.dpi, aim: state.profile.aim, ads: state.profile.ads, calibration_factor: state.calibration?.factor || 1 });
    state.trainer = { ...newTrainerState(mode), running: true, config, startedAt: performance.now() };
    $("trainerState").textContent = `${config.duration || 20} 秒`;
    $("trainerState").classList.remove("warning");
    $("trainerStart").textContent = "结束并评分";
    $("canvasHint").classList.add("hidden");
    const lock = canvas.requestPointerLock?.();
    if (lock?.catch) lock.catch(() => {});
    requestAnimationFrame(trainerLoop);
  } catch (error) { toast(`训练启动失败：${errorMessage(error)}`); }
}

function handleTrainerMove(event) {
  if (!state.trainer.running) return;
  const scale = Number(state.trainer.config?.scale || 1);
  const dx = Number(event.movementX || 0) * scale;
  const dy = Number(event.movementY || 0) * scale;
  state.trainer.x = clamp(state.trainer.x + dx, 20, canvas.width - 20);
  state.trainer.y = clamp(state.trainer.y + dy, 20, canvas.height - 20);
  if (dx || dy) {
    state.trainer.jerk += Math.abs(dx - state.trainer.lastDx) + Math.abs(dy - state.trainer.lastDy);
    state.trainer.movementEvents += 1;
    state.trainer.lastDx = dx;
    state.trainer.lastDy = dy;
    state.trainer.path.push([state.trainer.x, state.trainer.y]);
    if (state.trainer.path.length > 240) state.trainer.path.shift();
  }
}

function trainerLoop(nowTime) {
  if (!state.trainer.running) return;
  const elapsed = nowTime - state.trainer.startedAt;
  const width = canvas.width;
  const height = canvas.height;
  if (state.trainer.mode === "vertical") {
    const phase = (elapsed % 4500) / 4500;
    state.trainer.targetY = height - 70 - phase * (height - 140);
    state.trainer.targetX = width / 2 + Math.sin(elapsed / 430) * 28;
  } else if (state.trainer.mode === "horizontal") {
    state.trainer.targetX = width / 2 + Math.sin(elapsed / 620) * 270;
    state.trainer.targetY = height / 2 + Math.sin(elapsed / 1050) * 45;
  } else {
    state.trainer.targetX = width / 2 + Math.sin(elapsed / 500) * 180;
    state.trainer.targetY = height / 2 + Math.cos(elapsed / 680) * 120;
  }
  const xError = Math.abs(state.trainer.x - state.trainer.targetX);
  const yError = Math.abs(state.trainer.y - state.trainer.targetY);
  const distance = Math.hypot(xError, yError);
  state.trainer.samples += 1;
  state.trainer.sumXError += xError;
  state.trainer.sumYError += yError;
  if (distance <= (state.trainer.mode === "micro" ? 30 : 46)) state.trainer.withinTarget += 1;
  const durationMs = Number(state.trainer.config?.duration || 20) * 1000;
  $("trainerState").textContent = `${Math.max(0, Math.ceil((durationMs - elapsed) / 1000))} 秒`;
  drawTrainer();
  if (elapsed >= durationMs) finishTrainer(true); else requestAnimationFrame(trainerLoop);
}

function finishTrainer(force = false) {
  if (!state.trainer.running) return;
  const elapsed = performance.now() - state.trainer.startedAt;
  if (!force && elapsed < MIN_TRAINING_MS) {
    const wait = Math.ceil((MIN_TRAINING_MS - elapsed) / 1000);
    $("trainerState").textContent = `至少再测 ${wait} 秒`;
    $("trainerState").classList.add("warning");
    toast(`至少训练 5 秒后才能评分，还需 ${wait} 秒`);
    return;
  }
  state.trainer.running = false;
  if (document.pointerLockElement) document.exitPointerLock?.();
  const samples = Math.max(1, state.trainer.samples);
  const avgX = state.trainer.sumXError / samples;
  const avgY = state.trainer.sumYError / samples;
  const retention = clamp((state.trainer.withinTarget / samples) * 100, 0, 100);
  const vertical = clamp(1 + avgY / 55, 1, 5);
  const horizontal = clamp(1 + avgX / 65, 1, 5);
  const averageJerk = state.trainer.movementEvents ? state.trainer.jerk / state.trainer.movementEvents : 40;
  const shake = clamp(1 + averageJerk / 9, 1, 5);
  const smoothness = clamp(6 - shake, 1, 5);
  const stability = clamp(6 - (vertical + horizontal + shake) / 3, 1, 5);
  const score = clamp(Math.round(retention * 0.72 + stability * 5.6), 0, 100);
  state.trainer.result = { score, vertical, horizontal, shake, smoothness, stability, retention, elapsed: Math.round(elapsed), mode: state.trainer.mode };
  $("trainerState").textContent = "本轮完成";
  $("trainerState").classList.remove("warning");
  $("trainerStart").textContent = "再测一次";
  $("trainerScore").textContent = String(score);
  $("trainerScoreLabel").textContent = score >= 75 ? "控制趋势稳定" : score >= 50 ? "有可调空间" : "需要拆分问题";
  $("metricV").textContent = vertical.toFixed(1);
  $("metricH").textContent = horizontal.toFixed(1);
  $("metricS").textContent = smoothness.toFixed(1);
  $("metricR").textContent = `${Math.round(retention)}%`;
  $("saveTrainerResult").disabled = false;
  drawTrainer();
}

async function saveTrainerResult() {
  const result = state.trainer.result;
  if (!result) return toast("请先完成一次训练");
  try {
    if (!state.session || Number(state.session.profile_id) !== Number(state.profile.id)) {
      state.session = await call("create_session", { profile_id: state.profile.id, title: `2D 诊断 · ${({ vertical: "垂直压枪", horizontal: "横向稳定", micro: "跟枪微调" })[result.mode]}`, weapon: "Beryl", scope: "红点", distance: 50, magazines: 5, variable: "none" });
      state.session.trials = [];
    }
    const trialNumber = Number(state.session.trials?.length || state.session.trial_count || 0) + 1;
    await call("save_trial", {
      session_id: state.session.id,
      trial_number: trialNumber,
      source: "diagnostic",
      mode: result.mode,
      metrics: { vertical_control: result.vertical, horizontal_drift: result.horizontal, shake: result.shake, stability: result.stability, score: result.score, retention: result.retention, overcompensation: false },
      notes: `2D 诊断得分 ${result.score}，目标保持率 ${Math.round(result.retention)}%`,
      variable: "none",
    });
    await refreshCurrentSession(true);
    $("saveTrainerResult").disabled = true;
    toast("训练结果已保存到当前会话");
  } catch (error) { toast(`保存训练结果失败：${errorMessage(error)}`); }
}

function drawTrainer() {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0c0f11";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255,255,255,.055)";
  ctx.lineWidth = 1;
  for (let x = 20; x < width; x += 45) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 20; y < height; y += 45) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  ctx.strokeStyle = "rgba(255,148,77,.18)";
  ctx.beginPath(); ctx.moveTo(width / 2, 0); ctx.lineTo(width / 2, height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
  const radius = state.trainer.mode === "micro" ? 20 : 34;
  ctx.fillStyle = "rgba(255,148,77,.13)";
  ctx.beginPath(); ctx.arc(state.trainer.targetX, state.trainer.targetY, radius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#ff944d";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(state.trainer.targetX, state.trainer.targetY, radius, 0, Math.PI * 2); ctx.stroke();
  if (state.trainer.path.length > 1) {
    ctx.strokeStyle = "rgba(158,226,182,.75)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    state.trainer.path.forEach((point, index) => index ? ctx.lineTo(point[0], point[1]) : ctx.moveTo(point[0], point[1]));
    ctx.stroke();
  }
  ctx.strokeStyle = "#eef1f0";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(state.trainer.x - 10, state.trainer.y); ctx.lineTo(state.trainer.x + 10, state.trainer.y);
  ctx.moveTo(state.trainer.x, state.trainer.y - 10); ctx.lineTo(state.trainer.x, state.trainer.y + 10);
  ctx.stroke();
}

async function exportCurrent(format) {
  if (!state.session) return toast("当前没有会话");
  try { toast(`已导出：${await call("export_session", state.session.id, format)}`); }
  catch (error) { toast(`导出失败：${errorMessage(error)}`); }
}

async function importJson() {
  if (!window.pywebview?.api?.pick_import_file) return toast("桌面版中可使用文件选择器导入 JSON");
  try {
    const path = await call("pick_import_file");
    if (!path) return;
    state.session = await call("import_session", path);
    state.data = await call("load_profiles");
    const importedProfile = state.data.profiles.find((item) => Number(item.id) === Number(state.session.profile_id));
    if (importedProfile) fillProfile(importedProfile);
    applyCalibration(state.data.calibrations[String(state.profile.id)]);
    renderHistory();
    toast("会话和参数方案已导入");
  } catch (error) { toast(`导入失败：${errorMessage(error)}`); }
}

async function resetPreviewData() {
  if (!confirm("清空浏览器预览中的方案、校准和测试记录，并恢复默认参数？")) return;
  try {
    await call("reset_preview_data");
    state.data = await call("load_profiles");
    state.session = null;
    fillProfile(state.data.profiles[0] || { id: 1, ...DEFAULT });
    applyCalibration(null);
    $("historyFilter").value = "";
    renderProfileSwitcher();
    renderHistory();
    renderDashboard();
    renderFieldSession();
    toast("浏览器预览数据已恢复默认");
  } catch (error) { toast(`清理失败：${errorMessage(error)}`); }
}

async function boot() {
  if (state.booted) return;
  state.booted = true;
  try {
    state.data = await call("load_profiles");
    const profile = state.data.profiles[0] || { id: 1, ...DEFAULT };
    fillProfile(profile);
    applyCalibration(state.data.calibrations[String(profile.id)]);
    const summary = state.data.sessions.find((item) => Number(item.profile_id) === Number(profile.id));
    state.session = summary ? await call("get_session", summary.id) : null;
    state.trainer = newTrainerState("vertical");
    renderDashboard();
    renderFieldSession();
    renderProfileSwitcher();
    drawTrainer();
    if (!window.pywebview?.api) {
      $("connectionStatus").classList.add("preview");
      $("connectionStatus").lastChild.textContent = "浏览器预览模式";
      $("resetPreview").classList.remove("hidden");
    }
  } catch (error) {
    state.booted = false;
    toast(`初始化失败：${errorMessage(error)}`);
  }
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => go(button.dataset.view)));
  $$('[data-go]').forEach((button) => button.addEventListener("click", () => go(button.dataset.go)));
  $("quickNewSession").addEventListener("click", () => go("field"));
  $("profileSelect").addEventListener("change", async (event) => {
    try { await selectProfile(Number(event.target.value)); }
    catch (error) { toast(`切换失败：${errorMessage(error)}`); }
  });
  $("profileForm").addEventListener("submit", saveProfile);
  $("duplicateProfile").addEventListener("click", duplicateProfile);
  $("calibrationForm").addEventListener("submit", saveCalibration);
  ["calDistance", "calDegrees"].forEach((id) => $(id).addEventListener("input", updateCalibrationPreview));
  ["weapon", "scope", "distance"].forEach((id) => $(id).addEventListener("input", updateSessionSummary));
  $("sessionTitle").addEventListener("input", () => { $("sessionTitle").dataset.edited = "true"; });
  $("sessionForm").addEventListener("submit", createSession);
  $("trialForm").addEventListener("submit", saveTrial);
  $("newSessionFromTrial").addEventListener("click", () => { state.session = null; renderFieldSession(); });
  $("trainerStart").addEventListener("click", startTrainer);
  $("trainerReset").addEventListener("click", resetTrainer);
  $("saveTrainerResult").addEventListener("click", saveTrainerResult);
  $$(".mode-tab").forEach((button) => button.addEventListener("click", () => trainerMode(button.dataset.mode)));
  document.addEventListener("mousemove", handleTrainerMove);
  $("exportJson").addEventListener("click", () => exportCurrent("json"));
  $("exportCsv").addEventListener("click", () => exportCurrent("csv"));
  $("importJson").addEventListener("click", importJson);
  $("historyFilter").addEventListener("input", renderHistory);
  $("resetPreview").addEventListener("click", resetPreviewData);
}

function upgradeLinkedFlowMarkup() {
  const variableDetails = $("variable")?.closest("details");
  if (variableDetails) variableDetails.outerHTML = `<details class="advanced-session"><summary>选择调试方式</summary><p class="field-helper">默认综合联动：允许对相关参数做一组小幅候选，再整体比较。逐步排查：一次只动一个参数，适合你已明确问题方向时使用。</p><label>调试方式<select id="strategy"><option value="linked" selected>综合联动（推荐）</option><option value="guided">逐步排查</option></select></label></details>`;
  const sceneDetails = $$(".advanced-session")[0];
  const sceneSummary = $$(".scene-summary")[0];
  if (sceneDetails && sceneSummary && !$("posture")) sceneSummary.insertAdjacentHTML("afterend", `<div class="fixed-conditions"><label>测试姿势<select id="posture"><option selected>站姿</option><option>蹲姿</option><option>卧姿</option></select></label><label>实际使用的配件（每轮保持相同）<input id="attachments" required placeholder="例如：补偿器 + 垂直握把 + 枪托；无配件请填“无”" /></label><small>这是比较有效的前提：基准和候选用同一姿势、同一套配件。</small></div>`);
  const hint = $("trialHint");
  if (hint && !$("phaseNotice")) hint.insertAdjacentHTML("afterend", `<div class="phase-notice" id="phaseNotice"><strong>本轮阶段</strong><span>先创建会话。</span></div><label class="candidate-applied hidden" id="candidateApplyWrap"><input id="candidateApplied" type="checkbox" /> 我已在 PUBG 手动应用上面的候选设置</label><div class="impact-grid"><label>弹着中心相对瞄准点<select id="impactDirection" required><option value="center">居中</option><option value="up">偏上</option><option value="down">偏下</option><option value="left">偏左</option><option value="right">偏右</option></select><small>看约 5 个弹匣弹着点的整体中心，不记单发。</small></label><label>散布大小（1–5）<select id="impactSpread" required><option value="1">1 · 很集中</option><option value="2">2 · 较集中</option><option value="3" selected>3 · 一般</option><option value="4">4 · 较分散</option><option value="5">5 · 很分散</option></select><small>每轮尽量用同一靶位/距离比较。</small></label></div>`);
  const oldRedDot = $("scopeRedDot")?.closest("label");
  if (oldRedDot) oldRedDot.remove();
  const scopeGrid = $$(".scope-grid")[0];
  if (scopeGrid) {
    scopeGrid.classList.remove("seven");
    if (!$("redDotMappingNote")) scopeGrid.insertAdjacentHTML("beforebegin", `<p class="mapping-note" id="redDotMappingNote">红点 / 全息按截图暂以“开镜模式灵敏度 46”作为起始映射，进游戏核实后再测。旧档案中的红点 44 保留作兼容记录，不用于本工具推荐。</p>`);
  }
  const scopeSelect = $("scope");
  if (scopeSelect) ["6倍", "8倍", "15倍"].forEach((scope) => {
    if (![...scopeSelect.options].some((option) => option.value === scope || option.textContent === scope)) scopeSelect.add(new Option(scope, scope));
  });
  const phaseLabel = $("trialNumber")?.parentElement;
  if (phaseLabel && !$("trialPhaseLabel")) phaseLabel.insertAdjacentHTML("beforeend", ` · <span id="trialPhaseLabel">基准</span>`);
  const fieldIntro = $("view-field")?.querySelector(".view-head p");
  if (fieldIntro) fieldIntro.textContent = "先测当前完整方案，再与候选方案在相同条件下比较；命中表现优先，手感用于检查取舍。";
  const guideSteps = $$(".field-guide-steps span");
  if (guideSteps.length >= 3) {
    guideSteps[0].textContent = "1 固定场景与方案";
    guideSteps[1].textContent = "2 PUBG 每组打 5 弹匣";
    guideSteps[2].textContent = "3 记录弹着与手感";
  }
  if ($("dashboardPrimary")) $("dashboardPrimary").textContent = "开始基准测试";
  const oldClaim = $$("#view-dashboard .view-head p")[0];
  if (oldClaim) oldClaim.textContent = "先用当前完整参数建立基准，再比较候选方案的命中表现和手感取舍。";
}

document.addEventListener("DOMContentLoaded", () => {
  upgradeLinkedFlowMarkup();
  bindEvents();
  if (window.pywebview?.api) boot(); else setTimeout(boot, 450);
});
window.addEventListener("pywebviewready", boot);
window.addEventListener("unhandledrejection", (event) => {
  console.error(event.reason);
  toast(`操作失败：${errorMessage(event.reason)}`);
});
