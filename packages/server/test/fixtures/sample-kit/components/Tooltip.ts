export function Tooltip({ text, position }: { text: string; position?: "top" | "bottom" | "left" | "right" }) {
  return `<span class="tooltip tooltip--${position ?? "top"}" data-tip="${text}"></span>`;
}
