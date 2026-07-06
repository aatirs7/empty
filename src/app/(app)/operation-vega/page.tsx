import { redirect } from "next/navigation";
import { getLatestRunId } from "@/lib/queries";
import { Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function OperationVegaIndex() {
  const id = await getLatestRunId();
  if (!id) return <Empty>No research runs yet.</Empty>;
  redirect(`/operation-vega/${id}`);
}
