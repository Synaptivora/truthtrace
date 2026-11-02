import { afterEach, expect, it, vi } from "vitest";
import { parseEvidenceFile } from "../src/lib/ingestion/parser";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("accepts a text file larger than the former 8 MiB limit", async () => {
 vi.stubEnv("INGESTION_SERVICE_URL", "");
 const text = "x".repeat(9 * 1024 * 1024);
 const result = await parseEvidenceFile(new File([text], "large.txt", { type: "text/plain" }));
 expect(result[0].content).toHaveLength(text.length);
});
it("forwards files above 100 MiB without a size precheck", async () => {
 vi.stubEnv("INGESTION_SERVICE_URL", "http://localhost:8000");
 const file = new File(["pdf"], "large.pdf", { type: "application/pdf" });
 Object.defineProperty(file, "size", { value: 101 * 1024 * 1024 });
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ evidence: { id: "large", name: file.name, kind: "pdf", mimeType: file.type, content: "parsed" } })));
 vi.stubGlobal("fetch", fetcher);
 expect((await parseEvidenceFile(file))[0].content).toBe("parsed");
 expect(fetcher).toHaveBeenCalledOnce();
});
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
