import { LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { OfflineBanner, UpdatePrompt } from "./components/pwa";
import { TabBar } from "./components/ui";
import { PRIVACY, TERMS } from "./legal/content";
import { routeFor, type SessionState } from "./lib/routing";
import { showsTabBar } from "./lib/tabs";
import { Auth } from "./screens/Auth";
import { Home, Search } from "./screens/Dashboard";
import { LegalPage } from "./screens/Legal";
import { MyHomePlaceholder, Placeholder } from "./screens/Placeholder";
import { OnbChildren, OnbConsent, OnbPostal } from "./screens/Onboarding";
import { ProgramDetail } from "./screens/ProgramDetail";
import { useSession } from "./state/session";

export default function App() {
  const loc = useLocation();
  const { user, household } = useSession();
  const state: SessionState =
    user === undefined
      ? "checking"
      : user === null
        ? "signed-out"
        : household === undefined
          ? "loading-household"
          : household === null
            ? "needs-onboarding"
            : "ready";
  const target = routeFor(state, loc.pathname);

  return (
    <LazyMotion features={domMax} strict>
      {/* OS の「視差効果を減らす」設定では動きを止める */}
      <MotionConfig reducedMotion="user">
        <div className="app">
          <OfflineBanner />
          {target === "wait" ? (
            <p role="status" className="note sub" style={{ padding: 24 }}>
              読み込んでいます…
            </p>
          ) : target !== null ? (
            <Navigate to={target} replace />
          ) : (
            <>
              <m.div
                key={loc.pathname}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.16 }}
              >
                <Routes location={loc}>
                  <Route path="/" element={<Auth />} />
                  <Route path="/onboarding/postal" element={<OnbPostal />} />
                  <Route path="/onboarding/children" element={<OnbChildren />} />
                  <Route path="/onboarding/consent" element={<OnbConsent />} />
                  <Route path="/home" element={<Home />} />
                  <Route path="/search" element={<Search />} />
                  <Route path="/chat" element={<Placeholder title="AI相談" task="T24（#25）" />} />
                  <Route path="/my" element={<MyHomePlaceholder />} />
                  <Route path="/programs/:id" element={<ProgramDetail />} />
                  <Route path="/terms" element={<LegalPage doc={TERMS} />} />
                  <Route path="/privacy" element={<LegalPage doc={PRIVACY} />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </m.div>
              {state === "ready" && showsTabBar(loc.pathname) && <TabBar />}
            </>
          )}
          <UpdatePrompt />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
