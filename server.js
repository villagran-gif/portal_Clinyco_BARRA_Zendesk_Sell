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
