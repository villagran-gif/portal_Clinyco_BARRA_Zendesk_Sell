set -e

echo "==> 1) Actualizando extract.js (soporta KEY* + línea siguiente y KEY: valor)..."
cat > extract.js <<'EX'
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

// Formato: KEY *   (o KEY:) y valor en la línea siguiente
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

// Formato: "Nombres: ARLETTE SANIRI" (valor en la misma línea)
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
EX

echo "==> 2) Parchando server.js (/api/extract + imports)..."
python3 - <<'PY'
import re, pathlib

p = pathlib.Path("server.js")
s = p.read_text(encoding="utf-8")

# 2.1 Update extract import destructuring
pattern = r'const\s+\{[^}]*\}\s*=\s*require\("\.\/extract"\);'
new_import = (
'const {\n'
'  findEmail, findPhone, findRUT, findIMC, findInteres,\n'
'  parseKeyNextValue, parseInlineColonPairs, mergeMaps,\n'
'  splitNameFromMap, matchChoiceByName\n'
'} = require("./extract");'
)
if re.search(pattern, s):
    s = re.sub(pattern, new_import, s, count=1)
else:
    # fallback: try replacing a simpler line if your file differs
    if 'require("./extract")' not in s:
        raise SystemExit("No encontré el import de ./extract en server.js")

# 2.2 Replace the body inside /api/extract handler from after defs until just before closing `});`
start = s.find('app.post("/api/extract"')
if start == -1:
    raise SystemExit("No encontré app.post(\"/api/extract\") en server.js")

end = s.find("\n});", start)
# Find the correct handler end: the next "\n});" after the extract handler begins,
# but we want the one that closes that handler. We'll take the last occurrence before next endpoint or file end.
# Safer: find the substring for this handler and locate its final closing.
handler_start = start
# approximate handler end by finding the next "\n\napp." after handler_start, else file end
next_app = s.find("\n\napp.", handler_start + 10)
handler_end = next_app if next_app != -1 else len(s)
handler = s[handler_start:handler_end]

# locate defs line then replace until last "\n});" within handler
defs_pos = handler.find("const defs = await getFieldDefs();")
if defs_pos == -1:
    raise SystemExit("No encontré 'const defs = await getFieldDefs();' dentro de /api/extract")

# start replace at first 'const' after defs line
after_defs = handler.find("\n", defs_pos)
replace_from = handler.find("\n", after_defs+1)  # next line after blank maybe; tolerant
# but ensure we start where existing extraction logic begins
m = re.search(r"\n\s*const\s+email\s*=", handler[after_defs:])
if not m:
    # if not found, just replace from after defs newline
    replace_from = after_defs+1
else:
    replace_from = after_defs + m.start()

closing = handler.rfind("\n});")
if closing == -1:
    raise SystemExit("No pude ubicar el cierre de /api/extract (\\n});)")

new_block = r'''
  const mapA = parseKeyNextValue(text);
  const mapB = parseInlineColonPairs(text);
  const map = mergeMaps(mapA, mapB);

  const email =
    findEmail(text) ||
    map["correo electrónico"] || map["correo electronico"] || map["email"] || map["correo"] || "";

  const phone =
    findPhone(text) ||
    map["teléfono 1"] || map["telefono 1"] ||
    map["número de móvil"] || map["numero de movil"] ||
    map["móvil"] || map["movil"] ||
    map["teléfono"] || map["telefono"] || "";

  const rut =
    findRUT(text) ||
    map["run"] || map["rut"] || map["run / rut"] || "";

  const imc =
    findIMC(text) ||
    map["imc"] || "";

  const interes =
    findInteres(text) ||
    map["interés"] || map["interes"] || "";

  const { first_name, last_name } = splitNameFromMap(map);

  const address_line1 =
    map["dirección"] || map["direccion"] || map["calle"] || "";

  const city =
    map["comuna"] || map["ciudad"] || map["lugar de residencia"] || "";

  const cir = matchChoiceByName(defs.dealCirujano?.choices, text);
  const tramo = matchChoiceByName(defs.dealTramo?.choices, (map["modalidad"] || text));
  const prev = matchChoiceByName(defs.contactPrevision?.choices, (map["aseguradora"] || map["previsión"] || map["prevision"] || text));

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
    prevision_choice_id: prev ? prev.id : null
  });
'''.strip("\n")

handler_new = handler[:replace_from] + "\n" + new_block + "\n" + handler[closing:]
s = s[:handler_start] + handler_new + s[handler_end:]

p.write_text(s, encoding="utf-8")
print("OK: server.js actualizado")
PY

echo "==> 3) Parchando public/app.js (Usar en opción 2 rellena Calle/Ciudad)..."
python3 - <<'PY'
import pathlib, re

p = pathlib.Path("public/app.js")
s = p.read_text(encoding="utf-8")

if "x.address_line1" in s or "address_line1" in s:
    print("public/app.js ya tiene address_line1; no cambio")
else:
    # Insert inside applyToV2 function after rut2 assignment
    pat = r'(\$\("rut2"\)\.value\s*=\s*x\.rut\s*\|\|\s*\$\("rut2"\)\.value;\s*\n)'
    ins = r'\1    $("addr2").value = x.address_line1 || $("addr2").value;\n    $("city2").value = x.city || $("city2").value;\n'
    s2, n = re.subn(pat, ins, s, count=1)
    if n == 0:
        raise SystemExit("No pude insertar en applyToV2 (no encontré la línea rut2).")
    p.write_text(s2, encoding="utf-8")
    print("OK: public/app.js actualizado")
PY

echo "✅ Listo. Reinicia el server:"
echo "   (1) Ctrl+C si está corriendo"
echo "   (2) npm start"
