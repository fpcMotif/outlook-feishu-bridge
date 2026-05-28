/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as emailRecord from "../emailRecord.js";
import type * as emails from "../emails.js";
import type * as feishu_auth from "../feishu/auth.js";
import type * as feishu_bitable from "../feishu/bitable.js";
import type * as feishu_bot from "../feishu/bot.js";
import type * as feishu_call from "../feishu/call.js";
import type * as feishu_chat from "../feishu/chat.js";
import type * as feishu_client from "../feishu/client.js";
import type * as feishu_contacts from "../feishu/contacts.js";
import type * as feishu_docx from "../feishu/docx.js";
import type * as feishu_fileUpload from "../feishu/fileUpload.js";
import type * as feishu_forwardEmail from "../feishu/forwardEmail.js";
import type * as feishu_groups from "../feishu/groups.js";
import type * as feishu_im from "../feishu/im.js";
import type * as feishu_imageUpload from "../feishu/imageUpload.js";
import type * as feishu_markdown from "../feishu/markdown.js";
import type * as feishu_message from "../feishu/message.js";
import type * as feishu_pdf from "../feishu/pdf.js";
import type * as feishu_requestSync from "../feishu/requestSync.js";
import type * as feishu_userAuth from "../feishu/userAuth.js";
import type * as http from "../http.js";
import type * as returns from "../returns.js";
import type * as storage from "../storage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  emailRecord: typeof emailRecord;
  emails: typeof emails;
  "feishu/auth": typeof feishu_auth;
  "feishu/bitable": typeof feishu_bitable;
  "feishu/bot": typeof feishu_bot;
  "feishu/call": typeof feishu_call;
  "feishu/chat": typeof feishu_chat;
  "feishu/client": typeof feishu_client;
  "feishu/contacts": typeof feishu_contacts;
  "feishu/docx": typeof feishu_docx;
  "feishu/fileUpload": typeof feishu_fileUpload;
  "feishu/forwardEmail": typeof feishu_forwardEmail;
  "feishu/groups": typeof feishu_groups;
  "feishu/im": typeof feishu_im;
  "feishu/imageUpload": typeof feishu_imageUpload;
  "feishu/markdown": typeof feishu_markdown;
  "feishu/message": typeof feishu_message;
  "feishu/pdf": typeof feishu_pdf;
  "feishu/requestSync": typeof feishu_requestSync;
  "feishu/userAuth": typeof feishu_userAuth;
  http: typeof http;
  returns: typeof returns;
  storage: typeof storage;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
