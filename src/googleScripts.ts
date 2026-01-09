const DEFAULT_GOOGLE_API_SRC = "https://apis.google.com/js/api.js";
const DEFAULT_TIMEOUT_MS = 12000;

type EnvironmentSummary = {
  userAgent: string;
  platform: string;
  language: string;
  online: boolean;
  location: string;
};

export type ScriptLoadResult = {
  ok: boolean;
  src: string;
  error?: unknown;
  environment: EnvironmentSummary;
};

declare global {
  interface Window {
    googleScriptsAvailable?: boolean;
  }
}

/**
 * Loads a Google-hosted script with error handling so privacy blockers or network issues
 * do not crash the app. Sets a global flag for downstream checks.
 */
export async function loadGoogleApiScript(
  src: string = DEFAULT_GOOGLE_API_SRC
): Promise<ScriptLoadResult> {
  const environment = summarizeEnvironment();
  try {
    await loadExternalScript(src);
    window.googleScriptsAvailable = true;
    console.info("[google-scripts] Loaded", src);
    return { ok: true, src, environment };
  } catch (error) {
    window.googleScriptsAvailable = false;
    console.error("[google-scripts] Failed to load", src, error, environment);
    return { ok: false, src, error, environment };
  }
}

function loadExternalScript(src: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    // Avoid double-loading the same script tag.
    const existingScript = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existingScript) {
      const readyState = (existingScript as HTMLScriptElement & { readyState?: string }).readyState;
      if (existingScript.dataset.loaded === "true" || readyState === "complete" || readyState === "loaded") {
        resolve();
        return;
      }
      const timeoutId = window.setTimeout(() => {
        reject(new Error(`Timed out waiting for existing script ${src}`));
      }, timeoutMs);
      existingScript.addEventListener(
        "load",
        () => {
          window.clearTimeout(timeoutId);
          existingScript.dataset.loaded = "true";
          resolve();
        },
        { once: true }
      );
      existingScript.addEventListener(
        "error",
        (event) => {
          window.clearTimeout(timeoutId);
          reject(event instanceof ErrorEvent ? event.error ?? event : event);
        },
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;

    let settled = false;
    const cleanup = () => {
      script.onload = null;
      script.onerror = null;
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timed out loading script ${src} after ${timeoutMs} ms`));
    }, timeoutMs);

    script.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      window.clearTimeout(timer);
      script.dataset.loaded = "true";
      resolve();
    };

    script.onerror = (event) => {
      if (settled) return;
      settled = true;
      cleanup();
      window.clearTimeout(timer);
      if (event instanceof ErrorEvent) {
        reject(event.error ?? new Error(`Failed to load script ${src}`));
      } else {
        reject(new Error(`Failed to load script ${src}`));
      }
    };

    document.head.appendChild(script);
  });
}

function summarizeEnvironment(): EnvironmentSummary {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    online: navigator.onLine,
    location: window.location.href
  };
}
