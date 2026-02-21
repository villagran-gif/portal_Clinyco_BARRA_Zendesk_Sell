function norm(s){ return String(s||"").trim(); }

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

// KEY* (o KEY:) y el valor en la línea siguiente
function parseKeyNextValue(text){
  const lines = String(text||"")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length);

  const map = {};
  for (let i=0;i<lines.length;i++){
    const line = lines[i];

    const keyLine =
      /[*:]$/.test(line) ||
      /^(run|rut|run\s*\/\s*rut|nombres?|apellidos?|correo|correo electr[oó]nico|email|tel[eé]fono|m[oó]vil|celular|direcci[oó]n|calle|comuna|ciudad|aseguradora|previsi[oó]n|modalidad|tramo\/modalidad|imc|inter[eé]s|lugar de residencia)\b/i.test(line);

    if (!keyLine) continue;

    const key = line
      .replace(/\*+$/,"")
      .replace(/:$/,"")
      .trim()
      .toLowerCase();

    const val = lines[i+1] ? lines[i+1].trim() : "";
    if (!val) continue;

    if (!(key in map)) map[key] = val;
  }
  return map;
}

// "Nombres: ARLETTE SANIRI" (valor en misma línea)
function parseInlineColonPairs(text){
  const lines = String(text||"").split(/\r?\n/).map(l => l.trim());
  const map = {};
  for (const line of lines){
    const m = line.match(/^([^:]{2,40}):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (!val) continue;
    if (!(key in map)) map[key] = val;
  }
  return map;
}

function mergeMaps(a,b){
  const out = { ...(a||{}) };
  for (const [k,v] of Object.entries(b||{})){
    if (!(k in out) && v) out[k]=v;
  }
  return out;
}

function splitNameFromMap(map){
  const nombres =
    map["nombres"] || map["nombre"] || map["primer nombre"] || map["first name"] || "";
  const apellidos =
    map["apellidos"] || map["apellido"] || map["last name"] || "";
  return { first_name: norm(nombres), last_name: norm(apellidos) };
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

module.exports = {
  findEmail, findPhone, findRUT, findIMC, findInteres,
  parseKeyNextValue, parseInlineColonPairs, mergeMaps,
  splitNameFromMap, matchChoiceByName
};
