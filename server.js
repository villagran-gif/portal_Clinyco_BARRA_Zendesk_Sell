require("dotenv").config();
require("express-async-errors");

const express = require("express");
const path = require("path");

const CFG = require("./sell_config");
const {
  getCustomFields,
  getStagesByPipeline,
  searchContactsByRutNorm,
  searchDealsByRutInStages,
  createContact,
  updateContact,
  createDeal,
  links,
  choiceObject,
} = require("./sell");

const {
  findEmail,
  findPhone,
  findRUT,
  findIMC,
  findInteres,
  parseKeyNextValue,
  parseInlineColonPairs,
  mergeMaps,
  splitNameFromMap,
  matchChoiceByName,
} = require("./extract");

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


async function handleSearchByRut(req, res) {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Falta q" });

  const rutNormalizado = normalizeRut(q);
  if (!rutNormalizado) return res.status(400).json({ error: "RUT vacío" });

  // Buscar por RUT_normalizado (CONTACT custom field 6265931)
  const items = await searchContactsByRutNorm(rutNormalizado);

  return res.json({
    items: (items || []).map((c) => ({
      id: c.id,
      name: c.display_name || c.name || "",
      links: links("contact", c.id),
    })),
  });
}


app.get("/api/config", (_req, res) => {
  res.json({
    sell_leads_url: process.env.SELL_LEADS_URL || "",
    deal_url_base: process.env.SELL_DEAL_URL_BASE || "",
    contact_url_base: process.env.SELL_CONTACT_URL_BASE || "",
    deal_url_base_mobile: process.env.SELL_DEAL_URL_BASE_MOBILE || "",
    contact_url_base_mobile: process.env.SELL_CONTACT_URL_BASE_MOBILE || "",
  });
});

function normalizeRut(raw) {
  const s = String(raw || "").trim().toUpperCase();
  const cleaned = s.replace(/[^0-9K]/g, "");
  if (cleaned.length < 2) return null;
  const body = cleaned.slice(0, -1);
  const dv = cleaned.slice(-1);
  if (!/^[0-9]+$/.test(body)) return null;
  if (!/^[0-9K]$/.test(dv)) return null;
  return `${body}${dv}`; // ej: 167041256
}

function computeRutDv(bodyDigits) {
  let sum = 0;
  let mul = 2;
  for (let i = bodyDigits.length - 1; i >= 0; i--) {
    sum += Number(bodyDigits[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const mod = 11 - (sum % 11);
  if (mod === 11) return "0";
  if (mod === 10) return "K";
  return String(mod);
}

function validateRut(rutNorm) {
  const body = rutNorm.slice(0, -1);
  const dv = rutNorm.slice(-1);
  return computeRutDv(body) === dv;
}

function parseStageByPipelineEnv() {
  try {
    const raw = process.env.STAGE_BY_PIPELINE || "{}";
    const obj = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[String(k)] = Number(v);
    return out;
  } catch {
    return {};
  }
}

// Cache de opciones por 10 min
let cache = { at: 0, data: null, defs: null, stages: new Map() };
const TTL = 10 * 60 * 1000;

async function getFieldDefsCached() {
  const now = Date.now();
  if (cache.defs && now - cache.at < TTL) return cache.defs;

  const dealCF = await getCustomFields("deal");
  const contactCF = await getCustomFields("contact");

  const dealItems = (dealCF?.items || []).map((x) => x.data).filter(Boolean);
  const contactItems = (contactCF?.items || []).map((x) => x.data).filter(Boolean);

  const defs = {
    dealCirujano: dealItems.find((f) => f.id === CFG.deal.CIRUJANO_ID),
    dealTramo: dealItems.find((f) => f.id === CFG.deal.TRAMO_ID),
    dealPrevision: dealItems.find((f) => f.id === CFG.deal.PREVISION_ID),

    contactPrevision: contactItems.find((f) => f.id === CFG.contact.PREVISION_ID),
  };

  cache.at = now;
  cache.defs = defs;
  return defs;
}

async function getStagesForPipelineCached(pipelineId) {
  const now = Date.now();
  const hit = cache.stages.get(String(pipelineId));
  if (hit && now - hit.at < TTL) return hit.data;

  const r = await getStagesByPipeline(pipelineId);
  const items = (r?.items || []).map((x) => x.data).filter(Boolean);
  cache.stages.set(String(pipelineId), { at: now, data: items });
  return items;
}

// /api/options: mantiene lo que ya usa el frontend, y agrega deal.prevision
app.get("/api/options", async (_req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL) return res.json(cache.data);

  const defs = await getFieldDefsCached();
  const data = {
    deal: {
      cirujano: { id: CFG.deal.CIRUJANO_ID, name: defs.dealCirujano?.name, choices: defs.dealCirujano?.choices || [] },
      tramo: { id: CFG.deal.TRAMO_ID, name: defs.dealTramo?.name, choices: defs.dealTramo?.choices || [] },
      prevision: { id: CFG.deal.PREVISION_ID, name: defs.dealPrevision?.name, choices: defs.dealPrevision?.choices || [] },
    },
    contact: {
      prevision: { id: CFG.contact.PREVISION_ID, name: defs.contactPrevision?.name, choices: defs.contactPrevision?.choices || [] },
    },
    defaults: {
      pipeline_id: Number(process.env.DEFAULT_PIPELINE_ID || CFG.bariatrica.PIPELINE_ID),
      stage_by_pipeline: parseStageByPipelineEnv(),
    },
  };

  cache.at = now;
  cache.data = data;
  res.json(data);
});

// Buscar contactos: si parece RUT -> busca por RUT_normalizado; si no, queda como antes (email/teléfono)
app.get("/api/contacts/search", handleSearchByRut);
app.get("/api/contacts/search-rut", handleSearchByRut);

// Deal (contacto ya existe) - ahora también valida duplicado por RUT en pipeline default
app.post("/api/deals/create", async (req, res) => {
  const b = req.body || {};
  const required = ["contact_id", "deal_name", "rut", "cirujano_choice_id", "imc", "interes", "tramo_choice_id"];
  for (const k of required) if (!b[k]) return res.status(400).json({ error: `${k} requerido` });

  const rutNorm = normalizeRut(b.rut);
  if (!rutNorm) return res.status(400).json({ error: "RUT inválido (no se pudo normalizar)" });

  const validate = (process.env.RUT_VALIDATE || "true").toLowerCase() !== "false";
  if (validate && !validateRut(rutNorm)) return res.status(400).json({ error: "RUT inválido (DV no coincide)" });

  const defs = await getFieldDefsCached();

  const pipelineId = Number(b.pipeline_id || process.env.DEFAULT_PIPELINE_ID || CFG.bariatrica.PIPELINE_ID);
  const stages = await getStagesForPipelineCached(pipelineId);
  const activeStages = stages.filter((s) => s.active).sort((a, b) => a.position - b.position);
  const stageIds = activeStages.map((s) => s.id);

  // Dedupe deal en pipeline por RUT_normalizado
  const dupDeals = await searchDealsByRutInStages(rutNorm, stageIds);
  if (dupDeals.length >= 1) {
    return res.status(409).json({
      error: "DUPLICADO: ya existe deal con ese RUT_normalizado en el pipeline",
      rut_normalizado: rutNorm,
      pipeline_id: pipelineId,
      deal_duplicates: dupDeals.map((d) => ({
        id: d.id,
        name: d.name,
        stage_id: d.stage_id,
        links: links("deal", d.id),
      })),
    });
  }

  // Stage: Bariátrica candidato si aplica, si no primer stage activo
  const stageByPipeline = parseStageByPipelineEnv();
  let stageId =
    stageByPipeline[String(pipelineId)] ||
    (pipelineId === CFG.bariatrica.PIPELINE_ID ? CFG.bariatrica.STAGE_CANDIDATO_ID : null) ||
    activeStages[0]?.id;

  const { data, url } = await createDeal(
    {
      deal_name: b.deal_name,
      rut: b.rut,
      rut_normalizado: rutNorm,
      cirujano_choice_id: Number(b.cirujano_choice_id),
      imc: b.imc,
      interes: b.interes,
      tramo_choice_id: Number(b.tramo_choice_id),
    },
    {
      contactId: Number(b.contact_id),
      cirujanoFieldDef: defs.dealCirujano,
      tramoFieldDef: defs.dealTramo,
      previsionDealChoice: null,
      stageId,
    }
  );

  res.json({
    ok: true,
    deal_id: data?.id,
    deal_url: url,
    deal_links: links("deal", data?.id),
  });
});

// Contacto + Deal (principal) con reglas de dedupe por RUT_normalizado
app.post("/api/contact-deal/create", async (req, res) => {
  const body = req.body || {};
  const c = body.contact || {};
  const d = body.deal || {};

  const cReq = ["first_name", "last_name", "mobile", "email", "address_line1", "address_city", "rut", "phone", "email2", "prevision_choice_id"];
  for (const k of cReq) if (!c[k]) return res.status(400).json({ error: `contact.${k} requerido` });

  const dReq = ["deal_name", "rut", "cirujano_choice_id", "imc", "interes", "tramo_choice_id"];
  for (const k of dReq) if (!d[k]) return res.status(400).json({ error: `deal.${k} requerido` });

  const rutNorm = normalizeRut(c.rut);
  if (!rutNorm) return res.status(400).json({ error: "RUT inválido (no se pudo normalizar)" });

  const validate = (process.env.RUT_VALIDATE || "true").toLowerCase() !== "false";
  if (validate && !validateRut(rutNorm)) return res.status(400).json({ error: "RUT inválido (DV no coincide)" });

  const defs = await getFieldDefsCached();

  // 1) Dedupe contactos por RUT_normalizado
  const foundContacts = await searchContactsByRutNorm(rutNorm);
  if (foundContacts.length > 1) {
    return res.status(409).json({
      error: "DUPLICADO: existen múltiples contactos con el mismo RUT_normalizado",
      rut_normalizado: rutNorm,
      contact_duplicates: foundContacts.map((x) => ({
        id: x.id,
        display_name: x.display_name,
        links: links("contact", x.id),
      })),
    });
  }

  let contactId = foundContacts[0]?.id || null;

  // Resolver Previsión espejo (contact) + canónica (deal)
  const contactPrevObj = choiceObject(defs.contactPrevision, Number(c.prevision_choice_id));
  const dealPrevObj = contactPrevObj
    ? (() => {
        // Mapear por nombre hacia choices del DEAL (pueden ser ids distintos)
        const m = matchChoiceByName(defs.dealPrevision?.choices || [], contactPrevObj.name);
        return m ? { id: Number(m.id), name: m.name } : null;
      })()
    : null;

  // 2) Crear o actualizar contacto (espejo)
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
        rut_normalizado: rutNorm,
        phone: c.phone,
        email2: c.email2,
        prevision_choice_id: Number(c.prevision_choice_id),
        agente: c.agente || "",
        birth_date: c.birth_date || null,
      },
      { previsionFieldDef: defs.contactPrevision }
    );
    contactId = created?.id;
  } else {
    // Update espejo de contacto (no creamos duplicado)
    await updateContact(contactId, {
      email: c.email,
      mobile: c.mobile,
      phone: c.phone,
      address: { line1: c.address_line1, city: c.address_city },
      custom_fields: {
        [String(CFG.contact.RUT_NORM_ID)]: rutNorm,
        [String(CFG.contact.RUT_ID)]: c.rut,
        ...(contactPrevObj ? { [String(CFG.contact.PREVISION_ID)]: contactPrevObj } : {}),
      },
    });
  }

  // 3) Dedupe deals por RUT_normalizado dentro del pipeline
  const pipelineId = Number(d.pipeline_id || process.env.DEFAULT_PIPELINE_ID || CFG.bariatrica.PIPELINE_ID);
  const stages = await getStagesForPipelineCached(pipelineId);
  const activeStages = stages.filter((s) => s.active).sort((a, b) => a.position - b.position);
  const stageIds = activeStages.map((s) => s.id);

  const dupDeals = await searchDealsByRutInStages(rutNorm, stageIds);
  if (dupDeals.length >= 1) {
    return res.status(409).json({
      error: "DUPLICADO: ya existe deal con ese RUT_normalizado en el pipeline",
      rut_normalizado: rutNorm,
      pipeline_id: pipelineId,
      contact_id: contactId,
      contact_links: links("contact", contactId),
      deal_duplicates: dupDeals.map((x) => ({
        id: x.id,
        name: x.name,
        stage_id: x.stage_id,
        links: links("deal", x.id),
      })),
    });
  }

  // Stage: candidato si Bariátrica, si no primer stage activo
  const stageByPipeline = parseStageByPipelineEnv();
  let stageId =
    stageByPipeline[String(pipelineId)] ||
    (pipelineId === CFG.bariatrica.PIPELINE_ID ? CFG.bariatrica.STAGE_CANDIDATO_ID : null) ||
    activeStages[0]?.id;

  const { data: dealData, url: dealUrl } = await createDeal(
    {
      deal_name: d.deal_name,
      rut: d.rut,
      rut_normalizado: rutNorm,
      cirujano_choice_id: Number(d.cirujano_choice_id),
      imc: d.imc,
      interes: d.interes,
      tramo_choice_id: Number(d.tramo_choice_id),
      url_medinet: d.url_medinet || "",
      birth_date: c.birth_date || null,
    },
    {
      contactId,
      cirujanoFieldDef: defs.dealCirujano,
      tramoFieldDef: defs.dealTramo,
      previsionDealChoice: dealPrevObj,
      stageId,
    }
  );

  res.json({
    ok: true,
    rut_normalizado: rutNorm,
    pipeline_id: pipelineId,
    stage_id: stageId,
    contact_id: contactId,
    deal_id: dealData?.id,
    deal_url: dealUrl,
    contact_url: links("contact", contactId).web,
    deal_links: links("deal", dealData?.id),
    contact_links: links("contact", contactId),
    // Fix placeholder requerido por backend/plantillas
    payload_for_backend: {
      object: {
        birth_date: c.birth_date || null,
        fecha_nacimiento: c.birth_date || null,
      },
    },
  });
});

// Extract (igual que antes)
app.post("/api/extract", async (req, res) => {
  const text = String(req.body?.text || "");
  if (!text.trim()) return res.status(400).json({ error: "text requerido" });

  const defs = await getFieldDefsCached();

  const mapA = parseKeyNextValue(text);
  const mapB = parseInlineColonPairs(text);
  const map = mergeMaps(mapA, mapB);

  const email = findEmail(text) || map["correo electrónico"] || map["correo electronico"] || map["email"] || map["correo"] || "";
  const phone =
    findPhone(text) ||
    map["teléfono 1"] ||
    map["telefono 1"] ||
    map["número de móvil"] ||
    map["numero de movil"] ||
    map["móvil"] ||
    map["movil"] ||
    map["teléfono"] ||
    map["telefono"] ||
    "";

  const rut = findRUT(text) || map["run"] || map["rut"] || map["run / rut"] || "";
  const imc = findIMC(text) || map["imc"] || "";
  const interes = findInteres(text) || map["interés"] || map["interes"] || "";
  const { first_name, last_name } = splitNameFromMap(map);
  const address_line1 = map["dirección"] || map["direccion"] || map["calle"] || "";
  const city = map["comuna"] || map["ciudad"] || map["lugar de residencia"] || "";

  const cir = matchChoiceByName(defs.dealCirujano?.choices, text);
  const tramo = matchChoiceByName(defs.dealTramo?.choices, map["modalidad"] || text);
  const prev = matchChoiceByName(defs.contactPrevision?.choices, map["aseguradora"] || map["previsión"] || map["prevision"] || text);

  const fullName = `${first_name} ${last_name}`.trim();
  const deal_name = fullName ? `Bariatría - ${fullName}` : "";

  res.json({
    email: String(email).trim(),
    mobile: phone,
    phone: phone,
    rut: String(rut).trim(),
    imc: String(imc).trim(),
    interes: String(interes).trim(),
    first_name,
    last_name,
    address_line1,
    city,
    deal_name,
    cirujano_choice_id: cir ? cir.id : null,
    tramo_choice_id: tramo ? tramo.id : null,
    prevision_choice_id: prev ? prev.id : null,
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Portal listo en :${port}`));
