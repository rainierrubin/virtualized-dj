/**
 * Hooks for enumerating audio output devices and managing setSinkId on
 * individual audio elements. Chrome / Edge fully supported. Firefox supports
 * setSinkId but enumerateDevices may need a getUserMedia grant for labels.
 */
import { useCallback, useEffect, useState, type RefObject } from "react";

export interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

export interface DeviceState {
  devices: AudioOutputDevice[];
  hasLabels: boolean;
  supported: boolean;
  error: string | null;
}

export function useAudioOutputDevices(): {
  state: DeviceState;
  requestPermission: () => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<DeviceState>({
    devices: [],
    hasLabels: false,
    supported: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    try {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices ||
        !navigator.mediaDevices.enumerateDevices
      ) {
        setState({
          devices: [],
          hasLabels: false,
          supported: false,
          error: "navigator.mediaDevices not available",
        });
        return;
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      const outputs = all
        .filter((d) => d.kind === "audiooutput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
      const hasLabels = outputs.some((d) => d.label.length > 0);
      setState({ devices: outputs, hasLabels, supported: true, error: null });
    } catch (e) {
      setState((s) => ({
        ...s,
        error: e instanceof Error ? e.message : "enumerateDevices failed",
      }));
    }
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // we only needed the permission; stop the stream immediately
      stream.getTracks().forEach((t) => t.stop());
      await refresh();
    } catch (e) {
      setState((s) => ({
        ...s,
        error: e instanceof Error ? e.message : "permission denied",
      }));
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    const handler = () => refresh();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [refresh]);

  return { state, requestPermission, refresh };
}

/**
 * Wraps an audio element ref so its sink is updated whenever deviceId
 * changes (and any time the element re-mounts because the src changed).
 */
export function useAudioSink(
  audioRef: RefObject<HTMLAudioElement | null>,
  deviceId: string | null,
  reapplyKey: string | null
): { sinkSupported: boolean; sinkError: string | null } {
  const [sinkError, setSinkError] = useState<string | null>(null);
  const [sinkSupported, setSinkSupported] = useState(true);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const sinkable = a as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof sinkable.setSinkId !== "function") {
      setSinkSupported(false);
      return;
    }
    setSinkSupported(true);
    if (!deviceId) {
      // explicit "default": try empty string, fall back gracefully if unsupported
      sinkable.setSinkId("").catch(() => {
        // some browsers reject "" — treat as no-op
      });
      setSinkError(null);
      return;
    }
    sinkable.setSinkId(deviceId).then(
      () => setSinkError(null),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setSinkError(`setSinkId: ${msg}`);
      }
    );
  }, [audioRef, deviceId, reapplyKey]);

  return { sinkSupported, sinkError };
}
