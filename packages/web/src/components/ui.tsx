// 画面の共通部品（Requirement 11.1, 11.3〜11.6）

import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { TAB_ITEMS, type TabKey } from "../lib/tabs";

const spring = { type: "spring", stiffness: 500, damping: 35, mass: 0.8 } as const;
export const easeOut = [0.16, 1, 0.3, 1] as const;

export function Icon({
  name,
  size = 22,
}: {
  name: "back" | "next" | "send" | "close";
  size?: number;
}) {
  const d = {
    back: "M15 5l-7 7 7 7",
    next: "M9 5l7 7-7 7",
    send: "M4 12l16-8-6 16-3-7z",
    close: "M6 6l12 12M18 6L6 18",
  }[name];
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

export function Header({
  title,
  back,
  meta,
  plain,
}: {
  title?: ReactNode;
  back?: string | true;
  meta?: ReactNode;
  plain?: boolean;
}) {
  const nav = useNavigate();
  return (
    <header className={`header${back ? " back" : ""}${plain ? " plain" : ""}`}>
      {back && (
        <button
          type="button"
          className="icon-btn"
          aria-label="戻る"
          onClick={() => (back === true ? nav(-1) : nav(back))}
        >
          <Icon name="back" />
        </button>
      )}
      {typeof title === "string" ? (
        <h1 style={back ? { fontSize: 16 } : undefined}>{title}</h1>
      ) : (
        title
      )}
      {meta && <span className="meta">{meta}</span>}
    </header>
  );
}

const TAB_ICONS: Record<TabKey, ReactNode> = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l5 5" fill="none" />
    </>
  ),
  chat: <path d="M4 5h16v11H10l-6 4z" />,
  my: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6z" />
    </>
  ),
};

/**
 * 下部タブバー。ホーム／さがす／AI相談／マイホームの4項目。
 * 現在のタブは色だけでなく、ラベルの太さとアイコンの塗りでも示す。
 */
export function TabBar() {
  return (
    <nav className="tabbar" aria-label="メインメニュー">
      {TAB_ITEMS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) => `tab${isActive ? " active" : ""}`}
        >
          {({ isActive }) => (
            <>
              {isActive && <m.span layoutId="tab-pill" className="tab-pill" transition={spring} />}
              <svg
                aria-hidden="true"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill={isActive ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinejoin="round"
                strokeLinecap="round"
              >
                {TAB_ICONS[t.key]}
              </svg>
              <span>{t.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

/** モーダルダイアログ。開いた場所（origin）から拡大して出る */
export function Dialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  role = "dialog",
  origin = "50% 50%",
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  origin?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, a, input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <m.div
          className="scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, pointerEvents: "none" }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <m.div
            ref={ref}
            role={role}
            aria-modal="true"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            className="dialog"
            style={{ transformOrigin: origin }}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.22, ease: easeOut } }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const show = (s: string) => {
    setMsg(s);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2400);
  };
  const toast = (
    <AnimatePresence>
      {msg && (
        <m.div
          role="status"
          className="toast"
          initial={{ opacity: 0, y: 8, x: "-50%" }}
          animate={{ opacity: 1, y: 0, x: "-50%" }}
          exit={{ opacity: 0, y: 8, x: "-50%" }}
          transition={{ duration: 0.2 }}
        >
          {msg}
        </m.div>
      )}
    </AnimatePresence>
  );
  return { toast, show };
}
