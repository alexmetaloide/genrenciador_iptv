"use strict";

const STORAGE_KEY = "iptv_clientes_legal_v1";
const SESSION_KEY = "iptv_clientes_legal_session";
const SUPABASE_CONFIG_KEY = "iptv_clientes_supabase_config";
const LOCAL_MODE_KEY = "iptv_clientes_force_local";
const THEME_KEY = "iptv_clientes_theme";
const ONE_DAY = 24 * 60 * 60 * 1000;

const navItems = [
  ["dashboard", "D", "Dashboard"],
  ["clients", "C", "Clientes"],
  ["expirations", "V", "Vencimentos"],
  ["finance", "F", "Financeiro"],
  ["plans", "P", "Planos"],
  ["messages", "M", "Mensagens"],
  ["reports", "R", "Relatórios"],
  ["settings", "A", "Ajustes"],
];

const defaultTemplates = {
  dueToday:
    "Olá, {nome}. Seu plano {plano} vence hoje ({vencimento}). Valor: {valor}. Para renovar, é só me chamar por aqui. {empresa}",
  overdue:
    "Olá, {nome}. Identifiquei que seu plano {plano} venceu em {vencimento}. Valor da renovação: {valor}. Posso te ajudar a regularizar? {empresa}",
  confirmation:
    "Olá, {nome}. Pagamento de {valor} confirmado. Seu plano {plano} está ativo até {vencimento}. Obrigado. {empresa}",
  renewal:
    "Olá, {nome}. Sua renovação do plano {plano} foi registrada. Novo vencimento: {vencimento}. {empresa}",
};

const templateLabels = {
  dueToday: "Vence hoje",
  overdue: "Vencido",
  confirmation: "Confirmação de pagamento",
  renewal: "Renovação",
};

const app = document.getElementById("app");

let state = createBlankState();
let logged = false;
let toastTimer = null;
let bootReady = false;
let supabaseClient = null;
let supabaseSession = null;
let cloudSaveTimer = null;
let cloudSaveInFlight = false;
let suppressCloudSave = false;
let cloudStatus = "";
let deferredInstallPrompt = null;

const ui = {
  view: "dashboard",
  modal: null,
  clientSearch: "",
  clientStatus: "all",
  clientPlan: "all",
  clientDue: "all",
  expirationMode: "today",
  financeStatus: "all",
  financeStart: startOfMonthISO(),
  financeEnd: endOfMonthISO(),
  reportStart: startOfMonthISO(),
  reportEnd: endOfMonthISO(),
  messageClientId: "",
  messageType: "dueToday",
};

bindEvents();
boot();

function bindEvents() {
  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("change", handleChange);
  document.addEventListener("input", handleInput);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    render();
  });
  if (window.matchMedia) {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => {
      if (getThemePreference() === "system") applyTheme("system");
    };
    if (colorScheme.addEventListener) {
      colorScheme.addEventListener("change", syncSystemTheme);
    } else if (colorScheme.addListener) {
      colorScheme.addListener(syncSystemTheme);
    }
  }
}

async function boot() {
  applyTheme(getThemePreference());
  registerServiceWorker();
  state = loadState();
  logged = sessionStorage.getItem(SESSION_KEY) === "1";
  await initSupabaseClient();
  if (shouldUseCloudAuth() && supabaseClient) {
    await restoreCloudSession();
  }
  bootReady = true;
  render();
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createBlankState();
  try {
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    return createBlankState();
  }
}

function createBlankState() {
  return {
    meta: {
      initialized: false,
      userName: "",
      passwordHash: "",
      createdAt: new Date().toISOString(),
    },
    settings: {
      companyName: "Minha IPTV Legal",
      ownerName: "",
      defaultMethod: "Pix",
      maskPhones: false,
      templates: { ...defaultTemplates },
    },
    plans: [],
    clients: [],
    payments: [],
    auditLogs: [],
  };
}

function normalizeState(value) {
  const blank = createBlankState();
  return {
    ...blank,
    ...value,
    meta: { ...blank.meta, ...(value.meta || {}) },
    settings: {
      ...blank.settings,
      ...(value.settings || {}),
      templates: { ...defaultTemplates, ...((value.settings || {}).templates || {}) },
    },
    plans: Array.isArray(value.plans) ? value.plans : [],
    clients: Array.isArray(value.clients) ? value.clients : [],
    payments: Array.isArray(value.payments) ? value.payments : [],
    auditLogs: Array.isArray(value.auditLogs) ? value.auditLogs : [],
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (isCloudActive() && !suppressCloudSave) queueCloudSave();
}

function getSupabaseConfig() {
  const raw = localStorage.getItem(SUPABASE_CONFIG_KEY);
  if (raw) {
    try {
      const config = JSON.parse(raw);
      if (isValidSupabaseConfig(config)) return normalizeSupabaseConfig(config);
    } catch {
      return null;
    }
  }
  const bundled = window.IPTV_SUPABASE_CONFIG;
  return isValidSupabaseConfig(bundled) ? normalizeSupabaseConfig(bundled) : null;
}

function isValidSupabaseConfig(config) {
  return Boolean(
    config &&
      typeof config.url === "string" &&
      typeof config.anonKey === "string" &&
      config.url.trim().startsWith("https://") &&
      config.url.includes(".supabase.co") &&
      config.anonKey.trim().length > 20,
  );
}

function normalizeSupabaseConfig(config) {
  return {
    url: config.url.trim().replace(/\/+$/, ""),
    anonKey: config.anonKey.trim(),
  };
}

function setSupabaseConfig(config) {
  localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(config));
  sessionStorage.removeItem(LOCAL_MODE_KEY);
}

function hasSupabaseConfig() {
  return Boolean(getSupabaseConfig());
}

function isLocalModeForced() {
  return sessionStorage.getItem(LOCAL_MODE_KEY) === "1";
}

function shouldUseCloudAuth() {
  return hasSupabaseConfig() && !isLocalModeForced();
}

function isCloudActive() {
  return Boolean(supabaseClient && supabaseSession && !isLocalModeForced());
}

async function initSupabaseClient() {
  const config = getSupabaseConfig();
  supabaseClient = null;
  supabaseSession = null;
  cloudStatus = "";
  if (!config || isLocalModeForced()) return;
  if (!window.supabase || !window.supabase.createClient) {
    cloudStatus = "Biblioteca do Supabase nao carregada. Verifique a conexao.";
    return;
  }
  try {
    supabaseClient = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  } catch {
    cloudStatus = "Nao foi possivel iniciar a conexao Supabase.";
  }
}

async function restoreCloudSession() {
  if (!supabaseClient) return;
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    cloudStatus = error.message;
    return;
  }
  supabaseSession = data.session || null;
  logged = Boolean(supabaseSession);
  if (logged) {
    sessionStorage.setItem(SESSION_KEY, "1");
    await loadFromSupabase();
  } else {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

async function loadFromSupabase() {
  if (!isCloudActive()) return;
  const userId = supabaseSession.user.id;
  try {
    const [settingsRes, plansRes, clientsRes, paymentsRes, templatesRes, auditRes] = await Promise.all([
      supabaseClient.from("app_settings").select("*").eq("user_id", userId).maybeSingle(),
      supabaseClient.from("plans").select("*").eq("user_id", userId).order("created_at", { ascending: true }),
      supabaseClient.from("clients").select("*").eq("user_id", userId).order("due_date", { ascending: true }),
      supabaseClient.from("payments").select("*").eq("user_id", userId).order("created_at", { ascending: true }),
      supabaseClient.from("message_templates").select("*").eq("user_id", userId),
      supabaseClient.from("audit_logs").select("*").eq("user_id", userId).order("created_at", { ascending: true }).limit(500),
    ]);
    [settingsRes, plansRes, clientsRes, paymentsRes, templatesRes, auditRes].forEach((res) => {
      if (res.error) throw res.error;
    });

    const templates = { ...defaultTemplates };
    (templatesRes.data || []).forEach((row) => {
      templates[row.type] = row.body;
    });
    const settings = settingsRes.data
      ? {
          companyName: settingsRes.data.company_name || "Minha IPTV Legal",
          ownerName: settingsRes.data.owner_name || "",
          defaultMethod: settingsRes.data.default_method || "Pix",
          maskPhones: Boolean(settingsRes.data.mask_phones),
          templates,
        }
      : { ...createBlankState().settings, templates };

    const loaded = normalizeState({
      meta: {
        initialized: true,
        userName: supabaseSession.user.email || "supabase",
        passwordHash: "",
        createdAt: new Date().toISOString(),
      },
      settings,
      plans: (plansRes.data || []).map(planFromRow),
      clients: (clientsRes.data || []).map(clientFromRow),
      payments: (paymentsRes.data || []).map(paymentFromRow),
      auditLogs: (auditRes.data || []).map(auditFromRow),
    });

    suppressCloudSave = true;
    state = loaded;
    if (!state.plans.length && !state.clients.length && !state.payments.length) {
      seedBase(false);
      addAudit("sistema", "starter", "Planos iniciais criados");
      suppressCloudSave = false;
      await syncAllToSupabase();
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      suppressCloudSave = false;
    }
    cloudStatus = "Sincronizado com Supabase.";
  } catch (error) {
    cloudStatus = `Erro Supabase: ${error.message || error}`;
  }
}

function queueCloudSave() {
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => {
    syncAllToSupabase().catch((error) => {
      cloudStatus = `Erro ao sincronizar: ${error.message || error}`;
      showToast(cloudStatus);
    });
  }, 450);
}

async function syncAllToSupabase() {
  if (!isCloudActive() || cloudSaveInFlight) return;
  cloudSaveInFlight = true;
  const userId = supabaseSession.user.id;
  try {
    await upsertOrThrow("app_settings", [settingsToRow(userId)], "user_id");
    await upsertOrThrow("plans", state.plans.map((item) => planToRow(item, userId)));
    await deleteMissingRows("plans", state.plans.map((item) => item.id));
    await upsertOrThrow("clients", state.clients.map((item) => clientToRow(item, userId)));
    await deleteMissingRows("clients", state.clients.map((item) => item.id));
    await upsertOrThrow("payments", state.payments.map((item) => paymentToRow(item, userId)));
    await deleteMissingRows("payments", state.payments.map((item) => item.id));
    await upsertOrThrow(
      "message_templates",
      Object.entries(state.settings.templates || {}).map(([type, body]) => ({
        user_id: userId,
        type,
        body,
        updated_at: new Date().toISOString(),
      })),
      "user_id,type",
    );
    await upsertOrThrow("audit_logs", state.auditLogs.map((item) => auditToRow(item, userId)));
    await deleteMissingRows("audit_logs", state.auditLogs.map((item) => item.id));
    cloudStatus = `Sincronizado em ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`;
  } finally {
    cloudSaveInFlight = false;
  }
}

async function upsertOrThrow(table, rows, onConflict = "id") {
  if (!rows.length) return;
  const { error } = await supabaseClient.from(table).upsert(rows, { onConflict });
  if (error) throw error;
}

async function deleteMissingRows(table, ids) {
  const userId = supabaseSession.user.id;
  let query = supabaseClient.from(table).delete().eq("user_id", userId);
  if (ids.length) query = query.not("id", "in", `(${ids.join(",")})`);
  const { error } = await query;
  if (error) throw error;
}

function settingsToRow(userId) {
  return {
    user_id: userId,
    company_name: state.settings.companyName || "Minha IPTV Legal",
    owner_name: state.settings.ownerName || "",
    default_method: state.settings.defaultMethod || "Pix",
    mask_phones: Boolean(state.settings.maskPhones),
    updated_at: new Date().toISOString(),
  };
}

function planToRow(plan, userId) {
  return {
    id: plan.id,
    user_id: userId,
    name: plan.name,
    price: Number(plan.price || 0),
    duration_months: Number(plan.durationMonths || 1),
    screens: Number(plan.screens || 1),
    notes: plan.notes || "",
    active: plan.active !== false,
    created_at: plan.createdAt || new Date().toISOString(),
    updated_at: plan.updatedAt || new Date().toISOString(),
  };
}

function planFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    price: Number(row.price || 0),
    durationMonths: Number(row.duration_months || 1),
    screens: Number(row.screens || 1),
    notes: row.notes || "",
    active: row.active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clientToRow(client, userId) {
  return {
    id: client.id,
    user_id: userId,
    name: client.name,
    phone: client.phone,
    email: client.email || "",
    plan_id: client.planId || null,
    monthly_value: Number(client.monthlyValue || 0),
    due_date: client.dueDate,
    status: client.status || "active",
    notes: client.notes || "",
    created_at: client.createdAt || new Date().toISOString(),
    updated_at: client.updatedAt || new Date().toISOString(),
  };
}

function clientFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email || "",
    planId: row.plan_id || "",
    monthlyValue: Number(row.monthly_value || 0),
    dueDate: row.due_date,
    status: row.status || "active",
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function paymentToRow(payment, userId) {
  return {
    id: payment.id,
    user_id: userId,
    client_id: payment.clientId,
    amount: Number(payment.amount || 0),
    status: payment.status || "received",
    method: payment.method || "",
    due_date: payment.dueDate || todayISO(),
    paid_at: payment.paidAt || null,
    notes: payment.notes || "",
    created_at: payment.createdAt || new Date().toISOString(),
    updated_at: payment.updatedAt || new Date().toISOString(),
  };
}

function paymentFromRow(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    amount: Number(row.amount || 0),
    status: row.status || "received",
    method: row.method || "",
    dueDate: row.due_date,
    paidAt: row.paid_at || "",
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditToRow(log, userId) {
  return {
    id: log.id,
    user_id: userId,
    entity: log.entity,
    entity_id: log.entityId || "",
    action: log.action,
    summary: log.summary,
    old_data: log.oldData,
    new_data: log.newData,
    created_at: log.at || new Date().toISOString(),
  };
}

function auditFromRow(row) {
  return {
    id: row.id,
    entity: row.entity,
    entityId: row.entity_id,
    action: row.action,
    summary: row.summary,
    oldData: row.old_data,
    newData: row.new_data,
    at: row.created_at,
  };
}

function seedBase(includeDemo) {
  const now = new Date().toISOString();
  const p1 = {
    id: uid(),
    name: "Mensal 1 tela",
    price: 35,
    durationMonths: 1,
    screens: 1,
    notes: "Plano mensal padrão",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const p2 = {
    id: uid(),
    name: "Mensal 2 telas",
    price: 55,
    durationMonths: 1,
    screens: 2,
    notes: "",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const p3 = {
    id: uid(),
    name: "Trimestral 1 tela",
    price: 95,
    durationMonths: 3,
    screens: 1,
    notes: "Renovação a cada 3 meses",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  state.plans = [p1, p2, p3];

  if (includeDemo) {
    const clients = [
      {
        name: "Cliente Ativo",
        phone: "11999999999",
        email: "ativo@email.com",
        planId: p1.id,
        monthlyValue: 35,
        dueDate: addDaysISO(todayISO(), 18),
        status: "active",
        notes: "",
      },
      {
        name: "Cliente Vence Hoje",
        phone: "11988888888",
        email: "",
        planId: p2.id,
        monthlyValue: 55,
        dueDate: todayISO(),
        status: "active",
        notes: "",
      },
      {
        name: "Cliente Vencido",
        phone: "11977777777",
        email: "",
        planId: p1.id,
        monthlyValue: 35,
        dueDate: addDaysISO(todayISO(), -4),
        status: "active",
        notes: "Aguardar retorno",
      },
      {
        name: "Cliente Teste",
        phone: "11966666666",
        email: "",
        planId: p1.id,
        monthlyValue: 0,
        dueDate: addDaysISO(todayISO(), 2),
        status: "trial",
        notes: "Teste autorizado",
      },
    ];
    state.clients = clients.map((client) => ({
      ...client,
      id: uid(),
      createdAt: now,
      updatedAt: now,
    }));
    const activeClient = state.clients[0];
    state.payments = [
      {
        id: uid(),
        clientId: activeClient.id,
        amount: 35,
        status: "received",
        method: "Pix",
        dueDate: addDaysISO(todayISO(), -12),
        paidAt: addDaysISO(todayISO(), -12),
        notes: "Pagamento inicial",
        createdAt: now,
      },
    ];
  }
}

function render(options = {}) {
  const focus = options.preserveFocus ? captureFocus() : null;

  if (!bootReady) {
    app.innerHTML = `
      <div class="auth-page">
        <section class="auth-panel">
          <div class="auth-mark">IP</div>
          <h1>Clientes IPTV Legal</h1>
          <p>Carregando sistema...</p>
        </section>
      </div>
    `;
    return;
  }

  if (!state.meta.initialized || !logged) {
    app.innerHTML = renderAuth();
    return;
  }

  app.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}
      <main class="main" id="main">${renderView()}</main>
      ${renderBottomNav()}
      ${renderModal()}
      <input class="sr-only" id="backup-import" type="file" accept="application/json" />
    </div>
  `;

  restoreFocus(focus);
}

function renderAuth() {
  if (shouldUseCloudAuth()) return renderCloudAuth();

  if (!state.meta.initialized) {
    return `
      <div class="auth-page">
        <section class="auth-panel">
          <div class="auth-mark">IP</div>
          <h1>Clientes IPTV Legal</h1>
          <p>Crie o acesso inicial para começar a gerenciar clientes, vencimentos, pagamentos e renovações.</p>
          <form id="setup-form" class="grid">
            <label class="field">
              <span>Nome do usuário</span>
              <input id="setup-user" name="userName" autocomplete="username" required />
            </label>
            <label class="field">
              <span>Senha</span>
              <input id="setup-password" name="password" type="password" autocomplete="new-password" minlength="6" required />
            </label>
            <label class="check-line">
              <input name="demo" type="checkbox" />
              <span>Incluir dados de demonstração</span>
            </label>
            <button class="btn primary" type="submit">Criar acesso</button>
          </form>
          ${renderCloudConfigPanel()}
        </section>
      </div>
    `;
  }

  return `
    <div class="auth-page">
      <section class="auth-panel">
        <div class="auth-mark">IP</div>
        <h2>Entrar</h2>
        <p>${esc(state.settings.companyName)}</p>
        <form id="login-form" class="grid">
          <label class="field">
            <span>Usuário</span>
            <input id="login-user" name="userName" autocomplete="username" value="${esc(state.meta.userName)}" required />
          </label>
          <label class="field">
            <span>Senha</span>
            <input id="login-password" name="password" type="password" autocomplete="current-password" required />
          </label>
          <button class="btn primary" type="submit">Entrar</button>
        </form>
        ${renderCloudConfigPanel()}
      </section>
    </div>
  `;
}

function renderCloudAuth() {
  const config = getSupabaseConfig();
  return `
    <div class="auth-page">
      <section class="auth-panel">
        <div class="auth-mark">IP</div>
        <h2>Entrar com Supabase</h2>
        <p>Use o e-mail e senha da sua conta. Os dados ficam no Supabase e podem ser acessados pelo celular e computador.</p>
        ${cloudStatus ? `<p class="badge neutral">${esc(cloudStatus)}</p>` : ""}
        <form id="cloud-login-form" class="grid">
          <label class="field">
            <span>E-mail</span>
            <input name="email" type="email" autocomplete="email" required />
          </label>
          <label class="field">
            <span>Senha</span>
            <input name="password" type="password" autocomplete="current-password" minlength="6" required />
          </label>
          <div class="toolbar-actions">
            <button class="btn primary" name="intent" value="login" type="submit">Entrar</button>
            <button class="btn" name="intent" value="signup" type="submit">Criar conta</button>
          </div>
        </form>
        <div class="grid" style="margin-top: 14px">
          <p class="muted">Projeto conectado: ${esc(config ? config.url : "")}</p>
          <div class="toolbar-actions">
            <button class="btn ghost" data-action="use-local-auth" type="button">Usar modo local</button>
            <button class="btn ghost" data-action="forget-supabase-config" type="button">Trocar Supabase</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderCloudConfigPanel() {
  const config = getSupabaseConfig() || { url: "", anonKey: "" };
  return `
    <div class="inline-config">
      <div class="panel-header">
        <h2>Conectar Supabase</h2>
      </div>
      <form id="cloud-config-form" class="grid">
        <label class="field">
          <span>Project URL</span>
          <input name="url" value="${esc(config.url)}" placeholder="https://xxxx.supabase.co" required />
        </label>
        <label class="field">
          <span>Anon public key ou publishable key</span>
          <input name="anonKey" value="${esc(config.anonKey)}" placeholder="eyJ... ou sb_publishable_..." required />
        </label>
        <button class="btn primary" type="submit">Salvar e usar Supabase</button>
      </form>
    </div>
  `;
}

function renderSidebar() {
  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-logo">IP</div>
        <div>
          <span class="brand-name">${esc(state.settings.companyName)}</span>
          <span class="brand-subtitle">Gestão de clientes</span>
        </div>
      </div>
      <nav class="nav" aria-label="Menu principal">
        ${navItems.map(([id, icon, label]) => navButton(id, icon, label)).join("")}
      </nav>
      <div class="sidebar-footer">
        <button class="btn ghost" data-action="lock">Bloquear</button>
      </div>
    </aside>
  `;
}

function renderBottomNav() {
  const ids = ["dashboard", "clients", "expirations", "finance", "messages"];
  return `
    <nav class="bottom-nav" aria-label="Menu móvel">
      ${navItems
        .filter(([id]) => ids.includes(id))
        .map(([id, icon, label]) => navButton(id, icon, label))
        .join("")}
    </nav>
  `;
}

function navButton(id, icon, label) {
  return `
    <button class="nav-button ${ui.view === id ? "active" : ""}" data-action="nav" data-view="${id}" type="button">
      <span class="nav-icon">${icon}</span>
      <span>${label}</span>
    </button>
  `;
}

function renderView() {
  switch (ui.view) {
    case "clients":
      return renderClients();
    case "expirations":
      return renderExpirations();
    case "finance":
      return renderFinance();
    case "plans":
      return renderPlans();
    case "messages":
      return renderMessages();
    case "reports":
      return renderReports();
    case "settings":
      return renderSettings();
    default:
      return renderDashboard();
  }
}

function renderDashboard() {
  const m = getMetrics();
  const upcoming = getClientsByWindow("7").slice(0, 7);
  const overdue = getClientsByWindow("overdue").slice(0, 7);
  const byPlan = activePlans().map((plan) => {
    const count = state.clients.filter((c) => c.planId === plan.id && computedStatus(c).key !== "cancelled").length;
    return { label: plan.name, count };
  });
  const maxPlan = Math.max(1, ...byPlan.map((item) => item.count));

  return `
    <section class="section">
      ${topbar("Dashboard", "Visão geral do mês", `
        <button class="btn primary" data-action="open-client" type="button">Novo cliente</button>
        <button class="btn" data-action="open-payment" type="button">Registrar pagamento</button>
      `)}
      <div class="grid kpi-grid">
        ${metric("Clientes ativos", m.active, "primary", `${m.trial} em teste`)}
        ${metric("Vencidos", m.overdue, m.overdue ? "danger" : "", "clientes inadimplentes")}
        ${metric("Receita do mês", money(m.receivedMonth), "", "pagamentos recebidos")}
        ${metric("Receita prevista", money(m.expectedMonth), "warning", "vencimentos do mês")}
        ${metric("Vencem hoje", m.dueToday, "", "clientes para cobrar")}
        ${metric("Próximos 7 dias", m.due7, "", "sem contar vencidos")}
        ${metric("Cancelados", m.cancelled, "", "fora da previsão")}
        ${metric("Pendentes", money(m.pendingMonth), "", "pagamentos em aberto")}
      </div>
      <div class="grid two-col">
        <div class="panel">
          <div class="panel-header">
            <h2>Vencimentos próximos</h2>
            <button class="btn small" data-action="nav" data-view="expirations" type="button">Ver todos</button>
          </div>
          ${renderClientList(upcoming, { compact: true })}
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2>Receita e planos</h2>
          </div>
          <div class="progress-list">
            ${progressRow("Recebido no mês", m.receivedMonth, Math.max(m.expectedMonth, m.receivedMonth), "blue")}
            ${progressRow("Previsto no mês", m.expectedMonth, Math.max(m.expectedMonth, m.receivedMonth), "amber")}
            ${byPlan
              .map((item) => progressRow(item.label, item.count, maxPlan, ""))
              .join("")}
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Clientes vencidos</h2>
          <button class="btn small" data-action="set-expiration-mode" data-mode="overdue" type="button">Abrir lista</button>
        </div>
        ${renderClientList(overdue, { compact: true })}
      </div>
    </section>
  `;
}

function renderClients() {
  const clients = filteredClients();
  return `
    <section class="section">
      ${topbar("Clientes", `${clients.length} cliente(s) encontrados`, `
        <button class="btn primary" data-action="open-client" type="button">Novo cliente</button>
        <button class="btn" data-action="export-clients" type="button">CSV</button>
      `)}
      <div class="panel">
        <div class="filters">
          <label class="field">
            <span>Busca</span>
            <input id="client-search" data-bind="clientSearch" value="${esc(ui.clientSearch)}" placeholder="Nome, telefone ou e-mail" />
          </label>
          <label class="field">
            <span>Status</span>
            <select id="client-status" data-bind="clientStatus">
              ${option("all", "Todos", ui.clientStatus)}
              ${option("active", "Ativos", ui.clientStatus)}
              ${option("expiring", "Vencendo", ui.clientStatus)}
              ${option("overdue", "Vencidos", ui.clientStatus)}
              ${option("trial", "Teste", ui.clientStatus)}
              ${option("cancelled", "Cancelados", ui.clientStatus)}
            </select>
          </label>
          <label class="field">
            <span>Plano</span>
            <select id="client-plan" data-bind="clientPlan">
              ${option("all", "Todos", ui.clientPlan)}
              ${state.plans.map((p) => option(p.id, p.name, ui.clientPlan)).join("")}
            </select>
          </label>
          <label class="field">
            <span>Vencimento</span>
            <select id="client-due" data-bind="clientDue">
              ${option("all", "Todos", ui.clientDue)}
              ${option("today", "Hoje", ui.clientDue)}
              ${option("3", "Próximos 3 dias", ui.clientDue)}
              ${option("5", "Próximos 5 dias", ui.clientDue)}
              ${option("7", "Próximos 7 dias", ui.clientDue)}
              ${option("overdue", "Vencidos", ui.clientDue)}
              ${option("month", "Este mês", ui.clientDue)}
            </select>
          </label>
        </div>
      </div>
      ${renderClientsTable(clients)}
    </section>
  `;
}

function renderExpirations() {
  const clients = getClientsByWindow(ui.expirationMode);
  const label =
    ui.expirationMode === "overdue"
      ? "clientes vencidos"
      : ui.expirationMode === "today"
        ? "vencem hoje"
        : `vencem em até ${ui.expirationMode} dias`;
  return `
    <section class="section">
      ${topbar("Vencimentos", `${clients.length} ${label}`, `
        <button class="btn primary" data-action="open-client" type="button">Novo cliente</button>
      `)}
      <div class="segmented" role="tablist">
        ${segment("today", "Hoje", ui.expirationMode, "set-expiration-mode")}
        ${segment("3", "3 dias", ui.expirationMode, "set-expiration-mode")}
        ${segment("5", "5 dias", ui.expirationMode, "set-expiration-mode")}
        ${segment("7", "7 dias", ui.expirationMode, "set-expiration-mode")}
        ${segment("overdue", "Vencidos", ui.expirationMode, "set-expiration-mode")}
      </div>
      ${renderClientList(clients, { showNotes: true })}
    </section>
  `;
}

function renderPlans() {
  return `
    <section class="section">
      ${topbar("Planos", `${state.plans.length} plano(s) cadastrados`, `
        <button class="btn primary" data-action="open-plan" type="button">Novo plano</button>
      `)}
      <div class="grid three-col">
        ${
          state.plans.length
            ? state.plans
                .map((plan) => {
                  const clients = state.clients.filter((client) => client.planId === plan.id);
                  return `
                    <article class="item-card">
                      <div class="item-main">
                        <div>
                          <h3>${esc(plan.name)}</h3>
                          <div class="item-meta">
                            <span>${money(plan.price)}</span>
                            <span>${durationLabel(plan.durationMonths)}</span>
                            <span>${plan.screens || 1} tela(s)</span>
                          </div>
                        </div>
                        <span class="badge ${plan.active ? "active" : "neutral"}">${plan.active ? "Ativo" : "Inativo"}</span>
                      </div>
                      ${plan.notes ? `<p class="muted">${esc(plan.notes)}</p>` : ""}
                      <div class="item-meta"><span>${clients.length} cliente(s)</span></div>
                      <div class="row-actions">
                        <button class="btn small" data-action="open-plan" data-id="${plan.id}" type="button">Editar</button>
                        <button class="btn small" data-action="toggle-plan" data-id="${plan.id}" type="button">${plan.active ? "Desativar" : "Reativar"}</button>
                        <button class="btn small danger" data-action="delete-plan" data-id="${plan.id}" type="button">Excluir</button>
                      </div>
                    </article>
                  `;
                })
                .join("")
            : empty("Nenhum plano cadastrado.")
        }
      </div>
    </section>
  `;
}

function renderFinance() {
  const payments = filteredPayments();
  const totals = paymentTotals(payments);
  return `
    <section class="section">
      ${topbar("Financeiro", "Pagamentos recebidos e pendentes", `
        <button class="btn primary" data-action="open-payment" type="button">Registrar pagamento</button>
        <button class="btn" data-action="export-payments" type="button">CSV</button>
      `)}
      <div class="panel">
        <div class="finance-filters">
          <label class="field">
            <span>Início</span>
            <input id="finance-start" type="date" data-bind="financeStart" value="${esc(ui.financeStart)}" />
          </label>
          <label class="field">
            <span>Fim</span>
            <input id="finance-end" type="date" data-bind="financeEnd" value="${esc(ui.financeEnd)}" />
          </label>
          <label class="field">
            <span>Status</span>
            <select id="finance-status" data-bind="financeStatus">
              ${option("all", "Todos", ui.financeStatus)}
              ${option("received", "Recebidos", ui.financeStatus)}
              ${option("pending", "Pendentes", ui.financeStatus)}
            </select>
          </label>
          <div class="field">
            <span>&nbsp;</span>
            <button class="btn" data-action="set-finance-month" type="button">Este mês</button>
          </div>
        </div>
      </div>
      <div class="grid kpi-grid">
        ${metric("Recebido", money(totals.received), "primary", `${totals.receivedCount} pagamento(s)`)}
        ${metric("Pendente", money(totals.pending), totals.pending ? "warning" : "", `${totals.pendingCount} registro(s)`)}
        ${metric("Total lançado", money(totals.all), "", `${payments.length} registro(s)`)}
        ${metric("Inadimplentes", getClientsByWindow("overdue").length, getClientsByWindow("overdue").length ? "danger" : "", "clientes vencidos")}
      </div>
      ${renderPaymentsTable(payments)}
    </section>
  `;
}

function renderMessages() {
  const clients = state.clients.filter((client) => computedStatus(client).key !== "cancelled");
  if (!ui.messageClientId && clients[0]) ui.messageClientId = clients[0].id;
  const client = state.clients.find((item) => item.id === ui.messageClientId) || clients[0];
  const preview = client ? buildMessage(client, ui.messageType) : "";

  return `
    <section class="section">
      ${topbar("Mensagens", "WhatsApp manual", `
        <button class="btn" data-action="copy-message-preview" type="button">Copiar</button>
        <button class="btn primary" data-action="open-message-preview" type="button">Abrir WhatsApp</button>
      `)}
      <div class="grid two-col">
        <div class="panel">
          <div class="form-grid">
            <label class="field">
              <span>Cliente</span>
              <select id="message-client" data-bind="messageClientId">
                ${
                  clients.length
                    ? clients.map((c) => option(c.id, `${c.name} - ${formatPhone(c.phone)}`, ui.messageClientId)).join("")
                    : option("", "Nenhum cliente", "")
                }
              </select>
            </label>
            <label class="field">
              <span>Modelo</span>
              <select id="message-type" data-bind="messageType">
                ${Object.entries(templateLabels)
                  .map(([key, label]) => option(key, label, ui.messageType))
                  .join("")}
              </select>
            </label>
            <div class="field full">
              <span>Prévia</span>
              <div class="preview-box">${esc(preview)}</div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2>Modelos</h2>
          </div>
          <form id="templates-form" class="grid">
            ${Object.entries(templateLabels)
              .map(
                ([key, label]) => `
                  <label class="field">
                    <span>${esc(label)}</span>
                    <textarea name="${key}">${esc(state.settings.templates[key] || "")}</textarea>
                  </label>
                `,
              )
              .join("")}
            <button class="btn primary" type="submit">Salvar modelos</button>
          </form>
        </div>
      </div>
    </section>
  `;
}

function renderReports() {
  const payments = paymentsInPeriod(ui.reportStart, ui.reportEnd, "all");
  const totals = paymentTotals(payments);
  const createdClients = state.clients.filter((client) => inPeriod(dateOnly(client.createdAt), ui.reportStart, ui.reportEnd));
  const renewals = payments.filter((payment) => payment.notes && payment.notes.toLowerCase().includes("renova"));
  return `
    <section class="section">
      ${topbar("Relatórios", "Resumo por período", `
        <button class="btn" data-action="export-full-backup" type="button">Backup JSON</button>
      `)}
      <div class="panel">
        <div class="finance-filters">
          <label class="field">
            <span>Início</span>
            <input id="report-start" type="date" data-bind="reportStart" value="${esc(ui.reportStart)}" />
          </label>
          <label class="field">
            <span>Fim</span>
            <input id="report-end" type="date" data-bind="reportEnd" value="${esc(ui.reportEnd)}" />
          </label>
          <div class="field">
            <span>&nbsp;</span>
            <button class="btn" data-action="set-report-month" type="button">Este mês</button>
          </div>
          <div class="field">
            <span>&nbsp;</span>
            <button class="btn" data-action="export-period-report" type="button">CSV do período</button>
          </div>
        </div>
      </div>
      <div class="grid kpi-grid">
        ${metric("Recebido", money(totals.received), "primary", `${totals.receivedCount} pagamento(s)`)}
        ${metric("Pendente", money(totals.pending), totals.pending ? "warning" : "", `${totals.pendingCount} registro(s)`)}
        ${metric("Novos clientes", createdClients.length, "", "cadastrados no período")}
        ${metric("Renovações", renewals.length, "", "pagamentos marcados")}
      </div>
      <div class="grid two-col">
        <div class="panel">
          <div class="panel-header"><h2>Pagamentos do período</h2></div>
          ${renderPaymentsTable(payments, true)}
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Auditoria recente</h2></div>
          ${renderAuditList(state.auditLogs.slice(-12).reverse())}
        </div>
      </div>
    </section>
  `;
}

function renderSettingsLegacy() {
  return `
    <section class="section">
      ${topbar("Ajustes", "Conta, privacidade e backup", `
        <button class="btn" data-action="export-full-backup" type="button">Backup JSON</button>
        <button class="btn" data-action="trigger-import" type="button">Importar JSON</button>
      `)}
      <div class="grid two-col">
        <div class="panel">
          <div class="panel-header"><h2>Empresa</h2></div>
          <form id="settings-form" class="grid">
            <label class="field">
              <span>Nome da empresa</span>
              <input name="companyName" value="${esc(state.settings.companyName)}" required />
            </label>
            <label class="field">
              <span>Responsável</span>
              <input name="ownerName" value="${esc(state.settings.ownerName || "")}" />
            </label>
            <label class="field">
              <span>Método padrão</span>
              <select name="defaultMethod">
                ${["Pix", "Dinheiro", "Cartão", "Transferência", "Outro"].map((item) => option(item, item, state.settings.defaultMethod)).join("")}
              </select>
            </label>
            <label class="check-line">
              <input name="maskPhones" type="checkbox" ${state.settings.maskPhones ? "checked" : ""} />
              <span>Mascarar telefones nas listas</span>
            </label>
            <button class="btn primary" type="submit">Salvar ajustes</button>
          </form>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Segurança</h2></div>
          <form id="password-form" class="grid">
            <label class="field">
              <span>Senha atual</span>
              <input name="currentPassword" type="password" autocomplete="current-password" required />
            </label>
            <label class="field">
              <span>Nova senha</span>
              <input name="newPassword" type="password" autocomplete="new-password" minlength="6" required />
            </label>
            <button class="btn primary" type="submit">Alterar senha</button>
          </form>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Histórico de alterações</h2>
          <button class="btn small" data-action="export-audit" type="button">CSV</button>
        </div>
        ${renderAuditList(state.auditLogs.slice(-40).reverse())}
      </div>
    </section>
  `;
}

function renderSettings() {
  return `
    <section class="section">
      ${topbar("Ajustes", "Conta, privacidade e backup", `
        <button class="btn" data-action="export-full-backup" type="button">Backup JSON</button>
        <button class="btn" data-action="trigger-import" type="button">Importar JSON</button>
      `)}
      <div class="grid two-col">
        <div class="panel">
          <div class="panel-header"><h2>Empresa</h2></div>
          <form id="settings-form" class="grid">
            <label class="field">
              <span>Nome da empresa</span>
              <input name="companyName" value="${esc(state.settings.companyName)}" required />
            </label>
            <label class="field">
              <span>Responsavel</span>
              <input name="ownerName" value="${esc(state.settings.ownerName || "")}" />
            </label>
            <label class="field">
              <span>Metodo padrao</span>
              <select name="defaultMethod">
                ${["Pix", "Dinheiro", "Cartao", "Transferencia", "Outro"].map((item) => option(item, item, state.settings.defaultMethod)).join("")}
              </select>
            </label>
            <label class="check-line">
              <input name="maskPhones" type="checkbox" ${state.settings.maskPhones ? "checked" : ""} />
              <span>Mascarar telefones nas listas</span>
            </label>
            <button class="btn primary" type="submit">Salvar ajustes</button>
          </form>
        </div>
        <div class="grid">
          ${renderAppearancePanel()}
          ${renderInstallPanel()}
          ${isCloudActive() ? renderCloudAccountPanel() : renderLocalSecurityPanel()}
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>Supabase</h2></div>
        ${renderSupabaseSettingsPanel()}
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Historico de alteracoes</h2>
          <button class="btn small" data-action="export-audit" type="button">CSV</button>
        </div>
        ${renderAuditList(state.auditLogs.slice(-40).reverse())}
      </div>
    </section>
  `;
}

function renderAppearancePanel() {
  const current = getThemePreference();
  return `
    <div class="panel">
      <div class="panel-header"><h2>Aparencia</h2></div>
      <div class="grid">
        <p class="muted">Escolha como o app aparece neste aparelho.</p>
        <div class="segmented" role="group" aria-label="Tema do app">
          ${segment("system", "Sistema", current, "set-theme")}
          ${segment("light", "Claro", current, "set-theme")}
          ${segment("dark", "Escuro", current, "set-theme")}
        </div>
      </div>
    </div>
  `;
}

function renderInstallPanel() {
  const installed = isStandaloneApp();
  return `
    <div class="panel">
      <div class="panel-header"><h2>Instalar app</h2></div>
      <div class="grid">
        <p class="muted">${
          installed
            ? "Este app ja esta aberto como aplicativo instalado."
            : "Instale no celular ou computador para abrir em tela cheia e acessar mais rapido."
        }</p>
        <button class="btn primary" data-action="install-app" type="button" ${installed ? "disabled" : ""}>
          ${installed ? "App instalado" : "Instalar neste aparelho"}
        </button>
      </div>
    </div>
  `;
}

function renderLocalSecurityPanel() {
  return `
    <div class="panel">
      <div class="panel-header"><h2>Seguranca local</h2></div>
      <form id="password-form" class="grid">
        <label class="field">
          <span>Senha atual</span>
          <input name="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label class="field">
          <span>Nova senha</span>
          <input name="newPassword" type="password" autocomplete="new-password" minlength="6" required />
        </label>
        <button class="btn primary" type="submit">Alterar senha</button>
      </form>
    </div>
  `;
}

function renderCloudAccountPanel() {
  return `
    <div class="panel">
      <div class="panel-header"><h2>Conta Supabase</h2></div>
      <div class="grid">
        <p class="muted">${esc(supabaseSession.user.email || "")}</p>
        <p><span class="badge active">${esc(cloudStatus || "Conectado")}</span></p>
        <div class="toolbar-actions">
          <button class="btn primary" data-action="cloud-sync-now" type="button">Sincronizar agora</button>
          <button class="btn ghost" data-action="cloud-logout" type="button">Sair</button>
        </div>
      </div>
    </div>
  `;
}

function renderSupabaseSettingsPanel() {
  const config = getSupabaseConfig();
  if (isCloudActive()) {
    return `
      <div class="grid">
        <p class="muted">Conectado em ${esc(config ? config.url : "")}</p>
        <div class="toolbar-actions">
          <button class="btn" data-action="use-local-auth" type="button">Usar modo local</button>
          <button class="btn ghost" data-action="forget-supabase-config" type="button">Trocar Supabase</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="grid">
      ${config ? `<p class="muted">Configurado: ${esc(config.url)}</p>` : `<p class="muted">Nenhum projeto Supabase configurado neste navegador.</p>`}
      ${renderCloudConfigPanel()}
      ${
        config
          ? `<button class="btn primary" data-action="use-cloud-auth" type="button">Entrar com Supabase</button>`
          : ""
      }
    </div>
  `;
}

function renderModal() {
  if (!ui.modal) return "";
  if (ui.modal.type === "client") return renderClientModal(ui.modal.id);
  if (ui.modal.type === "plan") return renderPlanModal(ui.modal.id);
  if (ui.modal.type === "payment") return renderPaymentModal(ui.modal.clientId);
  if (ui.modal.type === "detail") return renderClientDetail(ui.modal.id);
  return "";
}

function renderClientModal(id) {
  const client = state.clients.find((item) => item.id === id);
  const plan = client ? findPlan(client.planId) : activePlans()[0];
  const c = client || {
    name: "",
    phone: "",
    email: "",
    planId: plan ? plan.id : "",
    monthlyValue: plan ? plan.price : "",
    dueDate: todayISO(),
    status: "active",
    notes: "",
  };
  return modal(
    client ? "Editar cliente" : "Novo cliente",
    `
      <form id="client-form" class="grid" data-id="${client ? client.id : ""}">
        <div class="form-grid">
          <label class="field">
            <span>Nome</span>
            <input name="name" value="${esc(c.name)}" required />
          </label>
          <label class="field">
            <span>Telefone/WhatsApp</span>
            <input name="phone" value="${esc(c.phone)}" inputmode="tel" required />
          </label>
          <label class="field">
            <span>E-mail</span>
            <input name="email" type="email" value="${esc(c.email || "")}" />
          </label>
          <label class="field">
            <span>Plano</span>
            <select name="planId" id="client-plan-select" required>
              ${state.plans.map((p) => option(p.id, p.name, c.planId)).join("")}
            </select>
          </label>
          <label class="field">
            <span>Valor</span>
            <input name="monthlyValue" type="number" min="0" step="0.01" value="${esc(c.monthlyValue)}" required />
          </label>
          <label class="field">
            <span>Data de vencimento</span>
            <input name="dueDate" type="date" value="${esc(c.dueDate)}" required />
          </label>
          <label class="field">
            <span>Status manual</span>
            <select name="status">
              ${option("active", "Ativo", c.status)}
              ${option("trial", "Teste", c.status)}
              ${option("cancelled", "Cancelado", c.status)}
            </select>
          </label>
          <label class="field full">
            <span>Observações internas</span>
            <textarea name="notes">${esc(c.notes || "")}</textarea>
          </label>
        </div>
      </form>
    `,
    `
      <button class="btn ghost" data-action="close-modal" type="button">Cancelar</button>
      <button class="btn primary" form="client-form" type="submit">Salvar</button>
    `,
  );
}

function renderPlanModal(id) {
  const plan = state.plans.find((item) => item.id === id);
  const p = plan || {
    name: "",
    price: "",
    durationMonths: 1,
    screens: 1,
    notes: "",
    active: true,
  };
  return modal(
    plan ? "Editar plano" : "Novo plano",
    `
      <form id="plan-form" class="grid" data-id="${plan ? plan.id : ""}">
        <div class="form-grid">
          <label class="field">
            <span>Nome do plano</span>
            <input name="name" value="${esc(p.name)}" required />
          </label>
          <label class="field">
            <span>Valor</span>
            <input name="price" type="number" min="0" step="0.01" value="${esc(p.price)}" required />
          </label>
          <label class="field">
            <span>Duração</span>
            <select name="durationMonths">
              ${option("1", "Mensal", String(p.durationMonths))}
              ${option("3", "Trimestral", String(p.durationMonths))}
              ${option("6", "Semestral", String(p.durationMonths))}
              ${option("12", "Anual", String(p.durationMonths))}
            </select>
          </label>
          <label class="field">
            <span>Telas/dispositivos</span>
            <input name="screens" type="number" min="1" step="1" value="${esc(p.screens || 1)}" required />
          </label>
          <label class="field full">
            <span>Observações do plano</span>
            <textarea name="notes">${esc(p.notes || "")}</textarea>
          </label>
        </div>
      </form>
    `,
    `
      <button class="btn ghost" data-action="close-modal" type="button">Cancelar</button>
      <button class="btn primary" form="plan-form" type="submit">Salvar</button>
    `,
  );
}

function renderPaymentModal(clientId) {
  const client = state.clients.find((item) => item.id === clientId);
  const defaultClient = client || state.clients[0];
  const amount = defaultClient ? defaultClient.monthlyValue || (findPlan(defaultClient.planId) || {}).price || 0 : 0;
  return modal(
    "Registrar pagamento",
    `
      <form id="payment-form" class="grid" data-client-id="${clientId || ""}">
        <div class="form-grid">
          <label class="field">
            <span>Cliente</span>
            <select name="clientId" required>
              ${state.clients.map((c) => option(c.id, `${c.name} - ${formatPhone(c.phone)}`, defaultClient ? defaultClient.id : "")).join("")}
            </select>
          </label>
          <label class="field">
            <span>Status</span>
            <select name="status">
              ${option("received", "Recebido", "received")}
              ${option("pending", "Pendente", "received")}
            </select>
          </label>
          <label class="field">
            <span>Valor</span>
            <input name="amount" type="number" min="0" step="0.01" value="${esc(amount)}" required />
          </label>
          <label class="field">
            <span>Método</span>
            <select name="method">
              ${["Pix", "Dinheiro", "Cartão", "Transferência", "Outro"].map((item) => option(item, item, state.settings.defaultMethod)).join("")}
            </select>
          </label>
          <label class="field">
            <span>Data de vencimento</span>
            <input name="dueDate" type="date" value="${defaultClient ? esc(defaultClient.dueDate) : todayISO()}" required />
          </label>
          <label class="field">
            <span>Data de pagamento</span>
            <input name="paidAt" type="date" value="${todayISO()}" />
          </label>
          <label class="check-line full">
            <input name="renewClient" type="checkbox" />
            <span>Renovar cliente junto com este pagamento</span>
          </label>
          <label class="field full">
            <span>Observações</span>
            <textarea name="notes"></textarea>
          </label>
        </div>
      </form>
    `,
    `
      <button class="btn ghost" data-action="close-modal" type="button">Cancelar</button>
      <button class="btn primary" form="payment-form" type="submit">Salvar</button>
    `,
  );
}

function renderClientDetail(id) {
  const client = state.clients.find((item) => item.id === id);
  if (!client) return "";
  const plan = findPlan(client.planId);
  const status = computedStatus(client);
  const payments = state.payments.filter((payment) => payment.clientId === id).sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt));
  const preview = buildMessage(client, status.key === "overdue" ? "overdue" : status.key === "expiring" ? "dueToday" : "confirmation");

  return modal(
    client.name,
    `
      <div class="drawer-detail">
        <div class="grid">
          <div class="panel">
            <div class="item-main">
              <div>
                <h3>${esc(client.name)}</h3>
                <div class="item-meta">
                  <span>${formatPhone(client.phone)}</span>
                  ${client.email ? `<span>${esc(client.email)}</span>` : ""}
                </div>
              </div>
              <span class="badge ${status.key}">${status.label}</span>
            </div>
            <div class="item-meta">
              <span>${esc(plan ? plan.name : "Sem plano")}</span>
              <span>${money(client.monthlyValue)}</span>
              <span>Vence em ${formatDate(client.dueDate)}</span>
            </div>
            ${client.notes ? `<p class="muted">${esc(client.notes)}</p>` : ""}
          </div>
          <div class="panel">
            <div class="panel-header"><h2>Mensagem</h2></div>
            <div class="preview-box">${esc(preview)}</div>
            <div class="row-actions">
              <button class="btn small" data-action="copy-client-message" data-id="${client.id}" type="button">Copiar</button>
              <button class="btn small primary" data-action="open-client-message" data-id="${client.id}" type="button">WhatsApp</button>
            </div>
          </div>
        </div>
        <div class="grid">
          <div class="panel">
            <div class="panel-header"><h2>Ações</h2></div>
            <div class="grid">
              <button class="btn primary" data-action="renew-client" data-id="${client.id}" type="button">Renovar</button>
              <button class="btn" data-action="open-payment" data-client-id="${client.id}" type="button">Registrar pagamento</button>
              <button class="btn" data-action="open-client" data-id="${client.id}" type="button">Editar cliente</button>
              <button class="btn ${client.status === "cancelled" ? "primary" : "danger"}" data-action="toggle-client-cancelled" data-id="${client.id}" type="button">${client.status === "cancelled" ? "Reativar" : "Cancelar"}</button>
            </div>
          </div>
          <div class="panel">
            <div class="panel-header"><h2>Histórico</h2></div>
            ${renderPaymentMiniList(payments)}
          </div>
        </div>
      </div>
    `,
    `<button class="btn primary" data-action="close-modal" type="button">Fechar</button>`,
  );
}

function modal(title, body, footer) {
  return `
    <div class="modal-backdrop" data-action="close-modal-bg">
      <section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header class="modal-header">
          <h2>${esc(title)}</h2>
          <button class="btn icon ghost" data-action="close-modal" type="button" aria-label="Fechar">X</button>
        </header>
        <div class="modal-body">${body}</div>
        <footer class="modal-footer">${footer}</footer>
      </section>
    </div>
  `;
}

function topbar(title, subtitle, actions = "") {
  return `
    <header class="topbar">
      <div>
        <h1>${esc(title)}</h1>
        <p>${esc(subtitle)}</p>
      </div>
      <div class="top-actions">${actions}</div>
    </header>
  `;
}

function metric(label, value, variant = "", foot = "") {
  return `
    <article class="metric ${variant}">
      <span class="metric-label">${esc(label)}</span>
      <strong class="metric-value">${esc(String(value))}</strong>
      <span class="metric-foot">${esc(foot)}</span>
    </article>
  `;
}

function progressRow(label, value, max, tone) {
  const pct = Math.max(0, Math.min(100, max ? (Number(value) / Number(max)) * 100 : 0));
  const display = typeof value === "number" && value > 99 ? value.toLocaleString("pt-BR") : String(value);
  const currencyLike = ["rece", "previsto", "pendente", "total"].some((term) => label.toLowerCase().includes(term));
  return `
    <div class="progress-row">
      <div class="progress-head">
        <span>${esc(label)}</span>
        <strong>${esc(display.startsWith("R$") ? display : typeof value === "number" && currencyLike ? money(value) : display)}</strong>
      </div>
      <div class="bar"><span class="${tone}" style="width:${pct}%"></span></div>
    </div>
  `;
}

function renderClientsTable(clients) {
  if (!clients.length) return empty("Nenhum cliente encontrado.");
  return `
    <div class="table-wrap desktop-table">
      <table>
        <thead>
          <tr>
            <th>Cliente</th>
            <th>Plano</th>
            <th>Valor</th>
            <th>Vencimento</th>
            <th>Status</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          ${clients
            .map((client) => {
              const plan = findPlan(client.planId);
              const status = computedStatus(client);
              return `
                <tr>
                  <td>
                    <div class="name-cell">
                      <strong>${esc(client.name)}</strong>
                      <small>${formatPhone(client.phone)}${client.email ? ` · ${esc(client.email)}` : ""}</small>
                    </div>
                  </td>
                  <td>${esc(plan ? plan.name : "Sem plano")}</td>
                  <td><span class="amount">${money(client.monthlyValue)}</span></td>
                  <td>${formatDate(client.dueDate)}<br><small class="muted">${daysLabel(client.dueDate)}</small></td>
                  <td><span class="badge ${status.key}">${status.label}</span></td>
                  <td>
                    <div class="row-actions">
                      <button class="btn small" data-action="open-detail" data-id="${client.id}" type="button">Ver</button>
                      <button class="btn small primary" data-action="renew-client" data-id="${client.id}" type="button">Renovar</button>
                      <button class="btn small" data-action="open-client-message" data-id="${client.id}" type="button">WhatsApp</button>
                      <button class="btn small" data-action="open-client" data-id="${client.id}" type="button">Editar</button>
                    </div>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
    <div class="mobile-list">
      ${renderClientList(clients)}
    </div>
  `;
}

function renderClientList(clients, opts = {}) {
  if (!clients.length) return empty("Nenhum cliente nesta lista.");
  return `
    <div class="list">
      ${clients
        .map((client) => {
          const status = computedStatus(client);
          const plan = findPlan(client.planId);
          return `
            <article class="item-card">
              <div class="item-main">
                <div>
                  <h3>${esc(client.name)}</h3>
                  <div class="item-meta">
                    <span>${formatPhone(client.phone)}</span>
                    <span>${esc(plan ? plan.name : "Sem plano")}</span>
                    <span>${money(client.monthlyValue)}</span>
                  </div>
                </div>
                <span class="badge ${status.key}">${status.label}</span>
              </div>
              <div class="item-meta">
                <span>Vence em ${formatDate(client.dueDate)}</span>
                <span>${daysLabel(client.dueDate)}</span>
              </div>
              ${opts.showNotes && client.notes ? `<p class="muted">${esc(client.notes)}</p>` : ""}
              <div class="row-actions">
                <button class="btn small" data-action="open-detail" data-id="${client.id}" type="button">Ver</button>
                <button class="btn small primary" data-action="renew-client" data-id="${client.id}" type="button">Renovar</button>
                <button class="btn small" data-action="open-client-message" data-id="${client.id}" type="button">WhatsApp</button>
                ${opts.compact ? "" : `<button class="btn small" data-action="open-client" data-id="${client.id}" type="button">Editar</button>`}
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderPaymentsTable(payments, compact = false) {
  if (!payments.length) return empty("Nenhum pagamento encontrado.");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Cliente</th>
            <th>Valor</th>
            <th>Status</th>
            <th>Vencimento</th>
            <th>Pagamento</th>
            ${compact ? "" : "<th>Ações</th>"}
          </tr>
        </thead>
        <tbody>
          ${payments
            .map((payment) => {
              const client = state.clients.find((item) => item.id === payment.clientId);
              return `
                <tr>
                  <td>
                    <div class="name-cell">
                      <strong>${esc(client ? client.name : "Cliente removido")}</strong>
                      <small>${esc(payment.method || "")}${payment.notes ? ` · ${esc(payment.notes)}` : ""}</small>
                    </div>
                  </td>
                  <td><span class="amount">${money(payment.amount)}</span></td>
                  <td><span class="badge ${payment.status}">${payment.status === "received" ? "Recebido" : "Pendente"}</span></td>
                  <td>${formatDate(payment.dueDate)}</td>
                  <td>${payment.paidAt ? formatDate(payment.paidAt) : "-"}</td>
                  ${
                    compact
                      ? ""
                      : `<td>
                          <div class="row-actions">
                            ${
                              payment.status === "pending"
                                ? `<button class="btn small primary" data-action="receive-payment" data-id="${payment.id}" type="button">Receber</button>
                                   <button class="btn small" data-action="receive-renew-payment" data-id="${payment.id}" type="button">Receber + renovar</button>`
                                : `<button class="btn small" data-action="payment-whatsapp" data-id="${payment.id}" type="button">Recibo</button>`
                            }
                            <button class="btn small danger" data-action="delete-payment" data-id="${payment.id}" type="button">Excluir</button>
                          </div>
                        </td>`
                  }
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderPaymentMiniList(payments) {
  if (!payments.length) return empty("Sem pagamentos registrados.");
  return `
    <div class="list">
      ${payments
        .slice(0, 8)
        .map(
          (payment) => `
            <article class="item-card">
              <div class="item-main">
                <div>
                  <h3>${money(payment.amount)}</h3>
                  <div class="item-meta">
                    <span>${payment.status === "received" ? "Recebido" : "Pendente"}</span>
                    <span>${payment.paidAt ? formatDate(payment.paidAt) : formatDate(payment.dueDate)}</span>
                  </div>
                </div>
                <span class="badge ${payment.status}">${payment.status === "received" ? "OK" : "Pendente"}</span>
              </div>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderAuditList(logs) {
  if (!logs.length) return empty("Sem alterações registradas.");
  return `
    <div class="list">
      ${logs
        .map(
          (log) => `
            <article class="item-card">
              <div class="item-main">
                <div>
                  <h3>${esc(log.summary || log.action)}</h3>
                  <div class="item-meta">
                    <span>${esc(log.entity)}</span>
                    <span>${formatDateTime(log.at)}</span>
                  </div>
                </div>
                <span class="badge neutral">${esc(log.action)}</span>
              </div>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function empty(text) {
  return `<div class="empty">${esc(text)}</div>`;
}

function segment(value, label, current, action) {
  return `
    <button class="segment ${value === current ? "active" : ""}" data-action="${action}" data-mode="${value}" type="button">
      ${esc(label)}
    </button>
  `;
}

function option(value, label, selected) {
  return `<option value="${esc(value)}" ${String(value) === String(selected) ? "selected" : ""}>${esc(label)}</option>`;
}

async function handleClick(event) {
  const backdrop = event.target.closest("[data-action='close-modal-bg']");
  if (backdrop && event.target === backdrop) {
    closeModal();
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "nav") {
    ui.view = button.dataset.view;
    ui.modal = null;
    render();
    return;
  }
  if (action === "set-expiration-mode") {
    ui.view = "expirations";
    ui.expirationMode = button.dataset.mode;
    render();
    return;
  }
  if (action === "close-modal") {
    closeModal();
    return;
  }
  if (action === "open-client") {
    ui.modal = { type: "client", id: button.dataset.id || "" };
    render();
    return;
  }
  if (action === "open-plan") {
    ui.modal = { type: "plan", id: button.dataset.id || "" };
    render();
    return;
  }
  if (action === "open-payment") {
    if (!state.clients.length) {
      showToast("Cadastre um cliente antes de registrar pagamentos.");
      return;
    }
    ui.modal = { type: "payment", clientId: button.dataset.clientId || "" };
    render();
    return;
  }
  if (action === "open-detail") {
    ui.modal = { type: "detail", id: button.dataset.id };
    render();
    return;
  }
  if (action === "renew-client") {
    renewClient(button.dataset.id);
    return;
  }
  if (action === "toggle-client-cancelled") {
    toggleClientCancelled(button.dataset.id);
    return;
  }
  if (action === "open-client-message") {
    const client = state.clients.find((item) => item.id === button.dataset.id);
    if (client) openWhatsApp(client, statusMessageType(client));
    return;
  }
  if (action === "copy-client-message") {
    const client = state.clients.find((item) => item.id === button.dataset.id);
    if (client) copyText(buildMessage(client, statusMessageType(client)));
    return;
  }
  if (action === "copy-message-preview") {
    const client = state.clients.find((item) => item.id === ui.messageClientId);
    if (client) copyText(buildMessage(client, ui.messageType));
    return;
  }
  if (action === "open-message-preview") {
    const client = state.clients.find((item) => item.id === ui.messageClientId);
    if (client) openWhatsApp(client, ui.messageType);
    return;
  }
  if (action === "payment-whatsapp") {
    const payment = state.payments.find((item) => item.id === button.dataset.id);
    const client = payment ? state.clients.find((item) => item.id === payment.clientId) : null;
    if (client) openWhatsApp(client, "confirmation");
    return;
  }
  if (action === "receive-payment") {
    receivePayment(button.dataset.id, false);
    return;
  }
  if (action === "receive-renew-payment") {
    receivePayment(button.dataset.id, true);
    return;
  }
  if (action === "delete-payment") {
    deletePayment(button.dataset.id);
    return;
  }
  if (action === "toggle-plan") {
    togglePlan(button.dataset.id);
    return;
  }
  if (action === "delete-plan") {
    deletePlan(button.dataset.id);
    return;
  }
  if (action === "set-finance-month") {
    ui.financeStart = startOfMonthISO();
    ui.financeEnd = endOfMonthISO();
    render();
    return;
  }
  if (action === "set-report-month") {
    ui.reportStart = startOfMonthISO();
    ui.reportEnd = endOfMonthISO();
    render();
    return;
  }
  if (action === "set-theme") {
    setThemePreference(button.dataset.mode || "system");
    render();
    return;
  }
  if (action === "install-app") {
    await installApp();
    return;
  }
  if (action === "export-clients") {
    exportClients();
    return;
  }
  if (action === "export-payments") {
    exportPayments(filteredPayments(), "pagamentos.csv");
    return;
  }
  if (action === "export-period-report") {
    exportPayments(paymentsInPeriod(ui.reportStart, ui.reportEnd, "all"), "relatorio-periodo.csv");
    return;
  }
  if (action === "export-full-backup") {
    exportBackup();
    return;
  }
  if (action === "trigger-import") {
    document.getElementById("backup-import")?.click();
    return;
  }
  if (action === "export-audit") {
    exportAudit();
    return;
  }
  if (action === "lock") {
    logged = false;
    sessionStorage.removeItem(SESSION_KEY);
    render();
    return;
  }
  if (action === "use-local-auth") {
    sessionStorage.setItem(LOCAL_MODE_KEY, "1");
    supabaseSession = null;
    logged = sessionStorage.getItem(SESSION_KEY) === "1";
    await initSupabaseClient();
    render();
    return;
  }
  if (action === "use-cloud-auth") {
    sessionStorage.removeItem(LOCAL_MODE_KEY);
    await initSupabaseClient();
    logged = false;
    sessionStorage.removeItem(SESSION_KEY);
    render();
    return;
  }
  if (action === "forget-supabase-config") {
    if (!confirm("Remover a configuracao Supabase deste navegador? Os dados no Supabase nao serao apagados.")) return;
    localStorage.removeItem(SUPABASE_CONFIG_KEY);
    sessionStorage.removeItem(LOCAL_MODE_KEY);
    supabaseClient = null;
    supabaseSession = null;
    logged = sessionStorage.getItem(SESSION_KEY) === "1";
    showToast("Configuracao Supabase removida.");
    render();
    return;
  }
  if (action === "cloud-logout") {
    if (supabaseClient) await supabaseClient.auth.signOut();
    supabaseSession = null;
    logged = false;
    sessionStorage.removeItem(SESSION_KEY);
    render();
    return;
  }
  if (action === "cloud-sync-now") {
    await syncAllToSupabase();
    showToast(cloudStatus || "Sincronizado.");
    render();
    return;
  }
}

async function handleCloudLogin(form, submitter) {
  if (!supabaseClient) {
    await initSupabaseClient();
  }
  if (!supabaseClient) {
    showToast(cloudStatus || "Configure o Supabase primeiro.");
    render();
    return;
  }
  const data = new FormData(form);
  const email = String(data.get("email") || "").trim();
  const password = String(data.get("password") || "");
  const intent = submitter && submitter.value === "signup" ? "signup" : "login";
  const result =
    intent === "signup"
      ? await supabaseClient.auth.signUp({ email, password })
      : await supabaseClient.auth.signInWithPassword({ email, password });

  if (result.error) {
    cloudStatus = result.error.message;
    showToast(cloudStatus);
    render();
    return;
  }

  supabaseSession = result.data.session || null;
  if (!supabaseSession && intent === "signup") {
    cloudStatus = "Conta criada. Confirme o e-mail, se o Supabase solicitar, e entre novamente.";
    showToast(cloudStatus);
    render();
    return;
  }

  if (!supabaseSession) {
    const sessionResult = await supabaseClient.auth.getSession();
    supabaseSession = sessionResult.data.session || null;
  }

  logged = Boolean(supabaseSession);
  if (logged) {
    sessionStorage.setItem(SESSION_KEY, "1");
    await loadFromSupabase();
    showToast("Conectado ao Supabase.");
  }
  render();
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();

  if (form.id === "cloud-config-form") {
    const data = new FormData(form);
    const url = String(data.get("url") || "").trim().replace(/\/+$/, "");
    const anonKey = String(data.get("anonKey") || "").trim();
    if (!url || !anonKey) {
      showToast("Informe a URL e a anon key do Supabase.");
      return;
    }
    setSupabaseConfig({ url, anonKey });
    await initSupabaseClient();
    logged = false;
    sessionStorage.removeItem(SESSION_KEY);
    showToast("Supabase configurado.");
    render();
    return;
  }

  if (form.id === "cloud-login-form") {
    await handleCloudLogin(form, event.submitter);
    return;
  }

  if (form.id === "setup-form") {
    const data = new FormData(form);
    const userName = String(data.get("userName") || "").trim();
    const password = String(data.get("password") || "");
    if (password.length < 6) {
      showToast("Use uma senha com pelo menos 6 caracteres.");
      return;
    }
    state = createBlankState();
    state.meta.initialized = true;
    state.meta.userName = userName;
    state.meta.passwordHash = await hashPassword(password);
    seedBase(Boolean(data.get("demo")));
    addAudit("sistema", "setup", "Criado acesso inicial");
    saveState();
    logged = true;
    sessionStorage.setItem(SESSION_KEY, "1");
    showToast("Acesso criado.");
    render();
    return;
  }

  if (form.id === "login-form") {
    const data = new FormData(form);
    const userName = String(data.get("userName") || "").trim();
    const password = String(data.get("password") || "");
    const hash = await hashPassword(password);
    if (userName === state.meta.userName && hash === state.meta.passwordHash) {
      logged = true;
      sessionStorage.setItem(SESSION_KEY, "1");
      render();
    } else {
      showToast("Usuário ou senha inválidos.");
    }
    return;
  }

  if (form.id === "client-form") {
    saveClient(form);
    return;
  }
  if (form.id === "plan-form") {
    savePlan(form);
    return;
  }
  if (form.id === "payment-form") {
    savePayment(form);
    return;
  }
  if (form.id === "templates-form") {
    const data = new FormData(form);
    Object.keys(defaultTemplates).forEach((key) => {
      state.settings.templates[key] = String(data.get(key) || "");
    });
    addAudit("mensagens", "templates", "Modelos de mensagem atualizados");
    saveState();
    showToast("Modelos salvos.");
    render();
    return;
  }
  if (form.id === "settings-form") {
    const data = new FormData(form);
    state.settings.companyName = String(data.get("companyName") || "").trim() || "Minha IPTV Legal";
    state.settings.ownerName = String(data.get("ownerName") || "").trim();
    state.settings.defaultMethod = String(data.get("defaultMethod") || "Pix");
    state.settings.maskPhones = Boolean(data.get("maskPhones"));
    addAudit("ajustes", "settings", "Ajustes da empresa atualizados");
    saveState();
    showToast("Ajustes salvos.");
    render();
    return;
  }
  if (form.id === "password-form") {
    const data = new FormData(form);
    const currentHash = await hashPassword(String(data.get("currentPassword") || ""));
    if (currentHash !== state.meta.passwordHash) {
      showToast("Senha atual incorreta.");
      return;
    }
    const newPassword = String(data.get("newPassword") || "");
    if (newPassword.length < 6) {
      showToast("Use uma senha com pelo menos 6 caracteres.");
      return;
    }
    state.meta.passwordHash = await hashPassword(newPassword);
    addAudit("seguranca", "password", "Senha alterada");
    saveState();
    form.reset();
    showToast("Senha alterada.");
    render();
  }
}

function handleChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;

  if (target.id === "backup-import" && target instanceof HTMLInputElement && target.files && target.files[0]) {
    importBackup(target.files[0]);
    return;
  }

  if (target.dataset.bind) {
    ui[target.dataset.bind] = target.value;
    render({ preserveFocus: true });
    return;
  }

  if (target.id === "client-plan-select") {
    const plan = findPlan(target.value);
    const amount = document.querySelector("input[name='monthlyValue']");
    if (plan && amount && !amount.value) amount.value = plan.price;
  }
}

function handleInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.dataset.bind) {
    ui[target.dataset.bind] = target.value;
    render({ preserveFocus: true });
  }
}

function saveClient(form) {
  const data = new FormData(form);
  const id = form.dataset.id;
  const now = new Date().toISOString();
  const payload = {
    name: String(data.get("name") || "").trim(),
    phone: String(data.get("phone") || "").trim(),
    email: String(data.get("email") || "").trim(),
    planId: String(data.get("planId") || ""),
    monthlyValue: Number(data.get("monthlyValue") || 0),
    dueDate: String(data.get("dueDate") || todayISO()),
    status: String(data.get("status") || "active"),
    notes: String(data.get("notes") || "").trim(),
    updatedAt: now,
  };
  if (!payload.name || !payload.phone || !payload.planId) {
    showToast("Preencha nome, telefone e plano.");
    return;
  }

  if (id) {
    const index = state.clients.findIndex((item) => item.id === id);
    if (index >= 0) {
      const old = { ...state.clients[index] };
      state.clients[index] = { ...state.clients[index], ...payload };
      addAudit("cliente", id, `Cliente atualizado: ${payload.name}`, old, state.clients[index]);
    }
  } else {
    const created = { id: uid(), ...payload, createdAt: now };
    state.clients.push(created);
    addAudit("cliente", created.id, `Cliente criado: ${created.name}`);
  }
  closeModal(false);
  saveState();
  showToast("Cliente salvo.");
  render();
}

function savePlan(form) {
  const data = new FormData(form);
  const id = form.dataset.id;
  const now = new Date().toISOString();
  const payload = {
    name: String(data.get("name") || "").trim(),
    price: Number(data.get("price") || 0),
    durationMonths: Number(data.get("durationMonths") || 1),
    screens: Number(data.get("screens") || 1),
    notes: String(data.get("notes") || "").trim(),
    active: true,
    updatedAt: now,
  };
  if (!payload.name) {
    showToast("Informe o nome do plano.");
    return;
  }
  if (id) {
    const index = state.plans.findIndex((item) => item.id === id);
    if (index >= 0) {
      const old = { ...state.plans[index] };
      state.plans[index] = { ...state.plans[index], ...payload, active: state.plans[index].active !== false };
      addAudit("plano", id, `Plano atualizado: ${payload.name}`, old, state.plans[index]);
    }
  } else {
    const created = { id: uid(), ...payload, createdAt: now };
    state.plans.push(created);
    addAudit("plano", created.id, `Plano criado: ${created.name}`);
  }
  closeModal(false);
  saveState();
  showToast("Plano salvo.");
  render();
}

function savePayment(form) {
  const data = new FormData(form);
  const clientId = String(data.get("clientId") || "");
  const client = state.clients.find((item) => item.id === clientId);
  if (!client) {
    showToast("Selecione um cliente.");
    return;
  }
  const status = String(data.get("status") || "received");
  const now = new Date().toISOString();
  const payment = {
    id: uid(),
    clientId,
    amount: Number(data.get("amount") || 0),
    status,
    method: String(data.get("method") || state.settings.defaultMethod || "Pix"),
    dueDate: String(data.get("dueDate") || client.dueDate || todayISO()),
    paidAt: status === "received" ? String(data.get("paidAt") || todayISO()) : "",
    notes: String(data.get("notes") || "").trim(),
    createdAt: now,
  };
  state.payments.push(payment);
  addAudit("pagamento", payment.id, `${status === "received" ? "Pagamento recebido" : "Pagamento pendente"}: ${client.name}`);

  if (status === "received" && data.get("renewClient")) {
    applyRenewal(client, payment.paidAt, "Pagamento com renovação");
  }

  closeModal(false);
  saveState();
  showToast("Pagamento salvo.");
  render();
}

function renewClient(id) {
  const client = state.clients.find((item) => item.id === id);
  if (!client) return;
  const plan = findPlan(client.planId);
  const amount = Number(client.monthlyValue || (plan ? plan.price : 0));
  const previousDue = client.dueDate;
  const paidAt = todayISO();
  const payment = {
    id: uid(),
    clientId: client.id,
    amount,
    status: "received",
    method: state.settings.defaultMethod || "Pix",
    dueDate: previousDue,
    paidAt,
    notes: "Renovação",
    createdAt: new Date().toISOString(),
  };
  state.payments.push(payment);
  applyRenewal(client, paidAt, "Renovação manual");
  addAudit("pagamento", payment.id, `Renovação recebida: ${client.name}`);
  saveState();
  showToast(`Cliente renovado até ${formatDate(client.dueDate)}.`);
  render();
}

function applyRenewal(client, paidAt, summary) {
  const plan = findPlan(client.planId);
  const months = plan ? Number(plan.durationMonths || 1) : 1;
  const base = dateValue(client.dueDate) >= dateValue(todayISO()) ? client.dueDate : paidAt || todayISO();
  const old = { ...client };
  client.dueDate = addMonthsISO(base, months);
  client.status = "active";
  client.updatedAt = new Date().toISOString();
  addAudit("cliente", client.id, `${summary}: ${client.name}`, old, client);
}

function receivePayment(id, renew) {
  const payment = state.payments.find((item) => item.id === id);
  if (!payment) return;
  const client = state.clients.find((item) => item.id === payment.clientId);
  const old = { ...payment };
  payment.status = "received";
  payment.paidAt = todayISO();
  payment.updatedAt = new Date().toISOString();
  addAudit("pagamento", payment.id, `Pagamento recebido: ${client ? client.name : "cliente"}`, old, payment);
  if (renew && client) applyRenewal(client, payment.paidAt, "Recebimento com renovação");
  saveState();
  showToast(renew ? "Pagamento recebido e cliente renovado." : "Pagamento marcado como recebido.");
  render();
}

function deletePayment(id) {
  const payment = state.payments.find((item) => item.id === id);
  if (!payment) return;
  if (!confirm("Excluir este pagamento?")) return;
  state.payments = state.payments.filter((item) => item.id !== id);
  addAudit("pagamento", id, "Pagamento excluído", payment, null);
  saveState();
  showToast("Pagamento excluído.");
  render();
}

function toggleClientCancelled(id) {
  const client = state.clients.find((item) => item.id === id);
  if (!client) return;
  const old = { ...client };
  client.status = client.status === "cancelled" ? "active" : "cancelled";
  client.updatedAt = new Date().toISOString();
  addAudit("cliente", id, `${client.status === "cancelled" ? "Cliente cancelado" : "Cliente reativado"}: ${client.name}`, old, client);
  saveState();
  showToast(client.status === "cancelled" ? "Cliente cancelado." : "Cliente reativado.");
  render();
}

function togglePlan(id) {
  const plan = state.plans.find((item) => item.id === id);
  if (!plan) return;
  const old = { ...plan };
  plan.active = !plan.active;
  plan.updatedAt = new Date().toISOString();
  addAudit("plano", id, `${plan.active ? "Plano reativado" : "Plano desativado"}: ${plan.name}`, old, plan);
  saveState();
  showToast(plan.active ? "Plano reativado." : "Plano desativado.");
  render();
}

function deletePlan(id) {
  const plan = state.plans.find((item) => item.id === id);
  if (!plan) return;
  const inUse = state.clients.some((client) => client.planId === id);
  if (inUse) {
    const old = { ...plan };
    plan.active = false;
    plan.updatedAt = new Date().toISOString();
    addAudit("plano", id, `Plano desativado por uso: ${plan.name}`, old, plan);
    saveState();
    showToast("Plano em uso foi desativado.");
    render();
    return;
  }
  if (!confirm("Excluir este plano?")) return;
  state.plans = state.plans.filter((item) => item.id !== id);
  addAudit("plano", id, `Plano excluído: ${plan.name}`, plan, null);
  saveState();
  showToast("Plano excluído.");
  render();
}

function closeModal(rerender = true) {
  ui.modal = null;
  if (rerender) render();
}

function filteredClients() {
  const q = normalize(ui.clientSearch);
  return state.clients
    .filter((client) => {
      const status = computedStatus(client).key;
      if (ui.clientStatus !== "all" && status !== ui.clientStatus) return false;
      if (ui.clientPlan !== "all" && client.planId !== ui.clientPlan) return false;
      if (ui.clientDue !== "all" && !clientMatchesWindow(client, ui.clientDue)) return false;
      if (!q) return true;
      return [client.name, client.phone, client.email]
        .map((value) => normalize(value || ""))
        .some((value) => value.includes(q));
    })
    .sort(clientSort);
}

function filteredPayments() {
  return paymentsInPeriod(ui.financeStart, ui.financeEnd, ui.financeStatus);
}

function paymentsInPeriod(start, end, status) {
  return state.payments
    .filter((payment) => status === "all" || payment.status === status)
    .filter((payment) => {
      const date = payment.status === "received" ? payment.paidAt || payment.createdAt : payment.dueDate || payment.createdAt;
      return inPeriod(dateOnly(date), start, end);
    })
    .sort((a, b) => dateValue(b.paidAt || b.dueDate || b.createdAt) - dateValue(a.paidAt || a.dueDate || a.createdAt));
}

function paymentTotals(payments) {
  return payments.reduce(
    (acc, payment) => {
      const amount = Number(payment.amount || 0);
      acc.all += amount;
      if (payment.status === "received") {
        acc.received += amount;
        acc.receivedCount += 1;
      } else {
        acc.pending += amount;
        acc.pendingCount += 1;
      }
      return acc;
    },
    { all: 0, received: 0, pending: 0, receivedCount: 0, pendingCount: 0 },
  );
}

function getMetrics() {
  const current = state.clients.map((client) => computedStatus(client).key);
  const monthPayments = paymentsInPeriod(startOfMonthISO(), endOfMonthISO(), "all");
  const totals = paymentTotals(monthPayments);
  const expectedMonth = state.clients
    .filter((client) => !["cancelled", "trial"].includes(computedStatus(client).key))
    .filter((client) => inPeriod(client.dueDate, startOfMonthISO(), endOfMonthISO()))
    .reduce((sum, client) => sum + Number(client.monthlyValue || 0), 0);
  return {
    active: current.filter((item) => item === "active" || item === "expiring").length,
    overdue: current.filter((item) => item === "overdue").length,
    cancelled: current.filter((item) => item === "cancelled").length,
    trial: current.filter((item) => item === "trial").length,
    dueToday: getClientsByWindow("today").length,
    due7: getClientsByWindow("7").length,
    receivedMonth: totals.received,
    pendingMonth: totals.pending,
    expectedMonth,
  };
}

function getClientsByWindow(mode) {
  return state.clients
    .filter((client) => computedStatus(client).key !== "cancelled")
    .filter((client) => clientMatchesWindow(client, mode))
    .sort(clientSort);
}

function clientMatchesWindow(client, mode) {
  const status = computedStatus(client).key;
  const diff = daysUntil(client.dueDate);
  if (mode === "today") return diff === 0 && status !== "cancelled";
  if (mode === "overdue") return diff < 0 && status !== "cancelled";
  if (mode === "month") return inPeriod(client.dueDate, startOfMonthISO(), endOfMonthISO());
  const days = Number(mode);
  if (Number.isFinite(days)) return diff >= 0 && diff <= days && status !== "cancelled";
  return true;
}

function computedStatus(client) {
  if (client.status === "cancelled") return { key: "cancelled", label: "Cancelado" };
  if (client.status === "trial") return { key: "trial", label: "Teste" };
  const diff = daysUntil(client.dueDate);
  if (diff < 0) return { key: "overdue", label: "Vencido" };
  if (diff <= 7) return { key: "expiring", label: "Vencendo" };
  return { key: "active", label: "Ativo" };
}

function clientSort(a, b) {
  const due = dateValue(a.dueDate) - dateValue(b.dueDate);
  if (due !== 0) return due;
  return a.name.localeCompare(b.name, "pt-BR");
}

function activePlans() {
  return state.plans.filter((plan) => plan.active !== false);
}

function findPlan(id) {
  return state.plans.find((plan) => plan.id === id);
}

function buildMessage(client, type) {
  const plan = findPlan(client.planId);
  const template = state.settings.templates[type] || defaultTemplates[type] || "";
  const values = {
    nome: client.name,
    telefone: client.phone,
    plano: plan ? plan.name : "plano",
    valor: money(client.monthlyValue || (plan ? plan.price : 0)),
    vencimento: formatDate(client.dueDate),
    empresa: state.settings.companyName || "",
    dias: String(Math.abs(daysUntil(client.dueDate))),
  };
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
}

function statusMessageType(client) {
  const key = computedStatus(client).key;
  if (key === "overdue") return "overdue";
  if (key === "expiring") return "dueToday";
  return "confirmation";
}

function openWhatsApp(client, type) {
  const phone = whatsappPhone(client.phone);
  if (!phone) {
    showToast("Telefone inválido.");
    return;
  }
  const message = buildMessage(client, type);
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, "_blank", "noopener");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Mensagem copiada.");
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    showToast("Mensagem copiada.");
  }
}

function exportClients() {
  const rows = state.clients.map((client) => {
    const plan = findPlan(client.planId);
    const status = computedStatus(client);
    return {
      nome: client.name,
      telefone: client.phone,
      email: client.email,
      plano: plan ? plan.name : "",
      valor: client.monthlyValue,
      vencimento: client.dueDate,
      status: status.label,
      observacoes: client.notes,
    };
  });
  downloadText("clientes.csv", toCSV(rows));
}

function exportPayments(payments, filename) {
  const rows = payments.map((payment) => {
    const client = state.clients.find((item) => item.id === payment.clientId);
    return {
      cliente: client ? client.name : "",
      valor: payment.amount,
      status: payment.status === "received" ? "Recebido" : "Pendente",
      metodo: payment.method,
      vencimento: payment.dueDate,
      pagamento: payment.paidAt || "",
      observacoes: payment.notes || "",
    };
  });
  downloadText(filename, toCSV(rows));
}

function exportAudit() {
  const rows = state.auditLogs.map((log) => ({
    data: log.at,
    entidade: log.entity,
    id: log.entityId,
    acao: log.action,
    resumo: log.summary,
  }));
  downloadText("historico-alteracoes.csv", toCSV(rows));
}

function exportBackup() {
  const safe = {
    ...state,
    exportedAt: new Date().toISOString(),
  };
  downloadText(`backup-clientes-${todayISO()}.json`, JSON.stringify(safe, null, 2), "application/json");
  state.meta.lastBackupAt = new Date().toISOString();
  saveState();
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || ""));
      if (!parsed || !parsed.meta || !Array.isArray(parsed.clients)) throw new Error("invalid");
      if (!confirm("Importar este backup e substituir os dados atuais?")) return;
      state = normalizeState(parsed);
      addAudit("sistema", "backup", "Backup importado");
      saveState();
      showToast("Backup importado.");
      render();
    } catch {
      showToast("Arquivo de backup inválido.");
    }
  };
  reader.readAsText(file);
}

function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(";")];
  rows.forEach((row) => {
    lines.push(headers.map((header) => csvValue(row[header])).join(";"));
  });
  return lines.join("\n");
}

function csvValue(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadText(filename, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function addAudit(entity, entityId, summary, oldData = null, newData = null) {
  state.auditLogs.push({
    id: uid(),
    entity,
    entityId,
    action: summary.split(":")[0],
    summary,
    oldData,
    newData,
    at: new Date().toISOString(),
  });
  if (state.auditLogs.length > 500) state.auditLogs = state.auditLogs.slice(-500);
}

async function hashPassword(password) {
  if (window.crypto && window.crypto.subtle) {
    const buffer = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
    return Array.from(new Uint8Array(buffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  let hash = 0;
  for (let i = 0; i < password.length; i += 1) {
    hash = (hash << 5) - hash + password.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function uid() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatDate(value) {
  if (!value) return "-";
  return parseDate(value).toLocaleDateString("pt-BR");
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatPhone(value) {
  const digits = onlyDigits(value);
  const display = state.settings.maskPhones ? maskPhone(digits) : value || "";
  return esc(display);
}

function maskPhone(digits) {
  if (!digits) return "";
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 2)} *****-${digits.slice(-4)}`;
}

function whatsappPhone(value) {
  let digits = onlyDigits(value);
  if (!digits) return "";
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function durationLabel(months) {
  const n = Number(months || 1);
  if (n === 1) return "Mensal";
  if (n === 3) return "Trimestral";
  if (n === 6) return "Semestral";
  if (n === 12) return "Anual";
  return `${n} meses`;
}

function daysLabel(value) {
  const diff = daysUntil(value);
  if (diff === 0) return "vence hoje";
  if (diff === 1) return "vence amanhã";
  if (diff > 1) return `vence em ${diff} dias`;
  if (diff === -1) return "venceu ontem";
  return `vencido há ${Math.abs(diff)} dias`;
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function startOfMonthISO() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
}

function endOfMonthISO() {
  const now = new Date();
  return dateOnly(new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString());
}

function addDaysISO(iso, days) {
  const date = parseDate(iso);
  date.setDate(date.getDate() + Number(days || 0));
  return dateOnly(date.toISOString());
}

function addMonthsISO(iso, months) {
  const date = parseDate(iso);
  const day = date.getDate();
  date.setMonth(date.getMonth() + Number(months || 0), 1);
  const maxDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, maxDay));
  return dateOnly(date.toISOString());
}

function daysUntil(iso) {
  return Math.round((dateValue(iso) - dateValue(todayISO())) / ONE_DAY);
}

function inPeriod(date, start, end) {
  const current = dateValue(date);
  return current >= dateValue(start) && current <= dateValue(end);
}

function parseDate(value) {
  if (value instanceof Date) return value;
  const iso = dateOnly(value);
  return new Date(`${iso}T12:00:00`);
}

function dateOnly(value) {
  if (!value) return todayISO();
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function dateValue(value) {
  return parseDate(value).getTime();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getThemePreference() {
  const saved = localStorage.getItem(THEME_KEY);
  return ["light", "dark", "system"].includes(saved) ? saved : "system";
}

function getResolvedTheme(preference) {
  if (preference === "system") {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return preference === "dark" ? "dark" : "light";
}

function setThemePreference(preference) {
  const next = ["light", "dark", "system"].includes(preference) ? preference : "system";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

function applyTheme(preference) {
  const theme = getResolvedTheme(preference);
  document.documentElement.dataset.theme = theme;
  document.querySelector("meta[name='theme-color']")?.setAttribute("content", theme === "dark" ? "#0f172a" : "#1D4ED8");
}

function isStandaloneApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

async function installApp() {
  if (!deferredInstallPrompt) {
    showToast("Use o menu do navegador e escolha instalar/adicionar a tela inicial.");
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  render();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // O app continua funcionando mesmo quando o navegador bloqueia o cache offline.
    });
  });
}

function showToast(message) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2800);
}

function captureFocus() {
  const active = document.activeElement;
  if (!active || !active.id) return null;
  return {
    id: active.id,
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

function restoreFocus(focus) {
  if (!focus) return;
  const node = document.getElementById(focus.id);
  if (!node) return;
  node.focus();
  if ("setSelectionRange" in node && focus.start !== null) {
    try {
      node.setSelectionRange(focus.start, focus.end);
    } catch {
      // Some input types do not support text selection.
    }
  }
}
