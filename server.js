require("dotenv").config();
require("express-async-errors");

const express = require("express");
const path = require("path");
const CFG = require("./sell_config");
const {
  getCustomFields,
  searchContactsByRutNorm,
  searchDealsByRutInStages,
  getStagesByPipeline,
  createContact,
  updateContact,
  createDeal,
  links,
  contactUrl
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
  matchChoiceByName
} = require("./extract");

const app = express();
app.use(express.json({ limit: "600kb" }));

function normalizeRut(input) {
  const cleaned = String(input || "").trim().toUpperCase().replace(/[.\-\s]/g, "");
  if (!cleaned) return "";
  const body = cleaned.slice(0, -1);
  const dv = cleaned.slice(-1);
  return `${body}${dv}`;
}

function validRutMod11(rutNorm) {
  if (!/^\d+[0-9K]$/.test(rutNorm)) return false;
  const body = rutNorm.slice(0, -1);
  const dv = rutNorm.slice(-1);
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const rest = 11 - (sum % 11);
  const expected = rest === 11 ? "0" : (rest === 10 ? "K" : String(rest));
  return expected === dv;
}

function parseStageByPipeline() {
  try {
    return JSON.parse(process.env.STAGE_BY_PIPELINE || "{}");
  } catch {
    return {};
  }
}

async function getFieldDefs() {
  const dealCF = await getCustomFields("deal");
  const contactCF = await getCustomFields("contact");
  const dealItems = (dealCF?.items || []).map((x) => x.data).filter(Boolean);
  const contactItems = (contactCF?.items || []).map((x) => x.data).filter(Boolean);

  return {
    dealCirujano: dealItems.find((f) => f.id === CFG.deal.CIRUJANO_ID),
    dealTramo: dealItems.find((f) => f.id === CFG.deal.TRAMO_ID),
    dealPrevision: dealItems.find((f) => f.id === CFG.deal.PREVISION_ID),
    contactPrevision: contactItems.find((f) => f.id === CFG.contact.PREVISION_ID)
  };
}

function mapPrevisionChoice({ contactFieldDef, dealFieldDef, selectedChoiceId }) {
  const contactChoice = (contactFieldDef?.choices || []).find((x) => Number(x.id) === Number(selectedChoiceId));
  if (!contactChoice) return { contactValue: null, dealValue: null };
  const dealChoice = (dealFieldDef?.choices || []).find((x) => x.name === contactChoice.name);
  return {
    contactValue: { id: Number(contactChoice.id), name: contactChoice.name },
    dealValue: dealChoice ? { id: Number(dealChoice.id), name: dealChoice.name } : null
  };
}

function payloadForBackend({ contact, rutNormalizado, birthDate }) {
  return {
    object: {
      first_name: contact.first_name,
      last_name: contact.last_name,
      rut: contact.rut,
      rut_normalizado: rutNormalizado,
      birth_date: birthDate || "",
      fecha_nacimiento: birthDate || ""
    }
  };
}

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self' https://*.zendesk.com https://clinyco.zendesk.com");
  next();
});

app.use((req, res, next) => {
  const key = process.env.PORTAL_KEY;

  // Sin key: no proteger nada
  if (!key) return next();

  // Siempre libre
  if (req.path === "/health") return next();

  // IMPORTANTÍSIMO:
  // Si proteges CSS/JS/imagenes con header, el navegador NO puede enviarlo al cargar assets.
  // Por eso solo protegemos /api/*
  if (!req.path.startsWith("/api/")) return next();

  const got = req.header("x-portal-key") || "";
  if (got !== key) return res.status(401).json({ error: "Unauthorized (x-portal-key)" });

  return next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/config", (_req, res) => {
  res.json({
    sell_leads_url: process.env.SELL_LEADS_URL || "",
    deal_url_base: process.env.SELL_DEAL_URL_BASE || "",
    contact_url_base: process.env.SELL_CONTACT_URL_BASE || ""
  });
});

let cache = { at: 0, data: null };
const TTL = 10 * 60 * 1000;

app.get("/api/options", async (_req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL) return res.json(cache.data);

  const defs = await getFieldDefs();

  const data = {
    deal: {
      cirujano: { id: CFG.deal.CIRUJANO_ID, name: defs.dealCirujano?.name, choices: defs.dealCirujano?.choices || [] },
      tramo: { id: CFG.deal.TRAMO_ID, name: defs.dealTramo?.name, choices: defs.dealTramo?.choices || [] },
      prevision: { id: CFG.deal.PREVISION_ID, name: defs.dealPrevision?.name, choices: defs.dealPrevision?.choices || [] }
    },
    contact: {
      prevision: { id: CFG.contact.PREVISION_ID, name: defs.contactPrevision?.name, choices: defs.contactPrevision?.choices || [] }
    }
  };

  cache = { at: now, data };
  res.json(data);
});

function isRutLike(value) {
  return /^\d+[0-9K]$/.test(String(value || "").trim());
}

async function handleSearchByRut(req, res) {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ items: [] });

  const rutNormalizado = normalizeRut(q);
  if (!isRutLike(rutNormalizado)) return res.json({ items: [] });

  const items = await searchContactsByRutNorm(rutNormalizado);
  return res.json({
    items: items.map((c) => ({
      id: c.id,
      name: c.display_name || c.name || "",
      links: links("contact", c.id)
    }))
  });
}

app.get("/api/contacts/search", handleSearchByRut);
app.get("/api/contacts/search-rut", handleSearchByRut);

app.post("/api/deals/create", async (req, res) => {
  const b = req.body || {};
  const required = ["contact_id", "deal_name", "rut", "cirujano_choice_id", "imc", "interes", "tramo_choice_id"];
  for (const k of required) if (!b[k]) return res.status(400).json({ error: `${k} requerido` });

  const rutNormalizado = normalizeRut(b.rut);
  if (String(process.env.RUT_VALIDATE || "false") === "true" && !validRutMod11(rutNormalizado)) {
    return res.status(400).json({ error: "RUT inválido (mod11)" });
  }

  const pipelineId = Number(b.pipeline_id || process.env.DEFAULT_PIPELINE_ID || CFG.bariatrica.PIPELINE_ID);
  const stages = await getStagesByPipeline(pipelineId);
  const activeStages = stages.filter((x) => x.active !== false);
  const candidateStages = activeStages.length ? activeStages : stages;
  const stageIds = candidateStages.map((s) => Number(s.id));
  const dupDeals = await searchDealsByRutInStages(rutNormalizado, stageIds);
  if (dupDeals.length >= 1) {
    return res.status(409).json({
      error: "Deal duplicado para RUT_normalizado en pipeline",
      deal_duplicates: dupDeals.map((d) => ({ id: d.id, name: d.name, stage_id: d.stage_id, links: links("deal", d.id) }))
    });
  }

  const defs = await getFieldDefs();
  const stageMap = parseStageByPipeline();
  const mapped = Number(stageMap[String(pipelineId)]);
  const stageId = mapped || (pipelineId === CFG.bariatrica.PIPELINE_ID ? CFG.bariatrica.STAGE_CANDIDATO_ID : Number(candidateStages[0]?.id));

  const custom_fields = {
    [String(CFG.deal.RUT_NORMALIZADO_ID)]: rutNormalizado,
    [String(CFG.deal.RUT_LEGACY_ID)]: b.rut,
    [String(CFG.deal.INTERES_ID)]: b.interes
  };

  const cir = (defs.dealCirujano?.choices || []).find((x) => Number(x.id) === Number(b.cirujano_choice_id));
  if (cir) custom_fields[String(CFG.deal.CIRUJANO_ID)] = { id: Number(cir.id), name: cir.name };

  const tramo = (defs.dealTramo?.choices || []).find((x) => Number(x.id) === Number(b.tramo_choice_id));
  if (tramo) custom_fields[String(CFG.deal.TRAMO_ID)] = { id: Number(tramo.id), name: tramo.name };

  if (b.birth_date) custom_fields[String(CFG.deal.BIRTHDATE_ID)] = b.birth_date;

  const imcRaw = String(b.imc || "").trim().replace(",", ".");
  if (imcRaw) {
    custom_fields[String(CFG.deal.IMC_TEXT_ID)] = imcRaw;
    const n = Number(imcRaw);
    if (Number.isFinite(n)) custom_fields[String(CFG.deal.IMC_NUM_ID)] = n.toFixed(2);
  }

  const { data, url } = await createDeal({ deal_name: b.deal_name, custom_fields }, { contactId: b.contact_id, stageId });

  return res.json({ ok: true, deal_id: data?.id, deal_url: url, links: links("deal", data?.id) });
});

app.post("/api/contact-deal/create", async (req, res) => {
  const body = req.body || {};
  const c = body.contact || {};
  const d = body.deal || {};

  const cReq = ["first_name", "last_name", "mobile", "email", "address_line1", "address_city", "rut", "phone", "email2", "prevision_choice_id"];
  for (const k of cReq) if (!c[k]) return res.status(400).json({ error: `contact.${k} requerido` });
  const dReq = ["deal_name", "rut", "cirujano_choice_id", "imc", "interes", "tramo_choice_id"];
  for (const k of dReq) if (!d[k]) return res.status(400).json({ error: `deal.${k} requerido` });

  const rutNormalizado = normalizeRut(c.rut);
  if (!rutNormalizado) return res.status(400).json({ error: "RUT vacío" });
  if (String(process.env.RUT_VALIDATE || "false") === "true" && !validRutMod11(rutNormalizado)) {
    return res.status(400).json({ error: "RUT inválido (mod11)" });
  }

  const defs = await getFieldDefs();
  const prevision = mapPrevisionChoice({
    contactFieldDef: defs.contactPrevision,
    dealFieldDef: defs.dealPrevision,
    selectedChoiceId: Number(c.prevision_choice_id)
  });

  const existingContacts = await searchContactsByRutNorm(rutNormalizado);
  if (existingContacts.length > 1) {
    return res.status(409).json({
      error: "Duplicados de contacto por RUT_normalizado",
      contact_duplicates: existingContacts.map((x) => ({ id: x.id, name: x.name || x.display_name, links: links("contact", x.id) }))
    });
  }

  const birthDate = c.birth_date || d.birth_date || "";
  const contactMirrorFields = {
    [String(CFG.contact.RUT_NORMALIZADO_ID)]: rutNormalizado,
    [String(CFG.contact.RUT_LEGACY_ID)]: c.rut,
    [String(CFG.contact.CIUDAD_ID)]: c.address_city,
    [String(CFG.contact.TELEFONO_ID)]: c.phone,
    [String(CFG.contact.CORREO_ID)]: c.email2,
    ...(prevision.contactValue ? { [String(CFG.contact.PREVISION_ID)]: prevision.contactValue } : {}),
    ...(birthDate ? { [String(CFG.contact.BIRTHDATE_ID)]: birthDate } : {})
  };

  if (c.agente) contactMirrorFields[String(CFG.contact.AGENTE_ID)] = c.agente;

  let contactId = existingContacts[0]?.id;
  if (contactId) {
    await updateContact(contactId, {
      email: c.email,
      mobile: c.mobile,
      phone: c.phone,
      custom_fields: contactMirrorFields
    });
  } else {
    const created = await createContact({
      ...c,
      custom_fields: contactMirrorFields
    });
    contactId = created?.id;
  }

  const pipelineId = Number(body.pipeline_id || d.pipeline_id || process.env.DEFAULT_PIPELINE_ID || CFG.bariatrica.PIPELINE_ID);
  const stages = await getStagesByPipeline(pipelineId);
  const activeStages = stages.filter((x) => x.active !== false);
  const candidateStages = activeStages.length ? activeStages : stages;
  const stageIds = candidateStages.map((s) => Number(s.id));
  const duplicateDeals = await searchDealsByRutInStages(rutNormalizado, stageIds);

  if (duplicateDeals.length >= 1) {
    return res.status(409).json({
      error: "Duplicados de deal por RUT_normalizado en pipeline",
      deal_duplicates: duplicateDeals.map((x) => ({ id: x.id, name: x.name, stage_id: x.stage_id, links: links("deal", x.id) })),
      contact_id: contactId,
      contact_links: links("contact", contactId)
    });
  }

  const stageMap = parseStageByPipeline();
  const mapped = Number(stageMap[String(pipelineId)]);
  const stageId = mapped || (pipelineId === CFG.bariatrica.PIPELINE_ID ? CFG.bariatrica.STAGE_CANDIDATO_ID : Number(candidateStages[0]?.id));

  const dealCustomFields = {
    [String(CFG.deal.RUT_NORMALIZADO_ID)]: rutNormalizado,
    [String(CFG.deal.RUT_LEGACY_ID)]: c.rut,
    [String(CFG.deal.INTERES_ID)]: d.interes,
    ...(prevision.dealValue ? { [String(CFG.deal.PREVISION_ID)]: prevision.dealValue } : {}),
    ...(birthDate ? { [String(CFG.deal.BIRTHDATE_ID)]: birthDate } : {})
  };

  const cir = (defs.dealCirujano?.choices || []).find((x) => Number(x.id) === Number(d.cirujano_choice_id));
  if (cir) dealCustomFields[String(CFG.deal.CIRUJANO_ID)] = { id: Number(cir.id), name: cir.name };

  const tramo = (defs.dealTramo?.choices || []).find((x) => Number(x.id) === Number(d.tramo_choice_id));
  if (tramo) dealCustomFields[String(CFG.deal.TRAMO_ID)] = { id: Number(tramo.id), name: tramo.name };

  const imcRaw = String(d.imc || "").trim().replace(",", ".");
  if (imcRaw) {
    dealCustomFields[String(CFG.deal.IMC_TEXT_ID)] = imcRaw;
    const n = Number(imcRaw);
    if (Number.isFinite(n)) dealCustomFields[String(CFG.deal.IMC_NUM_ID)] = n.toFixed(2);
  }

  if (d.url_medinet) dealCustomFields[String(CFG.deal.URL_MEDINET_ID)] = d.url_medinet;

  const { data: dealData, url: createdDealUrl } = await createDeal(
    { deal_name: d.deal_name, custom_fields: dealCustomFields },
    { contactId, stageId }
  );

  return res.json({
    ok: true,
    contact_id: contactId,
    deal_id: dealData?.id,
    deal_url: createdDealUrl,
    contact_url: contactUrl(contactId),
    links: {
      deal: links("deal", dealData?.id),
      contact: links("contact", contactId)
    },
    payload_for_backend: payloadForBackend({ contact: c, rutNormalizado, birthDate })
  });
});

app.post("/api/extract", async (req, res) => {
  const text = String(req.body?.text || "");
  if (!text.trim()) return res.status(400).json({ error: "text requerido" });

  const defs = await getFieldDefs();
  const mapA = parseKeyNextValue(text);
  const mapB = parseInlineColonPairs(text);
  const map = mergeMaps(mapA, mapB);

  const email = findEmail(text) || map["correo electrónico"] || map["correo electronico"] || map.email || map.correo || "";

  const phone =
    findPhone(text) ||
    map["teléfono 1"] ||
    map["telefono 1"] ||
    map["número de móvil"] ||
    map["numero de movil"] ||
    map["móvil"] ||
    map.movil ||
    map["teléfono"] ||
    map.telefono ||
    "";

  const rut = findRUT(text) || map.run || map.rut || map["run / rut"] || "";
  const imc = findIMC(text) || map.imc || "";
  const interes = findInteres(text) || map.interés || map.interes || "";
  const { first_name, last_name } = splitNameFromMap(map);
  const address_line1 = map.dirección || map.direccion || map.calle || "";
  const city = map.comuna || map.ciudad || map["lugar de residencia"] || "";
  const birth_date = map["fecha de nacimiento"] || map["fecha nacimiento"] || map.nacimiento || "";

  const cir = matchChoiceByName(defs.dealCirujano?.choices, text);
  const tramo = matchChoiceByName(defs.dealTramo?.choices, map.modalidad || text);
  const prev = matchChoiceByName(defs.contactPrevision?.choices, map.aseguradora || map.previsión || map.prevision || text);

  const fullName = `${first_name} ${last_name}`.trim();
  const deal_name = fullName ? `Bariatría - ${fullName}` : "";

  return res.json({
    email: String(email).trim(),
    mobile: phone,
    phone,
    rut: String(rut).trim(),
    rut_normalizado: normalizeRut(rut),
    imc: String(imc).trim(),
    interes: String(interes).trim(),
    first_name,
    last_name,
    address_line1,
    city,
    deal_name,
    birth_date,
    fecha_nacimiento: birth_date,
    cirujano_choice_id: cir ? cir.id : null,
    tramo_choice_id: tramo ? tramo.id : null,
    prevision_choice_id: prev ? prev.id : null
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Portal listo en :${port}`));
