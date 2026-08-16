const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

export function isImageName(name) {
  const ext = name.split(".").pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

// Downscale an image File to a JPEG data URL + base64 to keep payloads small & fast.
export async function fileToDownscaledImage(file, maxDim = 1024, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = dataUrl.split(",")[1];
  return { dataUrl, base64, mimeType: "image/jpeg" };
}
