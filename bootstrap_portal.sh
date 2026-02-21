set -e

mkdir -p public/assets

# ---------- package.json ----------
cat > package.json <<'PKG'
{
  "name": "portal-clinyco-sell",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "engines": { "node": ">=18" },
  "dependencies": {
    "express": "^4.19.2"
  }
}
PKG

# ---------- .gitignore ----------
cat > .gitignore <<'GIT'
node_modules/
.env
.DS_Store
GIT

# ---------- .env.example ----------
cat > .env.example <<'ENV'
SELL_ACCESS_TOKEN=REEMPLAZA_ESTE_VALOR
SELL_API_BASE=https://api.getbase.com

# (opcional) seguridad simple
PORTAL_KEY=

# URLs para botones "Abrir en Sell"
SELL_LEADS_URL=https://clinyco.zendesk.com/sales/app/leads
SELL_DEAL_URL_BASE=https://clinyco.zendesk.com/sales/app/deals
SELL_CONTACT_URL_BASE=https://clinyco.zendesk.com/sales/app/contacts

# Defaults (opcionales)
DEFAULT_CURRENCY=CLP
DEAL_STAGE_ID=
DEAL_OWNER_ID=
DEAL_TAGS=portal,clinyco
ENV

# ---------- IDs de custom fields (desde tus outputs) ----------
cat > sell_config.js <<'CFG'
module.exports = {
  contact: {
    RUT_ID: 5883525,        // "RUT o ID"
    PREVISION_ID: 6373567,  // "Previsión" (list)
    TELEFONO_ID: 5862996,   // "Teléfono" (phone)
    CORREO_ID: 5862966,     // "Correo electrónico" (email)
    CIUDAD_ID: 5862997,     // "Ciudad" (string)
    AGENTE_ID: 6336406      // "AGENTE" (string) opcional
  },
  deal: {
    RUT_ID: 2540090,        // "RUT o ID"
    CIRUJANO_ID: 2523888,   // "CIRUJANO BARIÁTRICO" (list)
    IMC_TEXT_ID: 1291633,   // "IMC" (string)
    IMC_NUM_ID: 2567322,    // "IMC." (number)
    INTERES_ID: 1291635,    // "Interés" (string)
    TRAMO_ID: 2758483,      // "Tramo/Modalidad" (list)
    URL_MEDINET_ID: 2618053 // "URL-MEDINET" (url)
  }
};
CFG

# ---------- Sell API helper ----------
cat > sell.js <<'SELL'
const CFG = require("./sell_config");

const SELL_API_BASE = process.env.SELL_API_BASE || "https://api.getbase.com";

function mustToken() {
  const t = process.env.SELL_ACCESS_TOKEN;
  if (!t) throw new Error("Falta SELL_ACCESS_TOKEN");
  return t;
}

async function sellFetch(path, { method="GET", body } = {}) {
  const url = `${SELL_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${mustToken()}`
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!res.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : (json?.message || text || "");
    const err = new Error(`Sell API ${res.status}: ${msg}`.slice(0, 900));
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

async function getCustomFields(resourceType) {
  // resourceType: "deal" | "contact" | "lead"
  return sellFetch(`/v2/${resourceType}/custom_fields`);
}

function choiceObject(fieldDef, choiceId) {
  const c = (fieldDef?.choices || []).find(x => Number(x.id) === Number(choiceId));
  if (!c) return null;
  return { id: Number(c.id), name: c.name };
}

async function searchContacts(q) {
  const query = String(q || "").trim();
  if (!query) return [];
  const perPage = 20;

  // email
  if (query.includes("@")) {
    const r = await sellFetch(`/v2/contacts?email=${encodeURIComponent(query)}&per_page=${perPage}`);
    return (r?.items || []).map(x => x.data).filter(Boolean);
  }

  // phone first
  let r = await sellFetch(`/v2/contacts?phone=${encodeURIComponent(query)}&per_page=${perPage}`);
  let items = (r?.items || []).map(x => x.data).filter(Boolean);
  if (items.length) return items;

  // then mobile
  r = await sellFetch(`/v2/contacts?mobile=${encodeURIComponent(query)}&per_page=${perPage}`);
  items = (r?.items || []).map(x => x.data).filter(Boolean);
  return items;
}

async function findContactForDedupe({ email, phone, mobile }) {
  if (email) {
    const r = await sellFetch(`/v2/contacts?email=${encodeURIComponent(email)}&per_page=1`);
    const c = r?.items?.[0]?.data;
    if (c?.id) return c;
  }
  if (phone) {
    const r = await sellFetch(`/v2/contacts?phone=${encodeURIComponent(phone)}&per_page=1`);
    const c = r?.items?.[0]?.data;
    if (c?.id) return c;
  }
  if (mobile) {
    const r = await sellFetch(`/v2/contacts?mobile=${encodeURIComponent(mobile)}&per_page=1`);
    const c = r?.items?.[0]?.data;
    if (c?.id) return c;
  }
  return null;
}

function tagsFromEnv() {
  return (process.env.DEAL_TAGS || "portal,clinyco")
    .split(",").map(s => s.trim()).filter(Boolean);
}

function dealUrl(id){
  const base = process.env.SELL_DEAL_URL_BASE || "";
  if (!base || !id) return "";
  return `${base.replace(/\/$/,"")}/${id}`;
}
function contactUrl(id){
  const base = process.env.SELL_CONTACT_URL_BASE || "";
  if (!base || !id) return "";
  return `${base.replace(/\/$/,"")}/${id}`;
}

async function createContact(payload, { previsionFieldDef } = {}) {
  const custom_fields = {};
  custom_fields[String(CFG.contact.RUT_ID)] = payload.rut;
  custom_fields[String(CFG.contact.CIUDAD_ID)] = payload.address_city;
  custom_fields[String(CFG.contact.TELEFONO_ID)] = payload.phone;
  custom_fields[String(CFG.contact.CORREO_ID)] = payload.email2;

  if (payload.prevision_choice_id && previsionFieldDef) {
    const v = choiceObject(previsionFieldDef, payload.prevision_choice_id);
    if (v) custom_fields[String(CFG.contact.PREVISION_ID)] = v;
  }

  if (payload.agente) custom_fields[String(CFG.contact.AGENTE_ID)] = payload.agente;

  const body = {
    data: {
      is_organization: false,
      first_name: payload.first_name,
      last_name: payload.last_name,
      email: payload.email,
      mobile: payload.mobile,
      phone: payload.phone,
      address: { line1: payload.address_line1, city: payload.address_city },
      tags: tagsFromEnv(),
      custom_fields
    },
    meta: { type: "contact" }
  };

  const r = await sellFetch("/v2/contacts", { method:"POST", body });
  return r?.data;
}

async function createDeal(payload, { contactId, cirujanoFieldDef, tramoFieldDef } = {}) {
  const custom_fields = {};
  custom_fields[String(CFG.deal.RUT_ID)] = payload.rut;

  if (payload.cirujano_choice_id && cirujanoFieldDef) {
    const v = choiceObject(cirujanoFieldDef, payload.cirujano_choice_id);
    if (v) custom_fields[String(CFG.deal.CIRUJANO_ID)] = v;
  }

  // IMC: llenar string + number
  const imcRaw = String(payload.imc || "").trim().replace(",", ".");
  if (imcRaw) {
    custom_fields[String(CFG.deal.IMC_TEXT_ID)] = imcRaw;
    const n = Number(imcRaw);
    if (Number.isFinite(n)) custom_fields[String(CFG.deal.IMC_NUM_ID)] = n.toFixed(2);
  }

  custom_fields[String(CFG.deal.INTERES_ID)] = payload.interes;

  if (payload.tramo_choice_id && tramoFieldDef) {
    const v = choiceObject(tramoFieldDef, payload.tramo_choice_id);
    if (v) custom_fields[String(CFG.deal.TRAMO_ID)] = v;
  }

  if (payload.url_medinet) {
    custom_fields[String(CFG.deal.URL_MEDINET_ID)] = payload.url_medinet;
  }

  const body = {
    data: {
      name: payload.deal_name,
      contact_id: Number(contactId),
      tags: tagsFromEnv(),
      ...(process.env.DEFAULT_CURRENCY ? { currency: process.env.DEFAULT_CURRENCY } : {}),
      ...(process.env.DEAL_STAGE_ID ? { stage_id: Number(process.env.DEAL_STAGE_ID) } : {}),
      ...(process.env.DEAL_OWNER_ID ? { owner_id: Number(process.env.DEAL_OWNER_ID) } : {}),
      custom_fields
    },
    meta: { type: "deal" }
  };

  const r = await sellFetch("/v2/deals", { method:"POST", body });
  return { data: r?.data, url: dealUrl(r?.data?.id) };
}

module.exports = {
  getCustomFields,
  searchContacts,
  findContactForDedupe,
  createContact,
  createDeal,
  dealUrl,
  contactUrl
};
SELL

# ---------- Smart Paste extractor (MVP) ----------
cat > extract.js <<'EX'
function findEmail(text){
  const m = String(text||"").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : "";
}
function findPhone(text){
  const m = String(text||"").match(/\+?\d[\d\s()-]{7,}\d/);
  if (!m) return "";
  const raw = m[0];
  const digits = raw.replace(/[^\d+]/g,"");
  return digits.startsWith("+") ? digits : digits.replace(/\D/g,"");
}
function findRUT(text){
  const m = String(text||"").match(/\b\d{1,2}\.?\d{3}\.?\d{3}-[0-9kK]\b/);
  return m ? m[0] : "";
}
function findIMC(text){
  const m = String(text||"").match(/\bIMC\b\s*[:=]?\s*([0-9]+(?:[.,][0-9]+)?)/i);
  return m ? m[1].replace(",", ".") : "";
}
function findInteres(text){
  const m = String(text||"").match(/\bInter[eé]s\b\s*[:=]\s*([^\n\r]+)/i);
  return m ? String(m[1]).trim().slice(0,120) : "";
}
function guessName(text){
  const m = String(text||"").match(/\b(Nombre|Paciente)\b\s*[:=]\s*([^\n\r]+)/i);
  if (!m) return "";
  return String(m[2]).trim().replace(/\s+/g," ").slice(0,80);
}
function splitName(full){
  const s = String(full||"").trim().replace(/\s+/g," ");
  if (!s) return { first_name:"", last_name:"" };
  const p = s.split(" ");
  if (p.length === 1) return { first_name:"", last_name:p[0] };
  return { first_name:p.slice(0,-1).join(" "), last_name:p.at(-1) };
}
function matchChoiceByName(choices, text){
  const up = String(text||"").toUpperCase();
  for (const c of choices || []) {
    const n = String(c.name||"").toUpperCase();
    if (n && up.includes(n)) return c;
  }
  const tramo = up.match(/TRAMO\s*([ABCD])/);
  if (tramo) {
    const needle = `TRAMO ${tramo[1]}`;
    return (choices||[]).find(c => String(c.name||"").toUpperCase() === needle) || null;
  }
  return null;
}
module.exports = { findEmail, findPhone, findRUT, findIMC, findInteres, guessName, splitName, matchChoiceByName };
EX

# ---------- Frontend ----------
cat > public/app.css <<'CSS'
:root{
  --bg-edge:#002444; --bg-mid:#10324e; --bg-center:#47596d;
  --text:#eaf1f7; --muted:rgba(234,241,247,.75);
  --card:rgba(255,255,255,.06); --card-border:rgba(255,255,255,.10);
  --shadow:rgba(0,0,0,.25);
  --btn:#e63b7a; --btn-hover:#ff4b8c;
  --input-bg:rgba(0,0,0,.18); --input-border:rgba(255,255,255,.16);
  --ok:rgba(110,231,183,.95); --warn:rgba(253,230,138,.95); --err:rgba(252,165,165,.95);
}
*{box-sizing:border-box} html,body{height:100%}
body{
  margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;
  color:var(--text);
  background: radial-gradient(circle at 50% 40%, var(--bg-center) 0%, var(--bg-mid) 45%, var(--bg-edge) 100%);
}
.wrap{min-height:100%; display:grid; place-items:start center; padding:22px 14px 40px; gap:14px}
.brand{width:min(980px,96vw)} .logo{width:100%; display:block}
.card{
  width:min(980px,96vw); background:var(--card); border:1px solid var(--card-border);
  border-radius:18px; padding:18px; box-shadow:0 20px 50px var(--shadow); backdrop-filter: blur(8px);
}
.top{display:flex; gap:10px; align-items:center; justify-content:space-between}
h1{margin:0; font-size:18px}
.badge{font-size:12px; padding:6px 10px; border-radius:999px; border:1px solid var(--card-border); color:var(--muted)}
nav{display:flex; flex-wrap:wrap; gap:10px; margin:12px 0}
button,.btn{
  border:0; border-radius:12px; padding:11px 14px; cursor:pointer;
  background:var(--btn); color:#fff; font-weight:700; text-decoration:none;
}
button:hover,.btn:hover{background:var(--btn-hover)}
button.secondary{background:rgba(255,255,255,.10); border:1px solid rgba(255,255,255,.18)}
button.secondary:hover{background:rgba(255,255,255,.14)}
.grid{display:grid; grid-template-columns:1fr; gap:12px}
@media(min-width:820px){ .grid.two{grid-template-columns:1fr 1fr} }
label{display:grid; gap:6px; font-size:13px}
.req::after{content:" *"; color:#ff4b8c; font-weight:800}
input,select,textarea{
  width:100%; padding:10px 12px; border-radius:12px;
  border:1px solid var(--input-border); background:var(--input-bg); color:var(--text); outline:none;
}
input:focus,select:focus,textarea:focus{border-color:rgba(230,59,122,.6); box-shadow:0 0 0 4px rgba(230,59,122,.18)}
.section{margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,.10)}
.section h2{margin:0 0 8px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.2px}
.status{margin-top:10px; font-size:13px; color:var(--muted); white-space:pre-wrap}
.status.ok{color:var(--ok)} .status.warn{color:var(--warn)} .status.err{color:var(--err)}
.hidden{display:none}
CSS

cat > public/index.html <<'HTML'
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Portal Clínyco</title>
  <link rel="stylesheet" href="/app.css"/>
</head>
<body>
  <main class="wrap">
    <header class="brand">
      <!-- Pon tu logo aquí: public/assets/logo_clinyco_3d.jpeg -->
      <img class="logo" src="/assets/logo_clinyco_3d.jpeg" alt="Clínyco"/>
    </header>

    <section class="card">
      <div class="top">
        <h1>Portal Clínyco (MVP)</h1>
        <span class="badge">Sell + Portal</span>
      </div>

      <nav>
        <button class="secondary" data-view="v1">1) Trato (contacto existe)</button>
        <button class="secondary" data-view="v2">2) Contacto + Trato</button>
        <button class="secondary" data-view="v4">4) Box inteligente</button>
        <button class="secondary" data-view="v5">5) Medinet</button>
        <a class="btn secondary" id="leadsBtn" href="#" target="_blank" rel="noopener">Ir a Leads</a>
      </nav>

      <p class="status" id="globalStatus"></p>

      <!-- VIEW 1 -->
      <section id="v1" class="section hidden">
        <h2>1) Crear trato (contacto ya existe)</h2>

        <div class="grid two">
          <label class="req">Buscar contacto (email o teléfono)
            <input id="searchQ" placeholder="correo@dominio.com o +569..." />
          </label>
          <label class="req">Seleccionar contacto encontrado
            <select id="contactSelect" disabled>
              <option value="">Primero busca...</option>
            </select>
          </label>
        </div>

        <div style="margin-top:8px">
          <button id="searchBtn">Buscar</button>
        </div>

        <div class="section">
          <h2>Datos obligatorios del trato</h2>
          <div class="grid two">
            <label class="req">Nombre del trato
              <input id="dealName1" placeholder="Ej: Bariatría - Juan Pérez"/>
            </label>
            <label class="req">RUT o ID
              <input id="rut1" placeholder="12.345.678-9"/>
            </label>

            <label class="req">CIRUJANO BARIÁTRICO
              <select id="cirujano1"></select>
            </label>
            <label class="req">IMC
              <input id="imc1" type="number" step="0.1" min="0" placeholder="35.2"/>
            </label>

            <label class="req">Interés
              <input id="interes1" placeholder="Evaluación"/>
            </label>
            <label class="req">Tramo/Modalidad
              <select id="tramo1"></select>
            </label>
          </div>

          <div style="margin-top:10px">
            <button id="createDealBtn">Crear trato</button>
          </div>

          <p class="status" id="status1"></p>
        </div>
      </section>

      <!-- VIEW 2 -->
      <section id="v2" class="section hidden">
        <h2>2) Crear contacto + trato</h2>

        <div class="section">
          <h2>Contacto (obligatorios)</h2>
          <div class="grid two">
            <label class="req">Primer nombre <input id="fn2"/></label>
            <label class="req">Apellido <input id="ln2"/></label>
            <label class="req">Número de móvil <input id="mobile2" placeholder="+569..."/></label>
            <label class="req">Dirección de correo electrónico <input id="email2" type="email"/></label>
            <label class="req">Calle <input id="addr2"/></label>
            <label class="req">Ciudad <input id="city2"/></label>
            <label class="req">RUT o ID <input id="rut2"/></label>
            <label class="req">Teléfono <input id="phone2"/></label>
            <label class="req">Correo electrónico (extra) <input id="email2b" type="email"/></label>
            <label class="req">Previsión
              <select id="prevision2"></select>
            </label>
          </div>
        </div>

        <div class="section">
          <h2>Trato (obligatorios)</h2>
          <div class="grid two">
            <label class="req">Nombre del trato <input id="dealName2"/></label>
            <label class="req">CIRUJANO BARIÁTRICO <select id="cirujano2"></select></label>
            <label class="req">IMC <input id="imc2" type="number" step="0.1" min="0"/></label>
            <label class="req">Interés <input id="interes2"/></label>
            <label class="req">Tramo/Modalidad <select id="tramo2"></select></label>
          </div>
          <div style="margin-top:10px">
            <button id="createContactDealBtn">Crear contacto + trato</button>
          </div>
          <p class="status" id="status2"></p>
        </div>
      </section>

      <!-- VIEW 4 -->
      <section id="v4" class="section hidden">
        <h2>4) Box inteligente (copy/paste)</h2>
        <label class="req">Texto
          <textarea id="pasteText" rows="10" placeholder="Pega aquí..."></textarea>
        </label>
        <div style="margin-top:10px">
          <button id="extractBtn">Extraer datos</button>
          <button class="secondary" id="useToV1">Usar en opción 1</button>
          <button class="secondary" id="useToV2">Usar en opción 2</button>
        </div>
        <p class="status" id="status4"></p>
        <pre id="extractOut" class="status" style="margin-top:10px"></pre>
      </section>

      <!-- VIEW 5 -->
      <section id="v5" class="section hidden">
        <h2>5) Medinet (Contacto + Trato + URL Medinet)</h2>
        <p class="status">MVP: crea contacto+trato (como opción 2) y guarda URL en custom field URL-MEDINET.</p>

        <div class="section">
          <h2>Contacto (mismos obligatorios que opción 2)</h2>
          <div class="grid two">
            <label class="req">Primer nombre <input id="fn5"/></label>
            <label class="req">Apellido <input id="ln5"/></label>
            <label class="req">Número de móvil <input id="mobile5"/></label>
            <label class="req">Dirección de correo electrónico <input id="email5" type="email"/></label>
            <label class="req">Calle <input id="addr5"/></label>
            <label class="req">Ciudad <input id="city5"/></label>
            <label class="req">RUT o ID <input id="rut5"/></label>
            <label class="req">Teléfono <input id="phone5"/></label>
            <label class="req">Correo electrónico (extra) <input id="email5b" type="email"/></label>
            <label class="req">Previsión <select id="prevision5"></select></label>
          </div>
        </div>

        <div class="section">
          <h2>Trato + Medinet</h2>
          <div class="grid two">
            <label class="req">Nombre del trato <input id="dealName5"/></label>
            <label class="req">CIRUJANO BARIÁTRICO <select id="cirujano5"></select></label>
            <label class="req">IMC <input id="imc5" type="number" step="0.1" min="0"/></label>
            <label class="req">Interés <input id="interes5"/></label>
            <label class="req">Tramo/Modalidad <select id="tramo5"></select></label>
            <label>URL Medinet (opcional) <input id="urlMedinet5" type="url" placeholder="https://..."/></label>
          </div>
          <div style="margin-top:10px">
            <button id="createMedinetBtn">Crear (con Medinet)</button>
          </div>
          <p class="status" id="status5"></p>
        </div>
      </section>

    </section>
  </main>

  <script src="/app.js"></script>
</body>
</html>
HTML

cat > public/app.js <<'JS'
(async () => {
  const $ = (id) => document.getElementById(id);
  const views = ["v1","v2","v4","v5"];

  function show(viewId){
    views.forEach(v => $(v).classList.toggle("hidden", v !== viewId));
    // reset status per view
    ["status1","status2","status4","status5"].forEach(s => { if ($(s)) $(s).className = "status"; });
  }

  // nav
  document.querySelectorAll("button[data-view]").forEach(btn => {
    btn.addEventListener("click", () => show(btn.dataset.view));
  });

  // default view
  show("v1");

  // portal key (si usas PORTAL_KEY)
  // En vez de login, enviamos x-portal-key desde sessionStorage
  function getKey(){ return sessionStorage.getItem("portal_key") || ""; }
  function apiHeaders(){
    const h = { "Content-Type":"application/json" };
    const k = getKey();
    if (k) h["x-portal-key"] = k;
    return h;
  }
  async function api(path, opts={}){
    const res = await fetch(path, { ...opts, headers: { ...apiHeaders(), ...(opts.headers||{}) } });
    const data = await res.json().catch(()=> ({}));
    if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
    return data;
  }

  // config + leads button
  try{
    const cfg = await api("/api/config");
    const leadsUrl = cfg.sell_leads_url || "";
    if (leadsUrl) $("leadsBtn").href = leadsUrl;
    else $("leadsBtn").style.display = "none";
  }catch(e){
    $("globalStatus").textContent = "No se pudo cargar config: " + e.message;
    $("globalStatus").className = "status warn";
  }

  // options (dropdowns)
  let options;
  try{
    options = await api("/api/options");
    const cir = options?.deal?.cirujano?.choices || [];
    const tramo = options?.deal?.tramo?.choices || [];
    const prev = options?.contact?.prevision?.choices || [];

    function fillSelect(sel, items){
      sel.innerHTML = `<option value="">Selecciona...</option>` + items.map(x => `<option value="${x.id}">${x.name}</option>`).join("");
    }

    [$("cirujano1"),$("cirujano2"),$("cirujano5")].forEach(s => fillSelect(s, cir));
    [$("tramo1"),$("tramo2"),$("tramo5")].forEach(s => fillSelect(s, tramo));
    [$("prevision2"),$("prevision5")].forEach(s => fillSelect(s, prev));
  }catch(e){
    $("globalStatus").textContent = "No se pudieron cargar listas: " + e.message;
    $("globalStatus").className = "status err";
  }

  // -------- VIEW 1: search contacts ----------
  $("searchBtn").addEventListener("click", async () => {
    const q = $("searchQ").value.trim();
    $("status1").textContent = "Buscando...";
    $("status1").className = "status";
    $("contactSelect").disabled = true;
    $("contactSelect").innerHTML = `<option value="">Buscando...</option>`;

    try{
      const r = await api(`/api/contacts/search?q=${encodeURIComponent(q)}`);
      const items = r.items || [];
      if (!items.length){
        $("contactSelect").innerHTML = `<option value="">No encontrado</option>`;
        $("status1").textContent = "No se encontró contacto. Usa opción 2.";
        $("status1").className = "status warn";
        return;
      }
      $("contactSelect").disabled = false;
      $("contactSelect").innerHTML =
        `<option value="">Selecciona...</option>` +
        items.map(c => `<option value="${c.id}">${c.name || c.display_name || c.id} (id:${c.id})</option>`).join("");

      $("status1").textContent = "Selecciona el contacto y completa el trato.";
      $("status1").className = "status ok";
    }catch(e){
      $("contactSelect").innerHTML = `<option value="">Error</option>`;
      $("status1").textContent = e.message;
      $("status1").className = "status err";
    }
  });

  // create deal existing contact
  $("createDealBtn").addEventListener("click", async () => {
    const contactId = $("contactSelect").value;
    if (!contactId) {
      $("status1").textContent = "Selecciona un contacto.";
      $("status1").className = "status warn";
      return;
    }
    const payload = {
      contact_id: Number(contactId),
      deal_name: $("dealName1").value.trim(),
      rut: $("rut1").value.trim(),
      cirujano_choice_id: Number($("cirujano1").value),
      imc: $("imc1").value,
      interes: $("interes1").value.trim(),
      tramo_choice_id: Number($("tramo1").value)
    };
    const required = ["deal_name","rut","cirujano_choice_id","imc","interes","tramo_choice_id"];
    for (const k of required) {
      if (!payload[k] || payload[k] === 0) {
        $("status1").textContent = `Falta: ${k}`;
        $("status1").className = "status warn";
        return;
      }
    }
    $("status1").textContent = "Creando trato...";
    $("status1").className = "status";

    try{
      const r = await api("/api/deals/create", { method:"POST", body: JSON.stringify(payload) });
      $("status1").textContent = `✅ OK. deal_id=${r.deal_id}\n${r.deal_url || ""}`;
      $("status1").className = "status ok";
    }catch(e){
      $("status1").textContent = e.message;
      $("status1").className = "status err";
    }
  });

  // -------- VIEW 2: contact + deal ----------
  function suggestDealName(fn, ln, deal){
    if (deal.value.trim()) return;
    const name = `${fn.value} ${ln.value}`.trim();
    if (name) deal.value = `Bariatría - ${name}`;
  }
  $("fn2").addEventListener("blur", ()=>suggestDealName($("fn2"),$("ln2"),$("dealName2")));
  $("ln2").addEventListener("blur", ()=>suggestDealName($("fn2"),$("ln2"),$("dealName2")));

  $("createContactDealBtn").addEventListener("click", async () => {
    const contact = {
      first_name: $("fn2").value.trim(),
      last_name: $("ln2").value.trim(),
      mobile: $("mobile2").value.trim(),
      email: $("email2").value.trim(),
      address_line1: $("addr2").value.trim(),
      address_city: $("city2").value.trim(),
      rut: $("rut2").value.trim(),
      phone: $("phone2").value.trim(),
      email2: $("email2b").value.trim(),
      prevision_choice_id: Number($("prevision2").value)
    };
    const deal = {
      deal_name: $("dealName2").value.trim(),
      rut: contact.rut,
      cirujano_choice_id: Number($("cirujano2").value),
      imc: $("imc2").value,
      interes: $("interes2").value.trim(),
      tramo_choice_id: Number($("tramo2").value)
    };

    $("status2").textContent = "Creando...";
    $("status2").className = "status";

    try{
      const r = await api("/api/contact-deal/create", { method:"POST", body: JSON.stringify({ contact, deal }) });
      $("status2").textContent = `✅ OK. contact_id=${r.contact_id} deal_id=${r.deal_id}\n${r.deal_url || ""}`;
      $("status2").className = "status ok";
    }catch(e){
      $("status2").textContent = e.message;
      $("status2").className = "status err";
    }
  });

  // -------- VIEW 4: smart paste ----------
  let extracted = null;
  $("extractBtn").addEventListener("click", async () => {
    $("status4").textContent = "Extrayendo...";
    $("status4").className = "status";
    $("extractOut").textContent = "";

    try{
      const r = await api("/api/extract", { method:"POST", body: JSON.stringify({ text: $("pasteText").value }) });
      extracted = r;
      $("extractOut").textContent = JSON.stringify(r, null, 2);
      $("status4").textContent = "Listo. Puedes enviar a opción 1 o 2.";
      $("status4").className = "status ok";
    }catch(e){
      $("status4").textContent = e.message;
      $("status4").className = "status err";
    }
  });

  function applyToV1(x){
    $("dealName1").value = x.deal_name || $("dealName1").value;
    $("rut1").value = x.rut || $("rut1").value;
    $("imc1").value = x.imc || $("imc1").value;
    $("interes1").value = x.interes || $("interes1").value;
    if (x.cirujano_choice_id) $("cirujano1").value = String(x.cirujano_choice_id);
    if (x.tramo_choice_id) $("tramo1").value = String(x.tramo_choice_id);
    if (x.email || x.mobile) $("searchQ").value = x.email || x.mobile;
  }
  function applyToV2(x){
    $("fn2").value = x.first_name || $("fn2").value;
    $("ln2").value = x.last_name || $("ln2").value;
    $("mobile2").value = x.mobile || $("mobile2").value;
    $("email2").value = x.email || $("email2").value;
    $("phone2").value = x.phone || x.mobile || $("phone2").value;
    $("email2b").value = x.email || $("email2b").value;
    $("rut2").value = x.rut || $("rut2").value;
    $("dealName2").value = x.deal_name || $("dealName2").value;
    $("imc2").value = x.imc || $("imc2").value;
    $("interes2").value = x.interes || $("interes2").value;
    if (x.prevision_choice_id) $("prevision2").value = String(x.prevision_choice_id);
    if (x.cirujano_choice_id) $("cirujano2").value = String(x.cirujano_choice_id);
    if (x.tramo_choice_id) $("tramo2").value = String(x.tramo_choice_id);
  }

  $("useToV1").addEventListener("click", () => { if (extracted) { applyToV1(extracted); show("v1"); }});
  $("useToV2").addEventListener("click", () => { if (extracted) { applyToV2(extracted); show("v2"); }});

  // -------- VIEW 5: Medinet ----------
  $("fn5").addEventListener("blur", ()=>suggestDealName($("fn5"),$("ln5"),$("dealName5")));
  $("ln5").addEventListener("blur", ()=>suggestDealName($("fn5"),$("ln5"),$("dealName5")));

  $("createMedinetBtn").addEventListener("click", async () => {
    const contact = {
      first_name: $("fn5").value.trim(),
      last_name: $("ln5").value.trim(),
      mobile: $("mobile5").value.trim(),
      email: $("email5").value.trim(),
      address_line1: $("addr5").value.trim(),
      address_city: $("city5").value.trim(),
      rut: $("rut5").value.trim(),
      phone: $("phone5").value.trim(),
      email2: $("email5b").value.trim(),
      prevision_choice_id: Number($("prevision5").value)
    };
    const deal = {
      deal_name: $("dealName5").value.trim(),
      rut: contact.rut,
      cirujano_choice_id: Number($("cirujano5").value),
      imc: $("imc5").value,
      interes: $("interes5").value.trim(),
      tramo_choice_id: Number($("tramo5").value),
      url_medinet: $("urlMedinet5").value.trim()
    };

    $("status5").textContent = "Creando...";
    $("status5").className = "status";

    try{
      const r = await api("/api/contact-deal/create", { method:"POST", body: JSON.stringify({ contact, deal }) });
      $("status5").textContent = `✅ OK. contact_id=${r.contact_id} deal_id=${r.deal_id}\n${r.deal_url || ""}`;
      $("status5").className = "status ok";
    }catch(e){
      $("status5").textContent = e.message;
      $("status5").className = "status err";
    }
  });

})();
JS

# ---------- Backend server ----------
cat > server.js <<'SRV'
const express = require("express");
const path = require("path");
const CFG = require("./sell_config");
const { getCustomFields, searchContacts, findContactForDedupe, createContact, createDeal, contactUrl } = require("./sell");
const { findEmail, findPhone, findRUT, findIMC, findInteres, guessName, splitName, matchChoiceByName } = require("./extract");

const app = express();
app.use(express.json({ limit: "600kb" }));

// Permitir iframe en Zendesk Sell (modal)
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'self' https://*.zendesk.com https://clinyco.zendesk.com"
  );
  next();
});

// Seguridad opcional por header
app.use((req, res, next) => {
  const key = process.env.PORTAL_KEY;
  if (!key) return next();
  if (req.path === "/health") return next();
  const got = req.header("x-portal-key") || "";
  if (got !== key) return res.status(401).json({ error: "Unauthorized (x-portal-key)" });
  next();
});

// Static
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/config", (_req, res) => {
  res.json({
    sell_leads_url: process.env.SELL_LEADS_URL || "",
    deal_url_base: process.env.SELL_DEAL_URL_BASE || "",
    contact_url_base: process.env.SELL_CONTACT_URL_BASE || ""
  });
});

// Cache de opciones por 10 min
let cache = { at: 0, data: null };
const TTL = 10 * 60 * 1000;

app.get("/api/options", async (_req, res) => {
  const now = Date.now();
  if (cache.data && (now - cache.at) < TTL) return res.json(cache.data);

  const dealCF = await getCustomFields("deal");
  const contactCF = await getCustomFields("contact");

  const dealItems = (dealCF?.items || []).map(x => x.data).filter(Boolean);
  const contactItems = (contactCF?.items || []).map(x => x.data).filter(Boolean);

  const dealCirujano = dealItems.find(f => f.id === CFG.deal.CIRUJANO_ID);
  const dealTramo = dealItems.find(f => f.id === CFG.deal.TRAMO_ID);
  const contactPrevision = contactItems.find(f => f.id === CFG.contact.PREVISION_ID);

  const data = {
    deal: {
      cirujano: { id: CFG.deal.CIRUJANO_ID, name: dealCirujano?.name, choices: dealCirujano?.choices || [] },
      tramo: { id: CFG.deal.TRAMO_ID, name: dealTramo?.name, choices: dealTramo?.choices || [] }
    },
    contact: {
      prevision: { id: CFG.contact.PREVISION_ID, name: contactPrevision?.name, choices: contactPrevision?.choices || [] }
    }
  };

  cache = { at: now, data };
  res.json(data);
});

app.get("/api/contacts/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Falta q" });
  const items = await searchContacts(q);
  // normaliza salida
  res.json({
    items: items.map(c => ({
      id: c.id,
      name: c.name || c.display_name || `${c.first_name||""} ${c.last_name||""}`.trim(),
      email: c.email,
      phone: c.phone,
      mobile: c.mobile
    }))
  });
});

async function getFieldDefs() {
  // usa cache si existe
  const opts = cache.data || (await (await fetch("http://localhost/")).json().catch(()=>null)); // no se usa realmente
  // mejor: obtener defs directas
  const dealCF = await getCustomFields("deal");
  const contactCF = await getCustomFields("contact");
  const dealItems = (dealCF?.items || []).map(x => x.data).filter(Boolean);
  const contactItems = (contactCF?.items || []).map(x => x.data).filter(Boolean);

  return {
    dealCirujano: dealItems.find(f => f.id === CFG.deal.CIRUJANO_ID),
    dealTramo: dealItems.find(f => f.id === CFG.deal.TRAMO_ID),
    contactPrevision: contactItems.find(f => f.id === CFG.contact.PREVISION_ID)
  };
}

app.post("/api/deals/create", async (req, res) => {
  const b = req.body || {};
  const required = ["contact_id","deal_name","rut","cirujano_choice_id","imc","interes","tramo_choice_id"];
  for (const k of required) if (!b[k]) return res.status(400).json({ error: `${k} requerido` });

  const defs = await getFieldDefs();

  const { data, url } = await createDeal(
    {
      deal_name: b.deal_name,
      rut: b.rut,
      cirujano_choice_id: Number(b.cirujano_choice_id),
      imc: b.imc,
      interes: b.interes,
      tramo_choice_id: Number(b.tramo_choice_id)
    },
    { contactId: Number(b.contact_id), cirujanoFieldDef: defs.dealCirujano, tramoFieldDef: defs.dealTramo }
  );

  res.json({ ok:true, deal_id: data?.id, deal_url: url });
});

app.post("/api/contact-deal/create", async (req, res) => {
  const body = req.body || {};
  const c = body.contact || {};
  const d = body.deal || {};

  const cReq = ["first_name","last_name","mobile","email","address_line1","address_city","rut","phone","email2","prevision_choice_id"];
  for (const k of cReq) if (!c[k]) return res.status(400).json({ error: `contact.${k} requerido` });

  const dReq = ["deal_name","rut","cirujano_choice_id","imc","interes","tramo_choice_id"];
  for (const k of dReq) if (!d[k]) return res.status(400).json({ error: `deal.${k} requerido` });

  const defs = await getFieldDefs();

  // dedupe
  const existing = await findContactForDedupe({ email: c.email, phone: c.phone, mobile: c.mobile });
  let contactId = existing?.id;

  if (!contactId) {
    const created = await createContact(
      {
        first_name: c.first_name,
        last_name: c.last_name,
        mobile: c.mobile,
        email: c.email,
        address_line1: c.address_line1,
        address_city: c.address_city,
        rut: c.rut,
        phone: c.phone,
        email2: c.email2,
        prevision_choice_id: Number(c.prevision_choice_id),
        agente: c.agente || ""
      },
      { previsionFieldDef: defs.contactPrevision }
    );
    contactId = created?.id;
  }

  const { data: dealData, url: dealUrl } = await createDeal(
    {
      deal_name: d.deal_name,
      rut: d.rut,
      cirujano_choice_id: Number(d.cirujano_choice_id),
      imc: d.imc,
      interes: d.interes,
      tramo_choice_id: Number(d.tramo_choice_id),
      url_medinet: d.url_medinet || ""
    },
    { contactId, cirujanoFieldDef: defs.dealCirujano, tramoFieldDef: defs.dealTramo }
  );

  res.json({
    ok:true,
    contact_id: contactId,
    deal_id: dealData?.id,
    deal_url: dealUrl,
    contact_url: contactUrl(contactId)
  });
});

app.post("/api/extract", async (req, res) => {
  const text = String(req.body?.text || "");
  if (!text.trim()) return res.status(400).json({ error: "text requerido" });

  const defs = await getFieldDefs();

  const email = findEmail(text);
  const phone = findPhone(text);
  const rut = findRUT(text);
  const imc = findIMC(text);
  const interes = findInteres(text);

  const fullName = guessName(text);
  const { first_name, last_name } = splitName(fullName);

  const cir = matchChoiceByName(defs.dealCirujano?.choices, text);
  const tramo = matchChoiceByName(defs.dealTramo?.choices, text);
  const prev = matchChoiceByName(defs.contactPrevision?.choices, text);

  res.json({
    email,
    mobile: phone,
    phone: phone,
    rut,
    imc,
    interes,
    first_name,
    last_name,
    deal_name: fullName ? `Bariatría - ${fullName}` : "",
    cirujano_choice_id: cir ? cir.id : null,
    tramo_choice_id: tramo ? tramo.id : null,
    prevision_choice_id: prev ? prev.id : null
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Portal listo en :${port}`));
SRV

echo "✅ Bootstrap listo. Ahora:"
echo "1) Copia tu logo a public/assets/logo_clinyco_3d.jpeg"
echo "2) cp .env.example .env  (y setea SELL_ACCESS_TOKEN nuevo)"
echo "3) npm install && npm start"
