const CFG = require("./sell_config");

const SELL_API_BASE = process.env.SELL_API_BASE || "https://api.getbase.com";

function mustToken() {
  const t = process.env.SELL_ACCESS_TOKEN;
  if (!t) throw new Error("Falta SELL_ACCESS_TOKEN");
  return t;
}

async function sellFetch(path, { method = "GET", body } = {}) {
  const url = `${SELL_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${mustToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : json?.message || text || "";
    const err = new Error(`Sell API ${res.status}: ${msg}`.slice(0, 900));
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

async function getCustomFields(resourceType) {
  return sellFetch(`/v2/${resourceType}/custom_fields`);
}

function choiceObject(fieldDef, choiceId) {
  const c = (fieldDef?.choices || []).find((x) => Number(x.id) === Number(choiceId));
  if (!c) return null;
  return { id: Number(c.id), name: c.name };
}

async function getStagesByPipeline(pipelineId) {
  return sellFetch(`/v2/stages?pipeline_id=${encodeURIComponent(pipelineId)}&per_page=100&sort_by=position`);
}

async function searchV3(index, { filter, projection = ["id"], per_page = 50 } = {}) {
  const body = {
    items: [
      {
        data: {
          query: {
            ...(filter ? { filter } : {}),
            projection: projection.map((name) => ({ name })),
          },
        },
        per_page,
      },
    ],
  };

  const r = await sellFetch(`/v3/${index}/search`, { method: "POST", body });
  const bucket = r?.items?.[0];
  if (!bucket?.successful) return [];
  return (bucket.items || []).map((x) => x.data).filter(Boolean);
}

async function searchContactsByRutNorm(rutNorm) {
  return searchV3("contacts", {
    filter: {
      filter: {
        attribute: { name: `custom_fields.${CFG.contact.RUT_NORM_ID}` },
        parameter: { eq: rutNorm },
      },
    },
    projection: ["id", "display_name", "email", , ],
    per_page: 25,
  });
}

async function searchDealsByRutInStages(rutNorm, stageIds) {
  return searchV3("deals", {
    filter: {
      and: [
        {
          filter: {
            attribute: { name: `custom_fields.${CFG.deal.RUT_NORM_ID}` },
            parameter: { eq: rutNorm },
          },
        },
        {
          filter: {
            attribute: { name: "stage_id" },
            parameter: { any: stageIds },
          },
        },
      ],
    },
    projection: ["id", "name", "stage_id", "contact_id"],
    per_page: 25,
  });
}

function tagsFromEnv() {
  return (process.env.DEAL_TAGS || "portal,clinyco")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function urlFromBase(base, id) {
  if (!base || !id) return "";
  return `${String(base).replace(/\/$/, "")}/${id}`;
}

function dealUrl(id) {
  return urlFromBase(process.env.SELL_DEAL_URL_BASE || "", id);
}
function contactUrl(id) {
  return urlFromBase(process.env.SELL_CONTACT_URL_BASE || "", id);
}
function dealUrlMobile(id) {
  return urlFromBase(process.env.SELL_DEAL_URL_BASE_MOBILE || "", id);
}
function contactUrlMobile(id) {
  return urlFromBase(process.env.SELL_CONTACT_URL_BASE_MOBILE || "", id);
}
function links(type, id) {
  if (type === "deal") return { web: dealUrl(id), mobile: dealUrlMobile(id) };
  if (type === "contact") return { web: contactUrl(id), mobile: contactUrlMobile(id) };
  return { web: "", mobile: "" };
}

async function createContact(payload, { previsionFieldDef } = {}) {
  const custom_fields = {};

  // CANÓNICO: RUT_normalizado
  custom_fields[String(CFG.contact.RUT_NORM_ID)] = payload.rut_normalizado;

  // LEGACY espejo: RUT o ID (raw)
  custom_fields[String(CFG.contact.RUT_ID)] = payload.rut;

  custom_fields[String(CFG.contact.CIUDAD_ID)] = payload.address_city;
  custom_fields[String(CFG.contact.TELEFONO_ID)] = payload.phone;
  custom_fields[String(CFG.contact.CORREO_ID)] = payload.email2;

  if (payload.birth_date) custom_fields[String(CFG.contact.BIRTHDATE_ID)] = payload.birth_date;

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
      custom_fields,
    },
    meta: { type: "contact" },
  };

  const r = await sellFetch("/v2/contacts", { method: "POST", body });
  return r?.data;
}

async function updateContact(contactId, patch) {
  const body = { data: patch, meta: { type: "contact" } };
  const r = await sellFetch(`/v2/contacts/${contactId}`, { method: "PUT", body });
  return r?.data;
}

async function createDeal(payload, { contactId, cirujanoFieldDef, tramoFieldDef, previsionDealChoice, stageId } = {}) {
  const custom_fields = {};

  // CANÓNICO: RUT_normalizado
  custom_fields[String(CFG.deal.RUT_NORM_ID)] = payload.rut_normalizado;

  // LEGACY: RUT o ID (raw)
  custom_fields[String(CFG.deal.RUT_ID)] = payload.rut;

  if (payload.birth_date) custom_fields[String(CFG.deal.BIRTHDATE_ID)] = payload.birth_date;

  // Previsión canónica en DEAL (objeto {id,name})
  if (previsionDealChoice) custom_fields[String(CFG.deal.PREVISION_ID)] = previsionDealChoice;

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

  if (payload.url_medinet) custom_fields[String(CFG.deal.URL_MEDINET_ID)] = payload.url_medinet;

  const body = {
    data: {
      name: payload.deal_name,
      contact_id: Number(contactId),
      tags: tagsFromEnv(),
      ...(process.env.DEFAULT_CURRENCY ? { currency: process.env.DEFAULT_CURRENCY } : {}),
      ...(stageId ? { stage_id: Number(stageId) } : {}),
      ...(process.env.DEAL_OWNER_ID ? { owner_id: Number(process.env.DEAL_OWNER_ID) } : {}),
      custom_fields,
    },
    meta: { type: "deal" },
  };

  const r = await sellFetch("/v2/deals", { method: "POST", body });
  return { data: r?.data, url: dealUrl(r?.data?.id) };
}

module.exports = {
  sellFetch,
  getCustomFields,
  getStagesByPipeline,
  searchV3,
  searchContactsByRutNorm,
  searchDealsByRutInStages,
  createContact,
  updateContact,
  createDeal,
  dealUrl,
  contactUrl,
  dealUrlMobile,
  contactUrlMobile,
  links,
  choiceObject,
};
