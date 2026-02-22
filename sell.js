const CFG = require("./sell_config");

const SELL_API_BASE = process.env.SELL_API_BASE || "https://api.getbase.com";

function mustToken() {
  const t = process.env.SELL_ACCESS_TOKEN;
  if (!t) throw new Error("Falta SELL_ACCESS_TOKEN");
  return t;
}

async function sellFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${SELL_API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${mustToken()}`
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : (json?.message || text || "");
    const err = new Error(`Sell API ${res.status}: ${msg}`.slice(0, 900));
    err.status = res.status;
    err.details = json;
    throw err;
  }

  return json;
}

async function searchV3(index, { queryFilter, projectionNames = [], per_page = 100 } = {}) {
  const query = { filter: queryFilter };
  if (projectionNames.length > 0) {
    query.projection = projectionNames.map((name) => ({ name }));
  }

  const body = {
    items: [
      {
        data: { query },
        per_page
      }
    ]
  };

  const r = await sellFetch(`/v3/${index}/search`, { method: "POST", body });
  const bucket = r?.items?.[0];
  return (bucket?.items || []).map((x) => x.data).filter(Boolean);
}

async function searchContactsByRutNorm(rutNorm) {
  return searchV3("contacts", {
    queryFilter: {
      filter: {
        attribute: { name: `custom_fields.contact:${CFG.contact.RUT_NORMALIZADO_ID}` },
        parameter: { eq: String(rutNorm) }
      }
    },
    projectionNames: ["id", "display_name"],
    per_page: 50
  });
}

async function searchDealsByRutInStages(rutNorm, stageIds = []) {
  return searchV3("deals", {
    queryFilter: {
      and: [
        {
          filter: {
            attribute: { name: `custom_fields.${CFG.deal.RUT_NORMALIZADO_ID}` },
            parameter: { eq: String(rutNorm) }
          }
        },
        {
          filter: {
            attribute: { name: "stage_id" },
            parameter: { any: stageIds.map(Number) }
          }
        }
      ]
    },
    projectionNames: ["id", "name", "stage_id", "contact_id"],
    per_page: 50
  });
}

async function getStagesByPipeline(pipelineId) {
  const r = await sellFetch(`/v2/stages?pipeline_id=${encodeURIComponent(pipelineId)}&sort_by=position&per_page=100`);
  return (r?.items || []).map((x) => x.data).filter(Boolean);
}

async function getCustomFields(resourceType) {
  return sellFetch(`/v2/${resourceType}/custom_fields`);
}

function choiceObject(fieldDef, choiceId) {
  const c = (fieldDef?.choices || []).find((x) => Number(x.id) === Number(choiceId));
  return c ? { id: Number(c.id), name: c.name } : null;
}

function tagsFromEnv() {
  return (process.env.DEAL_TAGS || "portal,clinyco").split(",").map((s) => s.trim()).filter(Boolean);
}

function links(type, id) {
  const cleanId = Number(id);
  if (!cleanId) return { web: "", mobile: "" };

  const webDealBase = process.env.SELL_DEAL_URL_BASE || "https://clinyco.zendesk.com/sales/deals";
  const webContactBase = process.env.SELL_CONTACT_URL_BASE || "https://clinyco.zendesk.com/sales/contacts";
  const mobileDealBase = process.env.SELL_DEAL_MOBILE_URL_BASE || "https://app.futuresimple.com/sales/deals";
  const mobileContactBase = process.env.SELL_CONTACT_MOBILE_URL_BASE || "https://app.futuresimple.com/crm/contacts";

  if (type === "deal") {
    return {
      web: `${webDealBase.replace(/\/$/, "")}/${cleanId}`,
      mobile: `${mobileDealBase.replace(/\/$/, "")}/${cleanId}`
    };
  }

  return {
    web: `${webContactBase.replace(/\/$/, "")}/${cleanId}`,
    mobile: `${mobileContactBase.replace(/\/$/, "")}/${cleanId}`
  };
}

function dealUrl(id) {
  return links("deal", id).web;
}

function contactUrl(id) {
  return links("contact", id).web;
}

async function searchContacts(q) {
  const query = String(q || "").trim();
  if (!query) return [];
  const perPage = 20;

  if (query.includes("@")) {
    const r = await sellFetch(`/v2/contacts?email=${encodeURIComponent(query)}&per_page=${perPage}`);
    return (r?.items || []).map((x) => x.data).filter(Boolean);
  }

  let r = await sellFetch(`/v2/contacts?phone=${encodeURIComponent(query)}&per_page=${perPage}`);
  let items = (r?.items || []).map((x) => x.data).filter(Boolean);
  if (items.length) return items;

  r = await sellFetch(`/v2/contacts?mobile=${encodeURIComponent(query)}&per_page=${perPage}`);
  items = (r?.items || []).map((x) => x.data).filter(Boolean);
  return items;
}

async function createContact(payload) {
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
      custom_fields: payload.custom_fields || {}
    },
    meta: { type: "contact" }
  };

  const r = await sellFetch("/v2/contacts", { method: "POST", body });
  return r?.data;
}

async function updateContact(contactId, payload) {
  const body = {
    data: {
      ...(payload.email ? { email: payload.email } : {}),
      ...(payload.mobile ? { mobile: payload.mobile } : {}),
      ...(payload.phone ? { phone: payload.phone } : {}),
      ...(payload.custom_fields ? { custom_fields: payload.custom_fields } : {})
    },
    meta: { type: "contact" }
  };

  const r = await sellFetch(`/v2/contacts/${Number(contactId)}`, { method: "PUT", body });
  return r?.data;
}

async function createDeal(payload, { contactId, stageId } = {}) {
  const body = {
    data: {
      name: payload.deal_name,
      contact_id: Number(contactId),
      stage_id: Number(stageId),
      tags: tagsFromEnv(),
      ...(process.env.DEFAULT_CURRENCY ? { currency: process.env.DEFAULT_CURRENCY } : {}),
      ...(process.env.DEAL_OWNER_ID ? { owner_id: Number(process.env.DEAL_OWNER_ID) } : {}),
      custom_fields: payload.custom_fields || {}
    },
    meta: { type: "deal" }
  };

  const r = await sellFetch("/v2/deals", { method: "POST", body });
  return { data: r?.data, url: dealUrl(r?.data?.id) };
}

module.exports = {
  sellFetch,
  searchV3,
  searchContactsByRutNorm,
  searchDealsByRutInStages,
  getStagesByPipeline,
  getCustomFields,
  choiceObject,
  links,
  searchContacts,
  createContact,
  updateContact,
  createDeal,
  dealUrl,
  contactUrl
};
