import { PrivateReader } from "@/components/private-reader";

export const dynamic = "force-dynamic";
export default function Home() {
  return <PrivateReader />;
}
