import { afterEach, expect, it, vi } from "vitest";
import { parseEvidenceFile } from "../src/lib/ingestion/parser";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("preserves actionable errors from the ingestion service", async () => {
 vi.stubEnv("INGESTION_SERVICE_URL", "http://localhost:8000");
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({error:"PDF is encrypted"}), {status:422})));
 await expect(parseEvidenceFile(new File(["pdf"], "locked.pdf", {type:"application/pdf"}))).rejects.toThrow("PDF is encrypted");
});
it("handles non-JSON ingestion errors", async () => {
 vi.stubEnv("INGESTION_SERVICE_URL", "http://localhost:8000");
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", {status:503})));
 await expect(parseEvidenceFile(new File(["pdf"], "test.pdf"))).rejects.toThrow("503");
});
