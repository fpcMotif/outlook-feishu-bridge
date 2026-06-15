import {
  initialIntakeState,
  intakeReducer,
  type IntakeState,
  type UploadedFile,
} from "./intakeReducer";

const MAX_INTAKE_DRAFTS = 30;
const drafts = new Map<string, IntakeState>();

export function buildIntakeDraftKey(
  openId: string | undefined,
  userEmail: string | undefined,
  mailKey: string,
): string | null {
  const email = userEmail?.trim().toLowerCase();
  const context = mailKey.trim();
  if (!email || !context) return null;
  const owner = openId?.trim() ?? "";
  return `${owner}\0${email}\n${context}`;
}

export function loadIntakeDraft(
  key: string | null,
  mailFrom: string,
  restoredUploads: UploadedFile[] = [],
  defaultSales: IntakeState["selectedSales"] = null,
): IntakeState {
  if (key === null) return initialIntakeState({ mailFrom, restoredUploads, defaultSales });
  const saved = drafts.get(key);
  if (!saved) return initialIntakeState({ mailFrom, restoredUploads, defaultSales });

  drafts.delete(key);
  drafts.set(key, saved);
  return saved.mailFrom === mailFrom
    ? saved
    : intakeReducer(saved, { type: "mailFromChanged", mailFrom });
}

export function rememberIntakeDraft(key: string | null, state: IntakeState): void {
  if (key === null) return;
  drafts.delete(key);
  drafts.set(key, state);
  while (drafts.size > MAX_INTAKE_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

export function clearIntakeDraft(key: string | null): void {
  if (key === null) return;
  drafts.delete(key);
}

export function clearIntakeDraftCache(): void {
  drafts.clear();
}
