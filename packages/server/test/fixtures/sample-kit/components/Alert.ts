export function Alert({ message, type }: { message: string; type?: "info" | "warning" | "error" }) {
  return `<div class="alert alert--${type ?? "info"}">${message}</div>`;
}
