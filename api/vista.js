// ============================================================
//  MASA IDEAS · vista previa de los links (WhatsApp, Instagram, Telegram…)
//  Cuando alguien pega el link de una ficha (/cartel/1101) en un chat,
//  WhatsApp no ejecuta la página: lee unas etiquetas del HTML (og:*).
//  Esta función le arma esas etiquetas con la foto, el nombre y la
//  disponibilidad de ESE cartel. Las personas nunca pasan por acá:
//  vercel.json sólo manda a los "lectores de links" (por su user-agent).
// ============================================================

const API = "https://vdxkgywwcxluklvhzmor.supabase.co/rest/v1";
const LLAVE = "sb_publishable_Pde178b3hSbn8bjirUR9Lw_PsaJiUC_";   // la pública (sólo lectura), la misma que usa la ficha

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const fecha = (d) => { const p = String(d || "").split("-"); return p.length === 3 ? Number(p[2]) + " de " + MESES[Number(p[1]) - 1] : ""; };
const ZONAS = { "vte lopez": "Vicente López", "vicente lopez": "Vicente López", "3 de february": "Tres de Febrero", "3 de febrero": "Tres de Febrero", "caba": "CABA" };
const zona = (z) => { const t = String(z || "").trim(); const k = t.toLowerCase().replace(/\./g, " ").replace(/\s+/g, " ").normalize("NFD").replace(/[̀-ͯ]/g, ""); return ZONAS[k] || t; };

async function pedir(ruta) {
  const r = await fetch(API + ruta, { headers: { apikey: LLAVE, Authorization: "Bearer " + LLAVE } });
  return r.ok ? r.json() : [];
}
async function existe(url) {
  try { const r = await fetch(url, { method: "HEAD" }); return r.ok && /image/.test(r.headers.get("content-type") || ""); } catch (e) { return false; }
}

// el link del portal (/disponibles?zona=Pilar&formato=Top%20Wall): cuántos hay disponibles con ese filtro
async function vistaPortal(req, base) {
  const q = req.query || {};
  const zonaSel = zona(q.zona || ""), fmt = String(q.formato || "").trim(), est = String(q.estado || "").trim();
  let titulo = "Espacios disponibles en vía pública — Masa Ideas";
  try {
    const filas = await pedir("/masa_portal?select=zona,formato,estado");
    const n = (filas || []).filter((r) => (!zonaSel || zona(r.zona) === zonaSel) && (!fmt || r.formato === fmt) &&
      (est === "todos" || est === "pronto" || r.estado === "Disponible")).length;
    const uno = n === 1;
    const f = fmt.toLowerCase();
    const que = !f ? (uno ? "espacio" : "espacios")
      : f === "pantalla led" ? (uno ? "pantalla LED" : "pantallas LED")
      : f === "mural" ? (uno ? "mural" : "murales")
      : f === "espectacular" ? (uno ? "espectacular" : "espectaculares")
      : f;
    if (n) titulo = n + " " + (est === "todos" ? que : que + (uno ? " disponible" : " disponibles")) + (zonaSel ? " en " + zonaSel : "") + " — Masa Ideas";
  } catch (e) {}
  return { titulo, texto: "Carteles, pantallas LED y murales en CABA y GBA. Fotos y disponibilidad en vivo.",
    imagen: base + "/fotos/og/portal.jpg", link: base + (req.url || "/disponibles") };
}

export default async function handler(req, res) {
  if (req.query && req.query.portal) {
    const host0 = req.headers["x-forwarded-host"] || req.headers.host || "via-publica-delta.vercel.app";
    const v = await vistaPortal(req, "https://" + host0);
    return enviar(res, v.titulo, v.texto, v.imagen, 1200, 630, "https://" + host0 + "/disponibles");
  }
  const codigo = String((req.query && req.query.codigo) || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 12);
  const host = req.headers["x-forwarded-host"] || req.headers.host || "via-publica-delta.vercel.app";
  const base = "https://" + host;
  const link = base + "/cartel/" + encodeURIComponent(codigo);

  let titulo = "Espacio publicitario — Masa Ideas";
  let texto = "Mirá las fotos, los datos y la disponibilidad de este cartel.";
  let imagen = base + "/fotos/og/portal.jpg", ancho = 1200, alto = 630;

  try {
    const [carteles, fotos] = await Promise.all([
      pedir("/masa_carteles?select=codigo,nombre,localidad,tipo,medidas,iluminado,estado,disponible_desde&codigo=eq." + encodeURIComponent(codigo)),
      pedir("/masa_fotos?select=url,portada,orden&codigo=eq." + encodeURIComponent(codigo) + "&order=orden.asc"),
    ]);
    const c = carteles && carteles[0];
    if (c) {
      const nombre = String(c.nombre || "Cartel " + codigo).replace(/\s*\((?:tr[áa]nsito|visual)[^)]*\)/ig, "").replace(/\s{2,}/g, " ").trim();
      titulo = nombre + " · COD " + codigo;
      const estado = c.estado === "Disponible" || !c.estado ? "Disponible ahora"
        : c.estado === "Ocupado" ? (c.disponible_desde ? "Se libera el " + fecha(c.disponible_desde) : "Ocupado — consultá próximas fechas")
        : "Consultá disponibilidad";
      texto = [estado, c.tipo, c.medidas ? c.medidas + " m" : "", c.iluminado ? "Iluminado" : "", zona(c.localidad)].filter(Boolean).join(" · ") +
        ". Fotos, audiencia y datos del espacio.";
    }
    // la foto: la armada para WhatsApp; si no hay, la del catálogo; si no, la primera que tenga
    if (await existe(base + "/fotos/og/" + encodeURIComponent(codigo) + ".jpg")) imagen = base + "/fotos/og/" + encodeURIComponent(codigo) + ".jpg";
    else if (fotos && fotos.length) {
      const f = fotos.filter((x) => !x.portada && /\/lote-/.test(x.url))[0] || fotos.filter((x) => !x.portada)[0] || fotos[0];
      imagen = f.url; ancho = 0; alto = 0;
    }
  } catch (e) { /* si algo falla, igual sale una vista previa correcta con la imagen general */ }

  return enviar(res, titulo, texto, imagen, ancho, alto, link);
}

function enviar(res, titulo, texto, imagen, ancho, alto, link) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
  res.status(200).send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(texto)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Masa Ideas">
<meta property="og:locale" content="es_AR">
<meta property="og:url" content="${esc(link)}">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(texto)}">
<meta property="og:image" content="${esc(imagen)}">
<meta property="og:image:secure_url" content="${esc(imagen)}">
<meta property="og:image:type" content="image/jpeg">
${ancho ? `<meta property="og:image:width" content="${ancho}">\n<meta property="og:image:height" content="${alto}">` : ""}
<meta property="og:image:alt" content="${esc(titulo)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(titulo)}">
<meta name="twitter:description" content="${esc(texto)}">
<meta name="twitter:image" content="${esc(imagen)}">
<link rel="canonical" href="${esc(link)}">
</head><body><a href="${esc(link)}">${esc(titulo)}</a></body></html>`);
}
