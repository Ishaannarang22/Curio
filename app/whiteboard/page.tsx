import type { Metadata } from "next";
import { WhiteboardClient } from "./client";

export const metadata: Metadata = {
  title: "Curio Whiteboard",
};

export default function WhiteboardPage() {
  return <WhiteboardClient />;
}
