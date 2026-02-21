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
