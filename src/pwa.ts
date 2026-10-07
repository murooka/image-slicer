import { registerSW } from "virtual:pwa-register";

const toast = document.getElementById("pwa-toast")!;
const text = document.getElementById("pwa-toast-text")!;
const reloadButton = document.getElementById("pwa-reload") as HTMLButtonElement;
const closeButton = document.getElementById("pwa-close") as HTMLButtonElement;

/** Service Worker を登録し、オフライン対応の完了と新しいバージョンの公開を通知する */
export function setupPwa(): void {
  const updateSW = registerSW({
    onOfflineReady() {
      show("オフラインでも使えるようになりました。", false);
    },
    onNeedRefresh() {
      // 作業中の分割線が失われないよう、自動では再読み込みしない
      show("新しいバージョンがあります。更新すると編集中の内容は失われます。", true);
    },
  });
  reloadButton.addEventListener("click", () => updateSW(true));
  closeButton.addEventListener("click", () => (toast.hidden = true));
}

function show(message: string, canReload: boolean): void {
  text.textContent = message;
  reloadButton.hidden = !canReload;
  toast.hidden = false;
}
