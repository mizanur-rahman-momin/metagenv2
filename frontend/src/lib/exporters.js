function csvField(v) {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

// Adobe Stock official CSV: Filename, Title, Keywords, Category, Releases
export function buildCSV(rows, category = "") {
  const header = "Filename,Title,Keywords,Category,Releases";
  const lines = rows.map((r) =>
    [
      csvField(r.name),
      csvField(r.title),
      csvField((r.keywords || []).join(", ")),
      csvField(category || ""),
      csvField(""),
    ].join(",")
  );
  return [header, ...lines].join("\r\n");
}

export function buildTXT(rows) {
  return rows
    .map((r) => {
      return [
        `File: ${r.name}`,
        `Title: ${r.title}`,
        `Description: ${r.description || ""}`,
        `Keywords: ${(r.keywords || []).join(", ")}`,
        "",
      ].join("\n");
    })
    .join("\n");
}

export function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
