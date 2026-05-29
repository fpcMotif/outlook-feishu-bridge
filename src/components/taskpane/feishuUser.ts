// Shared Feishu identity shape used across auth, profile chrome, and request sync.
export interface FeishuUser {
  openId: string;
  userName?: string;
  avatarUrl?: string;
  email?: string;
  org?: string;
}
