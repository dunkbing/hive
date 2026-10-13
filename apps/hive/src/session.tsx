import type { Me } from "@hive/core";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api.ts";

interface Session {
  me: Me | null;
  refresh: () => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session>({ me: null, refresh: () => {}, signOut: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);

  const refresh = useCallback(() => {
    api.me().then(setMe, () => setMe({ user: null }));
  }, []);

  useEffect(refresh, [refresh]);

  const signOut = useCallback(async () => {
    await api.logout();
    setMe({ user: null });
    location.assign("/");
  }, []);

  return <SessionContext.Provider value={{ me, refresh, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}

export function signInUrl(next = location.pathname + location.search) {
  return `/auth/github?next=${encodeURIComponent(next)}`;
}
