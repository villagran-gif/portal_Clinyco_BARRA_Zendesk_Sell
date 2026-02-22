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
    if (!res.ok) {
      const err = new Error(data?.error || `Error ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function formatDuplicates(label, rows = []) {
    if (!rows.length) return "";
    const body = rows.map((x) => {
      const web = x?.links?.web ? `web: ${x.links.web}` : "";
      const mobile = x?.links?.mobile ? `mobile: ${x.links.mobile}` : "";
      return `- #${x.id} ${x.name || ""} ${web} ${mobile}`.trim();
    }).join("\n");
    return `\n${label}:\n${body}`;
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
      const extra = e.status === 409 ? formatDuplicates("deal_duplicates", e.data?.deal_duplicates) : "";
      $("status1").textContent = `${e.message}${extra}`;
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
      const extra = e.status === 409 ?
        `${formatDuplicates("contact_duplicates", e.data?.contact_duplicates)}${formatDuplicates("deal_duplicates", e.data?.deal_duplicates)}` : "";
      $("status2").textContent = `${e.message}${extra}`;
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
      const extra = e.status === 409 ?
        `${formatDuplicates("contact_duplicates", e.data?.contact_duplicates)}${formatDuplicates("deal_duplicates", e.data?.deal_duplicates)}` : "";
      $("status5").textContent = `${e.message}${extra}`;
      $("status5").className = "status err";
    }
  });

})();
