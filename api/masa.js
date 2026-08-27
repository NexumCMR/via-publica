// ============================================================
//  MASA IDEAS · servidor de fichas de carteles
//  Sube fotos y publica fichas usando la clave privada de
//  Supabase, que vive SOLO acá (nunca llega al navegador).
// ============================================================

const SUPABASE_URL = "https://vdxkgywwcxluklvhzmor.supabase.co";
const BUCKET = "masa-fotos";

import { createHash } from "node:crypto";

const sha256 = (t) => createHash("sha256").update(String(t)).digest("hex");

// La clave del panel vive en la base, no en el código (el repositorio es público).
async function claveValida(intento) {
  if (!intento) return false;
  const r = await sb("/rest/v1/masa_config?select=clave_hash&id=eq.1", { method: "GET" });
  if (!r.ok) return false;
  const filas = await r.json();
  if (!filas || !filas.length) return false;
  return sha256(intento) === filas[0].clave_hash;
}

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
        // Reemplaza SÓLO las fotos que subió ella; las del catálogo quedan intactas.
        await sb(`/rest/v1/masa_fotos?codigo=eq.${encodeURIComponent(cartel.codigo)}&url=not.like.*lote-*`, { method: "DELETE" });
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

    // -------- Reemplazar todo el inventario del portal (viene del Excel) --------
    if (accion === "portal") {
      if (!(await claveValida(body.clave)))
        return res.status(401).json({ error: "Clave incorrecta" });

      const banda = (v) => {
        const n = Number(v) || 0;
        if (!n) return null;
        if (n <= 3000000) return 1;
        if (n <= 8000000) return 2;
        return 3;
      };
      // El Excel suele traer códigos repetidos: nos quedamos con la última fila de cada uno.
      const unicos = new Map();
      for (const f of (Array.isArray(body.carteles) ? body.carteles : [])) {
        const { precio, ...resto } = f;
        if (!resto.codigo) continue;
        unicos.set(String(resto.codigo), { ...resto, banda: banda(precio) });  // el precio no viaja al portal
      }
      const filas = Array.from(unicos.values());
      const repetidos = (Array.isArray(body.carteles) ? body.carteles.length : 0) - filas.length;
      if (!filas.length) return res.status(400).json({ error: "No llegó ningún cartel" });
      if (filas.length > 3000) return res.status(413).json({ error: "Demasiadas filas" });

      // Se borra lo viejo y se carga lo nuevo, para que nunca queden espacios fantasma
      const rDel = await sb("/rest/v1/masa_portal?codigo=neq.__nada__", { method: "DELETE" });
      if (!rDel.ok) return res.status(502).json({ error: "No se pudo limpiar el inventario anterior" });

      for (let i = 0; i < filas.length; i += 500) {
        const lote = filas.slice(i, i + 500);
        const r = await sb("/rest/v1/masa_portal", {
          method: "POST",
          headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify(lote),
        });
        if (!r.ok) return res.status(502).json({ error: "No se pudo guardar el inventario", detalle: await r.text() });
      }

      const disponibles = filas.filter((f) => f.estado === "Disponible").length;
      await sb("/rest/v1/masa_portal_meta", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: 1, actualizado: new Date().toISOString(), total: filas.length, disponibles }),
      });

      return res.status(200).json({ ok: true, total: filas.length, disponibles, repetidos });
    }

    // -------- Subir fotos en lote y dejar la ficha lista --------
    if (accion === "fotos-lote") {
      if (!(await claveValida(body.clave)))
        return res.status(401).json({ error: "Clave incorrecta" });
      const items = Array.isArray(body.fotos) ? body.fotos : [];
      if (!items.length) return res.status(400).json({ error: "No llegó ninguna foto" });

      const porCodigo = {};
      for (const it of items) {
        if (!it.codigo || !it.base64) continue;
        (porCodigo[it.codigo] = porCodigo[it.codigo] || []).push(it);
      }

      const hechos = [];
      for (const codigo of Object.keys(porCodigo)) {
        // datos del cartel, tomados del inventario que ya subieron
        const rp = await sb(`/rest/v1/masa_portal?codigo=eq.${encodeURIComponent(codigo)}&select=*`, { method: "GET" });
        const base = rp.ok ? (await rp.json())[0] : null;
        if (!base) continue;

        const urls = [];
        for (let i = 0; i < porCodigo[codigo].length; i++) {
          const it = porCodigo[codigo][i];
          const limpio = String(it.base64).replace(/^data:[^;]+;base64,/, "");
          const bytes = Buffer.from(limpio, "base64");
          if (bytes.length > 6 * 1024 * 1024) continue;
          const archivo = `${codigo}/lote-${Date.now()}-${i}.jpg`;
          const r = await sb(`/storage/v1/object/${BUCKET}/${archivo}`, {
            method: "POST", headers: { "Content-Type": "image/jpeg", "x-upsert": "true" }, body: bytes,
          });
          if (r.ok) urls.push(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${archivo}`);
        }
        if (!urls.length) continue;

        await sb("/rest/v1/masa_carteles", {
          method: "POST",
          headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            codigo, nombre: base.direccion, direccion: base.direccion, localidad: base.zona, zona: base.zona,
            tipo: base.tipo || base.formato, medidas: base.medidas, iluminado: !!base.iluminado,
            estado: base.estado, disponible_desde: base.libre_desde,
            mostrar_precio: false, publicado: true, actualizado: new Date().toISOString(),
          }),
        });
        // Se AGREGAN: nunca se borran las fotos que ya tenía el cartel.
        await sb("/rest/v1/masa_fotos", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(urls.map((u, i) => ({ codigo, url: u, orden: i, portada: false }))),
        });
        await sb(`/rest/v1/masa_portal?codigo=eq.${encodeURIComponent(codigo)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ con_ficha: true }),
        });
        hechos.push({ codigo, fotos: urls.length });
      }
      return res.status(200).json({ ok: true, hechos });
    }

    // -------- Publicar un comprobante de campaña --------
    if (accion === "campana") {
      const { campana, fotos } = body;
      if (!campana || !campana.slug || !campana.marca)
        return res.status(400).json({ error: "Faltan datos de la campaña" });

      const r1 = await sb("/rest/v1/masa_campanas", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ ...campana, publicado: true }),
      });
      if (!r1.ok) return res.status(502).json({ error: "No se pudo guardar la campaña", detalle: await r1.text() });

      if (Array.isArray(fotos)) {
        await sb(`/rest/v1/masa_campana_fotos?slug=eq.${encodeURIComponent(campana.slug)}`, { method: "DELETE" });
        if (fotos.length) {
          const filas = fotos.map((f, i) => ({
            slug: campana.slug, url: f.url, epigrafe: f.epigrafe || null,
            momento: f.momento || null, orden: typeof f.orden === "number" ? f.orden : i,
          }));
          const r2 = await sb("/rest/v1/masa_campana_fotos", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(filas),
          });
          if (!r2.ok) return res.status(502).json({ error: "No se pudieron guardar las fotos" });
        }
      }
      return res.status(200).json({ ok: true, link: `/campana/${campana.slug}` });
    }

    // -------- Borrar un comprobante --------
    if (accion === "borrar-campana") {
      const { slug } = body;
      if (!slug) return res.status(400).json({ error: "Falta el identificador" });
      await sb(`/rest/v1/masa_campana_fotos?slug=eq.${encodeURIComponent(slug)}`, { method: "DELETE" });
      const r = await sb(`/rest/v1/masa_campanas?slug=eq.${encodeURIComponent(slug)}`, { method: "DELETE" });
      if (!r.ok) return res.status(502).json({ error: "No se pudo borrar" });
      return res.status(200).json({ ok: true });
    }

    // -------- Borrar una foto puntual --------
    if (accion === "borrar-foto") {
      if (!(await claveValida(body.clave)))
        return res.status(401).json({ error: "Clave incorrecta" });
      const { id } = body;
      if (!id) return res.status(400).json({ error: "Falta la foto" });
      const r = await sb(`/rest/v1/masa_fotos?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) return res.status(502).json({ error: "No se pudo borrar la foto" });
      return res.status(200).json({ ok: true });
    }

    // -------- Cambiar la clave del panel --------
    if (accion === "clave") {
      if (!(await claveValida(body.actual)))
        return res.status(401).json({ error: "La clave actual no es correcta" });
      const nueva = String(body.nueva || "");
      if (nueva.length < 6) return res.status(400).json({ error: "La clave nueva tiene que tener al menos 6 caracteres" });
      const r = await sb("/rest/v1/masa_config", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: 1, clave_hash: sha256(nueva), actualizado: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(502).json({ error: "No se pudo cambiar la clave" });
      return res.status(200).json({ ok: true });
    }

    // -------- Mostrar u ocultar del catálogo --------
    if (accion === "catalogo") {
      const { codigo, destacado } = body;
      if (!codigo) return res.status(400).json({ error: "Falta el código" });
      const r = await sb(`/rest/v1/masa_carteles?codigo=eq.${encodeURIComponent(codigo)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destacado: !!destacado }),
      });
      if (!r.ok) return res.status(502).json({ error: "No se pudo actualizar" });
      return res.status(200).json({ ok: true });
    }

    // -------- Borrar una ficha publicada --------
    if (accion === "borrar") {
      const { codigo } = body;
      if (!codigo) return res.status(400).json({ error: "Falta el código" });
      await sb(`/rest/v1/masa_fotos?codigo=eq.${encodeURIComponent(codigo)}`, { method: "DELETE" });
      const r = await sb(`/rest/v1/masa_carteles?codigo=eq.${encodeURIComponent(codigo)}`, { method: "DELETE" });
      if (!r.ok) return res.status(502).json({ error: "No se pudo borrar", detalle: await r.text() });
      return res.status(200).json({ ok: true });
    }

    // -------- Cuántas visitas tuvo cada ficha --------
    if (accion === "visitas") {
      const r = await sb("/rest/v1/masa_visitas?select=codigo,visitante,interno&interno=is.false", { method: "GET" });
      if (!r.ok) return res.status(502).json({ error: "No se pudieron leer las visitas" });
      const filas = await r.json();
      const conteo = {}, unicos = {};
      for (const f of filas) {
        conteo[f.codigo] = (conteo[f.codigo] || 0) + 1;
        if (!unicos[f.codigo]) unicos[f.codigo] = new Set();
        unicos[f.codigo].add(f.visitante || "sin-id");
      }
      const personas = {};
      for (const k of Object.keys(unicos)) personas[k] = unicos[k].size;
      return res.status(200).json({ visitas: conteo, personas });
    }

    return res.status(400).json({ error: "Acción desconocida" });
  } catch (e) {
    return res.status(500).json({ error: "Error inesperado", detalle: String(e && e.message) });
  }
}
