/** Server-side Orthanc DICOMweb transport. Record URLs are never fetch targets. */
export class DicomWebError extends Error {
  public statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
export const validDicomUid = (value: string) => value.length <= 64 && /^\d+(?:\.\d+)+$/.test(value);
const MAX_BYTES = 8 * 1024 * 1024;

async function request(path: string, accept: string) {
  const configured = process.env.PACS_DICOMWEB_BASE_URL?.trim();
  if (!configured) throw new DicomWebError(503, "Imaging preview service is not configured");
  let base: URL;
  try {
    base = new URL(configured);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
  } catch { throw new DicomWebError(503, "Imaging preview service configuration is invalid"); }
  const headers: Record<string, string> = { Accept: accept };
  const token = process.env.PACS_DICOMWEB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (process.env.PACS_DICOMWEB_USERNAME && process.env.PACS_DICOMWEB_PASSWORD) {
    headers.Authorization = `Basic ${Buffer.from(`${process.env.PACS_DICOMWEB_USERNAME}:${process.env.PACS_DICOMWEB_PASSWORD}`).toString("base64")}`;
  }
  let response: Response;
  try {
    response = await fetch(`${base.href.replace(/\/$/, "")}/${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch { throw new DicomWebError(502, "Imaging preview service could not be reached"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new DicomWebError(response.status === 404 ? 404 : 502, response.status === 404 ? "Images are not available for this study" : "Imaging preview service could not load this study");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new DicomWebError(502, "Imaging preview service returned no content");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new DicomWebError(502, "Imaging preview exceeds the supported size");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { bytes: Buffer.concat(chunks), type: response.headers.get("content-type")?.split(";")[0].trim() };
}

export interface DicomInstance { seriesUid: string; instanceUid: string; frames: number; number: number; }
export async function getDicomInstances(studyUid: string): Promise<{ instances: DicomInstance[]; limited: boolean }> {
  if (!validDicomUid(studyUid)) throw new DicomWebError(400, "Invalid study UID");
  const result = await request(`studies/${studyUid}/instances?limit=501&includefield=00280008&includefield=00200013`, "application/dicom+json");
  let rows: Record<string, { Value?: unknown[] }>[];
  try {
    rows = JSON.parse(result.bytes.toString("utf8"));
    if (!Array.isArray(rows)) throw new Error();
  } catch { throw new DicomWebError(502, "Imaging preview service returned invalid metadata"); }
  if (rows.some(row => row["0020000D"]?.Value?.[0] && String(row["0020000D"].Value![0]) !== studyUid)) {
    throw new DicomWebError(502, "Imaging preview service returned a different study");
  }
  const instances = rows.slice(0, 500).map(row => ({
    seriesUid: String(row["0020000E"]?.Value?.[0] ?? ""),
    instanceUid: String(row["00080018"]?.Value?.[0] ?? ""),
    frames: Math.max(1, Math.min(10000, Number(row["00280008"]?.Value?.[0]) || 1)),
    number: Number(row["00200013"]?.Value?.[0]) || 0,
  }));
  if (instances.some(item => !validDicomUid(item.seriesUid) || !validDicomUid(item.instanceUid) || !Number.isInteger(item.frames))) {
    throw new DicomWebError(502, "Imaging preview service returned invalid identifiers");
  }
  instances.sort((a, b) => a.seriesUid.localeCompare(b.seriesUid) || a.number - b.number || a.instanceUid.localeCompare(b.instanceUid));
  return { instances, limited: rows.length > 500 };
}

export async function getDicomFrame(studyUid: string, seriesUid: string, instanceUid: string, frame: number) {
  if (![studyUid, seriesUid, instanceUid].every(validDicomUid) || !Number.isInteger(frame) || frame < 1 || frame > 10000) {
    throw new DicomWebError(400, "Invalid image identifiers or frame");
  }
  const manifest = await getDicomInstances(studyUid);
  const instance = manifest.instances.find(item => item.seriesUid === seriesUid && item.instanceUid === instanceUid);
  if (!instance || frame > instance.frames) throw new DicomWebError(404, "Image is not available for this study");
  const result = await request(`studies/${studyUid}/series/${seriesUid}/instances/${instanceUid}/frames/${frame}/rendered`, "image/png");
  if (result.type !== "image/png" || !result.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new DicomWebError(502, "Imaging preview service returned an unsupported image");
  }
  return result.bytes;
}
