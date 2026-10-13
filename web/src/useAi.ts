import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../shared/types.ts";
import { streamAi, type AiKind } from "./api.ts";

export function useAiStream(analysisId: string) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }, []);

  const run = useCallback(
    async (kind: AiKind, body: { path?: string; messages?: ChatMessage[] }): Promise<string> => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setText("");
      setError(null);
      setLoading(true);
      let acc = "";
      try {
        await streamAi(analysisId, kind, body, (t) => {
          acc += t;
          setText(acc);
        }, ctrl.signal);
      } catch (e) {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (abortRef.current === ctrl) {
          abortRef.current = null;
          setLoading(false);
        }
      }
      return acc;
    },
    [analysisId],
  );

  const reset = useCallback(() => {
    stop();
    setText("");
    setError(null);
  }, [stop]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { text, loading, error, run, stop, reset, setText };
}
