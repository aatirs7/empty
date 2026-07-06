import PositionsView from "@/components/PositionsView";

export const dynamic = "force-dynamic";

export default function PositionsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Positions</h1>
      <PositionsView />
    </div>
  );
}
