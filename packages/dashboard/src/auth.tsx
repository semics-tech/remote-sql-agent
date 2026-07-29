import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@rsagent/protocol/browser';

/**
 * Client-side session state.
 *
 * This is presentation only. Every permission decision is made server-side —
 * hiding a button the API would refuse is a courtesy, not a control.
 */

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
  identityProvider: string;
  roleFromIdp: boolean;
}

export interface AuthConfig {
  localEnabled: boolean;
  entraEnabled: boolean;
  entraLoginUrl: string;
}

interface AuthState {
  user: CurrentUser | null;
  permissions: string[];
  loading: boolean;
  config: AuthConfig | null;
  can: (permission: string) => boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Read the CSRF cookie the server set alongside the session. */
export function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)rsagent_csrf=([^;]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

/** fetch wrapper that attaches the CSRF header to mutating requests. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('x-rsagent-csrf', csrfToken());
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }
  return fetch(path, { ...init, headers, credentials: 'same-origin' });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<AuthConfig | null>(null);

  useEffect(() => {
    void fetch('/api/auth/config')
      .then((r) => (r.ok ? (r.json() as Promise<AuthConfig>) : null))
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const me = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      const res = await apiFetch('/api/auth/me');
      // 401 is the normal signed-out state, not an error worth retrying.
      if (res.status === 401) return { user: null, permissions: [] };
      if (!res.ok) throw new Error('Could not load your session.');
      return (await res.json()) as { user: CurrentUser; permissions: string[] };
    },
    retry: false,
    staleTime: 30_000,
  });

  const value: AuthState = {
    user: me.data?.user ?? null,
    permissions: me.data?.permissions ?? [],
    loading: me.isLoading || config === null,
    config,
    can: (permission) => (me.data?.permissions ?? []).includes(permission),
    signIn: async (username, password) => {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(body.detail ?? body.error ?? 'Sign-in failed.');
      }
      await queryClient.invalidateQueries();
    },
    signOut: async () => {
      await apiFetch('/api/auth/logout', { method: 'POST' });
      // Clear everything: cached estate data belongs to the previous session.
      queryClient.clear();
      await queryClient.invalidateQueries();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
