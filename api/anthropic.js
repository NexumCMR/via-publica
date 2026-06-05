// Función de Vercel: reenvía los pedidos a Anthropic usando la clave secreta.
// maxDuration alto para que las búsquedas con IA + web no se corten.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en Vercel." });
    return;
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
    });
    const text = await r.text();
    res.setHeader("content-type", "application/json");
    res.status(r.status).send(text);
  } catch (e) {
    res.status(500).json({ error: "Error en el servidor", detalle: String(e) });
  }
}
