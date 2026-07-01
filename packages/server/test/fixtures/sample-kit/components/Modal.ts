export function Modal({ title, body }: { title: string; body: string }) {
  return `<div class="modal-overlay"><div class="modal"><h2>${title}</h2><p>${body}</p></div></div>`;
}
