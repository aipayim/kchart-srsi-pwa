/**
 * CKX SDK（开放层 M2a）公开类型声明 —— 手写，与 `dist/ckx.esm.js` / `dist/ckx.umd.js` 逐一对应。
 *
 * 该文件同时是运行时导出名的契约：`tools/ckx/verify-ckx-sdk.mjs` 会把它与真实 bundle
 * 的导出列表做一致性断言，防止声明漂移。
 */

// ---------------------------------------------------------------- 常量

/** CKX 格式版本（即 `meta.ckx`）。 */
export declare const CKX_FORMAT_VERSION: '1';
/** 元数据 UTF-8 上限（字节）。 */
export declare const CKX_META_MAX_BYTES: 4096;
/** 文本载荷上限（字节，介质 A）。 */
export declare const CKX_TEXT_MAX_BYTES: number;
/** 开放层固定 PBKDF2 迭代数。 */
export declare const CKX_ITERATIONS: 600000;
/** `IMGV` 帧头字节数。 */
export declare const IMGV_HEADER_BYTES: 8;
/** 介质 E 尾部 magic（12 个 ASCII 字符）。 */
export declare const VIDEO_TRAILER_MAGIC: 'CKVIDEOVAULT';
/** 介质 E 尾部总字节数 = magic(12) + uint64 LE(8)。 */
export declare const VIDEO_TRAILER_SIZE: 20;

/** 规范定义的 11 个 CKX 错误码。 */
export declare const CKX_CODES: readonly [
  'CKX_NO_CARRIER',
  'CKX_PAYLOAD_TOO_LARGE',
  'CKX_UNSUPPORTED_FORMAT_VERSION',
  'CKX_WRONG_PASSWORD',
  'CKX_PASSWORD_REQUIRED',
  'CKX_RENAMED_CARRIER',
  'CKX_SET_NAME_MISMATCH',
  'CKX_SCHEMA_MISMATCH',
  'CKX_CAPABILITY_REQUIRED',
  'CKX_CARRIER_DAMAGED',
  'CKX_TIMEOUT',
];

export type CkxCode = (typeof CKX_CODES)[number];
/** 非密码学契约的接入参数错误码。 */
export declare const CKX_PARAM_ERROR: 'INVALID_PARAMS';
export type CkxAnyCode = CkxCode | typeof CKX_PARAM_ERROR;

/** 错误码 → 稳定 i18n 键（`ckx.err.*`），宿主据此本地化。 */
export declare const CKX_MESSAGE_KEYS: Readonly<Record<CkxAnyCode, string>>;

/** 结构化可操作细节；**不含**密钥/部分明文/密码学 oracle。 */
export interface CkxErrorDetail {
  field?: string;
  limit?: number;
  actual?: number | string;
  hint?: string;
}

// ---------------------------------------------------------------- 错误

/**
 * 错误语义细分（AIDID-2/GEN-6/GEN-7）：`message` 恒为**英文**，`messageKey` 稳定，
 * `detail` 为结构化细节，`retryable` 表示重试是否有意义。
 */
export declare class CkxError extends Error {
  readonly code: CkxAnyCode;
  readonly messageKey: string;
  readonly detail: CkxErrorDetail | undefined;
  readonly retryable: boolean;
  constructor(code: CkxAnyCode, message: string, detail?: CkxErrorDetail);
}

// ---------------------------------------------------------------- 数据类型

/** 载体携带的公开元数据。 */
export interface CkxMeta {
  /** 恒为 `'1'`。 */
  ckx: string;
  app: string;
  schemaId?: string;
  schemaVersion?: string;
  label?: string;
  createdAt?: string;
  note?: string;
  ckx_caps?: string[];
  [key: string]: unknown;
}

/** 载体图像素缓冲（浏览器可直接传 `ImageData`）。 */
export interface CkxImageData {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** `encryptTo*` 元数据入参。 */
export interface CkxMetaInput {
  app: string;
  schema?: string | null;
  schemaVersion?: string | null;
  label?: string | null;
  caps?: string[];
  createdAt?: string;
}

export type CkxMedium = 'text' | 'file' | 'image-text' | 'image-binary' | 'video';

/** `decryptFromVideo` 结果（介质 E）。 */
export interface CkxVideoDecryptResult {
  /** 明文为合法 UTF-8 时的文本，否则 `null`（二进制载荷）。 */
  text: string | null;
  /** 原始明文字节。 */
  bytes: Uint8Array;
  /** 载体携带的公开元数据。 */
  meta: CkxMeta;
}

export interface CkxDecryptOptions {
  schema?: string | null;
}

export interface CkxDecryptResult {
  plaintext: Uint8Array;
  text: string | null;
  meta: CkxMeta;
  medium: CkxMedium;
}

export interface CkxCapacityEstimate {
  medium: 'image-text' | 'image-binary';
  capacityBytes: number;
  maxContainerBytes: number;
  maxPayloadBytes: number;
}

export interface CkxImageOptions {
  binary?: boolean;
  inPlace?: boolean;
}

// ---------------------------------------------------------------- 容量工具

export declare function containerBytes(metaLen: number, payloadLen: number): number;
export declare function textEmbedRequiredBytes(containerLen: number): number;
export declare function textLsbCapacityBytes(width: number, height: number): number;
export declare function imgvCapacityBytes(width: number, height: number): number;
export declare function base64UrlLength(byteLen: number): number;

export declare function estimateCapacity(
  source: CkxImageData | { width: number; height: number } | number,
  options?: { binary?: boolean; metaBytes?: number },
): CkxCapacityEstimate;

export declare function suggestCarrierSize(containerLen: number, options?: { binary?: boolean }): number;

// ---------------------------------------------------------------- 主 API

/** 介质 A：文本 → base64url(`SAFE` v3 容器)，仅文本 ≤ 5 MB。 */
export declare function encryptToText(text: string, password: string, meta: CkxMetaInput): Promise<string>;
/** 介质 D：任意字节/文本 → `SAFE` v3 容器原字节。 */
export declare function encryptToFile(
  payload: string | Uint8Array,
  password: string,
  meta: CkxMetaInput,
): Promise<Uint8Array>;
/** 介质 B/C：把容器写入载体像素（LSB）。默认不改入参，返回新载体。 */
export declare function encryptToImage(
  payload: string | Uint8Array,
  password: string,
  meta: CkxMetaInput,
  carrier: CkxImageData,
  options?: CkxImageOptions,
): Promise<CkxImageData>;
/** 自动识别载体并解密；解密失败统一抛 `CkxError('CKX_WRONG_PASSWORD')`。 */
export declare function decrypt(
  carrier: string | Uint8Array | CkxImageData,
  password: string,
  options?: CkxDecryptOptions,
): Promise<CkxDecryptResult>;
/** 只读公开元数据，不解密；不可读/非 CKX 载体返回 `null`。 */
export declare function readMeta(carrier: string | Uint8Array | CkxImageData): CkxMeta | null;
/** 介质 E：容器尾挂到视频原文件字节，返回可直接保存为视频文件的字节。 */
export declare function encryptToVideo(
  payload: string | Uint8Array,
  password: string,
  meta: CkxMetaInput,
  videoBytes: Uint8Array,
): Promise<Uint8Array>;
/** 介质 E：视频文件字节 → 尾挂容器 → 解密；无合法尾挂抛 `CkxError('CKX_NO_CARRIER')`。
 *  `options.schema` 与 `decrypt` 一致门禁（不符抛 `CKX_SCHEMA_MISMATCH`）。 */
export declare function decryptFromVideo(
  videoBytes: Uint8Array,
  password: string,
  options?: CkxDecryptOptions,
): Promise<CkxVideoDecryptResult>;
/** 介质 E 纯帧函数：`video || payload || magic || uint64LE(len)`（与站点 trailer 同构）。 */
export declare function attachVideoTrailer(video: Uint8Array, payload: Uint8Array): Uint8Array;
/** 介质 E 纯帧函数：切出尾挂 payload；magic 不匹配 / 长度非法 / 太短 → `null`。 */
export declare function detachVideoTrailer(file: Uint8Array): Uint8Array | null;
/** 介质 E 纯帧函数：文件是否携带合法尾挂（不复制 payload）。 */
export declare function hasVideoTrailer(file: Uint8Array): boolean;

// ---------------------------------------------------------------- 签约能力门控（M4）

/** 签约判定来源。 */
export type CkxLicenseSource = 'token' | 'kv' | 'revoked' | 'none';

/** `ckxLicense.verify` 选项。 */
export interface CkxLicenseOptions {
  /** 签约主体标识（= 令牌 `sub`，如 `merchant1`）。 */
  app: string;
  /** 上次获得的离线令牌（可选）。 */
  token?: string | null;
  /** 服务基址；默认 `https://cryptokey.im`（尾部 `/` 会被归一化）。 */
  endpoint?: string;
  /** Ed25519 公钥（raw 32B，base64/base64url）；省略则经 `/v1/ckx/release` 拉取。 */
  publicKey?: string;
  /** 是否发起在线兜底请求，默认 `true`；`false` = 纯离线验签。 */
  online?: boolean;
  /** 网络超时（ms），默认 8000。 */
  timeoutMs?: number;
  /** 注入 `fetch`（测试/自定义传输）；默认全局 `fetch`。 */
  fetch?: typeof fetch;
}

/** `ckxLicense.verify` 结果。 */
export interface CkxLicenseResult {
  /** 是否具备签约能力（开放层能力不受此约束）。 */
  pro: boolean;
  /** 已归一化（去重、排序）的签约能力位。 */
  features: string[];
  /** 到期时间（ms）；无到期时间时为 `null`。 */
  expiresAt: number | null;
  /** 判定来源。 */
  source: CkxLicenseSource;
  /** 服务端在线续签下发的新令牌（若有）。 */
  token?: string;
}

/** 签约能力门控 API。 */
export interface CkxLicense {
  verify(options: CkxLicenseOptions): Promise<CkxLicenseResult>;
  /** 开放层能力恒为 `true`；签约能力须出现在 `features` 中。 */
  can(
    features: string[] | CkxLicenseResult | null | undefined,
    required: string | string[],
  ): boolean;
  readonly freeFeatures: readonly string[];
  readonly proFeatures: readonly string[];
  clearCache(): void;
}

/**
 * 签约能力门控。离线校验 `ckx1.<payloadB64url>.<sigB64url>` Ed25519 令牌（公钥来自
 * `options.publicKey` 或 `GET /v1/ckx/release` 并内存缓存），在线 `POST
 * /v1/ckx/license/verify` 兜底/撤销；网络不可用时静默回落，不抛异常。
 * 开放层能力（`text/image/file/video`）永远可用，不受门控。
 */
export declare const ckxLicense: CkxLicense;

// ---------------------------------------------------------------- 签约 schema 自助注册（SDK 0.3.0）

/**
 * CKX schema HTTP 层错误码：服务端 `error` 原样透出；传输失败 `CKX_TIMEOUT`，
 * 2xx 但响应体畸形 `CKX_HTTP_ERROR`。`(string & {})` 保留任意服务端码的余地。
 */
export type CkxSchemaErrorCode =
  | 'INVALID_PARAMS'
  | 'CKX_TIMEOUT'
  | 'CKX_HTTP_ERROR'
  | 'APP_KEY_REQUIRED'
  | 'INVALID_APP_KEY'
  | 'LICENSE_NOT_FOUND'
  | 'APP_KEY_NOT_ISSUED'
  | 'LICENSE_INACTIVE'
  | 'CAPABILITY_REQUIRED'
  | 'SCHEMA_RESERVED'
  | 'SCHEMA_OWNED_BY_ANOTHER_APP'
  | 'SCHEMA_NOT_FOUND'
  | 'INVALID_APP'
  | 'INVALID_SCHEMA_ID'
  | 'INVALID_FIELDS'
  | 'INVALID_VERSION'
  | 'INVALID_DESCRIPTION'
  | 'KV_UNAVAILABLE'
  | 'RATE_LIMITED'
  | (string & {});

/** 单个字段定义（只描述结构，绝不承载用户数据）。 */
export interface CkxSchemaField {
  key: string;
  type: string;
  label?: string;
  placeholder?: string;
  description?: string;
  required?: boolean;
  options?: string[];
}

/** 注册结果的完整 schema 记录。 */
export interface CkxSchemaRecord {
  schemaId: string;
  owner: string;
  version: number;
  fields: CkxSchemaField[];
  description: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 列表结果的 schema 摘要。 */
export interface CkxSchemaSummary {
  schemaId: string;
  version: number;
  fields: CkxSchemaField[];
  description: string | null;
  updatedAt: string | null;
}

/** 传输类公共选项。 */
export interface CkxSchemaTransportOptions {
  /** 服务基址；默认 `https://cryptokey.im`（尾部 `/` 会被归一化）。 */
  endpoint?: string;
  /** 网络超时（ms），默认 8000。 */
  timeoutMs?: number;
  /** 注入 `fetch`（测试/自定义传输）；默认全局 `fetch`。 */
  fetch?: typeof fetch;
}

/** 所有 schema 调用的公共选项（app + app API Key）。 */
export interface CkxSchemaOptions extends CkxSchemaTransportOptions {
  /** 签约主体标识（schema 的 owner）。 */
  app: string;
  /** app API Key（`ckxapp_…`，只在 `Authorization` 头发送）。 */
  apiKey: string;
}

/** `ckxSchema.register` 选项。 */
export interface CkxSchemaRegisterOptions extends CkxSchemaOptions {
  /** schema 标识（1–64 位 `[A-Za-z0-9._:-]`）。 */
  schemaId: string;
  /** 字段定义数组（最多 64 项）。 */
  fields: CkxSchemaField[];
  /** 显式版本（1–1000000）；省略则服务端续期自增。 */
  version?: number;
  /** 可选说明（≤ 512 字符）。 */
  description?: string | null;
}

/** `ckxSchema.list` 选项。 */
export type CkxSchemaListOptions = CkxSchemaOptions;

/** `ckxSchema.remove` 选项。 */
export interface CkxSchemaRemoveOptions extends CkxSchemaOptions {
  schemaId: string;
}

/** `ckxSchema.register` 结果。 */
export interface CkxSchemaRegisterResult {
  created: boolean;
  schema: CkxSchemaRecord;
}

/** `ckxSchema.list` 结果。 */
export interface CkxSchemaListResult {
  app: string;
  schemas: CkxSchemaSummary[];
  count: number;
}

/** `ckxSchema.remove` 结果。 */
export interface CkxSchemaRemoveResult {
  schemaId: string;
  owner: string;
  deleted: true;
}

/** 签约 schema 自助注册 API。 */
export interface CkxSchema {
  register(options: CkxSchemaRegisterOptions): Promise<CkxSchemaRegisterResult>;
  list(options: CkxSchemaListOptions): Promise<CkxSchemaListResult>;
  remove(options: CkxSchemaRemoveOptions): Promise<CkxSchemaRemoveResult>;
}

/**
 * 签约 schema 自助注册。鉴权 = app API Key（`Authorization: Bearer ckxapp_…`），
 * 不是 license 令牌。写操作不静默降级：参数误用抛 `INVALID_PARAMS`，服务端错误码
 * 原样透出，网络/超时抛 `CKX_TIMEOUT`。`apiKey` 永不进入日志 / 错误 message / 返回对象。
 */
export declare const ckxSchema: CkxSchema;
