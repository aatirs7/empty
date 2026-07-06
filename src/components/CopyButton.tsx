"use client";
import { useState } from "react";

export default function CopyButton({ text, label = "Copy all" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked; ignore
    }
  }
  return (
    <button onClick={copy} className="w-full rounded-lg bg-accent text-white py-2.5 font-medium">
      {copied ? "Copied!" : label}
    </button>
  );
}
