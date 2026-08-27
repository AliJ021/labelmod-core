/**
 * تایپ‌های Kysely برای جدول‌هایی که API واقعاً لمس می‌کند.
 *
 * عمداً دست‌نویس و ناقص است — نه تولیدشده از کل اسکیما. دلیلش:
 * تولید خودکار تایپ برای ۳۸ جدول، فهرستی می‌سازد که هیچ‌کس نمی‌خواندش
 * و با هر مهاجرت بی‌صدا کهنه می‌شود. اینجا هر جدولی که اضافه شود، یعنی
 * کسی عمداً تصمیم گرفته API آن را ببیند.
 *
 * پول همه‌جا string است، نه number: پارسر NUMERIC در pg رشته می‌دهد و
 * ما همان را به bigint می‌بریم. هیچ مبلغی نباید حتی یک لحظه number شود.
 */
import type { Generated } from "kysely";

export interface AppUserTable {
  id: Generated<string>;
  username: string;
  full_name: string;
  mobile: string | null;
  password_hash: string | null;
  pin_hash: string | null;
  is_active: boolean;
  totp_secret: string | null;
  created_at: Generated<Date>;
}

export interface RoleTable {
  code: string;
  name: string;
}

export interface UserRoleTable {
  user_id: string;
  role_code: string;
  branch_id: string | null;
}

export interface DeviceTable {
  id: Generated<string>;
  fingerprint: string;
  label: string;
  kind: "pos" | "desktop" | "mobile" | "other";
  branch_id: string | null;
  is_approved: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  last_seen_at: Date | null;
  created_at: Generated<Date>;
}

export interface SessionTable {
  id: Generated<string>;
  token_hash: string;
  user_id: string;
  device_id: string | null;
  subject: "staff" | "customer";
  auth_method: "password" | "totp" | "webauthn" | "otp";
  ip: string | null;
  user_agent: string | null;
  issued_at: Generated<Date>;
  expires_at: Date;
  last_seen_at: Generated<Date>;
  locked_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface AuthAttemptTable {
  id: Generated<number>;
  at: Generated<Date>;
  kind: "password" | "pin" | "totp" | "otp" | "webauthn";
  username: string | null;
  user_id: string | null;
  device_id: string | null;
  ip: string | null;
  succeeded: boolean;
  failure_code: string | null;
}

export interface SettingTable {
  key: string;
  value: unknown;
  description: string;
  requires_approval: boolean;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface BranchTable {
  id: Generated<string>;
  code: string;
  name: string;
  is_active: boolean;
}

export interface Database {
  "identity.app_user": AppUserTable;
  "identity.role": RoleTable;
  "identity.user_role": UserRoleTable;
  "identity.device": DeviceTable;
  "identity.session": SessionTable;
  "identity.auth_attempt": AuthAttemptTable;
  "platform.setting": SettingTable;
  "platform.branch": BranchTable;
}
