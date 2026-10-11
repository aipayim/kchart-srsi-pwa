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
/** 只读公开元数据，不解密；不可读/非 CKX 载体返回 `null`。同时探测非对称容器 `CKXA`（介质 G）。 */
export declare function readMeta(carrier: string | Uint8Array | CkxImageData): CkxMeta | null;

// ---------------------------------------------------------------- 介质 G：非对称容器 `CKXA` v1（R16 Phase 5）

/** 容器 magic = ASCII `CKXA`（只读，勿就地修改）。 */
export declare const CKXA_MAGIC: Uint8Array;
/** 容器版本（字节 4）= 1。 */
export declare const CKXA_VERSION: 1;
/** 固定 header 字节数（magic‖ver‖epk‖wrapIv‖wrappedCEK‖metaLen）= 101。 */
export declare const CKXA_HEADER_BYTES: 101;
/** `wrappedCEK` 字节数 = CEK(32) + GCM tag(16) = 48。 */
export declare const CKXA_WRAPPED_CEK_BYTES: 48;
/** 临时公钥 `epk` 字节数 = 32。 */
export declare const CKXA_EPK_BYTES: 32;
/** CEK 字节数 = 32（AES-256）。 */
export declare const CKXA_CEK_BYTES: 32;
/** `wrapIv` 字节数 = 12。 */
export declare const CKXA_WRAP_IV_BYTES: 12;
/** `contentIv` 字节数 = 12。 */
export declare const CKXA_CONTENT_IV_BYTES: 12;
/** `wrapAad` 字节数 = magic(4)+ver(1)+epk(32) = 37。 */
export declare const CKXA_WRAP_AAD_BYTES: 37;
/** `metaJSON` 上限 = 4096 B（与 SAFE v3 一致）。 */
export declare const CKXA_META_MAX_BYTES: 4096;
/** `metaJSON` 中标记「非对称容器」的字段名 = `asym`。 */
export declare const CKXA_META_TAG_FIELD: 'asym';
/** `meta.asym` 取值 = `"1"`。 */
export declare const CKXA_META_TAG_VALUE: '1';

/** X25519 收件人密钥对（公钥 raw / 私钥 PKCS#8，均 base64url）。 */
export interface CkxRecipientKeyPair {
  /** base64url(raw 32 B X25519 public key)；可公开分发。 */
  publicKey: string;
  /** base64url(PKCS#8 DER)；**必须**保密。 */
  privateKey: string;
}
/** `encryptToRecipient` 元数据入参（与 `CkxMetaInput` 同形）。 */
export type CkxAsymMetaInput = CkxMetaInput;
/** `decryptAsRecipient` 选项（`schema` 不符抛 `CKX_SCHEMA_MISMATCH`）。 */
export interface CkxAsymDecryptOptions {
  schema?: string | null;
}
/** `decryptAsRecipient` 结果。 */
export interface CkxAsymDecryptResult {
  plaintext: Uint8Array;
  text: string | null;
  meta: CkxMeta;
}

/** 生成 X25519 收件人密钥对；运行时无 X25519 → `CKX_UNSUPPORTED_FORMAT_VERSION`。 */
export declare function generateRecipientKeyPair(): Promise<CkxRecipientKeyPair>;
/** 导出公钥为 base64url(raw 32 B)。 */
export declare function exportRecipientPublicKey(key: CryptoKey): Promise<string>;
/** 导出私钥为 base64url(PKCS#8 DER)（WebCrypto 不支持 X25519 私钥 raw 导出）。 */
export declare function exportRecipientPrivateKey(key: CryptoKey): Promise<string>;
/** 导入 base64url(raw 32 B) 公钥；长度/编码非法 → `INVALID_PARAMS`。 */
export declare function importRecipientPublicKey(publicKeyB64: string): Promise<CryptoKey>;
/** 导入 base64url(PKCS#8 DER) 私钥；导入失败 → `INVALID_PARAMS`。 */
export declare function importRecipientPrivateKey(privateKeyB64: string): Promise<CryptoKey>;
/** 由私钥反推公钥（base64url raw 32 B）——便于只存私钥的宿主发布公钥。 */
export declare function recipientPublicKeyFromPrivate(privateKeyB64: string): Promise<string>;
/** 公钥指纹 = `hex(SHA-256(raw)[0..8))`（小写 16 hex 字符），仅展示用。 */
export declare function recipientKeyFingerprint(publicKeyB64: string): Promise<string>;
/** 介质 G：用收件人公钥加密 → `CKXA` v1 容器字节。 */
export declare function encryptToRecipient(
  payload: string | Uint8Array,
  recipientPublicKeyB64: string,
  meta: CkxAsymMetaInput,
): Promise<Uint8Array>;
/** 介质 G：用收件人私钥解密；私钥不匹配/篡改统一抛 `CKX_WRONG_PASSWORD`。 */
export declare function decryptAsRecipient(
  container: Uint8Array | string,
  recipientPrivateKeyB64: string,
  options?: CkxAsymDecryptOptions,
): Promise<CkxAsymDecryptResult>;
/** 只读 `CKXA` 公开元数据（不解密、不抛）；非 CKXA / 不可解析 → `null`。 */
export declare function readRecipientMeta(container: Uint8Array | string): CkxMeta | null;
/** 是否以 `CKXA` magic 开头（不看版本/长度）。 */
export declare function hasCkxAsymMagic(bytes: Uint8Array): boolean;
/** `verifyIntegrity` 的机器可读结论（**不**做任何解密，不构成密码 oracle）。 */
export type CkxIntegrityReason =
  | 'ok'
  | 'empty'
  | 'not-a-ckx-carrier'
  | 'truncated-header'
  | 'unsupported-format-version'
  | 'meta-too-large'
  | 'truncated-meta'
  | 'invalid-meta'
  | 'no-payload';
/** `verifyIntegrity` 结果：结构是否自洽 + 可读的公开元数据（不接触口令/明文）。 */
export interface CkxIntegrityResult {
  ok: boolean;
  reason: CkxIntegrityReason;
  medium: CkxMedium | null;
  containerBytes: number | null;
  metaBytes: number | null;
  payloadBytes: number | null;
  meta: CkxMeta | null;
}
/** 免密码结构自检（只读 magic/版本/metaLen/长度/公开 meta）；任意畸形输入都返回
 *  `{ ok:false, reason }`，**绝不抛**。`ok:true` 只代表结构自洽，不代表口令正确。 */
export declare function verifyIntegrity(carrier: string | Uint8Array | CkxImageData): CkxIntegrityResult;
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

// ---------------------------------------------------------------- C2：轻量探测 / 载体规划 / 容器直嵌（AIDID-4/5）

/** (AIDID-5) `readVideoMeta` 结果（同步探测，不解密）。 */
export interface CkxVideoMetaResult {
  hasTrailer: boolean;
  containerBytes: number | null;
  trailerOffset: number | null;
  meta: CkxMeta | null;
}
/** 视频载体轻量同步探测：读尾部长度 + 明文 meta，不解密、不复制 payload。 */
export declare function readVideoMeta(video: ArrayBuffer | Uint8Array): CkxVideoMetaResult;

/** (AIDID-4) 用已有容器规划图片基底（省一次 PBKDF2）。 */
export interface CkxCarrierPlan {
  medium: 'image-text' | 'image-binary';
  binary: boolean;
  containerBytes: number;
  requiredBytes: number;
  recommended: { width: number; height: number };
  formula: string;
}
/**
 * 用已有容器规划图片基底。字符串容器 → 介质 B（默认），字节容器 → 介质 C（默认）；
 * `opts.binary` 可显式覆盖，`opts.minSize` / `opts.maxSize` 覆盖边长 clamp（默认 256/4096）。
 */
export declare function planImageCarrier(
  container: string | Uint8Array,
  opts?: { binary?: boolean; minSize?: number; maxSize?: number },
): CkxCarrierPlan;
/** 把已加密容器写入 RGBA 像素（返回同一 `image` 引用，便于链式）。 */
export declare function embedContainer(
  image: CkxImageData,
  container: string | Uint8Array,
): { image: CkxImageData; medium: 'image-text' | 'image-binary' };

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

// ------------------------------------------------------------------ embed 协议 v1（postMessage）

/**
 * CKX iframe embed postMessage 协议的字段级类型（协议版本 `v` = 1）。
 *
 * 机器可读 JSON Schema：`https://cryptokey.im/ckx/spec/protocol-v1.schema.json`
 * （发布副本 `/ckx/sdk/` 亦含本声明）。字段含义见 `https://cryptokey.im/ckx/spec/`。
 *
 * 握手：宿主等 `ckx:ready` → 回显其 `nonce` 发 `ckx:init` → 用 `ckx:encrypt` / `ckx:decrypt`
 * 驱动 → 处理 `ckx:result` / `ckx:plaintext` / `ckx:error`。成功 `ckx:init` 前 embed 忽略一切消息。
 */
export type CkxEmbedProtocolVersion = 1;

/** 宿主 → embed 的消息类型。 */
export type CkxHostToEmbedType = 'ckx:init' | 'ckx:encrypt' | 'ckx:encrypt.bulk' | 'ckx:decrypt' | 'ckx:cancel' | 'ckx:estimate';
/** embed → 宿主的消息类型。 */
export type CkxEmbedToHostType =
  | 'ckx:ready'
  | 'ckx:capabilities'
  | 'ckx:result'
  | 'ckx:plaintext'
  | 'ckx:error'
  | 'ckx:idle-warning'
  | 'ckx:resize'
  | 'ckx:estimate.result';

/** 介质自描述（BL-3）：`hostCarrier=true` 表示该介质接受宿主/用户提供的载体。 */
export interface CkxMediumInfo {
  hostCarrier: boolean;
  carrier: string;
}

/** 四介质能力自描述。 */
export interface CkxMediums {
  text: CkxMediumInfo;
  image: CkxMediumInfo;
  file: CkxMediumInfo;
  video: CkxMediumInfo;
}

/** 容器元数据（明文写入 SAFE v3 头；仅公开字段，切勿放业务明文）。 */

/** 带二进制载荷的文件（浏览器中 `bytes` 为 ArrayBuffer）。 */
export interface CkxFilePayload {
  name: string;
  mime: string;
  bytes: ArrayBuffer | Uint8Array | string;
}

export interface CkxInitMessage {
  v: CkxEmbedProtocolVersion;
  type: 'ckx:init';
  nonce: string;
  /** 宿主 origin（裸 origin）；embed 会在反钓鱼横幅展示。 */
  app: string;
  mode?: 'text' | 'image' | 'file' | 'video';
  schema?: string;
  schemaVersion?: string;
  label?: string;
  locale?: string;
  theme?: 'light' | 'dark';
  strictMatching?: boolean;
  timeout?: number;
}

export interface CkxEncryptMessage {
  v: CkxEmbedProtocolVersion;
  type: 'ckx:encrypt' | 'ckx:encrypt.bulk';
  nonce: string;
  payload?: string | ArrayBuffer | Uint8Array;
  bulk?: Array<{
    payload: string | ArrayBuffer | Uint8Array;
    filename?: string;
    label?: string;
    mime?: string;
    meta?: CkxMeta;
  }>;
  meta?: CkxMeta;
  carrier?: string | ArrayBuffer | Uint8Array;
  carrierName?: string;
  filename?: string;
  shard?: Record<string, unknown>;
}

export interface CkxDecryptMessage {
  v: CkxEmbedProtocolVersion;
  type: 'ckx:decrypt';
  nonce: string;
  carrier?: string | ArrayBuffer | Uint8Array;
  carriers?: Array<string | ArrayBuffer | Uint8Array>;
  carrierName?: string;
  filename?: string;
}

export interface CkxCancelMessage {
  v: CkxEmbedProtocolVersion;
  type: 'ckx:cancel';
  nonce: string;
}

/** 容量预检（不加密）；回复 `CkxEstimateResultMessage`。 */
export interface CkxEstimateMessage {
  v: CkxEmbedProtocolVersion;
  type: 'ckx:estimate';
  nonce: string;
  payload: string | ArrayBuffer | Uint8Array;
  meta?: CkxMeta;
  carrier?: string | ArrayBuffer | Uint8Array;
}

export type CkxHostToEmbedMessage =
  | CkxInitMessage
  | CkxEncryptMessage
  | CkxDecryptMessage
  | CkxCancelMessage
  | CkxEstimateMessage;

export interface CkxReadyMessage {
  v: CkxEmbedProtocolVersion;
  formatVersion: string;
  type: 'ckx:ready';
  nonce: string;
  capabilities: string[];
  pro: boolean;
  strictMatching?: boolean;
  shardLimits?: Record<string, unknown>;
  branding?: Record<string, unknown>;
  mediums?: CkxMediums;
  sdkVersion?: string;
}

export interface CkxCapabilitiesMessage {
  v: CkxEmbedProtocolVersion;
  formatVersion: string;
  type: 'ckx:capabilities';
  nonce: string;
  capabilities: string[];
  pro: boolean;
  granted: string[];
  schemas?: string[];
  expiresAt?: number | null;
  source?: string;
  strictMatching?: boolean;
  shardLimits?: Record<string, unknown>;
  branding?: Record<string, unknown>;
  mediums?: CkxMediums;
  sdkVersion?: string;
  /** 本次会话生效的空闲超时（秒；0 = 关闭），可由 `ckx:init.timeout` 覆盖。 */
  idleTimeoutSec?: number;
  /** 已接受但未授权（免费层降级为信息性标签）的字段，例如 `['schema']`；绝不静默丢弃。 */
  ignored?: string[];
}

export interface CkxResultMessage {
  v: CkxEmbedProtocolVersion;
  formatVersion: string;
  type: 'ckx:result';
  nonce: string;
  kind: 'ciphertext' | 'carrier' | 'bulk';
  text?: string;
  file?: CkxFilePayload;
  files?: CkxFilePayload[];
  count?: number;
  items?: Array<{
    index: number;
    kind: string;
    text?: string;
    file?: CkxFilePayload;
    meta?: CkxMeta;
    error?: Record<string, unknown>;
  }>;
  meta?: CkxMeta;
}

export interface CkxPlaintextMessage {
  v: CkxEmbedProtocolVersion;
  formatVersion: string;
  type: 'ckx:plaintext';
  nonce: string;
  text?: string;
  bytes?: ArrayBuffer | Uint8Array;
  meta?: CkxMeta;
}

export interface CkxEmbedErrorMessage {
  v: CkxEmbedProtocolVersion;
  formatVersion: string;
  type: 'ckx:error';
  nonce: string;
  code: string;
  message: string;
  messageKey?: string;
  detail?: { field?: string; limit?: number; actual?: number; hint?: string } & Record<string, unknown>;
  retryable?: boolean;
}

export interface CkxEstimateResultMessage {
  v: CkxEmbedProtocolVersion;
  formatVersion: string;
  type: 'ckx:estimate.result';
  nonce: string;
  mode?: 'text' | 'image' | 'file' | 'video';
  medium?: 'A' | 'B' | 'C' | 'D' | 'E';
  binary?: boolean;
  payloadBytes?: number;
  containerBytes?: number;
  requiredBytes?: number;
  availableBytes?: number;
  fits: boolean;
  detail?: { limit?: number; actual?: number } & Record<string, unknown>;
}

/** 空闲超时前的预警（随后若无交互将发 `CKX_TIMEOUT`）。 */
export interface CkxIdleWarningMessage {
  v: CkxEmbedProtocolVersion;
  formatVersion: string;
  type: 'ckx:idle-warning';
  nonce: string;
  remainingMs?: number;
}

/** embed 内容尺寸（宿主可据此调整 iframe 高度）。 */
export interface CkxResizeMessage {
  v: CkxEmbedProtocolVersion;
  formatVersion: string;
  type: 'ckx:resize';
  nonce: string;
  height: number;
  width?: number;
}

export type CkxEmbedToHostMessage =
  | CkxReadyMessage
  | CkxCapabilitiesMessage
  | CkxResultMessage
  | CkxPlaintextMessage
  | CkxEmbedErrorMessage
  | CkxIdleWarningMessage
  | CkxResizeMessage
  | CkxEstimateResultMessage;

/** 任意 CKX embed 协议消息。 */
export type CkxEmbedMessage = CkxHostToEmbedMessage | CkxEmbedToHostMessage;
