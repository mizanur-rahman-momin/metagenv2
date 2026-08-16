import { isImageName } from "./imageUtils";

export const DONE_FOLDER = "meta done";

export function supportsFileSystemAccess() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

// Pick a folder and return { dirHandle, files: [{name, handle}] }
export async function pickDirectoryImages() {
  const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  const files = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && isImageName(name) && name !== DONE_FOLDER) {
      files.push({ name, handle });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { dirHandle, files };
}

// Move a completed file into the "meta done" subfolder.
export async function moveToDone(dirHandle, fileHandle, name) {
  const doneDir = await dirHandle.getDirectoryHandle(DONE_FOLDER, {
    create: true,
  });

  if (typeof fileHandle.move === "function") {
    try {
      await fileHandle.move(doneDir);
      return;
    } catch (e) {
      // fall through to copy + delete
    }
  }

  const file = await fileHandle.getFile();
  const dest = await doneDir.getFileHandle(name, { create: true });
  const writable = await dest.createWritable();
  await writable.write(await file.arrayBuffer());
  await writable.close();
  await dirHandle.removeEntry(name);
}
