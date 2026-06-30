export function Input({ placeholder, type }: { placeholder?: string; type?: string }) {
  return `<input class="input" type="${type ?? "text"}" placeholder="${placeholder ?? ""}" />`;
}
