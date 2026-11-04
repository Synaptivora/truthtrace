import {it,expect} from "vitest";
import {explicitDue} from "../src/lib/commitments";
it("does not fabricate relative dates or missing timezones",()=>{
 for(const label of ["周五","明天","2026-11-04","2026-11-04T12:00","2026-02-30T12:00+08:00"])
 expect(explicitDue(label).dueAt).toBeNull();
 expect(explicitDue("2026-11-04T12:00+08:00").dueAt).toBe("2026-11-04T04:00:00.000Z");
});
