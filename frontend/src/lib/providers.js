// Direct browser calls to Gemini & OpenRouter using the user's own API keys.

function parseMeta(text) {
  if (!text) throw new Error("Empty model response");
  let s = text.trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  const obj = JSON.parse(s);
  let keywords = obj.keywords || [];
  if (typeof keywords === "string") {
    keywords = keywords.split(",").map((k) => k.trim());
  }
  keywords = keywords.map((k) => String(k).trim()).filter(Boolean);
  return {
    title: String(obj.title || "").trim(),
    description: String(obj.description || "").trim(),
    keywords,
  };
}

async function geminiCall({ model, apiKey, base64, mimeType, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) {
    const reason = cand?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(`Gemini returned no text${reason ? ` (${reason})` : ""}`);
  }
  return parseMeta(text);
}

async function openrouterCall({ model, apiKey, dataUrl, prompt }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": window.location.origin,
      "X-Title": "StockMeta",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("OpenRouter returned no content");
  return parseMeta(text);
}

export async function generateMetadata({
  provider,
  model,
  apiKey,
  base64,
  dataUrl,
  mimeType,
  prompt,
}) {
  if (provider === "gemini") {
    return geminiCall({ model, apiKey, base64, mimeType, prompt });
  }
  return openrouterCall({ model, apiKey, dataUrl, prompt });
}
