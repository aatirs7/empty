"use client";

// Opens the single WhatsNew modal (rendered once in the layout) via a window event,
// so we can place this button in both the mobile header and the desktop sidebar
// without mounting two modals.
export default function WhatsNewButton() {
  return (
    <button
      onClick={() => window.dispatchEvent(new Event("vega:whatsnew"))}
      aria-label="What's new"
      className="text-muted h-7 w-7 grid place-items-center rounded-full border border-border text-sm font-semibold leading-none"
    >
      ?
    </button>
  );
}
