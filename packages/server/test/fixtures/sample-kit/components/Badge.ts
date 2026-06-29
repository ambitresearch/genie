export function Badge({ text, variant }: { text: string; variant?: "info" | "success" | "warning" | "error" }) {
  return `<span class="badge badge--${variant ?? "info"}">${text}</span>`;
}
