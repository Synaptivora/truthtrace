import { InvestigationWorkbench } from "@/components/investigation-workbench";
import { demoAnalysis, demoEvidence } from "@/lib/demo-case";

export default function Home() {
  return <InvestigationWorkbench initialEvidence={demoEvidence} initialAnalysis={demoAnalysis} />;
}
