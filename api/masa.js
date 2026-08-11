// ============================================================
//  MASA IDEAS · servidor de fichas de carteles
//  Sube fotos y publica fichas usando la clave privada de
//  Supabase, que vive SOLO acá (nunca llega al navegador).
// ============================================================

const SUPABASE_URL = "https://vdxkgywwcxluklvhzmor.supabase.co";
const BUCKET = "masa-fotos";

function sb(ruta, opciones = {}) {
  const clave = process.env.SUPABASE_SERVICE_KEY;
  return fetch(SUPABASE_URL + ruta, {
    ...opciones,
    headers: {
      apikey: clave,
      Authorization: "Bearer " + clave,
      ...(opciones.headers || {}),
    },
  });
}

// Sólo se aceptan pedidos que vengan de nuestras propias páginas
function origenValido(req) {
  const o = req.headers.origin || req.headers.referer || "";
  if (!o) return false;
  try {
    const h = new URL(o).hostname;
    return h.endsWith(".vercel.app") || h.endsWith("masaideas.com.ar") || h === "localhost";
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: "Falta configurar SUPABASE_SERVICE_KEY en Vercel" });
  if (!origenValido(req)) return res.status(403).json({ error: "Origen no permitido" });

  const accion = (req.query && req.query.accion) || "";
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  try {
    // -------- Subir una foto --------
    if (accion === "foto") {
      const { codigo, nombre, base64, tipo } = body;
      if (!codigo || !base64) return res.status(400).json({ error: "Faltan datos de la foto" });

      const limpio = String(base64).replace(/^data:[^;]+;base64,/, "");
      const bytes = Buffer.from(limpio, "base64");
      if (bytes.length > 6 * 1024 * 1024) return res.status(413).json({ error: "La foto pesa demasiado" });

      const mime = tipo && /^image\//.test(tipo) ? tipo : "image/jpeg";
      const ext = mime.split("/")[1].replace("jpeg", "jpg");
      const archivo = `${codigo}/${Date.now()}-${(nombre || "foto").replace(/[^a-zA-Z0-9._-]/g, "")}.${ext}`;

      const r = await sb(`/storage/v1/object/${BUCKET}/${archivo}`, {
        method: "POST",
        headers: { "Content-Type": mime, "x-upsert": "true" },
        body: bytes,
      });
      if (!r.ok) return res.status(502).json({ error: "No se pudo guardar la foto", detalle: await r.text() });

      return res.status(200).json({
        url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${archivo}`,
      });
    }

    // -------- Publicar / actualizar la ficha de un cartel --------
    if (accion === "publicar") {
      const { cartel, fotos } = body;
      if (!cartel || !cartel.codigo) return res.status(400).json({ error: "Falta el código del cartel" });

      const fila = { ...cartel, actualizado: new Date().toISOString() };
      const r1 = await sb("/rest/v1/masa_carteles", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(fila),
      });
      if (!r1.ok) return res.status(502).json({ error: "No se pudo guardar el cartel", detalle: await r1.text() });

      if (Array.isArray(fotos)) {
        await sb(`/rest/v1/masa_fotos?codigo=eq.${encodeURIComponent(cartel.codigo)}`, { method: "DELETE" });
        if (fotos.length) {
          const filas = fotos.map((f, i) => ({
            codigo: cartel.codigo,
            url: f.url,
            epigrafe: f.epigrafe || null,
            orden: typeof f.orden === "number" ? f.orden : i,
            portada: !!f.portada,
          }));
          const r2 = await sb("/rest/v1/masa_fotos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(filas),
          });
          if (!r2.ok) return res.status(502).json({ error: "No se pudieron guardar las fotos", detalle: await r2.text() });
        }
      }

      return res.status(200).json({ ok: true, link: `/cartel/${cartel.codigo}` });
    }

    // -------- Cuántas visitas tuvo cada ficha --------
    if (accion === "visitas") {
      const r = await sb("/rest/v1/masa_visitas?select=codigo", { method: "GET" });
      if (!r.ok) return res.status(502).json({ error: "No se pudieron leer las visitas" });
      const filas = await r.json();
      const conteo = {};
      for (const f of filas) conteo[f.codigo] = (conteo[f.codigo] || 0) + 1;
      return res.status(200).json({ visitas: conteo });
    }

    return res.status(400).json({ error: "Acción desconocida" });
  } catch (e) {
    return res.status(500).json({ error: "Error inesperado", detalle: String(e && e.message) });
  }
}
