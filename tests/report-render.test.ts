import {it,expect} from "vitest";
import {renderReport} from "../src/lib/report-render";
it("exports the same document without executing source HTML",()=>{
 const text='<script>alert(1)</script><img src=x onerror=alert(1)>\n中文'.repeat(1000);
 const report={schemaVersion:1 as const,caseId:null,generatedAt:"2026-11-04",mode:"rule",markdown:text};
 expect(renderReport(report,"markdown")).toBe(text);
 const html=renderReport(report,"html");expect(html).not.toContain("<script>");expect(html).not.toContain("<img ");expect(html).toContain("&lt;script&gt;");expect(html).toContain("default-src 'none'");
});
