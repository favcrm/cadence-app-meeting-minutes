// Installed once for the app frame's lifetime; native form navigation stays sandboxed.
export function installSandboxFormActions(doc: Document): void {
  const submit = (event: Event, button: HTMLButtonElement) => {
    const form = button.form;
    if (!form || button.matches(":disabled")) return;
    event.preventDefault();
    if (!form.noValidate && !button.formNoValidate && !form.reportValidity()) return;
    form.dispatchEvent(
      new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: button,
      }),
    );
  };

  doc.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    if (button instanceof HTMLButtonElement && button.type === "submit") submit(event, button);
  });

  doc.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.repeat ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const input = event.target;
    if (
      !(input instanceof HTMLInputElement) ||
      input.isContentEditable ||
      !input.form ||
      !["text", "email", "tel", "url", "search", "password", "number"].includes(input.type)
    ) {
      return;
    }
    // Document order includes form-associated drawer footers. Never skip a disabled first submitter.
    const button = Array.from(doc.querySelectorAll("button")).find(
      (candidate) => candidate.type === "submit" && candidate.form === input.form,
    );
    if (button) submit(event, button);
  });
}
