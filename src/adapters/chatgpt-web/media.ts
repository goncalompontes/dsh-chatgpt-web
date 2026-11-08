import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "playwright-core";

const MAX_ASSETS = 8;
const MAX_ASSET_BYTES = 8 * 1024 ** 2;
const MAX_STORE_BYTES = 512 * 1024 ** 2;

export function exportableChatGptImageUrl(value: string): boolean {
  if (/^data:image\/(?:png|jpeg|webp|gif|avif);base64,/i.test(value)) return value.length <= MAX_ASSET_BYTES * 1.4;
  try {
    const url = new URL(value);
    if (url.protocol === "blob:") return url.origin === "https://chatgpt.com";
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname.endsWith(".oaiusercontent.com")
      || url.hostname === "oaiusercontent.com");
  } catch { return false; }
}

export function chatGptImageExtension(bytes: Uint8Array): string | undefined {
  const hex = Buffer.from(bytes.subarray(0, 16)).toString("hex");
  if (hex.startsWith("89504e470d0a1a0a")) return "png";
  if (hex.startsWith("ffd8ff")) return "jpg";
  if (hex.startsWith("474946383761") || hex.startsWith("474946383961")) return "gif";
  if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") return "webp";
  if (hex.slice(8, 16) === "66747970" && ["61766966", "61766973"].includes(hex.slice(16, 24))) return "avif";
  return undefined;
}

export function chatGptArtifactName(value: string): string {
  return value.split(/[\\/]/).at(-1)!.replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^[. ]+/, "").slice(0, 120) || "attachment";
}

async function storeSize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await storeSize(path) : (await stat(path)).size;
  }
  return total;
}

// Serialize quota checks and writes across turns; do not evict files already linked in replies.
let saveTail = Promise.resolve();
async function save(directory: string, name: string, bytes: Buffer): Promise<string> {
  const operation = saveTail.then(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await storeSize(directory) + bytes.length > MAX_STORE_BYTES) throw new Error("artifact store full");
    const target = join(directory, `${randomUUID()}-${chatGptArtifactName(name)}`);
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    return target;
  });
  saveTail = operation.then(() => {}, () => {});
  return operation;
}

async function fetchMedia(reply: Locator, url: string): Promise<Buffer> {
  if (!exportableChatGptImageUrl(url)) throw new Error("unsupported media origin");
  const encoded = await reply.evaluate(async (_root, { url, maxBytes }) => {
    const response = await fetch(url, { credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("media unavailable or oversized");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("media oversized");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    let binary = "";
    for (let index = 0; index < combined.length; index += 8192) binary += String.fromCharCode(...combined.subarray(index, index + 8192));
    return btoa(binary);
  }, { url, maxBytes: MAX_ASSET_BYTES });
  return Buffer.from(encoded, "base64");
}

/** Export only media inside the final bound reply. Append links so streamed prose never changes. */
export async function captureChatGptMedia(reply: Locator, directory: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const deadline = Date.now() + 20_000;
  const assets = await reply.evaluate((root, limit) => {
    const images = [...root.querySelectorAll("img")].filter(image => {
      const rect = image.getBoundingClientRect();
      return image.getAttribute("aria-hidden") !== "true" && rect.width >= 64 && rect.height >= 64;
    }).map(image => ({ kind: "image", url: image.currentSrc || image.src, name: image.alt || "Image", index: -1 }));
    const files = [...root.querySelectorAll('a,button,[role="button"],[role="link"]')].flatMap((anchor, index) => {
      const url = anchor.getAttribute("href") || "";
      const label = anchor.getAttribute("aria-label") || anchor.textContent?.trim() || "";
      const downloadButton = !url && /^download(?:\s|$)/i.test(label)
        && (/\.[a-z0-9]{1,8}(?:\s|$)/i.test(label) || /^download(?: file| image)?$/i.test(label));
      return /^sandbox:\/mnt\/data\//.test(url) || (anchor.hasAttribute("download") && /^blob:https:\/\/chatgpt\.com\//.test(url))
        || downloadButton ? [{ kind: "file", url: url || `download-button:${index}`, name: label || "Download", index }] : [];
    });
    const graphics = [...root.querySelectorAll('canvas,svg')].flatMap((element, index) => {
      const rect = element.getBoundingClientRect();
      const name = element.getAttribute('aria-label') || element.querySelector('title')?.textContent?.trim();
      return name && element.getAttribute('aria-hidden') !== 'true' && rect.width >= 64 && rect.height >= 64
        ? [{ kind: 'graphic', url: `graphic:${index}`, name, index }] : [];
    });
    const seen = new Set<string>();
    return [...files, ...images, ...graphics].filter(asset => !seen.has(asset.url) && Boolean(seen.add(asset.url))).slice(0, limit);
  }, MAX_ASSETS + 1);
  if (!assets.length) {
    const controls = await reply.locator('a,button,[role="button"],[role="link"],[data-testid]').evaluateAll(nodes => nodes
      .filter(node => /download[^\n]{0,120}\.[a-z0-9]{1,8}/i.test(node.textContent ?? ""))
      .slice(0, 8).map(node => ({ tag: node.tagName, role: node.getAttribute("role"), testId: node.getAttribute("data-testid"),
        label: node.getAttribute("aria-label"), text: node.textContent?.slice(0, 120) })));
    if (controls.length) console.info(`[chatgpt-web] media_unrecognized_controls ${JSON.stringify(controls)}`);
  }
  const links: string[] = [];
  for (const asset of assets.slice(0, MAX_ASSETS)) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) {
      links.push("Additional attachments are available in ChatGPT.");
      break;
    }
    const label = asset.name.replace(/[\[\]<>\\\r\n]/g, " ").slice(0, 160).trim() || "Attachment";
    if (asset.kind === "image" && !exportableChatGptImageUrl(asset.url)) {
      links.push(`${label}: export unavailable; open the attachment in ChatGPT.`);
      continue;
    }
    let phase = "image_fetch";
    let downloadProtocol: string | undefined;
    try {
      let bytes: Buffer;
      let filename: string;
      if (asset.kind === "image") {
        bytes = await fetchMedia(reply, asset.url);
        const extension = chatGptImageExtension(bytes);
        if (!extension) throw new Error("unsupported image encoding");
        filename = `image.${extension}`;
      } else if (asset.kind === 'graphic') {
        phase = 'graphic_capture';
        const graphic = reply.locator('canvas,svg').nth(asset.index);
        const bounds = await graphic.boundingBox();
        if (!bounds || bounds.width > 4096 || bounds.height > 4096) throw new Error('graphic oversized');
        // Capture the displayed pixels, including canvas content that cannot be
        // represented by Markdown. Keep semantic descriptions in the prose too.
        bytes = await graphic.screenshot({ type: 'png', scale: 'css', timeout: 5_000 });
        if (bytes.length > MAX_ASSET_BYTES) throw new Error('graphic oversized');
        filename = 'visual.png';
      } else {
        const page = reply.page();
        phase = "download_click";
        // Attach the listener before clicking; only sandbox/download links are eligible.
        const download = page.waitForEvent("download", { timeout: 10_000 }).catch(() => undefined);
        await reply.locator('a,button,[role="button"],[role="link"]').nth(asset.index).click({ timeout: 5_000 });
        const handle = await download;
        if (!handle) throw new Error("download unavailable");
        try {
          downloadProtocol = new URL(handle.url()).protocol;
          filename = handle.suggestedFilename();
          phase = "download_read";
          // Read the browser's actual download, including authenticated URLs and
          // blob URLs revoked by the renderer immediately after the click.
          const deadline = setTimeout(() => { void handle.cancel().catch(() => {}); }, 10_000);
          const cancel = () => { void handle.cancel().catch(() => {}); };
          signal?.addEventListener("abort", cancel, { once: true });
          try {
            const stream = await handle.createReadStream();
            if (!stream) throw new Error("download unavailable");
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of stream) {
              signal?.throwIfAborted();
              size += chunk.length;
              if (size > MAX_ASSET_BYTES) { stream.destroy(); throw new Error("download oversized"); }
              chunks.push(Buffer.from(chunk));
            }
            bytes = Buffer.concat(chunks);
          } finally {
            clearTimeout(deadline);
            signal?.removeEventListener("abort", cancel);
          }
        } finally { await handle.cancel().catch(() => {}); await handle.delete().catch(() => {}); }
      }
      signal?.throwIfAborted();
      phase = "save";
      const path = await save(directory, filename, bytes);
      if (signal?.aborted) { await rm(path, { force: true }); signal.throwIfAborted(); }
      links.push(`${asset.kind === "file" ? "" : "!"}[${label}](<${path}>)`);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.info(`[chatgpt-web] media_export_failed ${JSON.stringify({ kind: asset.kind, phase, downloadProtocol })}`);
      links.push(`${label}: export unavailable; open the attachment in ChatGPT.`);
    }
  }
  if (assets.length > MAX_ASSETS && !links.includes("Additional attachments are available in ChatGPT.")) {
    links.push("Additional attachments are available in ChatGPT.");
  }
  return links.length ? `\n\n${links.join("\n\n")}` : "";
}
