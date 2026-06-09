const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function relativeSubmittedTime(submittedAt?: number, now = Date.now()): string {
  if (submittedAt === undefined) return "Just now";
  const elapsed = Math.max(0, now - submittedAt);
  if (elapsed < DAY_MS) return "Less than 1d ago";
  if (elapsed < WEEK_MS) {
    const days = Math.floor(elapsed / DAY_MS);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  const weeks = Math.floor(elapsed / WEEK_MS);
  return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
}
