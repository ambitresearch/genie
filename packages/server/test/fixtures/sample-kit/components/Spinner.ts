export function Spinner({ size }: { size?: "sm" | "md" | "lg" }) {
  return `<div class="spinner spinner--${size ?? "md"}"></div>`;
}
