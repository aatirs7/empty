import PositionsView from "@/components/PositionsView";
import { PageTitle } from "@/components/ui";
import ProfileTabs from "@/components/ProfileTabs";

export const dynamic = "force-dynamic";

export default function PositionsPage() {
  return (
    <div className="space-y-5">
      <PageTitle title="Positions" />
      <ProfileTabs />
      <PositionsView />
    </div>
  );
}
