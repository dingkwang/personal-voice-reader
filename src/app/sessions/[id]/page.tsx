import { PrivateReader } from "@/components/private-reader";
export const dynamic = "force-dynamic";
export default async function Session({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PrivateReader id={id} />;
}
