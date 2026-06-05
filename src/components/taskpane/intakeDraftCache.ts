import { initialIntakeState, intakeReducer, type IntakeState } from "./intakeReducer";

const MAX_INTAKE_DRAFTS = 30;
const drafts = new Map<string, IntakeState>();

export function loadIntakeDraft(mailKey: string, mailFrom: string): IntakeState {
  const saved = drafts.get(mailKey);
  if (!saved) return initialIntakeState(mailFrom);

  drafts.delete(mailKey);
  drafts.set(mailKey, saved);
  return saved.mailFrom === mailFrom
    ? saved
    : intakeReducer(saved, { type: "mailFromChanged", mailFrom });
}

export function rememberIntakeDraft(mailKey: string, state: IntakeState): void {
  drafts.delete(mailKey);
  drafts.set(mailKey, state);
  while (drafts.size > MAX_INTAKE_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

export function clearIntakeDraftCache(): void {
  drafts.clear();
}
