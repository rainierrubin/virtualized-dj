function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function formatSessionStart(d: Date): string {
  return (
    `${pad(d.getMonth() + 1)}/${pad(d.getDate())}_` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function formatTrackTitle(sessionStart: string, trackNumber: number): string {
  return `${sessionStart}_${pad(trackNumber)}`;
}
