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
