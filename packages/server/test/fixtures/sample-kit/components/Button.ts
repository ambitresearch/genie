export function Button({ label, onClick }: { label: string; onClick?: () => void }) {
  return `<button class="btn" onclick="${onClick}">${label}</button>`;
}
