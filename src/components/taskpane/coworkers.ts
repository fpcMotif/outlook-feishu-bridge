// Domain type for the single Feishu assignee written to the Base row.
export interface Coworker {
  openId: string;
  name: string;
  avatarUrl?: string;
}

export type CoworkerDirectoryState =
  | { status: "idle"; records: Coworker[] }
  | { status: "loading"; records: Coworker[] }
  | { status: "ready"; records: Coworker[] }
  | { status: "error"; records: Coworker[] };
