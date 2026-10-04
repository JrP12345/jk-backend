import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { getDicomFrame, getDicomInstances } from "../services/dicomWeb.ts";
const fetchMock = vi.fn();
const rows = [{ "0020000E": { Value: ["1.2.3"] }, "00080018": { Value: ["1.2.4"] }, "00280008": { Value: [2] } }];
const metadata = () => new Response(JSON.stringify(rows), { headers: { "content-type": "application/dicom+json" } });
beforeEach(() => { vi.stubEnv("PACS_DICOMWEB_BASE_URL", "https://orthanc.test/dicom-web"); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("loads the transport in Node strip-only mode and preserves its error contract", () => {
  const moduleUrl = new URL("../services/dicomWeb.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { DicomWebError } from ${JSON.stringify(moduleUrl)};
    const error = new DicomWebError(503, "Imaging preview unavailable");
    assert.ok(error instanceof Error);
    assert.ok(error instanceof DicomWebError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, "Imaging preview unavailable");
  `], { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_OPTIONS: "" } });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
});
it("rejects identifiers and frames outside the authorized study", async () => {
  await expect(getDicomInstances("../other")).rejects.toMatchObject({ statusCode: 400 });
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockImplementation(metadata);
  await expect(getDicomFrame("1.2.5", "1.2.3", "1.2.999", 1)).rejects.toMatchObject({ statusCode: 404 });
  await expect(getDicomFrame("1.2.5", "1.2.3", "1.2.4", 3)).rejects.toMatchObject({ statusCode: 404 });
  expect(fetchMock.mock.calls.every(([url]) => url.includes("/instances?"))).toBe(true);
});
it("retrieves a rendered PNG and rejects HTML, redirects and missing metadata", async () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  fetchMock.mockImplementationOnce(metadata).mockResolvedValueOnce(new Response(png, { headers: { "content-type": "image/png" } }));
  expect(await getDicomFrame("1.2.5", "1.2.3", "1.2.4", 2)).toEqual(png);
  expect(fetchMock).toHaveBeenLastCalledWith("https://orthanc.test/dicom-web/studies/1.2.5/series/1.2.3/instances/1.2.4/frames/2/rendered", expect.objectContaining({ redirect: "error" }));
  fetchMock.mockImplementationOnce(metadata).mockResolvedValueOnce(new Response("<html>login</html>", { headers: { "content-type": "image/png" } }));
  await expect(getDicomFrame("1.2.5", "1.2.3", "1.2.4", 1)).rejects.toMatchObject({ statusCode: 502 });
  fetchMock.mockRejectedValueOnce(new Error("redirect"));
  await expect(getDicomInstances("1.2.5")).rejects.toMatchObject({ statusCode: 502 });
  fetchMock.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
  await expect(getDicomInstances("1.2.5")).rejects.toMatchObject({ statusCode: 404 });
});
it("caps preview instances and response size", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 501 }, () => rows[0]))));
  const manifest = await getDicomInstances("1.2.5");
  expect(manifest.instances).toHaveLength(500); expect(manifest.limited).toBe(true);
  fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
  await expect(getDicomInstances("1.2.5")).rejects.toMatchObject({ statusCode: 502 });
});
it("rejects metadata containing a different study UID", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ ...rows[0], "0020000D": { Value: ["1.2.999"] } }])));
  await expect(getDicomInstances("1.2.5")).rejects.toMatchObject({ statusCode: 502 });
});
