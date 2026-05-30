// DEV-only dark-mode QA aid. Injects a small fixed button that flips the
// `.dark` class on <html> (persisted in localStorage) so the taskpane's dark
// palette can be eyeballed without changing the OS theme. Gated behind
// import.meta.env.DEV in main.tsx, so it never ships to the hosted SPA.

const STORAGE_KEY = "dev-dark-mode";

function applyDark(on: boolean): void {
  document.documentElement.classList.toggle("dark", on);
}

export function mountDevDarkToggle(): void {
  if (document.querySelector("#dev-dark-toggle")) return;

  let dark = localStorage.getItem(STORAGE_KEY) === "1";
  applyDark(dark);

  const button = document.createElement("button");
  button.id = "dev-dark-toggle";
  button.type = "button";
  button.style.cssText =
    "position:fixed;right:8px;bottom:8px;z-index:9999;padding:4px 8px;" +
    "font:600 11px system-ui;border-radius:8px;border:1px solid #8884;" +
    "background:#0006;color:#fff;cursor:pointer;backdrop-filter:blur(4px)";

  const render = () => {
    button.textContent = dark ? "Light" : "Dark";
  };
  render();

  button.addEventListener("click", () => {
    dark = !dark;
    localStorage.setItem(STORAGE_KEY, dark ? "1" : "0");
    applyDark(dark);
    render();
  });

  document.body.append(button);
}
