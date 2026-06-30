export function Tabs({ items }: { items: string[] }) {
  const tabs = items.map((item, i) => `<li class="tab${i === 0 ? " tab--active" : ""}">${item}</li>`).join("");
  return `<ul class="tabs">${tabs}</ul>`;
}
