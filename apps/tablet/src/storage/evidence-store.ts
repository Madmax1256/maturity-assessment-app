// Archivos de evidencia (fotos y documentos): se cifran con la misma llave de la base y se
// guardan aparte; la base solo registra ruta, tamaño y SHA-256 del archivo original.

import { idbGet, idbSet } from './idb';

const KEY_KEY = 'fs-db-key-v1';

async function key(): Promise<CryptoKey> {
  const k = await idbGet<CryptoKey>(KEY_KEY);
  if (!k) throw new Error('La base local no está inicializada');
  return k;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function storeEvidenceFile(file: File): Promise<{ localPath: string; sha256: string; bytes: number; mime: string }> {
  const data = await file.arrayBuffer();
  const sha256 = await sha256Hex(data);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), data));
  const localPath = `evidence/${sha256}`;
  await idbSet(localPath, { iv, ct, mime: file.type || 'application/octet-stream', name: file.name });
  return { localPath, sha256, bytes: data.byteLength, mime: file.type || 'application/octet-stream' };
}

export async function readEvidenceUrl(localPath: string): Promise<string | null> {
  const rec = await idbGet<{ iv: Uint8Array; ct: Uint8Array; mime: string }>(localPath);
  if (!rec) return null;
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, await key(), rec.ct);
  return URL.createObjectURL(new Blob([plain], { type: rec.mime }));
}
