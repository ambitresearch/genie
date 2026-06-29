export function Card({ title, children }: { title: string; children: string }) {
  return `<div class="card"><h3>${title}</h3><div>${children}</div></div>`;
}
