// オフライン・インストール案内・更新の通知（Requirement 11.2, 11.9）

import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { OFFLINE_BANNER_MESSAGE } from "../lib/offline";
import { installHint, isStandalone } from "../lib/pwa";
import { readFlag, writeFlag } from "../lib/storage";
import { useOnline } from "../lib/useOnline";
import { Icon } from "./ui";

/** オフラインの間だけ、画面上部に制限があることを示す */
export function OfflineBanner() {
  const online = useOnline();
  return (
    <AnimatePresence initial={false}>
      {!online && (
        <m.p
          role="status"
          className="banner"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          {OFFLINE_BANNER_MESSAGE}
        </m.p>
      )}
    </AnimatePresence>
  );
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
const DISMISS_KEY = "install-hint-dismissed";

/** ホーム画面への追加の案内。iOS は手順を文章で示す */
export function InstallHint() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => readFlag(DISMISS_KEY));
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const hint = installHint({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: isStandalone(
      window.matchMedia("(display-mode: standalone)").matches,
      (navigator as Navigator & { standalone?: boolean }).standalone,
    ),
    hasPrompt: promptEvent !== null,
    dismissed,
  });
  const close = () => {
    writeFlag(DISMISS_KEY, true);
    setDismissed(true);
  };

  return (
    <AnimatePresence>
      {hint && (
        <m.aside
          aria-label="ホーム画面に追加"
          className="card install"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.24 }}
        >
          <div className="between" style={{ alignItems: "flex-start" }}>
            <p className="bold" style={{ fontSize: 15 }}>
              ホーム画面に追加すると、アプリのように使えます
            </p>
            <button
              type="button"
              className="icon-btn"
              aria-label="案内を閉じる"
              onClick={close}
              style={{ margin: "-12px -12px 0 0" }}
            >
              <Icon name="close" size={20} />
            </button>
          </div>
          {hint === "prompt" ? (
            <button
              type="button"
              className="btn primary self-start"
              onClick={async () => {
                await promptEvent?.prompt();
                setPromptEvent(null);
              }}
            >
              ホーム画面に追加
            </button>
          ) : (
            <p className="note" style={{ lineHeight: 1.6 }}>
              Safari の下にある共有ボタンから「ホーム画面に追加」を選んでください。
            </p>
          )}
        </m.aside>
      )}
    </AnimatePresence>
  );
}

/** 新しい版の Service Worker が待機しているときに更新を促す */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  return (
    <AnimatePresence>
      {needRefresh && (
        <m.div
          role="status"
          className="toast row"
          style={{ gap: 12 }}
          initial={{ opacity: 0, y: 8, x: "-50%" }}
          animate={{ opacity: 1, y: 0, x: "-50%" }}
          exit={{ opacity: 0, y: 8, x: "-50%" }}
        >
          新しい版があります
          <button
            type="button"
            className="btn"
            style={{ minHeight: 44 }}
            onClick={() => void updateServiceWorker(true)}
          >
            更新する
          </button>
          <button
            type="button"
            className="btn ghost"
            style={{ minHeight: 44, color: "var(--white)" }}
            onClick={() => setNeedRefresh(false)}
          >
            あとで
          </button>
        </m.div>
      )}
    </AnimatePresence>
  );
}
