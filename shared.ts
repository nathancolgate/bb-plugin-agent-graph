// Values shared by the backend (server.ts) and the frontend (app.tsx,
// graph.tsx). Keep this file free of server-only imports: the frontend
// bundle includes it.

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode); the choice just won't stick.
  }
}
