// The forward contract shared by the UI (channel cards) and the forward
// orchestration. Kept framework-free so forwardEmail.ts, its tests, and the
// bench script can import it without pulling in React components.

export interface ForwardTargets {
  bot: boolean;
  chat: boolean;
  bitable: boolean;
  contacts: string[];
  groups: string[];
  attachPdf: boolean;
  includeAttachments: boolean;
  createDoc: boolean;
}

export interface Contact {
  openId: string;
  name: string;
  avatarUrl?: string;
}

export interface ChatGroup {
  chatId: string;
  name: string;
  avatar: string;
  description?: string;
}
